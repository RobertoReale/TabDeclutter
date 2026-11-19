/**
 * Putting the saved activity records back on the right tabs, PLAN.md §6.1.
 *
 * Tab ids do not survive a browser restart, and on Chrome they do not even survive a
 * discard, so after a restart the records the tracker wrote are keyed by ids that no
 * longer exist. The only thing both sides still share is the URL, so the records are
 * matched to the tabs as a multiset: as many records as there are tabs for that URL, and
 * when several tabs claim the same one, the window/index order decides who gets which.
 *
 * Pure, like everything in `src/core/` (invariant 4): the tracker reads the store and the
 * tabs, this decides, the tracker writes the result.
 */

import type { ActivityStore, TabActivity } from './types';
import { unwrapSuspendedUrl } from './url';

/**
 * What matching needs of a tab. A subset of `TabInfo`, because the background has the
 * browser's own tab objects here and nothing else in this file looks at a tab.
 */
export interface ReconcileTab {
  readonly id: number;
  readonly windowId: number;
  /** Position in its window: the tie-break when two tabs have the same URL. */
  readonly index: number;
  /** Empty when the browser does not say: such a tab matches nothing. */
  readonly url: string;
  /** The browser's own last-used time, when it still has one. */
  readonly lastAccessed?: number;
}

export interface ReconcileResult {
  /** The new store, keyed by the ids the tabs have now. */
  readonly activity: ActivityStore;
  /** Tabs that got their own record back. */
  readonly matched: number;
  /** Tabs nothing was known about, given an invented record. */
  readonly invented: number;
  /** Saved records no tab claimed. They are gone (PLAN.md §6.1). */
  readonly dropped: number;
}

export interface ReconcileOptions {
  readonly now: number;
  /**
   * Firefox: what `sessions.getTabValue` gave back, already keyed by the current tab id.
   * It survives a restart, so it wins over matching by URL (PLAN.md §5.5).
   */
  readonly fromSession?: ActivityStore;
}

/**
 * Whether a stored value is really a record.
 *
 * Everything here comes back from storage or from Firefox's session store, where an
 * older release of the extension — or anything else — may have left something else.
 */
export function isTabActivity(value: unknown): value is TabActivity {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<TabActivity>;
  return (
    typeof record.tabId === 'number' &&
    typeof record.url === 'string' &&
    isTime(record.createdAt) &&
    isTime(record.lastActiveAt) &&
    isTime(record.activations) &&
    isTime(record.foregroundMs) &&
    (record.bootstrappedAt === undefined || isTime(record.bootstrappedAt))
  );
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The record for a tab whose history nobody knows: `tab.lastAccessed` when the browser
 * still has it, otherwise now, and `bootstrappedAt` so the score leaves it alone for a
 * day (PLAN.md §6.1, §6.4). This is "bootstrapped: true" of §6.1, with the moment
 * recorded rather than a flag, because the grace period needs to end.
 */
export function bootstrapRecord(tab: ReconcileTab, now: number): TabActivity {
  const seen =
    tab.lastAccessed !== undefined && tab.lastAccessed > 0 ? Math.min(tab.lastAccessed, now) : now;
  return {
    tabId: tab.id,
    url: unwrapSuspendedUrl(tab.url),
    createdAt: seen,
    lastActiveAt: seen,
    activations: 0,
    foregroundMs: 0,
    bootstrappedAt: now,
  };
}

/**
 * After a restart: the saved records against the tabs that came back, by URL.
 *
 * A tab that claims no record gets an invented one, so that the store always describes
 * the tabs that exist now and the events that follow have something to update.
 */
export function reconcileActivity(
  saved: ActivityStore,
  tabs: readonly ReconcileTab[],
  options: ReconcileOptions,
): ReconcileResult {
  const byUrl = new Map<string, TabActivity[]>();
  for (const record of records(saved)) {
    const key = unwrapSuspendedUrl(record.url);
    const sameUrl = byUrl.get(key);
    if (sameUrl === undefined) byUrl.set(key, [record]);
    else sameUrl.push(record);
  }

  const activity: ActivityStore = {};
  let matched = 0;
  let invented = 0;
  let used = 0;

  for (const tab of [...tabs].sort(inWindowOrder)) {
    const effectiveUrl = unwrapSuspendedUrl(tab.url);
    // An empty URL is "the browser did not say", not something two tabs have in common.
    const byUrlRecord = effectiveUrl === '' ? undefined : byUrl.get(effectiveUrl)?.shift();
    // The saved copy of a tab Firefox restored itself is spent either way: the session
    // value is the same record, so the tabs behind this one must get the other records.
    if (byUrlRecord !== undefined) used += 1;

    const restored = options.fromSession?.[tab.id];
    const record = isTabActivity(restored) ? restored : byUrlRecord;
    if (record === undefined) {
      activity[tab.id] = bootstrapRecord(tab, options.now);
      invented += 1;
    } else {
      activity[tab.id] = { ...record, tabId: tab.id, url: effectiveUrl };
      matched += 1;
    }
  }

  return { activity, matched, invented, dropped: Object.keys(saved).length - used };
}

/**
 * First run (`runtime.onInstalled`): a record for every tab that has none, keeping the
 * ones that already exist.
 *
 * Tab ids are still valid here — the extension was installed or updated, the browser did
 * not restart — so a record is recognised by its id and no URL matching is needed. An
 * update therefore keeps what the previous version observed, and records left behind by
 * tabs that have since been closed are dropped.
 */
export function bootstrapActivity(
  saved: ActivityStore,
  tabs: readonly ReconcileTab[],
  now: number,
): ReconcileResult {
  const activity: ActivityStore = {};
  let matched = 0;
  let invented = 0;

  for (const tab of tabs) {
    const stored = saved[tab.id];
    if (isTabActivity(stored)) {
      activity[tab.id] = { ...stored, tabId: tab.id, url: unwrapSuspendedUrl(tab.url) };
      matched += 1;
    } else {
      activity[tab.id] = bootstrapRecord(tab, now);
      invented += 1;
    }
  }

  return { activity, matched, invented, dropped: Object.keys(saved).length - matched };
}

/** The saved records, oldest first, so the oldest tab of a URL gets the oldest record. */
function records(saved: ActivityStore): TabActivity[] {
  return Object.values(saved)
    .filter(isTabActivity)
    .filter((record) => record.url !== '')
    .sort((a, b) => a.createdAt - b.createdAt || a.tabId - b.tabId);
}

/** Left to right, window by window: the order the user sees (PLAN.md §6.1). */
function inWindowOrder(a: ReconcileTab, b: ReconcileTab): number {
  return a.windowId - b.windowId || a.index - b.index || a.id - b.id;
}
