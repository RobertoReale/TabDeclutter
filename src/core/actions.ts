/**
 * The pure half of the actions of PLAN.md §9: what a close puts in the archive, what the
 * user has to confirm before it happens, and how a restore is matched to the browser's
 * own list of recently closed tabs.
 *
 * It is here rather than in `platform/tabs.ts` because none of it needs a browser
 * (invariant 4): every decision is a function of the tabs, the archive entries and the
 * clock, so the safeguards that stand between the user and a mistake are tested in full
 * without an extension context.
 */

import { tabUrl } from './duplicates';
import { keepKey } from './scoring';
import type { ArchivedTab, ArchiveReason, TabInfo } from './types';
import { NO_GROUP_ID } from './types';

/**
 * A close of more than this many tabs asks first (PLAN.md §9: "Chiudi 42 schede?
 * [Conferma] [Annulla]").
 */
export const BULK_CONFIRM_LIMIT = 25;

export interface ArchiveOptions {
  /** Why the tabs are going (PLAN.md §4.5 filters the Archive view on it). */
  readonly reason?: ArchiveReason;
  /** `groupId` → the group's title, for the tabs that are in one. */
  readonly groupTitles?: ReadonlyMap<number, string>;
  /** For a `duplicate-*` close: tab id → the URL of the tab kept instead. */
  readonly duplicateOfUrl?: ReadonlyMap<number, string>;
}

/**
 * The archive entries for one action's tabs, in the order they were given — which is the
 * order `addToArchive` writes them in, and the order the Archive view shows.
 *
 * Invariant 3: this is what makes a close reversible, so it carries everything a restore
 * needs and nothing a restore cannot use. In particular the favicon is kept **only** when
 * it is already a `data:` URL: storing a remote one would mean a network request to show
 * the Archive view, and PLAN.md §5.5 forbids it outright ("Do not store remote favicons
 * in the archive").
 */
export function archiveEntries(
  tabs: readonly TabInfo[],
  now: number,
  options: ArchiveOptions = {},
): readonly ArchivedTab[] {
  const reason = options.reason ?? 'manual';
  return tabs.map((tab) => {
    const entry: ArchivedTab = {
      id: archiveId(tab.id, now),
      url: tabUrl(tab),
      title: tab.title,
      closedAt: now,
      reason,
      windowId: tab.windowId,
      index: tab.index,
    };
    const favIconUrl = dataFavicon(tab.favIconUrl);
    const groupTitle = groupTitleOf(tab, options.groupTitles);
    const duplicateOfUrl = options.duplicateOfUrl?.get(tab.id);
    return {
      ...entry,
      ...(favIconUrl === undefined ? {} : { favIconUrl }),
      ...(groupTitle === undefined ? {} : { groupTitle }),
      ...(duplicateOfUrl === undefined ? {} : { duplicateOfUrl }),
    };
  });
}

/**
 * `ArchivedTab.id` is ours, not the browser's: tab ids are reused, and the archive
 * outlives the tab by weeks.
 *
 * The moment of the close and the id the tab had while it lived are enough to be unique:
 * a tab id belongs to one tab at a time, so it can appear in only one close, and two
 * closes of the same tab are two different tabs with two different moments.
 */
function archiveId(tabId: number, closedAt: number): string {
  return `${closedAt.toString(36)}-${tabId.toString(36)}`;
}

/** Invariant 1: a remote icon is dropped, an inline one costs nothing to keep. */
function dataFavicon(favIconUrl: string | undefined): string | undefined {
  return favIconUrl !== undefined && favIconUrl.startsWith('data:') ? favIconUrl : undefined;
}

/**
 * PLAN.md §5.5: a group id does not survive a restart and Firefox's `sessions` never
 * reports one, so the title is the only handle an archive entry can keep. A group with no
 * title is nothing a restore could look up, and is left out.
 */
function groupTitleOf(
  tab: TabInfo,
  groupTitles: ReadonlyMap<number, string> | undefined,
): string | undefined {
  if (tab.groupId === NO_GROUP_ID) return undefined;
  const title = groupTitles?.get(tab.groupId);
  return title === undefined || title === '' ? undefined : title;
}

export interface SafeguardInput {
  /** What the user picked, by tab id. An id that is no longer open is ignored. */
  readonly selectedIds: readonly number[];
  /** Every open tab, so the selection can be compared with the windows it touches. */
  readonly tabs: readonly TabInfo[];
  /**
   * The window the user is looking at. Without it no tab counts as "the active tab of
   * the current window", which is exactly what PLAN.md §9 protects: a tab that is active
   * in a window nobody is looking at is not the tab the user is working on.
   */
  readonly focusedWindowId?: number;
}

/** What PLAN.md §9's three safeguards say about one selection. */
export interface Safeguards {
  /** The selected tabs that are still open, in the order `tabs` listed them. */
  readonly tabs: readonly TabInfo[];
  /**
   * The windows the selection empties, ascending. Closing those tabs closes the window
   * too, so the button says so: "Chiudi N schede e la finestra".
   */
  readonly wholeWindowIds: readonly number[];
  /** The active tab of the focused window, when the selection includes it. */
  readonly activeTab?: TabInfo;
  /** More than `BULK_CONFIRM_LIMIT` tabs are going at once. */
  readonly bulk: boolean;
  /**
   * The bar has to ask before it closes anything. Emptying a window does not: §9 changes
   * the button's wording for that one, and wording is not a question.
   */
  readonly needsConfirmation: boolean;
}

/**
 * The three safeguards of PLAN.md §9, computed together because the bar shows them
 * together: one of them renames the button and the other two put a confirmation in front
 * of it.
 */
export function safeguardsFor(input: SafeguardInput): Safeguards {
  const wanted = new Set(input.selectedIds);
  const tabs = input.tabs.filter((tab) => wanted.has(tab.id));

  const open = new Map<number, number>();
  const picked = new Map<number, number>();
  for (const tab of input.tabs) open.set(tab.windowId, (open.get(tab.windowId) ?? 0) + 1);
  for (const tab of tabs) picked.set(tab.windowId, (picked.get(tab.windowId) ?? 0) + 1);
  const wholeWindowIds = [...picked.keys()]
    .filter((windowId) => picked.get(windowId) === open.get(windowId))
    .sort((a, b) => a - b);

  const focused = input.focusedWindowId;
  const activeTab =
    focused === undefined ? undefined : tabs.find((tab) => tab.active && tab.windowId === focused);
  const bulk = tabs.length > BULK_CONFIRM_LIMIT;

  return {
    tabs,
    wholeWindowIds,
    ...(activeTab === undefined ? {} : { activeTab }),
    bulk,
    needsConfirmation: activeTab !== undefined || bulk,
  };
}

/** One entry of `sessions.getRecentlyClosed`, reduced to what a restore reads. */
export interface ClosedTab {
  readonly sessionId?: string;
  readonly url?: string;
}

/** How one archived tab comes back. */
export interface RestoreStep {
  readonly entry: ArchivedTab;
  /**
   * Set when the browser still remembers the closed tab: `sessions.restore` brings back
   * its history and its scroll position, which `tabs.create` cannot (PLAN.md §9).
   */
  readonly sessionId?: string;
}

/**
 * Pairs the tabs to restore with the browser's recently closed sessions, by URL
 * (PLAN.md §9).
 *
 * Each session is used at most once, so two archived copies of the same page do not both
 * claim the same `sessionId` and quietly come back as one tab. `getRecentlyClosed` answers
 * newest first, so the first claim on a URL gets the freshest session.
 *
 * URLs are compared with `keepKey`, like every other store keyed by URL: a page that came
 * back with a different `utm_*` is the page the user closed.
 */
export function planRestores(
  entries: readonly ArchivedTab[],
  closed: readonly ClosedTab[],
): readonly RestoreStep[] {
  const available = new Map<string, string[]>();
  for (const tab of closed) {
    if (tab.sessionId === undefined || tab.url === undefined) continue;
    const key = keepKey(tab.url);
    const queue = available.get(key);
    if (queue === undefined) available.set(key, [tab.sessionId]);
    else queue.push(tab.sessionId);
  }

  return entries.map((entry) => {
    const sessionId = available.get(keepKey(entry.url))?.shift();
    return sessionId === undefined ? { entry } : { entry, sessionId };
  });
}
