import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { keepKey } from '../../src/core/scoring';
import type { ArchivedTab, TabInfo } from '../../src/core/types';
import { DEFAULT_KEEP_MS, NO_GROUP_ID } from '../../src/core/types';
import type { Capabilities } from '../../src/platform/capabilities';
import type {
  ActionsApi,
  BrowserTab,
  BrowserTabGroup,
  ClosedSession,
} from '../../src/platform/tabs';
import {
  closeTabs,
  closeWindow,
  discardTab,
  keepTab,
  protectSite,
  restoreTabs,
} from '../../src/platform/tabs';
import {
  addToArchive,
  archiveItem,
  isExempt,
  keepsItem,
  protectedDomainsItem,
} from '../../src/platform/storage';

/**
 * The actions of PLAN.md §9 against the real storage, which is what `fakeBrowser` gives
 * us: the archive, the keeps, the protected sites and the guard's exemptions are read back
 * from storage after every action rather than asserted on a spy.
 *
 * The tab calls are an injected API instead. `fakeBrowser` implements none of
 * `tabs.discard`, `tabs.group`, `windows.remove`, `sessions.*` or `tabGroups.*`, and its
 * `tabs.create` drops the window and the index — the two things a restore depends on. So
 * the gaps are worked around in the test and not in the code (DECISIONS, M2.1), and the
 * failure each action has to survive (a tab already closed, a window that is gone, a group
 * the user deleted) is produced on purpose.
 */

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** A browser with native tab groups and `sessions`: Chrome, and Firefox 139+. */
const WITH_GROUPS: Capabilities = {
  sidePanel: true,
  sidebarAction: false,
  faviconApi: true,
  promptApi: false,
  tabGroups: true,
  containers: false,
  sessionTabValues: false,
  duplicateCommandDetection: true,
};

/** Invariant 10: Firefox before 139 has no tab groups at all. */
const WITHOUT_GROUPS: Capabilities = { ...WITH_GROUPS, tabGroups: false };

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function tab(id: number, overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id,
    windowId: 1,
    index: id,
    url: `https://example.com/${String(id)}`,
    title: `Tab ${String(id)}`,
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

function archived(overrides: Partial<ArchivedTab> = {}): ArchivedTab {
  return {
    id: 'e1',
    url: 'https://example.com/1',
    title: 'Tab 1',
    closedAt: NOW,
    reason: 'manual',
    windowId: 4,
    index: 7,
    ...overrides,
  };
}

interface FakeOptions {
  /** What `sessions.getRecentlyClosed` reports, newest first. */
  readonly closed?: readonly ClosedSession[];
  /** What `tabGroups.query` reports. */
  readonly groups?: readonly BrowserTabGroup[];
  /** A browser that does not grant `sessions`. */
  readonly noSessions?: boolean;
  /** A browser with no `tabGroups` namespace. */
  readonly noTabGroups?: boolean;
}

function fakeApi(options: FakeOptions = {}) {
  let nextTabId = 100;
  const calls: string[] = [];

  const create = vi.fn(
    (properties: { url: string; windowId?: number; index?: number; active: boolean }) => {
      calls.push(
        `create ${properties.url} w=${String(properties.windowId)} i=${String(properties.index)}`,
      );
      return Promise.resolve<BrowserTab>({
        id: nextTabId++,
        windowId: properties.windowId ?? 1,
        index: properties.index ?? 0,
        url: properties.url,
        active: properties.active,
      });
    },
  );
  const remove = vi.fn((tabIds: readonly number[]) => {
    calls.push(`remove ${tabIds.join(',')}`);
    return Promise.resolve(undefined);
  });
  const discard = vi.fn((tabId: number) => {
    calls.push(`discard ${String(tabId)}`);
    return Promise.resolve(undefined);
  });
  const group = vi.fn((options_: { tabIds: readonly number[]; groupId: number }) => {
    calls.push(`group ${options_.tabIds.join(',')} -> ${String(options_.groupId)}`);
    return Promise.resolve(undefined);
  });
  const removeWindow = vi.fn((windowId: number) => {
    calls.push(`close-window ${String(windowId)}`);
    return Promise.resolve(undefined);
  });
  const queryGroups = vi.fn((query: Record<string, unknown>) => {
    calls.push(`query-groups ${JSON.stringify(query)}`);
    return Promise.resolve([...(options.groups ?? [])]);
  });
  const getRecentlyClosed = vi.fn((filter: { maxResults: number }) => {
    calls.push(`recently-closed ${String(filter.maxResults)}`);
    return Promise.resolve([...(options.closed ?? [])]);
  });
  const restore = vi.fn((sessionId: string) => {
    calls.push(`restore ${sessionId}`);
    return Promise.resolve({ tab: { id: nextTabId++, windowId: 1, url: 'https://restored/' } });
  });

  const api: ActionsApi = {
    tabs: {
      query: vi.fn(() => Promise.resolve<BrowserTab[]>([])),
      update: vi.fn(() => Promise.resolve(undefined)),
      create,
      remove,
      discard,
      group,
    },
    windows: {
      update: vi.fn(() => Promise.resolve(undefined)),
      remove: removeWindow,
    },
    ...(options.noTabGroups === true ? {} : { tabGroups: { query: queryGroups } }),
    ...(options.noSessions === true ? {} : { sessions: { getRecentlyClosed, restore } }),
  };

  return {
    api,
    calls,
    create,
    remove,
    discard,
    group,
    removeWindow,
    queryGroups,
    getRecentlyClosed,
    restore,
  };
}

describe('closeTabs', () => {
  it('archives the batch and then removes it in one call', async () => {
    const fake = fakeApi();
    const entries = await closeTabs([tab(1), tab(2)], NOW, {
      api: fake.api,
      capabilities: WITHOUT_GROUPS,
    });

    expect(await archiveItem.getValue()).toEqual([...entries]);
    expect(fake.remove).toHaveBeenCalledTimes(1);
    expect(fake.remove).toHaveBeenCalledWith([1, 2]);
  });

  /* Invariant 3: a close that fails after the write is still a close the user can undo. */
  it('keeps the archive even when the removal fails outright', async () => {
    const fake = fakeApi();
    fake.remove.mockRejectedValue(new Error('No tab with id: 1.'));

    const entries = await closeTabs([tab(1)], NOW, {
      api: fake.api,
      capabilities: WITHOUT_GROUPS,
    });

    expect(entries).toHaveLength(1);
    expect((await archiveItem.getValue()).map((entry) => entry.url)).toEqual([
      'https://example.com/1',
    ]);
  });

  /* PLAN.md §8.6: a tab the user closed in the meantime must not take the others with it. */
  it('retries one by one when a tab is already closed', async () => {
    const fake = fakeApi();
    fake.remove.mockImplementation((tabIds: readonly number[]) =>
      tabIds.includes(404)
        ? Promise.reject(new Error('No tab with id: 404.'))
        : Promise.resolve(undefined),
    );

    await closeTabs([tab(1), tab(404), tab(2)], NOW, {
      api: fake.api,
      capabilities: WITHOUT_GROUPS,
    });

    expect(fake.remove.mock.calls.map((call) => call[0])).toEqual([[1, 404, 2], [1], [404], [2]]);
  });

  it('records the title of the group each tab was in', async () => {
    const fake = fakeApi({ groups: [{ id: 12, windowId: 1, title: 'Work' }] });

    await closeTabs([tab(1, { groupId: 12 }), tab(2)], NOW, {
      api: fake.api,
      capabilities: WITH_GROUPS,
    });

    expect((await archiveItem.getValue()).map((entry) => entry.groupTitle)).toEqual([
      'Work',
      undefined,
    ]);
  });

  it('asks for no group when no tab is in one', async () => {
    const fake = fakeApi({ groups: [{ id: 12, windowId: 1, title: 'Work' }] });

    await closeTabs([tab(1)], NOW, { api: fake.api, capabilities: WITH_GROUPS });

    expect(fake.queryGroups).not.toHaveBeenCalled();
  });

  /* Invariant 10: Firefox before 139 has no `tabGroups` to ask. */
  it('asks for no group where there are none', async () => {
    const fake = fakeApi({ noTabGroups: true });

    await closeTabs([tab(1, { groupId: 12 })], NOW, {
      api: fake.api,
      capabilities: WITHOUT_GROUPS,
    });

    expect((await archiveItem.getValue())[0]?.groupTitle).toBeUndefined();
  });

  it('records the reason and the tab kept instead, for a duplicate close', async () => {
    const fake = fakeApi();

    await closeTabs([tab(1)], NOW, {
      api: fake.api,
      capabilities: WITHOUT_GROUPS,
      reason: 'duplicate-auto',
      duplicateOfUrl: new Map([[1, 'https://example.com/kept']]),
    });

    expect((await archiveItem.getValue())[0]).toMatchObject({
      reason: 'duplicate-auto',
      duplicateOfUrl: 'https://example.com/kept',
    });
  });

  it('does nothing at all for no tabs', async () => {
    const fake = fakeApi();

    expect(await closeTabs([], NOW, { api: fake.api, capabilities: WITH_GROUPS })).toEqual([]);
    expect(fake.remove).not.toHaveBeenCalled();
    expect(await archiveItem.getValue()).toEqual([]);
  });
});

describe('closeWindow', () => {
  it('archives the window’s own tabs and then closes it', async () => {
    const fake = fakeApi();
    const tabs = [tab(1, { windowId: 1 }), tab(2, { windowId: 2 }), tab(3, { windowId: 2 })];

    await closeWindow(2, tabs, NOW, { api: fake.api, capabilities: WITHOUT_GROUPS });

    const stored = await archiveItem.getValue();
    expect(stored.map((entry) => entry.url)).toEqual([
      'https://example.com/2',
      'https://example.com/3',
    ]);
    expect(stored.every((entry) => entry.reason === 'window')).toBe(true);
    expect(fake.calls).toEqual(['close-window 2']);
  });

  it('leaves a window alone when none of its tabs can be archived', async () => {
    const fake = fakeApi();

    expect(await closeWindow(9, [tab(1, { windowId: 1 })], NOW, { api: fake.api })).toEqual([]);
    expect(fake.removeWindow).not.toHaveBeenCalled();
    expect(await archiveItem.getValue()).toEqual([]);
  });

  /* PLAN.md §8.6: the window may have gone on its own between the two calls. */
  it('still archives when the window is already gone', async () => {
    const fake = fakeApi();
    fake.removeWindow.mockRejectedValue(new Error('No window with id: 1.'));

    const entries = await closeWindow(1, [tab(1)], NOW, {
      api: fake.api,
      capabilities: WITHOUT_GROUPS,
    });

    expect(entries).toHaveLength(1);
    expect(await archiveItem.getValue()).toHaveLength(1);
  });
});

describe('restoreTabs', () => {
  it('prefers the session the browser remembers, which keeps the page’s history', async () => {
    const entry = archived({ url: 'https://example.com/a' });
    await addToArchive([entry]);
    const fake = fakeApi({
      closed: [{ tab: { sessionId: 's1', url: 'https://example.com/a' } }],
    });

    const restored = await restoreTabs([entry], NOW, {
      api: fake.api,
      capabilities: WITHOUT_GROUPS,
    });

    expect(fake.restore).toHaveBeenCalledWith('s1');
    expect(fake.create).not.toHaveBeenCalled();
    expect(restored).toHaveLength(1);
    expect(await archiveItem.getValue()).toEqual([]);
  });

  it('asks for the 25 closes the browser keeps and no more', async () => {
    const fake = fakeApi();
    await restoreTabs([archived()], NOW, { api: fake.api, capabilities: WITHOUT_GROUPS });

    expect(fake.getRecentlyClosed).toHaveBeenCalledWith({ maxResults: 25 });
  });

  /* PLAN.md §9: past those 25, the window and the index are all a restore has. */
  it('creates the tab where it was when there is no session for it', async () => {
    const entry = archived({ url: 'https://example.com/a', windowId: 4, index: 7 });
    await addToArchive([entry]);
    const fake = fakeApi({ closed: [] });

    await restoreTabs([entry], NOW, { api: fake.api, capabilities: WITHOUT_GROUPS });

    expect(fake.create).toHaveBeenCalledWith({
      url: 'https://example.com/a',
      windowId: 4,
      index: 7,
      active: false,
    });
    expect(await archiveItem.getValue()).toEqual([]);
  });

  it('creates the tab in the current window when the old one is gone', async () => {
    const entry = archived({ url: 'https://example.com/a' });
    const fake = fakeApi();
    fake.create.mockRejectedValueOnce(new Error('No window with id: 4.'));

    const restored = await restoreTabs([entry], NOW, {
      api: fake.api,
      capabilities: WITHOUT_GROUPS,
    });

    expect(fake.create.mock.calls.map((call) => call[0])).toEqual([
      { url: 'https://example.com/a', windowId: 4, index: 7, active: false },
      { url: 'https://example.com/a', active: false },
    ]);
    expect(restored).toHaveLength(1);
  });

  it('leaves an entry it could not restore in the archive', async () => {
    const entry = archived();
    await addToArchive([entry]);
    const fake = fakeApi();
    fake.create.mockRejectedValue(new Error('Tabs cannot be edited right now.'));

    expect(await restoreTabs([entry], NOW, { api: fake.api })).toEqual([]);
    expect((await archiveItem.getValue()).map((stored) => stored.id)).toEqual(['e1']);
  });

  it('falls back to creating the tab in a browser without `sessions`', async () => {
    const fake = fakeApi({ noSessions: true });

    await restoreTabs([archived()], NOW, { api: fake.api, capabilities: WITHOUT_GROUPS });

    expect(fake.create).toHaveBeenCalledTimes(1);
  });

  it('restores a tab even when `getRecentlyClosed` itself fails', async () => {
    const fake = fakeApi();
    fake.getRecentlyClosed.mockRejectedValue(new Error('Sessions API unavailable.'));

    expect(await restoreTabs([archived()], NOW, { api: fake.api })).toHaveLength(1);
    expect(fake.create).toHaveBeenCalledTimes(1);
  });

  it('ignores a closed window among the recently closed sessions', async () => {
    const fake = fakeApi({ closed: [{ window: { sessionId: 'w1' } }] });

    await restoreTabs([archived()], NOW, { api: fake.api, capabilities: WITHOUT_GROUPS });

    expect(fake.restore).not.toHaveBeenCalled();
    expect(fake.create).toHaveBeenCalledTimes(1);
  });

  /* PLAN.md §5.5: the group is found by title, because its id did not survive. */
  it('puts the tab back in the group with that title, in its own window', async () => {
    const fake = fakeApi({
      groups: [
        { id: 5, windowId: 9, title: 'Work' },
        { id: 6, windowId: 4, title: 'Work' },
      ],
    });

    const restored = await restoreTabs([archived({ groupTitle: 'Work' })], NOW, {
      api: fake.api,
      capabilities: WITH_GROUPS,
    });

    expect(fake.group).toHaveBeenCalledWith({ tabIds: [restored[0]], groupId: 6 });
  });

  it('takes a group of that name in another window when there is none here', async () => {
    const fake = fakeApi({ groups: [{ id: 5, windowId: 9, title: 'Work' }] });

    await restoreTabs([archived({ groupTitle: 'Work' })], NOW, {
      api: fake.api,
      capabilities: WITH_GROUPS,
    });

    expect(fake.group).toHaveBeenCalledWith({ tabIds: [100], groupId: 5 });
  });

  it('leaves the tab ungrouped when the group no longer exists', async () => {
    const entry = archived({ groupTitle: 'Work' });
    await addToArchive([entry]);
    const fake = fakeApi({ groups: [] });

    const restored = await restoreTabs([entry], NOW, {
      api: fake.api,
      capabilities: WITH_GROUPS,
    });

    expect(fake.group).not.toHaveBeenCalled();
    expect(restored).toHaveLength(1);
    expect(await archiveItem.getValue()).toEqual([]);
  });

  /**
   * Chrome reads `tabGroups.query({ title })` as a pattern, so the titles are compared
   * here instead: a group called "Work *" is not the group called "Work".
   */
  it('matches the group title exactly, never as a pattern', async () => {
    const fake = fakeApi({ groups: [{ id: 5, windowId: 4, title: 'Work *' }] });

    await restoreTabs([archived({ groupTitle: 'Work' })], NOW, {
      api: fake.api,
      capabilities: WITH_GROUPS,
    });

    expect(fake.group).not.toHaveBeenCalled();
  });

  it('does not try to group where there are no tab groups', async () => {
    const fake = fakeApi({ noTabGroups: true });

    await restoreTabs([archived({ groupTitle: 'Work' })], NOW, {
      api: fake.api,
      capabilities: WITHOUT_GROUPS,
    });

    expect(fake.group).not.toHaveBeenCalled();
  });

  it('survives a group call the browser refuses', async () => {
    const fake = fakeApi({ groups: [{ id: 5, windowId: 4, title: 'Work' }] });
    fake.group.mockRejectedValue(new Error('No group with id: 5.'));

    expect(
      await restoreTabs([archived({ groupTitle: 'Work' })], NOW, {
        api: fake.api,
        capabilities: WITH_GROUPS,
      }),
    ).toHaveLength(1);
  });

  /* PLAN.md §8.6: the extension's own tabs are exempt from the duplicate guard. */
  it('exempts the restored tab by URL and by id', async () => {
    const fake = fakeApi();

    const restored = await restoreTabs([archived({ url: 'https://example.com/a' })], NOW, {
      api: fake.api,
      capabilities: WITHOUT_GROUPS,
    });

    expect(await isExempt({ url: 'https://example.com/a' }, NOW)).toBe(true);
    expect(await isExempt({ tabId: restored[0] }, NOW)).toBe(true);
  });

  /**
   * The guard reacts to `onCreated`, so the URL has to be exempt before the tab exists:
   * an exemption written afterwards would be a race the guard can win.
   */
  it('exempts the URL before it creates the tab', async () => {
    const fake = fakeApi();
    const exemptWhenCreated: boolean[] = [];
    fake.create.mockImplementation(async (properties: { url: string; active: boolean }) => {
      exemptWhenCreated.push(await isExempt({ url: properties.url }, NOW));
      return { id: 100, windowId: 1, url: properties.url, active: properties.active };
    });

    await restoreTabs([archived({ url: 'https://example.com/a' })], NOW, {
      api: fake.api,
      capabilities: WITHOUT_GROUPS,
    });

    expect(exemptWhenCreated).toEqual([true]);
  });

  it('restores several entries and empties the archive of them', async () => {
    const entries = [
      archived({ id: 'e1', url: 'https://example.com/a' }),
      archived({ id: 'e2', url: 'https://example.com/b' }),
    ];
    await addToArchive([...entries, archived({ id: 'e3', url: 'https://example.com/c' })]);
    const fake = fakeApi({
      closed: [{ tab: { sessionId: 's1', url: 'https://example.com/b' } }],
    });

    const restored = await restoreTabs(entries, NOW, {
      api: fake.api,
      capabilities: WITHOUT_GROUPS,
    });

    expect(restored).toHaveLength(2);
    expect(fake.restore).toHaveBeenCalledTimes(1);
    expect(fake.create).toHaveBeenCalledTimes(1);
    expect((await archiveItem.getValue()).map((entry) => entry.id)).toEqual(['e3']);
  });

  it('does nothing at all for no entries', async () => {
    const fake = fakeApi();

    expect(await restoreTabs([], NOW, { api: fake.api })).toEqual([]);
    expect(fake.getRecentlyClosed).not.toHaveBeenCalled();
    expect(await isExempt({ url: 'https://example.com/1' }, NOW)).toBe(false);
  });
});

describe('keepTab', () => {
  it('keeps the page for the seven days of PLAN.md §6.4', async () => {
    await keepTab('https://example.com/a?utm_source=news', NOW);

    expect(await keepsItem.getValue()).toEqual({
      [keepKey('https://example.com/a')]: NOW + DEFAULT_KEEP_MS,
    });
  });

  it('keeps it for good when the user picks "Sempre"', async () => {
    await keepTab('https://example.com/a', NOW, true);

    expect(await keepsItem.getValue()).toEqual({ [keepKey('https://example.com/a')]: null });
  });
});

describe('protectSite', () => {
  it('adds the registrable domain, not the host', async () => {
    expect(await protectSite('https://docs.example.co.uk/a')).toBe('example.co.uk');
    expect(await protectedDomainsItem.getValue()).toEqual(['example.co.uk']);
  });

  it('adds it once, however often the menu item is used', async () => {
    await protectSite('https://docs.example.com/a');
    await protectSite('https://mail.example.com/b');

    expect(await protectedDomainsItem.getValue()).toEqual(['example.com']);
  });

  it('protects nothing for a URL that is not a site', async () => {
    expect(await protectSite('about:debugging')).toBeNull();
    expect(await protectedDomainsItem.getValue()).toEqual([]);
  });
});

describe('discardTab', () => {
  it('discards a tab that is in the background', async () => {
    const fake = fakeApi();

    expect(await discardTab(tab(1), { api: fake.api })).toBe(true);
    expect(fake.discard).toHaveBeenCalledWith(1);
  });

  /* PLAN.md §9: suspending the tab the user is on would reload the page under them. */
  it('refuses the active tab', async () => {
    const fake = fakeApi();

    expect(await discardTab(tab(1, { active: true }), { api: fake.api })).toBe(false);
    expect(fake.discard).not.toHaveBeenCalled();
  });

  it('refuses a tab that is already discarded', async () => {
    const fake = fakeApi();

    expect(await discardTab(tab(1, { discarded: true }), { api: fake.api })).toBe(false);
    expect(fake.discard).not.toHaveBeenCalled();
  });

  it('reports a refusal from the browser', async () => {
    const fake = fakeApi();
    fake.discard.mockRejectedValue(new Error('Tabs cannot be discarded right now.'));

    expect(await discardTab(tab(1), { api: fake.api })).toBe(false);
  });

  /* Firefox's `tabs.discard` resolves with nothing: that is a success, not a failure. */
  it('counts a call that resolves with nothing as done', async () => {
    const fake = fakeApi();
    fake.discard.mockResolvedValue(undefined);

    expect(await discardTab(tab(1), { api: fake.api })).toBe(true);
  });
});
