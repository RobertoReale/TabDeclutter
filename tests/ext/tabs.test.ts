import { describe, expect, it, vi } from 'vitest';

import { NO_GROUP_ID } from '../../src/core/types';
import type { BrowserTab, TabsApi } from '../../src/platform/tabs';
import { activateTab, asTabInfos, NO_WINDOW, queryTabs } from '../../src/platform/tabs';

/**
 * The boundary between the browser's tabs and the `TabInfo` the rules reason about
 * (invariant 4), and the "Vai" action of PLAN.md §4.3.
 *
 * The API is injected, so what we call and in which order is checked on an object of our
 * own. The file still belongs to the extension project rather than the unit one: since
 * M3.1 `platform/tabs.ts` writes the archive, and importing `platform/storage.ts` defines
 * the storage items, which read themselves as soon as they exist. The actions those
 * writes belong to are in `actions.test.ts`.
 */

function fakeApi(found: readonly BrowserTab[] = []) {
  const calls: string[] = [];
  const spies = {
    query: vi.fn((query: Record<string, unknown>) => {
      calls.push(`query ${JSON.stringify(query)}`);
      return Promise.resolve([...found]);
    }),
    updateTab: vi.fn((tabId: number, properties: { active: boolean }) => {
      calls.push(`tab ${String(tabId)} active=${String(properties.active)}`);
      return Promise.resolve(undefined);
    }),
    updateWindow: vi.fn((windowId: number, properties: { focused: boolean }) => {
      calls.push(`window ${String(windowId)} focused=${String(properties.focused)}`);
      return Promise.resolve(undefined);
    }),
  };
  const api: TabsApi = {
    tabs: { query: spies.query, update: spies.updateTab },
    windows: { update: spies.updateWindow },
  };
  return { api, calls, ...spies };
}

describe('asTabInfos', () => {
  it('fills in everything the rules read, for a tab that arrived nearly empty', () => {
    expect(asTabInfos([{ id: 7 }])).toEqual([
      {
        id: 7,
        windowId: NO_WINDOW,
        index: 0,
        url: '',
        pendingUrl: undefined,
        title: '',
        favIconUrl: undefined,
        pinned: false,
        audible: false,
        active: false,
        discarded: false,
        hidden: false,
        groupId: NO_GROUP_ID,
        cookieStoreId: undefined,
        incognito: false,
        openerTabId: undefined,
        lastAccessed: undefined,
      },
    ]);
  });

  it('keeps the fields it was given', () => {
    const tab: BrowserTab = {
      id: 7,
      windowId: 2,
      index: 3,
      url: 'https://example.com/a',
      pendingUrl: 'https://example.com/b',
      title: 'A page',
      favIconUrl: 'https://example.com/icon.png',
      pinned: true,
      audible: true,
      active: true,
      discarded: true,
      groupId: 12,
      cookieStoreId: 'firefox-container-3',
      incognito: true,
      openerTabId: 4,
      lastAccessed: 1_700_000_000_000,
    };
    expect(asTabInfos([tab])).toEqual([{ ...tab, hidden: false }]);
  });

  it('leaves out a tab with no id: nothing can be done to it', () => {
    expect(asTabInfos([{ id: 1 }, {}, { id: 2 }]).map((tab) => tab.id)).toEqual([1, 2]);
  });

  /* PLAN.md §5.5: a tab another extension hid is not on screen, so it is nowhere. */
  it('leaves out a hidden tab', () => {
    expect(asTabInfos([{ id: 1, hidden: true }, { id: 2 }]).map((tab) => tab.id)).toEqual([2]);
  });

  it("keeps the browser's own order, which is what breaks ties in the list", () => {
    expect(asTabInfos([{ id: 5 }, { id: 2 }, { id: 9 }]).map((tab) => tab.id)).toEqual([5, 2, 9]);
  });
});

describe('queryTabs', () => {
  it('asks for every tab in one call and maps them', async () => {
    const fake = fakeApi([
      { id: 1, url: 'https://example.com/a' },
      { id: 2, hidden: true },
    ]);
    const tabs = await queryTabs(fake.api);

    expect(fake.query).toHaveBeenCalledTimes(1);
    expect(fake.query).toHaveBeenCalledWith({});
    expect(tabs.map((tab) => tab.id)).toEqual([1]);
  });
});

describe('activateTab', () => {
  it('activates the tab and then brings its window forward', async () => {
    const fake = fakeApi();
    await activateTab(7, 2, fake.api);

    // In this order: the window that comes forward is already showing the right page.
    expect(fake.calls).toEqual(['tab 7 active=true', 'window 2 focused=true']);
  });

  it('only activates a tab that belongs to no window', async () => {
    const fake = fakeApi();
    await activateTab(7, NO_WINDOW, fake.api);

    expect(fake.updateTab).toHaveBeenCalledWith(7, { active: true });
    expect(fake.updateWindow).not.toHaveBeenCalled();
  });

  it('rejects when the browser does, so the caller can log it', async () => {
    const fake = fakeApi();
    fake.updateTab.mockRejectedValueOnce(new Error('No tab with id: 7.'));

    await expect(activateTab(7, 2, fake.api)).rejects.toThrow('No tab with id: 7.');
    expect(fake.updateWindow).not.toHaveBeenCalled();
  });
});
