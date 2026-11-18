import { describe, expect, it } from 'vitest';

import { NO_GROUP_ID } from '../../src/core/types';
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
});
