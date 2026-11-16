/**
 * What the browser forgets about a tab, PLAN.md §6.1.
 *
 * `tab.lastAccessed` is dropped when a tab is discarded, is absent from most event
 * payloads and says nothing about how long a tab was really used, so the background keeps
 * its own record per tab: when it was opened, when it was last in the foreground, how
 * many times it was activated, how long it was in the foreground. The score reads those
 * records; this writes them.
 *
 * **Writes are coalesced.** Ten tabs restored at once are ten events. They must cost one
 * write, so every change marks the store dirty and a `debounceMs` timer does the writing
 * (PLAN.md §6.1 asks for 1–2 s).
 *
 * **Nothing lives only in a variable** (invariant 6). Chrome stops the service worker
 * after about 30 s: the store is re-read from `local:activity` whenever a new worker needs
 * it, and the foreground clock is kept in `session:foreground`. What is held in memory is
 * the debounce window itself, and PLAN.md §16 answers that with the flush on
 * `runtime.onSuspend`.
 *
 * **Firefox** also gets each record written next to its tab with `sessions.setTabValue`,
 * which the browser restores with the tab. That is better than matching by URL, so it is
 * read first at start-up (PLAN.md §5.5); Chrome has no equivalent and relies on the
 * matching in `src/core/reconcile.ts`.
 */

import type { ReconcileTab } from '@/core/reconcile';
import {
  bootstrapActivity,
  bootstrapRecord,
  isTabActivity,
  reconcileActivity,
} from '@/core/reconcile';
import type { ActivityStore, TabActivity } from '@/core/types';
import type { Capabilities } from '@/platform/capabilities';
import { caps } from '@/platform/capabilities';
import { activityItem, foregroundItem } from '@/platform/storage';

/** PLAN.md §6.1 allows 1–2 s. The short end: on Chrome the flush is best effort. */
const WRITE_DEBOUNCE_MS = 1_000;

/** The key Firefox's session store keeps a tab's record under (PLAN.md §5.5). */
const SESSION_KEY = 'td';

/** `windows.WINDOW_ID_NONE`: no window has the focus. */
const NO_WINDOW = -1;

/** Firefox's per-tab session store, which survives a restart. Mocked in the tests. */
export interface SessionTabValues {
  getTabValue(tabId: number, key: string): Promise<unknown>;
  setTabValue(tabId: number, key: string, value: unknown): Promise<void>;
}

export interface TrackerOptions {
  /** The clock, injected so the tests can be exact. */
  readonly now?: () => number;
  /** How long writes are held back. Defaults to `WRITE_DEBOUNCE_MS`. */
  readonly debounceMs?: number;
  readonly capabilities?: Capabilities;
  /** Defaults to `browser.sessions` when the capability is there. */
  readonly sessions?: SessionTabValues;
}

export interface Tracker {
  /** Writes whatever the debounce is still holding. */
  flush(): Promise<void>;
}

/** What this module needs of a tab, whichever browser's type it came from. */
interface TabLike {
  id?: number;
  windowId?: number;
  index?: number;
  url?: string;
  pendingUrl?: string;
  lastAccessed?: number;
  active?: boolean;
}

/**
 * Registers the activity tracker. Called at the top level of the background, before any
 * `await`, because a service worker that wakes up for an event must already be listening
 * for it (invariant 6).
 */
export function registerTracker(options: TrackerOptions = {}): Tracker {
  const now = options.now ?? Date.now;
  const debounceMs = options.debounceMs ?? WRITE_DEBOUNCE_MS;
  const capabilities = options.capabilities ?? caps;
  const sessions = capabilities.sessionTabValues ? (options.sessions ?? sessionApi()) : undefined;

  /** The store as it will be written. `null` until this worker has read it. */
  let store: ActivityStore | null = null;
  /** Records changed since the last write: what Firefox has to re-save, tab by tab. */
  const touched = new Set<number>();
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** One handler at a time: they all read-modify-write the same store. */
  let chain: Promise<unknown> = Promise.resolve();

  function run<T>(action: () => Promise<T>): Promise<T> {
    const next = chain.then(action, action);
    chain = next.then(ignore, ignore);
    return next;
  }

  /** How a listener hands its work over: in order, and never unhandled. */
  function handle(action: () => Promise<void>): void {
    // Reported inside the queued work, so that a `flush()` waiting behind it sees the
    // report done: the queue is what keeps the handlers in order.
    void run(async () => {
      try {
        await action();
      } catch (error: unknown) {
        await report(error);
      }
    });
  }

  async function load(): Promise<ActivityStore> {
    // A copy: what storage gives back may be the shared fallback object.
    store ??= { ...(await activityItem.getValue()) };
    return store;
  }

  function mark(tabId: number): void {
    touched.add(tabId);
    dirty = true;
    timer ??= setTimeout(() => {
      timer = undefined;
      void write().catch((error: unknown) => void report(error));
    }, debounceMs);
  }

  /** Queued like a handler. Not to be called from inside one: the queue is serial. */
  function write(): Promise<void> {
    return run(writeNow);
  }

  async function writeNow(): Promise<void> {
    if (!dirty || store === null) return;
    dirty = false;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const snapshot = { ...store };
    const saved = [...touched];
    touched.clear();
    if (!(await writeStore(snapshot))) return;
    if (sessions !== undefined) await saveSessionValues(sessions, snapshot, saved);
  }

  /**
   * The record for a tab, invented if this worker has never seen the tab: a tab that was
   * open before the extension, or one whose `onCreated` went to a worker that died.
   */
  async function recordOf(
    current: ActivityStore,
    tabId: number,
    at: number,
    known?: TabLike,
  ): Promise<TabActivity | undefined> {
    const existing = current[tabId];
    if (existing !== undefined) return existing;
    const tab = known ?? (await getTab(tabId));
    if (tab === undefined) return undefined;
    const record = bootstrapRecord({ ...asReconcileTab(tab), id: tabId }, at);
    current[tabId] = record;
    mark(tabId);
    return record;
  }

  /** Charges the tab that was in the foreground for the time it spent there. */
  async function endPeriod(current: ActivityStore, at: number): Promise<void> {
    const period = await foregroundItem.getValue();
    if (period === null) return;
    await foregroundItem.setValue(null);
    const record = current[period.tabId];
    if (record === undefined) return;
    current[period.tabId] = {
      ...record,
      lastActiveAt: Math.max(record.lastActiveAt, at),
      foregroundMs: record.foregroundMs + Math.max(0, at - period.since),
    };
    mark(period.tabId);
  }

  async function startPeriod(
    current: ActivityStore,
    tabId: number,
    windowId: number,
    at: number,
  ): Promise<void> {
    await foregroundItem.setValue({ tabId, windowId, since: at });
    const record = current[tabId];
    if (record === undefined) return;
    current[tabId] = { ...record, lastActiveAt: at };
    mark(tabId);
  }

  browser.tabs.onCreated.addListener((tab: TabLike) => {
    const at = now();
    handle(async () => {
      if (tab.id === undefined) return;
      const current = await load();
      current[tab.id] = {
        tabId: tab.id,
        url: urlOf(tab),
        createdAt: at,
        lastActiveAt: at,
        activations: 0,
        foregroundMs: 0,
      };
      mark(tab.id);
    });
  });

  browser.tabs.onActivated.addListener((info: { tabId: number; windowId?: number }) => {
    const at = now();
    handle(async () => {
      const current = await load();
      await endPeriod(current, at);
      const record = await recordOf(current, info.tabId, at);
      if (record !== undefined) {
        current[info.tabId] = { ...record, activations: record.activations + 1, lastActiveAt: at };
        mark(info.tabId);
      }
      await startPeriod(current, info.tabId, info.windowId ?? NO_WINDOW, at);
    });
  });

  // The foreground clock stops when the browser loses the focus and starts again on the
  // active tab of the window that gets it, so a tab left in front of a game or another
  // application is not credited with the time (PLAN.md §6.1).
  browser.windows.onFocusChanged.addListener((windowId: number) => {
    const at = now();
    handle(async () => {
      const current = await load();
      await endPeriod(current, at);
      if (windowId === noWindowId()) return;
      const [active] = await browser.tabs.query({ active: true, windowId });
      const tabId = active?.id;
      if (active === undefined || tabId === undefined) return;
      await recordOf(current, tabId, at, active);
      await startPeriod(current, tabId, windowId, at);
    });
  });

  browser.tabs.onUpdated.addListener((tabId: number, change: { url?: string }, tab: TabLike) => {
    const url = change.url;
    if (url === undefined) return;
    const at = now();
    handle(async () => {
      const current = await load();
      const record = await recordOf(current, tabId, at, tab);
      if (record === undefined) return;
      // Navigating is using a tab, but only the one the user is looking at: a background
      // tab that redirects itself has not been touched (PLAN.md §6.1).
      current[tabId] = {
        ...record,
        url,
        lastActiveAt: tab.active === true ? at : record.lastActiveAt,
      };
      mark(tabId);
    });
  });

  // Chrome gives the page a new tab id when it discards it or swaps in a prerender; the
  // record has to follow, or a discarded tab would look brand new (PLAN.md §5.5).
  // Firefox keeps the id and never fires this.
  browser.tabs.onReplaced?.addListener((addedTabId: number, removedTabId: number) => {
    handle(async () => {
      const current = await load();
      const record = current[removedTabId];
      if (record === undefined) return;
      delete current[removedTabId];
      current[addedTabId] = { ...record, tabId: addedTabId };
      mark(removedTabId);
      mark(addedTabId);
      const period = await foregroundItem.getValue();
      if (period?.tabId === removedTabId) {
        await foregroundItem.setValue({ ...period, tabId: addedTabId });
      }
    });
  });

  browser.tabs.onRemoved.addListener((tabId: number) => {
    handle(async () => {
      const current = await load();
      if (current[tabId] !== undefined) {
        delete current[tabId];
        mark(tabId);
      }
      const period = await foregroundItem.getValue();
      if (period?.tabId === tabId) await foregroundItem.setValue(null);
    });
  });

  // A restart: the records are there, the tab ids are not (PLAN.md §5.5).
  browser.runtime.onStartup.addListener(() => {
    const at = now();
    handle(async () => {
      const tabs = await currentTabs();
      const saved = await activityItem.getValue();
      const fromSession =
        sessions === undefined ? undefined : await readSessionValues(sessions, tabs);
      store = reconcileActivity(saved, tabs, { now: at, fromSession }).activity;
      await foregroundItem.setValue(null);
      // The whole store was rebuilt, so every id in it is worth re-saving and none of the
      // ids from the previous run are.
      touched.clear();
      for (const tab of tabs) mark(tab.id);
      await writeNow();
    });
  });

  // First run, and every update: give the tabs that are already open a plausible record,
  // marked as invented so the score does not act on guesswork (PLAN.md §6.1).
  browser.runtime.onInstalled.addListener(() => {
    const at = now();
    handle(async () => {
      const tabs = await currentTabs();
      store = bootstrapActivity(await activityItem.getValue(), tabs, at).activity;
      touched.clear();
      for (const tab of tabs) mark(tab.id);
      await writeNow();
    });
  });

  // PLAN.md §16: the last chance to write. Chrome documents `onSuspend` for the event
  // page and warns that asynchronous work started here is not guaranteed to finish, and
  // Firefox fires it from 106; on an MV3 service worker it is best effort either way,
  // which is why the debounce above is a second and not two.
  browser.runtime.onSuspend?.addListener(() => {
    void write().catch((error: unknown) => void report(error));
  });

  return { flush: write };
}

/** The tabs as `reconcile.ts` wants them: the ones with an id, in the browser's order. */
async function currentTabs(): Promise<ReconcileTab[]> {
  const tabs = (await browser.tabs.query({})) as TabLike[];
  return tabs
    .filter((tab): tab is TabLike & { id: number } => tab.id !== undefined)
    .map(asReconcileTab);
}

function asReconcileTab(tab: TabLike & { id?: number }): ReconcileTab {
  return {
    id: tab.id ?? -1,
    windowId: tab.windowId ?? NO_WINDOW,
    index: tab.index ?? 0,
    url: urlOf(tab),
    lastAccessed: tab.lastAccessed,
  };
}

/** A tab that is still loading has its destination in `pendingUrl` and `url: ''`. */
function urlOf(tab: TabLike): string {
  const url = tab.url !== undefined && tab.url !== '' ? tab.url : tab.pendingUrl;
  return url ?? '';
}

/** Firefox restores these with the tab, so they are the first thing a restart reads. */
async function readSessionValues(
  sessions: SessionTabValues,
  tabs: readonly ReconcileTab[],
): Promise<ActivityStore> {
  const restored: ActivityStore = {};
  for (const tab of tabs) {
    try {
      const value = parse(await sessions.getTabValue(tab.id, SESSION_KEY));
      if (isTabActivity(value)) restored[tab.id] = value;
    } catch (error: unknown) {
      failed(error);
    }
  }
  return restored;
}

/** The store, written unless there is no browser left to write to (see `report`). */
async function writeStore(snapshot: ActivityStore): Promise<boolean> {
  try {
    await activityItem.setValue(snapshot);
    return true;
  } catch (error: unknown) {
    await report(error);
    return false;
  }
}

/**
 * A failure, unless the browser is on its way out (F.2).
 *
 * A browser shutting down rejects whichever call the tracker happens to have in flight —
 * the debounced write, a read of the foreground clock — and an extension that did nothing
 * wrong must not leave an error in the console for it (PLAN.md §14). As in
 * `saveSessionValues`, the question goes to the browser and never to the error's message,
 * which differs between Chrome and Firefox: a store that no longer answers at all is a
 * browser that is gone, while one that answers means the failure was the extension's own
 * (no space, a quota) and still reports.
 */
async function report(error: unknown): Promise<void> {
  if (await storageAnswers()) failed(error);
}

/** Whether the browser still answers at all, asked of the store the tracker writes to. */
async function storageAnswers(): Promise<boolean> {
  try {
    await activityItem.getValue();
    return true;
  } catch {
    return false;
  }
}

/** Only the records that changed, and only inside a write, never once per event. */
async function saveSessionValues(
  sessions: SessionTabValues,
  snapshot: ActivityStore,
  tabIds: readonly number[],
): Promise<void> {
  for (const tabId of tabIds) {
    const record = snapshot[tabId];
    if (record === undefined) continue;
    try {
      await sessions.setTabValue(tabId, SESSION_KEY, record);
    } catch (error: unknown) {
      // A tab closed between the event and the write — by the guard, or by the browser
      // taking every tab with it on the way out — has nothing left to attach the value to.
      // That is expected and not the extension's fault, so it is not reported (F.2): the
      // console of an extension that did nothing wrong must stay clean (PLAN.md §14). The
      // question goes to the tab and not to the error's message, which differs between
      // Chrome and Firefox. A write that failed with the tab still there is a real failure.
      if ((await getTab(tabId)) !== undefined) failed(error);
    }
  }
}

/** `setTabValue` may store an object or a string, so a read may give back either. */
function parse(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** The pieces of the extension API this module cannot name through WXT's types. */
interface TrackerApi {
  readonly sessions?: Partial<SessionTabValues>;
  readonly windows?: { readonly WINDOW_ID_NONE?: number };
}

function api(): TrackerApi {
  return browser as unknown as TrackerApi;
}

function sessionApi(): SessionTabValues | undefined {
  const sessions = api().sessions;
  return typeof sessions?.getTabValue === 'function' && typeof sessions.setTabValue === 'function'
    ? (sessions as SessionTabValues)
    : undefined;
}

function noWindowId(): number {
  return api().windows?.WINDOW_ID_NONE ?? NO_WINDOW;
}

async function getTab(tabId: number): Promise<TabLike | undefined> {
  try {
    return (await browser.tabs.get(tabId)) as TabLike | undefined;
  } catch {
    // Gone between the event and here. The next event will invent the record.
    return undefined;
  }
}

function failed(error: unknown): void {
  console.error('TabDeclutter: tracker', error);
}

function ignore(): void {
  /* keeps the queue alive after a failed handler */
}
