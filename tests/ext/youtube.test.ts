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
  setCloseLikedYouTube,
  setSortYouTubeByDuration,
  youTubeDenied,
  youTubeGranted,
} from '../../src/entrypoints/sidepanel/state/settings';
import { panelData, type PanelData } from '../../src/entrypoints/sidepanel/state/tabs';
import { forgetClose, lastClose } from '../../src/entrypoints/sidepanel/state/undo';
import {
  cancelLikedYouTubeClose,
  closeLikedYouTubeNow,
  eligibleLikedTabs,
  likedYouTubeStatus,
  likedYouTubeWorking,
  resetLikedYouTubeState,
} from '../../src/entrypoints/sidepanel/state/youtube-liked';
import {
  archiveItem,
  keepsItem,
  mergeYouTubeDurations,
  protectedDomainsItem,
  readSettings,
  readYouTubeDurations,
  saveSettings,
  ytLikedCheckedAtItem,
} from '../../src/platform/storage';
import { keepKey } from '../../src/core/scoring';
import type { BrowserTab, closeTabs } from '../../src/platform/tabs';
import {
  organizeWindows,
  sortWindowYouTubeTabs,
  undoOrganizeWindows,
  type WindowsOrganizeApi,
} from '../../src/platform/windows';
import {
  fetchYouTubeLikedPlaylist,
  fetchYouTubeVideoDuration,
  fetchYouTubeVideoLikeStatus,
  hasYouTubePermission,
  removeYouTubePermission,
  requestYouTubePermission,
  resetYouTubeFetcher,
  resolveLikedYouTubeVideos,
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
  resetLikedYouTubeState();
  forgetClose();
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

function streamResponse(parts: readonly string[]) {
  const encoder = new TextEncoder();
  const chunks = parts.map((p) => encoder.encode(p));
  const cancelSpy = vi.fn().mockResolvedValue(undefined);
  let idx = 0;
  const response = {
    ok: true,
    body: {
      getReader: () => ({
        read: async () =>
          idx >= chunks.length
            ? { done: true, value: undefined }
            : { done: false, value: chunks[idx++] },
        cancel: cancelSpy,
      }),
    },
  } as unknown as Response;
  return { response, cancelSpy, readCount: () => idx };
}

describe('YouTube liked-video detection, shared permissions, Declutter 1-click, and Autopilot', () => {
  it('streams LL playlist and /watch likeStatusEntity with credentials:include and early abort', async () => {
    const loggedOut = streamResponse(['{"LOGGED_IN":false}', 'X'.repeat(50_000)]);
    const outFetch = vi.fn().mockResolvedValue(loggedOut.response) as unknown as typeof fetch;
    expect(await fetchYouTubeLikedPlaylist(undefined, outFetch)).toEqual({
      loggedIn: false,
      likedIds: new Set(),
    });
    expect(outFetch).toHaveBeenCalledWith(
      'https://www.youtube.com/playlist?list=LL',
      expect.objectContaining({ credentials: 'include' }),
    );
    expect(loggedOut.cancelSpy).toHaveBeenCalledTimes(1);
    expect(loggedOut.readCount()).toBe(1);

    const watch = streamResponse([
      '{"LOGGED_IN":true}',
      '{"likeStatusEntity":{"key":"EgtkUXc0dzlXZ1hjUSA-KAE%3D","likeStatus":"LIKE"}}',
      'Y'.repeat(50_000),
    ]);
    const watchFetch = vi.fn().mockResolvedValue(watch.response) as unknown as typeof fetch;
    expect(await fetchYouTubeVideoLikeStatus('dQw4w9WgXcQ', undefined, watchFetch)).toEqual({
      kind: 'liked',
    });
    expect(watch.cancelSpy).toHaveBeenCalledTimes(1);
    expect(watch.readCount()).toBe(2);
  });

  it('resolves recent likes via Tier 1 LL playlist and older likes via Tier 2 /watch fallback', async () => {
    const tabs = [
      makeTab(1, 'https://www.youtube.com/watch?v=RecentLike1'),
      makeTab(
        2,
        'chrome-extension://bbomjaikkcabgmfaomdichgcodnaeecf/suspend.html?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DOlderLike01',
      ),
      makeTab(3, 'https://youtu.be/NotLiked001', { discarded: true }),
    ];
    const watchCalls: string[] = [];
    const progress: [number, number][] = [];

    const result = await resolveLikedYouTubeVideos(tabs, {
      onProgress: (done, total) => progress.push([done, total]),
      playlistFetcher: async () => ({
        loggedIn: true,
        likedIds: new Set(['RecentLike1', 'Unrelated01']),
      }),
      videoFetcher: async (id) => {
        watchCalls.push(id);
        return id === 'OlderLike01' ? { kind: 'liked' } : { kind: 'not-liked' };
      },
    });

    expect(result.status).toBe('ok');
    expect([...result.likedVideoIds].sort()).toEqual(['OlderLike01', 'RecentLike1']);
    expect(result.checkedCount).toBe(3);
    // Tier 1 hit skipped Tier 2 fetch for RecentLike1.
    expect(watchCalls.sort()).toEqual(['NotLiked001', 'OlderLike01']);
    expect(progress[progress.length - 1]).toEqual([3, 3]);
  });

  it('aborts immediately on logged-out, missing permission, or unavailable responses', async () => {
    const tabs = [makeTab(1, 'https://www.youtube.com/watch?v=VideoCheck1')];

    const noPermApi: YouTubePermissionApi = {
      permissions: {
        contains: vi.fn().mockResolvedValue(false),
        request: vi.fn(),
        remove: vi.fn(),
      },
    };
    expect(await resolveLikedYouTubeVideos(tabs, { permissionApi: noPermApi })).toEqual({
      status: 'no-permission',
      likedVideoIds: new Set(),
      checkedCount: 0,
    });

    const videoSpy = vi.fn();
    expect(
      await resolveLikedYouTubeVideos(tabs, {
        playlistFetcher: async () => ({ loggedIn: false, likedIds: new Set() }),
        videoFetcher: videoSpy,
      }),
    ).toEqual({ status: 'logged-out', likedVideoIds: new Set(), checkedCount: 0 });
    expect(videoSpy).not.toHaveBeenCalled();

    expect(
      await resolveLikedYouTubeVideos(tabs, {
        playlistFetcher: async () => null,
        videoFetcher: async () => ({ kind: 'logged-out' }),
      }),
    ).toEqual({ status: 'logged-out', likedVideoIds: new Set(), checkedCount: 0 });

    expect(
      await resolveLikedYouTubeVideos(tabs, {
        playlistFetcher: async () => null,
        videoFetcher: async () => null,
      }),
    ).toEqual({ status: 'unavailable', likedVideoIds: new Set(), checkedCount: 0 });
  });

  it('keeps the shared youtube.com permission until BOTH duration sorting and liked closing are off', async () => {
    const request = vi.spyOn(fakeBrowser.permissions, 'request').mockResolvedValue(true as never);
    const remove = vi.spyOn(fakeBrowser.permissions, 'remove').mockResolvedValue(true as never);

    setSortYouTubeByDuration(true);
    await vi.waitFor(async () => {
      expect((await readSettings()).sortYouTubeByDuration).toBe(true);
    });
    setCloseLikedYouTube(true);
    expect(request).toHaveBeenCalledWith({ origins: [YOUTUBE_ORIGIN] });
    await vi.waitFor(async () => {
      expect((await readSettings()).closeLikedYouTube).toBe(true);
    });

    // Disabling duration sort clears duration cache but MUST NOT revoke permission while liked closing is ON.
    await mergeYouTubeDurations({ KeepPerm001: { seconds: 120, fetchedAt: NOW } }, NOW);
    setSortYouTubeByDuration(false);
    await vi.waitFor(async () => {
      expect((await readSettings()).sortYouTubeByDuration).toBe(false);
      expect(await readYouTubeDurations()).toEqual({});
    });
    expect(remove).not.toHaveBeenCalled();
    expect(youTubeGranted.value).toBe(true);

    // Disabling the second YouTube toggle revokes the permission.
    setCloseLikedYouTube(false);
    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledWith({ origins: [YOUTUBE_ORIGIN] });
    });
    expect((await readSettings()).closeLikedYouTube).toBe(false);
    expect(youTubeGranted.value).toBe(false);
  });

  it('closes liked tabs in 1 click from Declutter, arms Undo toast, and handles status/cancel states', async () => {
    const tabs = [
      makeTab(1, 'https://www.youtube.com/watch?v=LikedVid001'),
      makeTab(2, 'https://www.youtube.com/watch?v=ActiveVid01', { active: true }),
      makeTab(3, 'https://www.youtube.com/watch?v=UnlikedVid1', { discarded: true }),
    ];
    panelData.value = {
      ...makeSnapshot(tabs, false),
      settings: { ...DEFAULT_SETTINGS, closeLikedYouTube: true, closeLikedYouTubeActive: false },
    };
    expect(eligibleLikedTabs.value.map((t) => t.id)).toEqual([1, 3]);

    const closeSpy = vi.fn(async (closing: readonly TabInfo[]) =>
      closing.map((t) => ({
        id: `a-${t.id}`,
        url: t.url,
        title: t.title,
        closedAt: NOW,
        windowId: t.windowId,
        reason: 'manual' as const,
      })),
    );

    await closeLikedYouTubeNow({
      resolveLiked: async () => ({
        status: 'ok',
        likedVideoIds: new Set(['LikedVid001', 'ActiveVid01']),
        checkedCount: 2,
      }),
      close: closeSpy as unknown as typeof closeTabs,
      now: () => NOW,
    });
    expect(closeSpy).toHaveBeenCalledWith([tabs[0]], NOW);
    expect(lastClose.value?.entries).toHaveLength(1);
    expect(likedYouTubeStatus.value).toBeNull();

    // Non-toast feedback states: none, logged-out, unavailable.
    await closeLikedYouTubeNow({
      resolveLiked: async () => ({ status: 'ok', likedVideoIds: new Set(), checkedCount: 2 }),
    });
    expect(likedYouTubeStatus.value).toBe('none');

    await closeLikedYouTubeNow({
      resolveLiked: async () => ({
        status: 'logged-out',
        likedVideoIds: new Set(),
        checkedCount: 0,
      }),
    });
    expect(likedYouTubeStatus.value).toBe('logged-out');

    await closeLikedYouTubeNow({
      resolveLiked: async () => ({
        status: 'unavailable',
        likedVideoIds: new Set(),
        checkedCount: 0,
      }),
    });
    expect(likedYouTubeStatus.value).toBe('unavailable');

    // Cancellation clears working state without setting an error status.
    let signalSeen: AbortSignal | undefined;
    const pending = closeLikedYouTubeNow({
      resolveLiked: async (_t, opts) => {
        signalSeen = opts?.signal;
        return new Promise((resolve) => {
          opts?.signal?.addEventListener('abort', () => {
            resolve({ status: 'unavailable', likedVideoIds: new Set(), checkedCount: 0 });
          });
        });
      },
    });
    expect(likedYouTubeWorking.value).toBe(true);
    cancelLikedYouTubeClose();
    await pending;
    expect(signalSeen?.aborted).toBe(true);
    expect(likedYouTubeWorking.value).toBe(false);
    expect(likedYouTubeStatus.value).toBeNull();
  });

  it('autopilot closes liked YouTube tabs periodically with 15-min cooldown, active/keeps/protected guardrails, and archives them', async () => {
    const keptUrl = 'https://www.youtube.com/watch?v=KeptLiked01';
    await saveSettings({
      ...DEFAULT_SETTINGS,
      autoDeclutter: true,
      closeLikedYouTube: true,
      closeLikedYouTubeActive: false,
    });
    await keepsItem.setValue({ [keepKey(keptUrl)]: null });
    await protectedDomainsItem.setValue(['music.youtube.com']);

    const openTabs = [
      makeTab(1, 'https://www.youtube.com/watch?v=AutoLiked01', { index: 0 }),
      makeTab(2, 'https://www.youtube.com/watch?v=ActiveLike1', { index: 1, active: true }),
      makeTab(3, keptUrl, { index: 2 }),
      makeTab(4, 'https://music.youtube.com/watch?v=ProtLiked01', { index: 3 }),
      makeTab(
        5,
        'chrome-extension://bbomjaikkcabgmfaomdichgcodnaeecf/suspend.html?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DSuspLiked01',
        { index: 4 },
      ),
    ];
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue(openTabs as never);
    const removeSpy = vi.spyOn(fakeBrowser.tabs, 'remove').mockResolvedValue(undefined as never);
    vi.spyOn(fakeBrowser.windows, 'getLastFocused').mockResolvedValue({ id: 1 } as never);
    vi.spyOn(fakeBrowser.permissions, 'contains').mockResolvedValue(true as never);

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        '{"LOGGED_IN":true,"items":[' +
        '{"playlistVideoRenderer":{"videoId":"AutoLiked01"}},' +
        '{"playlistVideoRenderer":{"videoId":"ActiveLike1"}},' +
        '{"playlistVideoRenderer":{"videoId":"KeptLiked01"}},' +
        '{"playlistVideoRenderer":{"videoId":"ProtLiked01"}},' +
        '{"playlistVideoRenderer":{"videoId":"SuspLiked01"}}]}',
    });
    vi.stubGlobal('fetch', fetchSpy);

    let clock = NOW;
    const autopilot = registerAutopilot({ now: () => clock });
    const first = await autopilot.run();

    // Only tabs 1 and 5 (non-active, non-kept, non-protected) were closed and archived.
    expect(first.closedTabs).toBe(2);
    expect(removeSpy).toHaveBeenCalledWith([1, 5]);
    expect(await archiveItem.getValue()).toHaveLength(2);
    expect(await ytLikedCheckedAtItem.getValue()).toBe(NOW);

    // Within the 15-minute cooldown window, a second sweep makes zero YouTube network calls.
    fetchSpy.mockClear();
    removeSpy.mockClear();
    clock = NOW + 5 * 60_000;
    const second = await autopilot.run();
    expect(second.closedTabs).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();

    // After 15 minutes and with closeLikedYouTubeActive=true, active tab 2 is eligible too.
    await saveSettings({
      ...DEFAULT_SETTINGS,
      autoDeclutter: true,
      closeLikedYouTube: true,
      closeLikedYouTubeActive: true,
    });
    clock = NOW + 16 * 60_000;
    const third = await autopilot.run();
    expect(third.closedTabs).toBe(3);
    expect(removeSpy).toHaveBeenCalledWith([1, 2, 5]);
    vi.unstubAllGlobals();
  });
});
