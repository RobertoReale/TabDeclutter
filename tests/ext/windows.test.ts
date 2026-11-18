import { describe, expect, it } from 'vitest';

import type { ScoredTab } from '../../src/core/scoring';
import { DAY, HOUR } from '../../src/core/time';
import { DEFAULT_SETTINGS, NO_GROUP_ID, type TabInfo } from '../../src/core/types';
import { isSafeToAutoClose } from '../../src/entrypoints/background/autopilot';
import type { BrowserTab } from '../../src/platform/tabs';
import {
  organizeWindows,
  ungroupAllOpenTabs,
  type WindowsOrganizeApi,
} from '../../src/platform/windows';

function fakeApi(initialTabs: BrowserTab[]) {
  const tabs = initialTabs.map((t) => ({ ...t }));
  const moves: { tabId: number; windowId?: number; index: number }[] = [];
  const ungrouped: number[] = [];
  let nextWindowId = 10;

  const api: WindowsOrganizeApi = {
    tabs: {
      query: async () => tabs.map((t) => ({ ...t })),
      move: async (tabId, props) => {
        moves.push({ tabId, ...props });
        const found = tabs.find((t) => t.id === tabId);
        if (found !== undefined) {
          if (props.windowId !== undefined) found.windowId = props.windowId;
          found.index = props.index;
        }
      },
      ungroup: async (ids) => {
        for (const id of ids) {
          ungrouped.push(id);
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
            found.windowId = windowId;
            found.index = 0;
          }
        }
        return { id: windowId };
      },
    },
  };

  return { api, tabs, moves, ungrouped };
}

describe('platform/windows', () => {
  it('ungroups all grouped tabs when useTabGroups is false', async () => {
    const { api, ungrouped } = fakeApi([
      { id: 1, windowId: 1, index: 0, url: 'https://github.com/a', title: 'A', groupId: 5 },
      {
        id: 2,
        windowId: 1,
        index: 1,
        url: 'https://github.com/b',
        title: 'B',
        groupId: NO_GROUP_ID,
      },
    ]);

    const count = await ungroupAllOpenTabs(api);
    expect(count).toBe(1);
    expect(ungrouped).toEqual([1]);
  });

  it('merges scattered windows into one sorted window in merge-windows mode', async () => {
    const { api, tabs } = fakeApi([
      { id: 1, windowId: 1, index: 0, url: 'https://youtube.com/watch?v=1', title: 'Video 1' },
      { id: 2, windowId: 2, index: 0, url: 'https://github.com/repo/one', title: 'Repo 1' },
      { id: 3, windowId: 3, index: 0, url: 'https://youtube.com/watch?v=2', title: 'Video 2' },
      { id: 4, windowId: 4, index: 0, url: 'https://github.com/repo/two', title: 'Repo 2' },
    ]);

    const result = await organizeWindows({
      windowMode: 'merge-windows',
      clusterMode: 'site',
      useTabGroups: false,
      focusedWindowId: 1,
      api,
    });

    expect(result.windowsCount).toBe(1);
    expect(result.movedTabs).toBeGreaterThan(0);
    // Every tab is now in window 1
    expect(new Set(tabs.map((t) => t.windowId))).toEqual(new Set([1]));
  });

  it('splits clusters into separate thematic windows in split-windows mode', async () => {
    const { api, tabs } = fakeApi([
      { id: 1, windowId: 1, index: 0, url: 'https://github.com/a', title: 'GitHub A' },
      { id: 2, windowId: 1, index: 1, url: 'https://youtube.com/1', title: 'YouTube 1' },
      { id: 3, windowId: 2, index: 0, url: 'https://github.com/b', title: 'GitHub B' },
      { id: 4, windowId: 2, index: 1, url: 'https://youtube.com/2', title: 'YouTube 2' },
    ]);

    const result = await organizeWindows({
      windowMode: 'split-windows',
      clusterMode: 'site',
      useTabGroups: false,
      focusedWindowId: 1,
      api,
    });

    expect(result.windowsCount).toBe(2);
    // GitHub tabs share one window, YouTube tabs share the other
    const githubWin = tabs.find((t) => t.id === 1)?.windowId;
    const youtubeWin = tabs.find((t) => t.id === 2)?.windowId;
    expect(tabs.find((t) => t.id === 3)?.windowId).toBe(githubWin);
    expect(tabs.find((t) => t.id === 4)?.windowId).toBe(youtubeWin);
    expect(githubWin).not.toBe(youtubeWin);
  });

  it('never moves New Tab pages, loading tabs, or OAuth login popups while the user is working', async () => {
    const { api, moves, tabs } = fakeApi([
      { id: 1, windowId: 1, index: 0, url: 'https://github.com/a', title: 'GitHub A' },
      { id: 2, windowId: 1, index: 1, url: 'https://github.com/b', title: 'GitHub B' },
      { id: 3, windowId: 2, index: 0, url: 'chrome://newtab/', title: 'New Tab' },
      {
        id: 4,
        windowId: 3,
        index: 0,
        url: 'https://accounts.google.com/o/oauth2/auth',
        title: 'Sign in',
      },
      { id: 5, windowId: 4, index: 0, url: '', title: 'Loading...' },
    ]);

    await organizeWindows({
      windowMode: 'merge-windows',
      clusterMode: 'site',
      useTabGroups: false,
      focusedWindowId: 1,
      api,
    });

    // None of the blank, OAuth, or loading tabs were moved out of their windows
    expect(moves.some((m) => m.tabId === 3 || m.tabId === 4 || m.tabId === 5)).toBe(false);
    expect(tabs.find((t) => t.id === 3)?.windowId).toBe(2);
    expect(tabs.find((t) => t.id === 4)?.windowId).toBe(3);
    expect(tabs.find((t) => t.id === 5)?.windowId).toBe(4);
  });

  it('never steals the active tab of the focused window into another window in split-windows mode', async () => {
    const { api, tabs } = fakeApi([
      { id: 1, windowId: 1, index: 0, url: 'https://github.com/a', title: 'GitHub A' },
      { id: 2, windowId: 1, index: 1, url: 'https://github.com/b', title: 'GitHub B' },
      {
        id: 3,
        windowId: 1,
        index: 2,
        url: 'https://youtube.com/1',
        title: 'YouTube Active',
        active: true,
      },
      { id: 4, windowId: 2, index: 0, url: 'https://youtube.com/2', title: 'YouTube 2' },
    ]);

    await organizeWindows({
      windowMode: 'split-windows',
      clusterMode: 'site',
      useTabGroups: false,
      focusedWindowId: 1,
      api,
    });

    // Tab 3 is active in focused window 1, so it must remain in window 1
    expect(tabs.find((t) => t.id === 3)?.windowId).toBe(1);
  });
});

function makeTab(overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id: 1,
    windowId: 1,
    index: 0,
    url: 'https://example.com/page',
    title: 'Example',
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

function makeScored(overrides: Partial<ScoredTab> = {}): ScoredTab {
  return {
    tabId: 1,
    windowId: 1,
    pageType: 'content',
    idleMs: 10 * DAY,
    score: 80,
    bucket: 'close',
    primaryReason: 'stale',
    reasons: [{ code: 'stale', points: 55, idleMs: 10 * DAY }],
    multiplier: 1,
    ...overrides,
  };
}

describe('autopilot safety guardrails (isSafeToAutoClose)', () => {
  const staleMs = 7 * DAY;

  it('never auto-closes active, pinned, audible, or loading tabs', () => {
    expect(
      isSafeToAutoClose(makeTab({ active: true }), makeScored(), DEFAULT_SETTINGS, staleMs),
    ).toBe(false);
    expect(
      isSafeToAutoClose(makeTab({ pinned: true }), makeScored(), DEFAULT_SETTINGS, staleMs),
    ).toBe(false);
    expect(
      isSafeToAutoClose(makeTab({ audible: true }), makeScored(), DEFAULT_SETTINGS, staleMs),
    ).toBe(false);
    expect(isSafeToAutoClose(makeTab({ url: '' }), makeScored(), DEFAULT_SETTINGS, staleMs)).toBe(
      false,
    );
  });

  it('never auto-closes local files, extension document viewers, OAuth pages, or localhost dev servers', () => {
    expect(
      isSafeToAutoClose(
        makeTab({ url: 'file:///C:/Users/Admin/Documents/report.pdf' }),
        makeScored(),
        DEFAULT_SETTINGS,
        staleMs,
      ),
    ).toBe(false);
    expect(
      isSafeToAutoClose(
        makeTab({ url: 'chrome-extension://bbomjaikkcabgmfaomdich/views/app.html' }),
        makeScored(),
        DEFAULT_SETTINGS,
        staleMs,
      ),
    ).toBe(false);
    expect(
      isSafeToAutoClose(
        makeTab({ url: 'https://accounts.google.com/signin' }),
        makeScored({ pageType: 'auth' }),
        DEFAULT_SETTINGS,
        staleMs,
      ),
    ).toBe(false);
    expect(
      isSafeToAutoClose(
        makeTab({ url: 'http://localhost:3000/dashboard' }),
        makeScored(),
        DEFAULT_SETTINGS,
        staleMs,
      ),
    ).toBe(false);
    expect(
      isSafeToAutoClose(
        makeTab({ url: 'http://127.0.0.1:8080/' }),
        makeScored(),
        DEFAULT_SETTINGS,
        staleMs,
      ),
    ).toBe(false);
  });

  it('never auto-closes a content or search tab before staleDays has actually elapsed', () => {
    // Only 2 days old when staleDays is 7 days: even if score >= 70, autopilot must not touch it
    expect(
      isSafeToAutoClose(
        makeTab({ url: 'https://www.youtube.com/watch?v=123' }),
        makeScored({ idleMs: 2 * DAY, score: 75 }),
        DEFAULT_SETTINGS,
        staleMs,
      ),
    ).toBe(false);

    // Once 7 days of inactivity have genuinely elapsed, it is safe to auto-close
    expect(
      isSafeToAutoClose(
        makeTab({ url: 'https://www.youtube.com/watch?v=123' }),
        makeScored({ idleMs: 8 * DAY, score: 75 }),
        DEFAULT_SETTINGS,
        staleMs,
      ),
    ).toBe(true);
  });

  it('allows auto-closing abandoned blank tabs idle for over 1 hour', () => {
    expect(
      isSafeToAutoClose(
        makeTab({ url: 'chrome://newtab/' }),
        makeScored({ pageType: 'blank', primaryReason: 'blank', idleMs: 2 * HOUR }),
        DEFAULT_SETTINGS,
        staleMs,
      ),
    ).toBe(true);
  });
});
