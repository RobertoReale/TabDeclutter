import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { DEFAULT_SETTINGS, NO_GROUP_ID, type TabInfo } from '../../src/core/types';
import { registerAutopilot } from '../../src/entrypoints/background/autopilot';
import {
  loadSavedYouTubeDurations,
  resetAiGrouping,
  savedYouTubeDurations,
  sortCurrentWindowYouTube,
  undoYouTubeSort,
  windowPlan,
  youTubeSorted,
  youTubeSortStatus,
} from '../../src/entrypoints/sidepanel/state/organize';
import {
  setSortYouTubeByDuration,
  youTubeDenied,
  youTubeGranted,
} from '../../src/entrypoints/sidepanel/state/settings';
import { panelData, type PanelData } from '../../src/entrypoints/sidepanel/state/tabs';
import {
  mergeYouTubeDurations,
  readSettings,
  readYouTubeDurations,
  saveSettings,
} from '../../src/platform/storage';
import type { BrowserTab } from '../../src/platform/tabs';
import {
  organizeWindows,
  sortWindowYouTubeTabs,
  undoOrganizeWindows,
  type WindowsOrganizeApi,
} from '../../src/platform/windows';
import {
  fetchYouTubeVideoDuration,
  hasYouTubePermission,
  removeYouTubePermission,
  requestYouTubePermission,
  resetYouTubeFetcher,
  resolveYouTubeDurations,
  YOUTUBE_ORIGIN,
  type YouTubePermissionApi,
} from '../../src/platform/youtube';

const NOW = Date.UTC(2026, 10, 25, 9, 0, 0);

/** Splice-accurate browser mock matching Chrome & Firefox `tabs.move` index semantics. */
function spliceWindowApi(initialTabs: BrowserTab[]) {
  const tabs = initialTabs.map((t) => ({ ...t }));
  const moves: { tabId: number; windowId?: number; index: number }[] = [];
  let nextWindowId = 10;

  function reindex(windowId: number): void {
    const inWin = tabs
      .filter((t) => t.windowId === windowId)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    inWin.forEach((t, i) => {
      t.index = i;
    });
  }

  const api: WindowsOrganizeApi = {
    tabs: {
      query: async () => tabs.map((t) => ({ ...t })),
      move: async (tabId, props) => {
        moves.push({ tabId, ...props });
        const moving = tabs.find((t) => t.id === tabId);
        if (moving === undefined) return;
        const oldWin = moving.windowId ?? 1;
        const newWin = props.windowId ?? oldWin;
        const inTarget = tabs
          .filter((t) => t.windowId === newWin && t.id !== tabId)
          .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        const insertAt = Math.max(0, Math.min(props.index, inTarget.length));
        moving.windowId = newWin;
        inTarget.splice(insertAt, 0, moving);
        inTarget.forEach((t, i) => {
          t.index = i;
        });
        if (oldWin !== newWin) reindex(oldWin);
      },
      ungroup: async (ids) => {
        for (const id of ids) {
          const found = tabs.find((t) => t.id === id);
          if (found !== undefined) found.groupId = NO_GROUP_ID;
        }
      },
    },
    windows: {
      create: async (props) => {
        const windowId = nextWindowId++;
        if (props.tabId !== undefined) {
          const found = tabs.find((t) => t.id === props.tabId);
          if (found !== undefined) {
            const oldWin = found.windowId ?? 1;
            found.windowId = windowId;
            found.index = 0;
            reindex(oldWin);
          }
        }
        return { id: windowId };
      },
      getLastFocused: async () => ({ id: 1 }),
    },
  };

  function orderIn(windowId: number): number[] {
    return tabs
      .filter((t) => t.windowId === windowId)
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((t) => t.id!);
  }

  return { api, tabs, moves, orderIn };
}

function makeTab(id: number, url: string, overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id,
    windowId: 1,
    index: id,
    url,
    title: `Tab ${id}`,
    pinned: false,
    audible: false,
    active: false,
    discarded: false,
    hidden: false,
    groupId: NO_GROUP_ID,
    incognito: false,
    ...overrides,
  };
}

function makeSnapshot(tabs: readonly TabInfo[], sortEnabled = true): PanelData {
  return {
    tabs,
    activity: {},
    settings: {
      ...DEFAULT_SETTINGS,
      sortYouTubeByDuration: sortEnabled,
      youTubeDurationOrder: 'asc',
    },
    keeps: {},
    protectedSites: [],
    whitelist: [],
    bookmarks: new Set<string>(),
    focusedWindowId: 1,
    ownOrigin: 'chrome-extension://test',
    at: NOW,
  };
}

beforeEach(() => {
  fakeBrowser.reset();
  resetYouTubeFetcher();
  resetAiGrouping();
  panelData.value = null;
  youTubeGranted.value = false;
  youTubeDenied.value = false;
  vi.restoreAllMocks();
});

describe('platform/youtube permissions and streaming fetcher', () => {
  it('checks, requests synchronously, and revokes the optional youtube.com origin permission', async () => {
    const contains = vi.fn().mockResolvedValue(true);
    const request = vi.fn().mockResolvedValue(true);
    const remove = vi.fn().mockResolvedValue(true);
    const permApi: YouTubePermissionApi = { permissions: { contains, request, remove } };

    expect(await hasYouTubePermission(permApi)).toBe(true);
    expect(contains).toHaveBeenCalledWith({ origins: [YOUTUBE_ORIGIN] });

    expect(await requestYouTubePermission(permApi)).toBe(true);
    expect(request).toHaveBeenCalledWith({ origins: [YOUTUBE_ORIGIN] });

    expect(await removeYouTubePermission(permApi)).toBe(true);
    expect(remove).toHaveBeenCalledWith({ origins: [YOUTUBE_ORIGIN] });
  });

  it('streams watch HTML and cancels early once duration and live context arrive', async () => {
    const encoder = new TextEncoder();
    const cancelSpy = vi.fn().mockResolvedValue(undefined);
    let chunkIndex = 0;
    const chunks = [
      encoder.encode('<html><head><title>Video</title></head><body>'),
      encoder.encode('{"videoDetails":{"lengthSeconds":"425","isLiveContent":false}}'),
      encoder.encode('X'.repeat(500_000)),
    ];
    const mockResponse = {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (chunkIndex >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[chunkIndex++] };
          },
          cancel: cancelSpy,
        }),
      },
    } as unknown as Response;

    const fetchFn = vi.fn().mockResolvedValue(mockResponse) as unknown as typeof fetch;
    const parsed = await fetchYouTubeVideoDuration('dQw4w9WgXcQ', undefined, fetchFn);
    expect(parsed).toEqual({ kind: 'duration', seconds: 425 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      expect.objectContaining({ credentials: 'omit' }),
    );
    expect(cancelSpy).toHaveBeenCalledTimes(1);
    // Stopped before reading the huge 3rd chunk.
    expect(chunkIndex).toBe(2);
  });

  it('retries once with credentials:include only when anonymous fetch returns unknown (e.g. consent wall)', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '<html><body>Consent required</body></html>',
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => '{"videoDetails":{"lengthSeconds":"310","isLiveContent":false}}',
      });

    const parsed = await fetchYouTubeVideoDuration(
      'ConsentVid1',
      undefined,
      fetchSpy as unknown as typeof fetch,
    );
    expect(parsed).toEqual({ kind: 'duration', seconds: 310 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit' });
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({ credentials: 'include' });
  });

  it('waits past DVR lengthSeconds chunk to detect active isLive:true in the next chunk', async () => {
    const encoder = new TextEncoder();
    let chunkIndex = 0;
    const chunks = [
      encoder.encode('{"videoDetails":{"lengthSeconds":"1420",'),
      encoder.encode('"isLive":true,"isLiveContent":true}}'),
    ];
    const mockResponse = {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (chunkIndex >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[chunkIndex++] };
          },
          cancel: vi.fn().mockResolvedValue(undefined),
        }),
      },
    } as unknown as Response;

    const fetchFn = vi.fn().mockResolvedValue(mockResponse) as unknown as typeof fetch;
    const parsed = await fetchYouTubeVideoDuration('LiveDvr0001', undefined, fetchFn);
    expect(parsed).toEqual({ kind: 'live' });
  });

  it('returns null on HTTP errors and network failures without throwing', async () => {
    const errFetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;
    expect(await fetchYouTubeVideoDuration('ErrVideo001', undefined, errFetch)).toBeNull();

    const throwFetch = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
    expect(await fetchYouTubeVideoDuration('ErrVideo002', undefined, throwFetch)).toBeNull();
  });

  it('hits local cache first, deduplicates video ids, unwraps suspended tabs, and leaves unknown/errors uncached', async () => {
    await mergeYouTubeDurations({ CachedVid01: { seconds: 120, fetchedAt: NOW - 1000 } }, NOW);
    const tabs: TabInfo[] = [
      makeTab(1, 'https://www.youtube.com/watch?v=CachedVid01'),
      makeTab(
        2,
        'chrome-extension://bbomjaikkcabgmfaomdichgcodnaeecf/suspend.html?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DSuspVid0001',
      ),
      makeTab(3, 'https://youtu.be/SuspVid0001', { discarded: true }),
      makeTab(4, 'https://www.youtube.com/live/LiveVid0001'),
      makeTab(5, 'https://www.youtube.com/watch?v=FailVid0001'),
      makeTab(6, 'https://www.youtube.com/watch?v=UnkVid00001'),
    ];

    const calls: string[] = [];
    const progress: [number, number][] = [];
    const resolved = await resolveYouTubeDurations(tabs, {
      now: NOW,
      onProgress: (done, total) => {
        progress.push([done, total]);
      },
      fetcher: async (videoId) => {
        calls.push(videoId);
        if (videoId === 'SuspVid0001') return { kind: 'duration', seconds: 480 };
        if (videoId === 'LiveVid0001') return { kind: 'live' };
        if (videoId === 'UnkVid00001') return { kind: 'unknown' };
        return null;
      },
    });

    // Cached video was never fetched, and duplicate suspended/discarded video was fetched once.
    expect(calls.sort()).toEqual(['FailVid0001', 'LiveVid0001', 'SuspVid0001', 'UnkVid00001']);
    expect(resolved.get('CachedVid01')).toBe(120);
    expect(resolved.get('SuspVid0001')).toBe(480);
    expect(resolved.get('LiveVid0001')).toBeNull();
    expect(resolved.has('FailVid0001')).toBe(false);
    expect(resolved.has('UnkVid00001')).toBe(false);
    expect(progress[0]).toEqual([1, 5]);
    expect(progress[progress.length - 1]).toEqual([5, 5]);

    // Only known durations and live streams were persisted; failures and unknown stay uncached.
    const stored = await readYouTubeDurations();
    expect(stored.CachedVid01?.seconds).toBe(120);
    expect(stored.SuspVid0001?.seconds).toBe(480);
    expect(stored.LiveVid0001?.seconds).toBeNull();
    expect(stored.FailVid0001).toBeUndefined();
    expect(stored.UnkVid00001).toBeUndefined();
  });

  it('never fetches when permission is not granted or allowNetwork is false', async () => {
    const permApi: YouTubePermissionApi = {
      permissions: {
        contains: vi.fn().mockResolvedValue(false),
        request: vi.fn(),
        remove: vi.fn(),
      },
    };
    const tabs = [makeTab(1, 'https://www.youtube.com/watch?v=NoPermVid01')];
    const resolved = await resolveYouTubeDurations(tabs, { permissionApi: permApi });
    expect(resolved.size).toBe(0);
  });
});

describe('sortWindowYouTubeTabs and organizeWindows integration', () => {
  it('sorts YouTube tabs in place (including suspended & discarded) and undoes back to exact original positions', async () => {
    const { api, moves, orderIn } = spliceWindowApi([
      {
        id: 1,
        windowId: 1,
        index: 0,
        url: 'https://www.youtube.com/watch?v=Pinned00001',
        pinned: true,
      },
      { id: 2, windowId: 1, index: 1, url: 'https://mail.google.com/' },
      {
        id: 3,
        windowId: 1,
        index: 2,
        url: 'chrome-extension://bbomjaikkcabgmfaomdichgcodnaeecf/suspend.html?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DLongVid0001',
      },
      { id: 4, windowId: 1, index: 3, url: 'chrome://newtab/' },
      {
        id: 5,
        windowId: 1,
        index: 4,
        url: 'https://www.youtube.com/watch?v=ShortVid001',
        discarded: true,
      },
      { id: 6, windowId: 1, index: 5, url: 'https://docs.google.com/doc/1' },
      { id: 7, windowId: 1, index: 6, url: 'https://www.youtube.com/shorts/MidVid00001' },
    ]);
    const durations = new Map<string, number | null>([
      ['Pinned00001', 9999],
      ['LongVid0001', 2400],
      ['ShortVid001', 45],
      ['MidVid00001', 180],
    ]);

    const result = await sortWindowYouTubeTabs({
      windowId: 1,
      order: 'asc',
      durations,
      api,
    });

    expect(result.videoCount).toBe(3);
    expect(result.knownCount).toBe(3);
    expect(result.movedTabs).toBeGreaterThan(0);
    expect(result.undo).toBeDefined();
    expect(orderIn(1)).toEqual([1, 2, 5, 4, 7, 6, 3]);
    // Pinned, Gmail, newtab, and Docs were never moved.
    expect(moves.every((m) => [3, 5, 7].includes(m.tabId))).toBe(true);

    moves.length = 0;
    const restored = await undoOrganizeWindows(result.undo!, api);
    expect(restored).toBeGreaterThan(0);
    expect(orderIn(1)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(moves.every((m) => [3, 5, 7].includes(m.tabId))).toBe(true);
  });

  it('sorts YouTube tabs by duration inside organizeWindows in both merge-windows and split-windows modes', async () => {
    const durations = new Map<string, number | null>([
      ['VidLong0001', 1800],
      ['VidShort001', 60],
      ['VidMid00001', 420],
    ]);

    const merged = spliceWindowApi([
      {
        id: 1,
        windowId: 1,
        index: 0,
        url: 'https://www.youtube.com/watch?v=VidLong0001',
        title: 'Long',
      },
      { id: 2, windowId: 2, index: 0, url: 'https://github.com/a', title: 'GitHub A' },
      {
        id: 3,
        windowId: 2,
        index: 1,
        url: 'https://www.youtube.com/watch?v=VidShort001',
        title: 'Short',
      },
      { id: 4, windowId: 1, index: 1, url: 'https://github.com/b', title: 'GitHub B' },
      {
        id: 5,
        windowId: 1,
        index: 2,
        url: 'https://www.youtube.com/watch?v=VidMid00001',
        title: 'Mid',
      },
    ]);

    await organizeWindows({
      windowMode: 'merge-windows',
      clusterMode: 'site',
      useTabGroups: false,
      focusedWindowId: 1,
      youTubeSort: { durations, order: 'asc' },
      api: merged.api,
    });
    const mergedOrder = merged.orderIn(1);
    const ytPositions = [3, 5, 1].map((id) => mergedOrder.indexOf(id));
    expect(ytPositions[0]).toBeLessThan(ytPositions[1]!);
    expect(ytPositions[1]).toBeLessThan(ytPositions[2]!);

    const split = spliceWindowApi([
      {
        id: 1,
        windowId: 1,
        index: 0,
        url: 'https://www.youtube.com/watch?v=VidShort001',
        title: 'Short',
      },
      { id: 2, windowId: 1, index: 1, url: 'https://github.com/a', title: 'GitHub A' },
      {
        id: 3,
        windowId: 2,
        index: 0,
        url: 'https://www.youtube.com/watch?v=VidLong0001',
        title: 'Long',
      },
      { id: 4, windowId: 2, index: 1, url: 'https://github.com/b', title: 'GitHub B' },
      {
        id: 5,
        windowId: 2,
        index: 2,
        url: 'https://www.youtube.com/watch?v=VidMid00001',
        title: 'Mid',
      },
    ]);

    await organizeWindows({
      windowMode: 'split-windows',
      clusterMode: 'site',
      useTabGroups: false,
      focusedWindowId: 1,
      youTubeSort: { durations, order: 'desc' },
      api: split.api,
    });
    const ytWin = split.tabs.find((t) => t.id === 1)!.windowId!;
    expect(split.orderIn(ytWin)).toEqual([3, 5, 1]);
  });
});

describe('Settings toggle, Organize state, and Autopilot integration', () => {
  it('requests optional youtube.com permission synchronously, refuses cleanly, and clears cache on disable', async () => {
    const request = vi.spyOn(fakeBrowser.permissions, 'request').mockResolvedValue(true as never);
    setSortYouTubeByDuration(true);
    expect(request).toHaveBeenCalledWith({ origins: [YOUTUBE_ORIGIN] });

    await vi.waitFor(async () => {
      expect((await readSettings()).sortYouTubeByDuration).toBe(true);
    });
    expect(youTubeGranted.value).toBe(true);
    expect(youTubeDenied.value).toBe(false);

    await mergeYouTubeDurations({ ClearMe0001: { seconds: 90, fetchedAt: NOW } }, NOW);
    const remove = vi.spyOn(fakeBrowser.permissions, 'remove').mockResolvedValue(true as never);
    setSortYouTubeByDuration(false);

    await vi.waitFor(async () => {
      expect((await readSettings()).sortYouTubeByDuration).toBe(false);
      expect(await readYouTubeDurations()).toEqual({});
    });
    expect(remove).toHaveBeenCalledWith({ origins: [YOUTUBE_ORIGIN] });

    // Refusal leaves setting off and flags warning.
    request.mockResolvedValueOnce(false as never);
    setSortYouTubeByDuration(true);
    await vi.waitFor(() => {
      expect(youTubeDenied.value).toBe(true);
    });
    expect((await readSettings()).sortYouTubeByDuration).toBe(false);
  });

  it('orders windowPlan preview and supports sortCurrentWindowYouTube + undoYouTubeSort', async () => {
    await mergeYouTubeDurations(
      {
        LongVid0001: { seconds: 900, fetchedAt: NOW },
        ShortVid001: { seconds: 60, fetchedAt: NOW },
      },
      NOW,
    );
    await loadSavedYouTubeDurations();
    expect(savedYouTubeDurations.value.LongVid0001?.seconds).toBe(900);

    const tabs = [
      makeTab(1, 'https://www.youtube.com/watch?v=LongVid0001', { index: 0, title: 'Long' }),
      makeTab(2, 'https://www.youtube.com/watch?v=ShortVid001', { index: 1, title: 'Short' }),
    ];
    panelData.value = makeSnapshot(tabs, true);
    expect(windowPlan.value.groups[0]?.tabIds).toEqual([2, 1]);

    const undoSpy = vi.fn().mockResolvedValue(1);
    const undoSnap = { tabs: [] };
    await sortCurrentWindowYouTube('asc', 1, {
      resolveDurations: async () =>
        new Map<string, number | null>([
          ['LongVid0001', 900],
          ['ShortVid001', 60],
        ]),
      sortWindow: async () => ({ movedTabs: 1, videoCount: 2, knownCount: 2, undo: undoSnap }),
    });
    expect(youTubeSorted.value).toEqual({ sortedCount: 2, unknownCount: 0, undo: undoSnap });
    expect(youTubeSortStatus.value).toBeNull();

    await undoYouTubeSort(undoSpy);
    expect(undoSpy).toHaveBeenCalledWith(undoSnap);
    expect(youTubeSorted.value).toBeNull();

    // Already ordered & unavailable feedback states
    await sortCurrentWindowYouTube('asc', 1, {
      resolveDurations: async () => new Map<string, number | null>([['LongVid0001', 900]]),
      sortWindow: async () => ({ movedTabs: 0, videoCount: 2, knownCount: 2 }),
    });
    expect(youTubeSortStatus.value).toBe('already-ordered');

    await sortCurrentWindowYouTube('asc', 1, {
      resolveDurations: async () => new Map<string, number | null>(),
      sortWindow: async () => ({ movedTabs: 0, videoCount: 2, knownCount: 0 }),
    });
    expect(youTubeSortStatus.value).toBe('unavailable');
  });

  it('autopilot sorts cached YouTube tabs by duration when autoOrganize and sortYouTubeByDuration are enabled', async () => {
    await saveSettings({
      ...DEFAULT_SETTINGS,
      autoOrganize: true,
      autoWindowMode: 'merge-windows',
      autoOrganizeMode: 'site',
      sortYouTubeByDuration: true,
      youTubeDurationOrder: 'desc',
    });
    await mergeYouTubeDurations(
      {
        AutoShort01: { seconds: 60, fetchedAt: NOW },
        AutoLong001: { seconds: 1200, fetchedAt: NOW },
      },
      NOW,
    );

    const { api, orderIn } = spliceWindowApi([
      {
        id: 1,
        windowId: 1,
        index: 0,
        url: 'https://www.youtube.com/watch?v=AutoShort01',
        title: 'S',
      },
      {
        id: 2,
        windowId: 1,
        index: 1,
        url: 'https://www.youtube.com/watch?v=AutoLong001',
        title: 'L',
      },
    ]);
    vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation((() => api.tabs.query({})) as never);
    vi.spyOn(fakeBrowser.tabs, 'move').mockImplementation(((
      id: number,
      props: { windowId?: number; index: number },
    ) => api.tabs.move(id, props)) as never);
    vi.spyOn(fakeBrowser.windows, 'getLastFocused').mockResolvedValue({ id: 1 } as never);

    const autopilot = registerAutopilot({ now: () => NOW });
    await autopilot.run();

    expect(orderIn(1)).toEqual([2, 1]);
  });
});
