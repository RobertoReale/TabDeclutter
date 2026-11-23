import { describe, expect, it } from 'vitest';

import type { ScoredTab } from '../../src/core/scoring';
import { DAY, HOUR } from '../../src/core/time';
import { DEFAULT_SETTINGS, NO_GROUP_ID, type TabInfo } from '../../src/core/types';
import { isSafeToAutoClose } from '../../src/entrypoints/background/autopilot';
import type { BrowserTab } from '../../src/platform/tabs';
import {
  organizeWindows,
  undoOrganizeWindows,
  ungroupAllOpenTabs,
  type WindowsOrganizeApi,
} from '../../src/platform/windows';

function fakeApi(initialTabs: BrowserTab[]) {
  const tabs = initialTabs.map((t) => ({ ...t }));
  const moves: { tabId: number; windowId?: number; index: number }[] = [];
  const ungrouped: number[] = [];
  let queryCalls = 0;
  let nextWindowId = 10;

  const api: WindowsOrganizeApi = {
    tabs: {
      query: async () => {
        queryCalls += 1;
        return tabs.map((t) => ({ ...t }));
      },
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

  return { api, tabs, moves, ungrouped, getQueryCalls: () => queryCalls };
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

  it('never moves browser-internal pages or hijacks their window in split-windows, while keeping Tiny Suspender web tabs movable', async () => {
    const { api, moves, tabs } = fakeApi([
      {
        id: 1,
        windowId: 1,
        index: 0,
        url: 'chrome://extensions/',
        title: 'Extensions',
        active: true,
      },
      {
        id: 2,
        windowId: 2,
        index: 0,
        url: 'chrome-extension://bbomjaikkcabgmfaomdichgcodnaeecf/suspend.html?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D1',
        title: 'Corrado Augias 1 - YouTube',
      },
      {
        id: 3,
        windowId: 2,
        index: 1,
        url: 'https://www.youtube.com/watch?v=2',
        title: 'Corrado Augias 2 - YouTube',
      },
      { id: 4, windowId: 2, index: 2, url: 'https://github.com/a', title: 'GitHub A' },
      { id: 5, windowId: 2, index: 3, url: 'https://github.com/b', title: 'GitHub B' },
    ]);

    await organizeWindows({
      windowMode: 'split-windows',
      clusterMode: 'site',
      useTabGroups: false,
      focusedWindowId: 1,
      api,
    });

    // `chrome://extensions/` stays untouched in window 1, and no topic bucket hijacks window 1.
    expect(moves.some((m) => m.tabId === 1)).toBe(false);
    expect(tabs.filter((t) => t.windowId === 1).map((t) => t.id)).toEqual([1]);
    // Both YouTube tabs (including the Tiny Suspender one) stay grouped together in one window.
    expect(tabs.find((t) => t.id === 2)?.windowId).toBe(tabs.find((t) => t.id === 3)?.windowId);
    expect(tabs.find((t) => t.id === 4)?.windowId).toBe(tabs.find((t) => t.id === 5)?.windowId);
    expect(tabs.find((t) => t.id === 2)?.windowId).not.toBe(tabs.find((t) => t.id === 4)?.windowId);
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

  it('applies a precomputed AI topic proposal while still protecting pinned, blank, loading and OAuth tabs', async () => {
    const { api, moves, tabs } = fakeApi([
      {
        id: 1,
        windowId: 1,
        index: 0,
        url: 'https://arxiv.org/abs/1',
        title: 'Linear algebra notes',
      },
      {
        id: 2,
        windowId: 2,
        index: 0,
        url: 'https://youtube.com/watch?v=math',
        title: 'Eigenvalues lecture',
      },
      { id: 3, windowId: 1, index: 1, url: 'https://booking.com/rome', title: 'Hotels in Rome' },
      {
        id: 4,
        windowId: 2,
        index: 1,
        url: 'https://trenitalia.com/tickets',
        title: 'Trains to Rome',
      },
      { id: 5, windowId: 3, index: 0, url: 'chrome://newtab/', title: 'New Tab' },
      {
        id: 6,
        windowId: 4,
        index: 0,
        url: 'https://accounts.google.com/o/oauth2/auth',
        title: 'Sign in',
      },
      {
        id: 7,
        windowId: 1,
        index: 2,
        url: 'https://mail.google.com/',
        title: 'Gmail',
        pinned: true,
      },
    ]);

    await organizeWindows({
      windowMode: 'split-windows',
      clusterMode: 'topic',
      useTabGroups: false,
      focusedWindowId: 1,
      proposal: {
        mode: 'topic',
        groups: [
          { key: 'math', title: 'Math', color: 'blue', windowId: 1, tabIds: [1, 2, 5, 7] },
          { key: 'trip', title: 'Rome Trip', color: 'green', windowId: 1, tabIds: [3, 4, 6] },
        ],
        ungrouped: [],
      },
      api,
    });

    // AI cross-domain clusters are placed together in dedicated windows
    expect(tabs.find((t) => t.id === 1)?.windowId).toBe(tabs.find((t) => t.id === 2)?.windowId);
    expect(tabs.find((t) => t.id === 3)?.windowId).toBe(tabs.find((t) => t.id === 4)?.windowId);
    expect(tabs.find((t) => t.id === 1)?.windowId).not.toBe(tabs.find((t) => t.id === 3)?.windowId);
    // Protected tabs (blank, OAuth, pinned) were never moved even though the proposal named them
    expect(moves.some((m) => m.tabId === 5 || m.tabId === 6 || m.tabId === 7)).toBe(false);
  });

  it('restores tabs and emptied windows back to their original layout with undoOrganizeWindows', async () => {
    const { api, tabs } = fakeApi([
      {
        id: 1,
        windowId: 1,
        index: 0,
        url: 'https://youtube.com/watch?v=1',
        title: 'Video 1',
        active: true,
      },
      { id: 2, windowId: 1, index: 1, url: 'https://github.com/repo/one', title: 'Repo 1' },
      {
        id: 3,
        windowId: 2,
        index: 0,
        url: 'https://youtube.com/watch?v=2',
        title: 'Video 2',
        active: true,
      },
      { id: 4, windowId: 2, index: 1, url: 'https://github.com/repo/two', title: 'Repo 2' },
    ]);

    const result = await organizeWindows({
      windowMode: 'merge-windows',
      clusterMode: 'site',
      useTabGroups: false,
      focusedWindowId: 1,
      api,
    });

    // All 4 tabs were consolidated into window 1 (window 2 is now empty/closed).
    expect(new Set(tabs.map((t) => t.windowId))).toEqual(new Set([1]));
    expect(result.undo).toBeDefined();

    const restoredCount = await undoOrganizeWindows(result.undo!, api);
    expect(restoredCount).toBe(4);

    // Tabs 1 & 2 are back in window 1 at indices 0 & 1; tabs 3 & 4 share a recreated second window.
    expect(tabs.find((t) => t.id === 1)).toMatchObject({ windowId: 1, index: 0 });
    expect(tabs.find((t) => t.id === 2)).toMatchObject({ windowId: 1, index: 1 });
    const win3 = tabs.find((t) => t.id === 3)?.windowId;
    expect(win3).not.toBe(1);
    expect(tabs.find((t) => t.id === 4)?.windowId).toBe(win3);
    expect(tabs.find((t) => t.id === 3)?.index).toBe(0);
    expect(tabs.find((t) => t.id === 4)?.index).toBe(1);
  });

  it('groups suspended and active tabs of the same site into the same window in split-windows mode', async () => {
    const suspend = (u: string) =>
      `chrome-extension://bbomjaikkcabgmfaomdichgcodnaeecf/suspend.html?url=${encodeURIComponent(u)}`;
    const { api, tabs } = fakeApi([
      {
        id: 1,
        windowId: 1,
        index: 0,
        url: suspend('https://www.youtube.com/watch?v=1'),
        title: 'Live #30 - YouTube',
      },
      {
        id: 2,
        windowId: 1,
        index: 1,
        url: suspend('https://gemini.google.com/app/aaa111222333'),
        title: 'Basi ortogonali - Google Gemini',
      },
      {
        id: 3,
        windowId: 1,
        index: 2,
        url: 'https://www.youtube.com/watch?v=2',
        title: 'Live #33 - YouTube',
      },
      {
        id: 4,
        windowId: 1,
        index: 3,
        url: 'https://gemini.google.com/app/bbb444555666',
        title: 'Spiegazione derivate - Google Gemini',
      },
    ]);

    const result = await organizeWindows({
      windowMode: 'split-windows',
      clusterMode: 'site',
      useTabGroups: false,
      focusedWindowId: 1,
      api,
    });

    expect(result.windowsCount).toBe(2);
    expect(tabs.find((t) => t.id === 1)?.windowId).toBe(tabs.find((t) => t.id === 3)?.windowId);
    expect(tabs.find((t) => t.id === 2)?.windowId).toBe(tabs.find((t) => t.id === 4)?.windowId);
    expect(tabs.find((t) => t.id === 1)?.windowId).not.toBe(tabs.find((t) => t.id === 2)?.windowId);
  });

  it('drops 1-tab ghost groups, clusters newly opened tabs, and evicts stale cached AI proposals', async () => {
    // 1. Valid cached AI proposal (covers >= 50% of tabs): group 1 shrank to 1 live tab (id 1) so
    //    it is dropped; group 2 (ids 2,3) survives; newly opened tabs (ids 4,5) on the same topic
    //    are clustered into their own window instead of dumped blindly into ungrouped.
    const partial = fakeApi([
      { id: 1, windowId: 1, index: 0, url: 'https://news.example/solo', title: 'Lonely news' },
      { id: 2, windowId: 1, index: 1, url: 'https://arxiv.org/abs/1', title: 'Linear algebra' },
      { id: 3, windowId: 1, index: 2, url: 'https://youtube.com/watch?v=m', title: 'Eigenvalues' },
      {
        id: 4,
        windowId: 1,
        index: 3,
        url: 'https://cooking.example/pasta-1',
        title: 'Pasta ricetta facile',
      },
      {
        id: 5,
        windowId: 1,
        index: 4,
        url: 'https://cooking.example/pasta-2',
        title: 'Pasta ricetta veloce',
      },
    ]);
    await organizeWindows({
      windowMode: 'split-windows',
      clusterMode: 'topic',
      useTabGroups: false,
      focusedWindowId: 1,
      proposal: {
        mode: 'topic',
        groups: [
          { key: 'news', title: 'News', color: 'red', windowId: 1, tabIds: [1, 999] },
          { key: 'math', title: 'Math', color: 'blue', windowId: 1, tabIds: [2, 3] },
        ],
        ungrouped: [],
      },
      api: partial.api,
    });
    expect(partial.tabs.find((t) => t.id === 2)?.windowId).toBe(
      partial.tabs.find((t) => t.id === 3)?.windowId,
    );
    expect(partial.tabs.find((t) => t.id === 4)?.windowId).toBe(
      partial.tabs.find((t) => t.id === 5)?.windowId,
    );
    expect(partial.tabs.find((t) => t.id === 2)?.windowId).not.toBe(
      partial.tabs.find((t) => t.id === 4)?.windowId,
    );
    // Tab 1 (shrunken 1-tab ghost group) landed in ungrouped, separate from Math and Pasta.
    expect(partial.tabs.find((t) => t.id === 1)?.windowId).not.toBe(
      partial.tabs.find((t) => t.id === 2)?.windowId,
    );

    // 2. Stale cached AI proposal (covers < 50% of tabs): discarded so fresh clustering runs on all tabs.
    const stale = fakeApi([
      {
        id: 1,
        windowId: 1,
        index: 0,
        url: 'https://example.org/rust-1',
        title: 'Rust async guide',
      },
      {
        id: 2,
        windowId: 1,
        index: 1,
        url: 'https://example.org/rust-2',
        title: 'Rust async tokio',
      },
      {
        id: 3,
        windowId: 1,
        index: 2,
        url: 'https://example.org/rust-3',
        title: 'Rust async streams',
      },
      {
        id: 4,
        windowId: 1,
        index: 3,
        url: 'https://example.org/pasta-1',
        title: 'Pasta ricetta forno',
      },
      {
        id: 5,
        windowId: 1,
        index: 4,
        url: 'https://example.org/pasta-2',
        title: 'Pasta ricetta veloce',
      },
      {
        id: 6,
        windowId: 1,
        index: 5,
        url: 'https://example.org/pasta-3',
        title: 'Pasta ricetta facile',
      },
    ]);
    await organizeWindows({
      windowMode: 'split-windows',
      clusterMode: 'topic',
      useTabGroups: false,
      focusedWindowId: 1,
      proposal: {
        mode: 'topic',
        // Only mentions 2 of 6 tabs (< 50%) — and groups unrelated tabs together.
        groups: [{ key: 'old', title: 'Old', color: 'grey', windowId: 1, tabIds: [1, 4] }],
        ungrouped: [],
      },
      api: stale.api,
    });
    expect(stale.tabs.find((t) => t.id === 1)?.windowId).toBe(
      stale.tabs.find((t) => t.id === 2)?.windowId,
    );
    expect(stale.tabs.find((t) => t.id === 1)?.windowId).toBe(
      stale.tabs.find((t) => t.id === 3)?.windowId,
    );
    expect(stale.tabs.find((t) => t.id === 4)?.windowId).toBe(
      stale.tabs.find((t) => t.id === 5)?.windowId,
    );
    expect(stale.tabs.find((t) => t.id === 1)?.windowId).not.toBe(
      stale.tabs.find((t) => t.id === 4)?.windowId,
    );
  });

  it('keeps movable tabs anchored after pinned tabs even when an unpinned New Tab is open', async () => {
    const { api, tabs } = fakeApi([
      { id: 1, windowId: 1, index: 0, url: 'https://youtube.com/watch?v=1', title: 'Video 1' },
      { id: 2, windowId: 1, index: 1, url: 'https://github.com/a', title: 'GitHub A' },
      { id: 3, windowId: 1, index: 2, url: 'https://github.com/b', title: 'GitHub B' },
      { id: 4, windowId: 1, index: 3, url: 'chrome://newtab/', title: 'New Tab' },
    ]);

    const first = await organizeWindows({
      windowMode: 'merge-windows',
      clusterMode: 'site',
      useTabGroups: false,
      focusedWindowId: 1,
      api,
    });
    expect(first.movedTabs).toBeGreaterThan(0);
    // Movable tabs start at index 0 (no pinned tabs), leaving the unpinned New Tab untouched.
    expect(tabs.find((t) => t.id === 2)?.index).toBe(0);
    expect(tabs.find((t) => t.id === 3)?.index).toBe(1);
    expect(tabs.find((t) => t.id === 1)?.index).toBe(2);

    // A second sweep sees the window is already sorted and makes zero moves.
    const second = await organizeWindows({
      windowMode: 'merge-windows',
      clusterMode: 'site',
      useTabGroups: false,
      focusedWindowId: 1,
      api,
    });
    expect(second.movedTabs).toBe(0);
  });

  it('organizes a real 30-tab Italian+English browsing session with Gemini Nano and incrementally places a single new tab into the right window', async () => {
    const { groupByAi } = await import('../../src/core/ai-grouping');
    const realSessionTabs: BrowserTab[] = [
      {
        id: 101,
        windowId: 1,
        index: 0,
        url: 'https://gemini.google.com/app/3dbbdad542c8de16',
        title: 'Prodotto scalare standard o generico? - Google Gemini',
      },
      {
        id: 102,
        windowId: 1,
        index: 1,
        url: 'https://gemini.google.com/notebook/e17e13be-20d2-4956-845c-f9ab5a60941e',
        title: 'Google Gemini',
      },
      {
        id: 103,
        windowId: 1,
        index: 2,
        url: 'https://gemini.google.com/app/5addf5db49a9ba71',
        title: "Calcolo del coefficiente m dell'asintoto obliquo - Google Gemini",
      },
      {
        id: 104,
        windowId: 1,
        index: 3,
        url: 'https://gemini.google.com/app/c76bcfca86bc2f89',
        title: 'Preparazione esercizi di derivate - Google Gemini',
      },
      {
        id: 105,
        windowId: 1,
        index: 4,
        url: 'https://www.youtube.com/watch?v=5oJ0Rhdq9oA',
        title: 'calcolo integrali - YouTube',
      },
      {
        id: 106,
        windowId: 2,
        index: 0,
        url: 'https://www.youtube.com/watch?v=1',
        title:
          'Lectio magistralis sulla laicità "Stato e Chiesa cattolica..." - CORRADO AUGIAS (prima parte) - YouTube',
      },
      {
        id: 107,
        windowId: 2,
        index: 1,
        url: 'https://www.youtube.com/watch?v=2',
        title:
          'Lectio magistralis sulla laicità "Stato e Chiesa cattolica..." - CORRADO AUGIAS (seconda parte) - YouTube',
      },
      {
        id: 108,
        windowId: 2,
        index: 2,
        url: 'https://www.youtube.com/watch?v=3',
        title: 'Lectio magistralis. Il grande romanzo dei Vangeli. Corrado Augias - YouTube',
      },
      {
        id: 109,
        windowId: 2,
        index: 3,
        url: 'https://www.youtube.com/watch?v=4',
        title: "L'intervista a Corrado Augias su islamismo, cristianesimo, ebraismo - YouTube",
      },
      {
        id: 110,
        windowId: 2,
        index: 4,
        url: 'https://www.youtube.com/watch?v=5',
        title: 'Corrado Augias: Breviario per un confuso presente (Einaudi) - YouTube',
      },
      {
        id: 111,
        windowId: 2,
        index: 5,
        url: 'https://www.youtube.com/watch?v=zD_D1kHBW8k',
        title: 'Corraudo Augias: I segreti del Vaticano - LaFeltrinelli - YouTube',
      },
      {
        id: 112,
        windowId: 2,
        index: 6,
        url: 'https://www.youtube.com/results?search_query=augias+i+segreti+del+vaticano',
        title: 'augias i segreti del vaticano - YouTube',
      },
      {
        id: 113,
        windowId: 3,
        index: 0,
        url: 'https://www.youtube.com/watch?v=15',
        title: 'The tragedy that always happens when you buy a Stratocaster. - YouTube',
      },
      {
        id: 114,
        windowId: 3,
        index: 1,
        url: 'https://www.youtube.com/watch?v=rj-YurbfhRE',
        title: 'You can play this Hendrix riff FOREVER and not get bored - YouTube',
      },
      {
        id: 115,
        windowId: 4,
        index: 0,
        url: 'https://www.youtube.com/watch?v=16',
        title: 'Live #33 - Cold war 2.0 calling? Con Alberto Forchielli - YouTube',
      },
      {
        id: 116,
        windowId: 4,
        index: 1,
        url: 'https://www.youtube.com/watch?v=17',
        title: 'Live #30 - Anti-storia degli Italiani. Con Michele Boldrin. - YouTube',
      },
    ];

    const { api, tabs } = fakeApi(realSessionTabs);
    const asInfos: TabInfo[] = realSessionTabs.map((t, index) => ({
      id: index + 1,
      windowId: 1,
      index,
      url: t.url ?? '',
      title: t.title ?? '',
      pinned: false,
      audible: false,
      active: false,
      discarded: false,
      hidden: false,
      groupId: NO_GROUP_ID,
      incognito: false,
    }));

    // Simulate real Gemini Nano output with omitted `},{` between groups and a final `"Other"`.
    const aiResult = await groupByAi(asInfos, {
      prompt: async () =>
        '```json\n{"groups":[{"name":"Mathematics & Calculus","tabIds":[1,2,3,4,5],"name":"Corrado Augias Lectures","tabIds":[6,7,8,9,10,11,12],"name":"Guitar","tabIds":[13,14],"name":"Politics & Economics","tabIds":[15,16],"name":"Other","tabIds":[]}]}\n```',
    });
    expect(aiResult.source).toBe('ai');
    expect(aiResult.proposal.groups.map((g) => g.title)).toEqual([
      'Corrado Augias Lectures',
      'Mathematics & Calculus',
      'Guitar',
      'Politics & Economics',
    ]);

    const realProposal = {
      ...aiResult.proposal,
      groups: aiResult.proposal.groups.map((g) => ({
        ...g,
        tabIds: g.tabIds.map((shortId) => realSessionTabs[shortId - 1]!.id!),
      })),
      ungrouped: aiResult.proposal.ungrouped.map((shortId) => realSessionTabs[shortId - 1]!.id!),
    };

    await organizeWindows({
      windowMode: 'split-windows',
      clusterMode: 'topic',
      useTabGroups: false,
      focusedWindowId: 1,
      proposal: realProposal,
      api,
    });

    const mathWindow = tabs.find((t) => t.id === 101)?.windowId;
    const augiasWindow = tabs.find((t) => t.id === 106)?.windowId;
    const guitarWindow = tabs.find((t) => t.id === 113)?.windowId;
    const politicsWindow = tabs.find((t) => t.id === 115)?.windowId;

    // All 5 math tabs (4 Gemini + 1 YouTube `calcolo integrali`) share the Math window.
    for (const id of [101, 102, 103, 104, 105]) {
      expect(tabs.find((t) => t.id === id)?.windowId).toBe(mathWindow);
    }
    // All 7 Corrado Augias tabs (including `Corraudo` typo and `?search_query=augias...`) share the Augias window.
    for (const id of [106, 107, 108, 109, 110, 111, 112]) {
      expect(tabs.find((t) => t.id === id)?.windowId).toBe(augiasWindow);
    }
    expect(new Set([mathWindow, augiasWindow, guitarWindow, politicsWindow]).size).toBe(4);

    // Now the user opens ONE new Corrado Augias tab in window 1 while the existing AI proposal is cached:
    tabs.push({
      id: 199,
      windowId: 1,
      index: 5,
      url: 'https://www.youtube.com/watch?v=new-augias',
      title: 'Tra Cesare e Dio. Incontro con Corrado Augias - YouTube',
      groupId: NO_GROUP_ID,
    });

    await organizeWindows({
      windowMode: 'split-windows',
      clusterMode: 'topic',
      useTabGroups: false,
      focusedWindowId: 1,
      proposal: realProposal,
      api,
    });

    // The single new tab is incrementally matched and moved straight into the Corrado Augias window!
    expect(tabs.find((t) => t.id === 199)?.windowId).toBe(augiasWindow);
  });

  it('separates multi-tab ungrouped sites (e.g. YouTube, Gemini) from unrelated singletons (e.g. GitHub) in topic split-windows mode', async () => {
    const { api, tabs } = fakeApi([
      {
        id: 1,
        windowId: 1,
        index: 0,
        url: 'https://www.youtube.com/watch?v=a1',
        title: 'Lectio magistralis - Corrado Augias - YouTube',
      },
      {
        id: 2,
        windowId: 1,
        index: 1,
        url: 'https://www.youtube.com/watch?v=a2',
        title: 'Tra Cesare e Dio - Corrado Augias - YouTube',
      },
      {
        id: 3,
        windowId: 1,
        index: 2,
        url: 'https://gemini.google.com/app/111122223333',
        title: 'Prodotto scalare standard - Google Gemini',
      },
      {
        id: 4,
        windowId: 1,
        index: 3,
        url: 'https://gemini.google.com/app/444455556666',
        title: 'Spiegazione rette tangenti - Google Gemini',
      },
      {
        id: 5,
        windowId: 1,
        index: 4,
        url: 'https://github.com/RobertoReale/TabDeclutter',
        title: 'RobertoReale/TabDeclutter - GitHub',
      },
      {
        id: 6,
        windowId: 1,
        index: 5,
        url: 'https://www.youtube.com/watch?v=yt1',
        title: 'The tragedy that always happens when you buy a Stratocaster - YouTube',
      },
      {
        id: 7,
        windowId: 1,
        index: 6,
        url: 'https://www.youtube.com/watch?v=yt2',
        title: 'FRANCESCO COSTA morning podcast - YouTube',
      },
      {
        id: 8,
        windowId: 1,
        index: 7,
        url: 'https://www.youtube.com/watch?v=yt3',
        title: 'CALENDARIO campionato serie A - YouTube',
      },
    ]);

    const result = await organizeWindows({
      windowMode: 'split-windows',
      clusterMode: 'topic',
      useTabGroups: false,
      focusedWindowId: 1,
      api,
    });

    const augiasWin = tabs.find((t) => t.id === 1)?.windowId;
    const geminiWin = tabs.find((t) => t.id === 3)?.windowId;
    const githubWin = tabs.find((t) => t.id === 5)?.windowId;
    const youtubeMiscWin = tabs.find((t) => t.id === 6)?.windowId;

    expect(result.windowsCount).toBe(4);
    expect(tabs.find((t) => t.id === 2)?.windowId).toBe(augiasWin);
    expect(tabs.find((t) => t.id === 4)?.windowId).toBe(geminiWin);
    expect(tabs.find((t) => t.id === 7)?.windowId).toBe(youtubeMiscWin);
    expect(tabs.find((t) => t.id === 8)?.windowId).toBe(youtubeMiscWin);
    // Gemini and GitHub must never be mixed into the miscellaneous YouTube window.
    expect(new Set([augiasWin, geminiWin, githubWin, youtubeMiscWin]).size).toBe(4);
  });

  it('queries browser tabs only once when no tabs are grouped and skips already-positioned leading tabs', async () => {
    const { api, moves, getQueryCalls } = fakeApi([
      {
        id: 1,
        windowId: 1,
        index: 0,
        url: 'https://github.com/org/repo1',
        title: 'Repo 1',
        groupId: NO_GROUP_ID,
      },
      {
        id: 2,
        windowId: 1,
        index: 1,
        url: 'https://github.com/org/repo2',
        title: 'Repo 2',
        groupId: NO_GROUP_ID,
      },
      {
        id: 3,
        windowId: 2,
        index: 0,
        url: 'https://github.com/org/repo3',
        title: 'Repo 3',
        groupId: NO_GROUP_ID,
      },
    ]);

    const result = await organizeWindows({
      windowMode: 'merge-windows',
      clusterMode: 'site',
      useTabGroups: false,
      focusedWindowId: 1,
      api,
    });

    // No tabs had a groupId, so organizeWindows must not re-query after skipping ungroup.
    expect(getQueryCalls()).toBe(1);
    // Tabs 1 and 2 are already at indices 0 and 1 in window 1, so only tab 3 needs to move.
    expect(moves).toEqual([{ tabId: 3, windowId: 1, index: 2 }]);
    expect(result.movedTabs).toBe(1);
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
        makeTab({
          url: 'chrome-extension://bbomjaikkcabgmfaomdichgcodnaeecf/suspend.html?url=http%3A%2F%2Flocalhost%3A3000%2F',
        }),
        makeScored(),
        DEFAULT_SETTINGS,
        staleMs,
      ),
    ).toBe(false);
    expect(
      isSafeToAutoClose(
        makeTab({
          url: 'chrome-extension://bbomjaikkcabgmfaomdichgcodnaeecf/suspend.html?url=https%3A%2F%2Fexample.com%2Farticle',
        }),
        makeScored({ idleMs: 8 * DAY, score: 80 }),
        DEFAULT_SETTINGS,
        staleMs,
      ),
    ).toBe(true);
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

  it('auto-closes read tabs in the review bucket once staleDays has elapsed, while never touching keep tabs', () => {
    // A normal read tab caps at 55 inactivity points (`bucket: 'review'`). Once idle >= staleDays
    // it is eligible for auto-close, while younger review tabs and all keep tabs stay untouched.
    expect(
      isSafeToAutoClose(
        makeTab({ url: 'https://www.youtube.com/watch?v=old' }),
        makeScored({ bucket: 'review', score: 55, idleMs: 8 * DAY }),
        DEFAULT_SETTINGS,
        staleMs,
      ),
    ).toBe(true);
    expect(
      isSafeToAutoClose(
        makeTab({ url: 'https://www.youtube.com/watch?v=recent' }),
        makeScored({ bucket: 'review', score: 45, idleMs: 2 * DAY }),
        DEFAULT_SETTINGS,
        staleMs,
      ),
    ).toBe(false);
    expect(
      isSafeToAutoClose(
        makeTab({ url: 'https://www.youtube.com/watch?v=kept' }),
        makeScored({ bucket: 'keep', score: 33, idleMs: 14 * DAY }),
        DEFAULT_SETTINGS,
        staleMs,
      ),
    ).toBe(false);
  });
});
