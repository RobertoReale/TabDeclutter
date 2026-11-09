import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { MINUTE } from '../../src/core/time';
import type { GuardSettings } from '../../src/core/types';
import {
  DEFAULT_SETTINGS,
  EXEMPTION_TTL_MS,
  NO_GROUP_ID,
  STARTUP_GRACE_MS,
} from '../../src/core/types';
import type { Guard, GuardOptions } from '../../src/entrypoints/background/guard';
import { registerGuard } from '../../src/entrypoints/background/guard';
import type { Capabilities } from '../../src/platform/capabilities';
import type { BrowserTab } from '../../src/platform/tabs';
import {
  addExemption,
  duplicateWhitelistItem,
  readArchive,
  readGuardState,
  readSettings,
  saveSettings,
} from '../../src/platform/storage';

/**
 * The live guard against a browser (PLAN.md §8.1, §8.2, §8.6): that each mode does what it
 * says, that a burst of twenty tabs of one page leaves exactly one of them, that everything
 * §8.6 protects is still protected, and that a close takes the archive and the badge with it.
 *
 * `core/duplicate-guard.ts` is tested on its own rules; what is in question here is the half
 * that needs a browser — the events, the index, the serial queue and the calls — so every
 * test opens tabs and then looks at which ones are left.
 *
 * Two things `fakeBrowser` cannot do by itself are arranged for:
 *
 * - **the fields it drops.** `tabs.create` keeps a URL and `active`, and ignores
 *   `cookieStoreId`, `openerTabId`, `index` and `windowId`. So `tabs.get` and `tabs.query`
 *   are decorated: `describeTab` says what the browser should report about a tab, and the
 *   guard reads it through the same two calls it would in Chrome.
 * - **the order.** A tab that is created with its URL already set is a Chrome tab; a tab
 *   that appears empty and gets its address from `onUpdated` is a Firefox tab (§5.5), and
 *   `arrive()` is that second shape. It is also the only moment at which a decoration is
 *   certain to be in place before the guard looks, so most tests use it.
 */

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
let clock = NOW;

/** PLAN.md §8.5's flash, as long as the badge makes it. */
const FLASH = 1_500;

/** `fakeBrowser` gives the window it starts with id 0, and every tab it creates belongs to it. */
const WINDOW = 0;

const RESUME_ALARM = 'guard-resume';
const PAUSE = 15 * MINUTE;

/** One page, three ways: plainly, with a tracking parameter, and a different page. */
const URL_A = 'https://example.com/a';
const TRACKED = 'https://example.com/a?utm_source=news';
const URL_B = 'https://example.com/b';

/** A tab id the fake browser never issued, for the `onReplaced` of a tab it cannot replace. */
const REPLACEMENT = 99;

/**
 * The `tabs` events `fakeBrowser` has no in-memory implementation for: its `addListener`
 * throws, so the test takes the listener and fires it itself.
 */
const STUBBED = ['onAttached', 'onReplaced'] as const;

/** Both of them take tab ids and nothing else. */
type TabEventListener = (...tabIds: number[]) => void;

/** The listeners the guard registered for those events, by event name. */
const stubbed = new Map<(typeof STUBBED)[number], TabEventListener>();

/** What the browser should report about a tab, over what `fakeBrowser` keeps. */
const extras = new Map<number, Partial<BrowserTab>>();

/** How many times §8.5's flash was asked for. */
let flashes = 0;

beforeEach(async () => {
  fakeBrowser.reset();
  // `reset` leaves the window `fakeBrowser` starts with and its one tab. Which tabs are
  // left is the whole assertion here, so the tests start from an empty browser.
  const existing = await fakeBrowser.tabs.query({});
  for (const tab of existing) {
    if (tab.id !== undefined) await fakeBrowser.tabs.remove(tab.id);
  }
  clock = NOW;
  flashes = 0;
  stubbed.clear();
  extras.clear();
  vi.useFakeTimers();

  for (const event of STUBBED) {
    vi.spyOn(fakeBrowser.tabs[event], 'addListener').mockImplementation(
      (listener: (...args: never[]) => void) => {
        stubbed.set(event, listener as TabEventListener);
      },
    );
  }

  // Bound before the spies replace them, and used by the spies: the guard sees the real
  // fake browser, with the fields it does not keep added back.
  const browserGet = fakeBrowser.tabs.get.bind(fakeBrowser.tabs) as (
    tabId: number,
  ) => Promise<BrowserTab | undefined>;
  const browserQuery = fakeBrowser.tabs.query.bind(fakeBrowser.tabs) as (
    query: Record<string, unknown>,
  ) => Promise<BrowserTab[]>;

  // `tabs.get` and `tabs.query` both have a callback overload, so a mocked implementation
  // is typed as returning `void` and the casts are unavoidable (see `badge.test.ts`).
  vi.spyOn(fakeBrowser.tabs, 'get').mockImplementation((async (tabId: number) => {
    const tab = await browserGet(tabId);
    return tab === undefined ? undefined : decorate(tab);
  }) as never);
  vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation((async (
    query: Record<string, unknown>,
  ) => {
    return (await browserQuery(query)).map(decorate);
  }) as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * A tab as the browser should report it: what `fakeBrowser` keeps, plus whatever
 * `describeTab` was told.
 *
 * Every tab `fakeBrowser` makes claims `groupId: 0`, which is a real Chrome group id and
 * would send `closeTabs` looking for a group title; the guard's subject is not groups.
 */
function decorate(tab: BrowserTab): BrowserTab {
  return { ...tab, groupId: NO_GROUP_ID, ...extras.get(tab.id ?? -1) };
}

/** What the browser reports about `tabId`, for the fields `tabs.create` drops. */
function describeTab(tabId: number, fields: Partial<BrowserTab>): void {
  extras.set(tabId, { ...extras.get(tabId), ...fields });
}

function capabilities(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    sidePanel: true,
    sidebarAction: false,
    faviconApi: true,
    promptApi: false,
    tabGroups: true,
    containers: false,
    sessionTabValues: false,
    duplicateCommandDetection: true,
    tabContextMenu: false,
    ...overrides,
  };
}

/** The guard, with the injected clock and a flash that takes PLAN.md §8.5's 1.5 s. */
function start(overrides: GuardOptions = {}): Guard {
  return registerGuard({
    now: () => clock,
    capabilities: capabilities(),
    flash: () => {
      flashes += 1;
      return new Promise<void>((resolve) => setTimeout(resolve, FLASH));
    },
    ...overrides,
  });
}

/** The stored settings, with `guard` as the test wants it. */
function configure(guard: Partial<GuardSettings> = {}): Promise<void> {
  return saveSettings({
    ...DEFAULT_SETTINGS,
    guard: { ...DEFAULT_SETTINGS.guard, ...guard },
  });
}

/**
 * Lets everything the listeners started finish, the badge flash included.
 *
 * The flash is a timer the fake clock has to be walked through, and it is started by a
 * close — which can happen at any point of the queue — so the clock is advanced until
 * `settled()` says there is nothing left rather than a fixed number of times.
 */
async function settle(guard: Guard): Promise<void> {
  let idle = false;
  const done = guard.settled().then(() => {
    idle = true;
  });
  for (let step = 0; step < 20 && !idle; step += 1) {
    await vi.advanceTimersByTimeAsync(FLASH);
  }
  await done;
}

/** A tab, Chrome's way: created with its URL already known. */
async function open(url?: string, properties: { active?: boolean } = {}): Promise<number> {
  const tab = await fakeBrowser.tabs.create({
    ...properties,
    ...(url === undefined ? {} : { url }),
  });
  const tabId = tab.id;
  if (tabId === undefined) throw new Error('the fake browser created a tab with no id');
  return tabId;
}

/**
 * A tab, Firefox's way: it appears empty and gets its address afterwards, which is how
 * every tab is opened there (PLAN.md §5.5, "no `pendingUrl`").
 *
 * The two events are settled separately, so `fields` is in place before the guard reads
 * the tab — and so the first one, on a tab with no URL at all, is a real event too.
 */
async function arrive(
  guard: Guard,
  url: string,
  fields: Partial<BrowserTab> = {},
  properties: { active?: boolean } = {},
): Promise<number> {
  const tabId = await open(undefined, properties);
  await settle(guard);
  describeTab(tabId, fields);
  await navigate(guard, tabId, url);
  return tabId;
}

/** A tab that loads a URL: the plainest of §8.2's events. */
async function navigate(guard: Guard, tabId: number, url: string): Promise<void> {
  await fakeBrowser.tabs.update(tabId, { url });
  await settle(guard);
}

/** Fires one of the events `fakeBrowser` does not implement, as the browser would. */
function fire(event: (typeof STUBBED)[number], ...tabIds: number[]): void {
  const listener = stubbed.get(event);
  if (listener === undefined) throw new Error(`the guard did not listen for tabs.${event}`);
  listener(...tabIds);
}

/** The open tabs, in the browser's own order. */
async function ids(): Promise<number[]> {
  const open = await fakeBrowser.tabs.query({});
  return open.flatMap((tab) => (tab.id === undefined ? [] : [tab.id]));
}

async function urlOf(tabId: number): Promise<string | undefined> {
  return (await fakeBrowser.tabs.get(tabId))?.url;
}

describe('the modes', () => {
  it('does nothing, and reads nothing, when the guard is off', async () => {
    await configure({ mode: 'off' });
    const a = await open(URL_A);
    const guard = start();
    const reads = vi.spyOn(fakeBrowser.tabs, 'query');

    const b = await open(URL_A);
    await settle(guard);

    // Asserted before `ids()`, which is a read of its own. "Niente" costs not a single
    // API call: the mode is checked before the index is built (PLAN.md §11).
    expect(reads).not.toHaveBeenCalled();
    expect(await ids()).toEqual([a, b]);
  });

  it('closes nothing in "Solo avvisi"', async () => {
    await configure({ mode: 'warn' });
    const a = await open(URL_A);
    const guard = start();
    const reads = vi.spyOn(fakeBrowser.tabs, 'query');

    const b = await open(URL_A);
    await settle(guard);

    // The warning itself is the badge's and the panel's (§8.5); the guard's part of
    // "Solo avvisi" is to keep its hands off the tabs.
    expect(reads).not.toHaveBeenCalled();
    expect(await ids()).toEqual([a, b]);
    expect(await readArchive()).toEqual([]);
  });

  it('closes the duplicate in "Chiudi automaticamente", and flashes the badge', async () => {
    await configure({ mode: 'auto' });
    const a = await open(URL_A);
    const guard = start();

    await open(URL_A);
    await settle(guard);

    expect(await ids()).toEqual([a]);
    expect(flashes).toBe(1);
  });

  it('takes a change of mode as soon as it is stored', async () => {
    await configure({ mode: 'warn' });
    const a = await open(URL_A);
    const guard = start();

    // The guard keeps the settings it read (PLAN.md §11); a change arrives as a
    // `storage.onChanged` and must not need a restart of the browser to be noticed.
    await configure({ mode: 'auto' });
    await open(URL_A);
    await settle(guard);

    expect(await ids()).toEqual([a]);
  });
});

describe('a burst of the same page', () => {
  it('leaves exactly one tab out of twenty opened at once', async () => {
    await configure({ mode: 'auto' });
    const guard = start();

    // §8.2's own case: twenty events, each of which sees the other nineteen tabs. Without
    // the serial queue they would close each other and the page would be gone.
    const opened = await Promise.all(Array.from({ length: 20 }, () => open(URL_A)));
    await settle(guard);

    expect(await ids()).toEqual([opened[0]]);
    expect(await readArchive()).toHaveLength(19);
    // §8.5: one flash for the burst, not nineteen.
    expect(flashes).toBe(1);
  });
});

describe('what the guard leaves alone', () => {
  it('does not touch a tab the extension itself opened, while the exemption lasts', async () => {
    await configure({ mode: 'auto' });
    const a = await open(URL_A);
    const guard = start();

    // What "Annulla" does to a close: undoing it and having the guard immediately redo it
    // would make the button a no-op (PLAN.md §8.6).
    await addExemption({ url: URL_A }, clock);
    const b = await open(URL_A);
    await settle(guard);

    expect(await ids()).toEqual([a, b]);
  });

  it('closes it again once the exemption has run out', async () => {
    await configure({ mode: 'auto' });
    const a = await open(URL_A);
    const guard = start();
    await addExemption({ url: URL_A }, clock);

    clock += EXEMPTION_TTL_MS + 1;
    await open(URL_A);
    await settle(guard);

    expect(await ids()).toEqual([a]);
  });

  it('closes nothing in the seconds after the browser starts', async () => {
    await configure({ mode: 'auto' });
    const a = await open(URL_A);
    const guard = start();

    // A restored session is full of duplicates the user never made (PLAN.md §8.6).
    await fakeBrowser.runtime.onStartup.trigger();
    await settle(guard);
    expect((await readGuardState()).graceUntil).toBe(NOW + STARTUP_GRACE_MS);

    const b = await open(URL_A);
    await settle(guard);

    expect(await ids()).toEqual([a, b]);
  });

  it('closes duplicates again once the start-up grace period is over', async () => {
    await configure({ mode: 'auto' });
    const a = await open(URL_A);
    const guard = start();
    await fakeBrowser.runtime.onStartup.trigger();
    await settle(guard);

    clock += STARTUP_GRACE_MS + 1;
    await open(URL_A);
    await settle(guard);

    expect(await ids()).toEqual([a]);
  });

  it('leaves a page on the duplicate whitelist alone', async () => {
    await configure({ mode: 'auto' });
    const a = await open(URL_A);
    const guard = start();

    // §8.3: the list is compiled on a change and not on every navigation, so a change has
    // to reach the guard the same way a change of settings does.
    await duplicateWhitelistItem.setValue([URL_A]);
    const b = await open(URL_A);
    await settle(guard);

    expect(await ids()).toEqual([a, b]);
  });

  it('leaves a tab another extension has hidden out of it', async () => {
    await configure({ mode: 'auto' });
    const a = await open(URL_A);
    // PLAN.md §5.5: a hidden tab is not on screen for the user to have duplicated, and is
    // excluded everywhere.
    describeTab(a, { hidden: true });
    const guard = start();

    const b = await open(URL_A);
    await settle(guard);

    expect(await ids()).toEqual([a, b]);
  });

  it('does not treat the same page in two containers as a duplicate', async () => {
    await configure({ mode: 'auto' });
    const a = await open(URL_A);
    describeTab(a, { cookieStoreId: 'firefox-container-1' });
    const guard = start();

    const b = await arrive(guard, URL_A, { cookieStoreId: 'firefox-container-2' });

    expect(await ids()).toEqual([a, b]);
  });

  it('closes it when the user has said containers are not separate', async () => {
    await configure({ mode: 'auto', containersAreSeparate: false });
    const a = await open(URL_A);
    describeTab(a, { cookieStoreId: 'firefox-container-1' });
    const guard = start();

    await arrive(guard, URL_A, { cookieStoreId: 'firefox-container-2' });

    expect(await ids()).toEqual([a]);
  });

  it('respects a duplicate the user made with Chrome’s "Duplicate tab"', async () => {
    await configure({ mode: 'auto' });
    const a = await open(URL_A);
    describeTab(a, { index: 0 });
    const guard = start();

    // The heuristic of §8.6: a new tab, on the same page, opened by that tab, immediately
    // to its right. The browser gives no other signal that the command was used.
    const b = await arrive(guard, URL_A, { openerTabId: a, index: 1 });

    expect(await ids()).toEqual([a, b]);
  });

  it('closes that same duplicate where the signal does not exist', async () => {
    await configure({ mode: 'auto' });
    const a = await open(URL_A);
    describeTab(a, { index: 0 });
    // Firefox has no "Duplicate tab" command to recognize (invariant 10), so the
    // heuristic is off there and the pair is an ordinary duplicate.
    const guard = start({ capabilities: capabilities({ duplicateCommandDetection: false }) });

    await arrive(guard, URL_A, { openerTabId: a, index: 1 });

    expect(await ids()).toEqual([a]);
  });
});

describe('the pause', () => {
  it('holds every event, and comes back to the mode it was in', async () => {
    await configure({ mode: 'auto' });
    const a = await open(URL_A);
    const guard = start();

    await guard.pause(PAUSE);
    const b = await open(URL_A);
    await settle(guard);

    expect(await ids()).toEqual([a, b]);
    expect(await guard.status()).toEqual({
      mode: 'auto',
      paused: true,
      pausedUntil: NOW + PAUSE,
      resumeMode: 'auto',
    });
    // The mode itself is not rewritten: a pause is a pause, and "Chiudi
    // automaticamente" is what the user chose (PLAN.md §8.1).
    expect((await readSettings()).guard.mode).toBe('auto');
    // An alarm and not a timer: 15 minutes outlive the service worker many times over.
    expect(await fakeBrowser.alarms.get(RESUME_ALARM)).toMatchObject({
      name: RESUME_ALARM,
      scheduledTime: NOW + PAUSE,
    });

    clock += PAUSE;
    await fakeBrowser.alarms.onAlarm.trigger({
      name: RESUME_ALARM,
      scheduledTime: clock,
      persistAcrossSessions: false,
    });
    await settle(guard);

    expect(await guard.status()).toEqual({ mode: 'auto', paused: false });
    expect(await fakeBrowser.alarms.get(RESUME_ALARM)).toBeUndefined();

    // And the guard is working again: the tab that survived the pause navigates onto the
    // same page a second time, and this time one of the two goes.
    await navigate(guard, b, URL_A);
    expect(await ids()).toEqual([a]);
  });

  it('needs no alarm for a pause that lasts until the browser restarts', async () => {
    await configure({ mode: 'auto' });
    const guard = start();

    await guard.pause(null);

    // `storage.session` is cleared by the restart, so the deadline only has to be one no
    // session reaches (PLAN.md §8.1).
    expect(await fakeBrowser.alarms.getAll()).toEqual([]);
    const status = await guard.status();
    expect(status.paused).toBe(true);
    expect(status.pausedUntil ?? 0).toBeGreaterThan(NOW + 300 * 24 * 60 * MINUTE);
  });
});

describe('a tab that gets its address after it appears', () => {
  it('is still a new tab, and not the tab the user is working on', async () => {
    await configure({ mode: 'auto' });
    const a = await open(URL_A);
    const guard = start();

    // Firefox opens every tab this way (PLAN.md §5.5). The tab is the active one, which on
    // Chrome would mean the user navigated it there — here it means nothing of the kind,
    // and §8.4.3.2 must keep the page that was already open.
    const b = await open(undefined, { active: true });
    await settle(guard);
    expect(await ids()).toEqual([a, b]);

    await navigate(guard, b, URL_A);

    expect(await ids()).toEqual([a]);
  });

  it('unlike a tab the user really did navigate onto the page', async () => {
    await configure({ mode: 'auto' });
    await open(URL_A);
    const b = await open(URL_B, { active: true });
    const guard = start();

    await navigate(guard, b, URL_A);

    // §8.4.3.2: the tab being used wins, so the older one is the one that goes.
    expect(await ids()).toEqual([b]);
  });
});

describe('a tab the browser replaced', () => {
  it('updates the index and closes nothing', async () => {
    await configure({ mode: 'auto' });
    const a = await open(URL_A);
    const b = await open(URL_B);
    const guard = start();
    // One event, so that there is an index to update at all.
    await navigate(guard, b, URL_B);

    // Chrome gives a discarded or prerendered page a new tab id (PLAN.md §5.5). The fake
    // browser cannot perform the swap, so the event is fired as the browser would.
    fire('onReplaced', REPLACEMENT, a);
    await settle(guard);

    expect(await ids()).toEqual([a, b]);
    expect(await readArchive()).toEqual([]);

    // And the index really moved: the page is filed under an id nothing answers for, so
    // the next tab on it finds no candidate instead of closing a live tab (§8.6).
    const c = await open(URL_A);
    await settle(guard);

    expect(await ids()).toEqual([a, b, c]);
  });
});

describe('the "Stessa finestra" scope', () => {
  it('ignores another window until the tab is dragged over', async () => {
    await configure({ mode: 'auto', scope: 'window' });
    const a = await open(URL_A);
    const guard = start();

    const b = await arrive(guard, URL_A, { windowId: WINDOW + 1 });
    expect(await ids()).toEqual([a, b]);

    // Dragged into the window the other tab is in: nothing navigated, but the tab is now
    // next to tabs it was not being compared with (PLAN.md §8.2).
    describeTab(b, { windowId: WINDOW });
    fire('onAttached', b);
    await settle(guard);

    expect(await ids()).toEqual([a]);
  });
});

describe('after a close', () => {
  it('writes the closed tab to the archive, with the tab it duplicated', async () => {
    await configure({ mode: 'auto' });
    const a = await open(URL_A);
    const guard = start();

    await open(TRACKED);
    await settle(guard);

    expect(await ids()).toEqual([a]);
    const archived = await readArchive();
    expect(archived).toMatchObject([
      { url: TRACKED, reason: 'duplicate-auto', duplicateOfUrl: URL_A },
    ]);
    // "Riapri l'ultimo duplicato chiuso" (PLAN.md §8.5) needs to know which entry it was.
    const archiveId = archived[0]?.id;
    expect(archiveId).toBeDefined();
    expect((await readGuardState()).lastAutoClosedId).toBe(archiveId);
  });

  it('loads the new URL in the kept tab for "Più vecchia ricaricata"', async () => {
    await configure({ mode: 'auto', keep: 'oldest-reloaded' });
    const a = await open(URL_A);
    const guard = start();

    // The same page by key, a different URL to the eye: §8.4.3.4 keeps the old tab and
    // sends it to where the new one was going.
    await open(TRACKED);
    await settle(guard);

    expect(await ids()).toEqual([a]);
    expect(await urlOf(a)).toBe(TRACKED);
  });

  it('gives the kept tab the place of the one that went', async () => {
    await configure({ mode: 'auto', after: 'move-activate' });
    const a = await open(URL_A);
    const guard = start();
    const moves = vi
      .spyOn(fakeBrowser.tabs, 'move')
      .mockImplementation((() => Promise.resolve([])) as never);

    await arrive(guard, URL_A, { index: 3 }, { active: true });

    expect(await ids()).toEqual([a]);
    expect(moves).toHaveBeenCalledWith(a, { windowId: WINDOW, index: 3 });
  });

  it('leaves the kept tab where it is when the duplicate opened in the background', async () => {
    await configure({ mode: 'auto', after: 'move-activate' });
    const a = await open(URL_A);
    const guard = start();
    const moves = vi
      .spyOn(fakeBrowser.tabs, 'move')
      .mockImplementation((() => Promise.resolve([])) as never);
    const updates = vi.spyOn(fakeBrowser.tabs, 'update');

    // A link opened in a new background tab: the user is reading something else, and
    // §8.4.4 will not pull them away from it.
    await open(URL_A);
    await settle(guard);

    expect(await ids()).toEqual([a]);
    expect(moves).not.toHaveBeenCalled();
    expect(updates).not.toHaveBeenCalled();
  });
});
