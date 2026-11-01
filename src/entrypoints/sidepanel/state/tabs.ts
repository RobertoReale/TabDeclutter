/**
 * What the panel knows about the browser, and how it stays current.
 *
 * PLAN.md §5.2: the panel reads `browser.tabs` itself, computes the scores with
 * `src/core/` and sends no messages to the background. The background only
 * *writes* what it observes (activity, settings, keeps), so the panel follows it
 * through `storage.onChanged` and follows the browser through `tabs.on*`.
 *
 * **One snapshot, one score.** Everything a score depends on is read together
 * into a single `PanelData` and `scoreTabs` is a pure function of it, so the
 * header, the sections and the rows can never disagree about which moment they
 * are describing. `now` is part of the snapshot for the same reason.
 *
 * **Reloads are coalesced.** Restoring a window is dozens of events and must
 * cost one read: the first event starts a `debounceMs` window (PLAN.md §5.2 asks
 * for 150 ms) and everything that arrives inside it is already covered, because
 * the reload at the end reads the whole state anyway. That bounds the latency at
 * one window, which restarting the timer on every event would not.
 *
 * Exposed as signals, so a change only re-renders what read it (PLAN.md §11):
 * the derived counts are numbers, and a recompute that lands on the same number
 * notifies nobody.
 */

import { computed, signal } from '@preact/signals';

import { compile } from '@/core/patterns';
import type { ScoringResult } from '@/core/scoring';
import { scoreTabs } from '@/core/scoring';
import type { ActivityStore, Keeps, Settings, TabInfo } from '@/core/types';
import { NO_GROUP_ID } from '@/core/types';
import {
  activityItem,
  duplicateWhitelistItem,
  keepsItem,
  protectedDomainsItem,
  readKeeps,
  readSettings,
  settingsItem,
} from '@/platform/storage';

/** PLAN.md §5.2 asks for a 150 ms debounce on the tab events. */
const RELOAD_DEBOUNCE_MS = 150;

/** `windows.WINDOW_ID_NONE`, for a tab that belongs to no window. */
const NO_WINDOW = -1;

/** `local:activity` → `activity`: the key the browser reports a change under. */
function bareKey(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}

/**
 * The stored values a score depends on, under the names `onChanged` reports.
 * Derived from the items themselves, so the two can never drift apart.
 */
const WATCHED: readonly string[] = [
  activityItem,
  keepsItem,
  settingsItem,
  protectedDomainsItem,
  duplicateWhitelistItem,
].map((item) => bareKey(item.key));

/** Everything one score is computed from, read in one pass. */
export interface PanelData {
  /** The open tabs, in the browser's order, without the hidden ones. */
  readonly tabs: readonly TabInfo[];
  readonly activity: ActivityStore;
  readonly settings: Settings;
  readonly keeps: Keeps;
  /** "Siti protetti" (PLAN.md §4.6). */
  readonly protectedSites: readonly string[];
  /** The duplicate whitelist, as the user wrote it (PLAN.md §8.3). */
  readonly whitelist: readonly string[];
  /** The window the panel is in, which is the one the user is looking at. */
  readonly focusedWindowId?: number;
  /** `browser.runtime.getURL('')`, so the extension's own pages are protected. */
  readonly ownOrigin: string;
  /** When the snapshot was taken: the clock the score is a function of. */
  readonly at: number;
}

const EMPTY_SCORING: ScoringResult = { tabs: [], windows: [] };

/** The snapshot, or `null` until the first read comes back. */
export const panelData = signal<PanelData | null>(null);

/** Whether the panel has anything to show yet. */
export const loaded = computed(() => panelData.value !== null);

export const tabs = computed<readonly TabInfo[]>(() => panelData.value?.tabs ?? []);

export const tabCount = computed(() => tabs.value.length);

/**
 * How many windows those tabs are spread over.
 *
 * Counted from the tabs rather than asked of `windows.getAll()`: every window
 * has at least one tab, so the answer is the same and the panel makes one call
 * instead of two (PLAN.md §3, §11).
 */
export const windowCount = computed(() => new Set(tabs.value.map((tab) => tab.windowId)).size);

/** Every tab's verdict, PLAN.md §6.4. */
export const scoring = computed<ScoringResult>(() => {
  const data = panelData.value;
  if (data === null) return EMPTY_SCORING;
  return scoreTabs(data.tabs, data.activity, data.settings, data.at, {
    // Compiled once per score, never once per tab (PLAN.md §8.3).
    isWhitelisted: compile(data.whitelist).match,
    protectedSites: data.protectedSites,
    keeps: data.keeps,
    ownOrigin: data.ownOrigin,
    focusedWindowId: data.focusedWindowId,
  });
});

/**
 * How many tabs the score suggests looking at: the "23 da rivedere" of §4.2.
 * Everything that is not `keep`, which is exactly what the Declutter view lists.
 */
export const reviewCount = computed(
  () => scoring.value.tabs.filter((tab) => tab.bucket !== 'keep').length,
);

export interface PanelStateOptions {
  /** The clock, injected so the tests can be exact. */
  readonly now?: () => number;
  /** How long events are coalesced. Defaults to `RELOAD_DEBOUNCE_MS`. */
  readonly debounceMs?: number;
}

export interface PanelStateHandle {
  /** Reads the whole state now, without waiting for the debounce. */
  refresh(): Promise<void>;
  /** Stops the debounce. The listeners live as long as the document does. */
  stop(): void;
}

/**
 * Starts following the browser and asks for the first read.
 *
 * The listeners are registered before that read is asked for, so nothing that
 * happens while it is in flight goes unnoticed.
 */
export function startPanelState(options: PanelStateOptions = {}): PanelStateHandle {
  const now = options.now ?? Date.now;
  const debounceMs = options.debounceMs ?? RELOAD_DEBOUNCE_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  /** One read at a time, so a late answer cannot overwrite a newer snapshot. */
  let chain: Promise<unknown> = Promise.resolve();

  function refresh(): Promise<void> {
    const next = chain.then(reload, reload);
    chain = next.then(ignore, ignore);
    return next;
  }

  async function reload(): Promise<void> {
    panelData.value = await read(now());
  }

  /** What every listener does: ask for a read, at most once per window. */
  function schedule(): void {
    timer ??= setTimeout(() => {
      timer = undefined;
      void refresh().catch(failed);
    }, debounceMs);
  }

  // Everything that can change which tabs are open, where they are, or what they
  // show. `onUpdated` carries the title, the favicon and the URL, so it is the
  // noisiest of them and the reason the debounce exists.
  browser.tabs.onCreated.addListener(schedule);
  browser.tabs.onRemoved.addListener(schedule);
  browser.tabs.onMoved.addListener(schedule);
  browser.tabs.onUpdated.addListener(schedule);
  browser.tabs.onActivated.addListener(schedule);
  browser.tabs.onAttached.addListener(schedule);
  browser.tabs.onDetached.addListener(schedule);
  // Chrome gives a discarded tab a new id; Firefox never fires this (PLAN.md §5.5).
  browser.tabs.onReplaced?.addListener(schedule);

  // The background's side of PLAN.md §5.2: it writes what it observes, and the
  // panel hears about it here. `session:` holds only the guard's state, which the
  // Declutter list does not read, so `local` is the only area worth watching.
  browser.storage.onChanged.addListener((changes: Record<string, unknown>, area: string) => {
    if (area !== 'local') return;
    if (WATCHED.some((key) => key in changes)) schedule();
  });

  void refresh().catch(failed);

  return {
    refresh,
    stop: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** One pass over everything a score needs. */
async function read(at: number): Promise<PanelData> {
  const [browserTabs, activity, settings, keeps, protectedSites, whitelist, focusedWindowId] =
    await Promise.all([
      browser.tabs.query({}),
      activityItem.getValue(),
      readSettings(),
      readKeeps(at),
      protectedDomainsItem.getValue(),
      duplicateWhitelistItem.getValue(),
      currentWindowId(),
    ]);

  return {
    tabs: asTabInfos(browserTabs as BrowserTab[]),
    activity,
    settings,
    keeps,
    protectedSites,
    whitelist,
    focusedWindowId,
    ownOrigin: browser.runtime.getURL(''),
    at,
  };
}

/**
 * What this module needs of a tab, whichever browser's type it came from.
 *
 * `platform/tabs.ts` owns this mapping once the panel starts acting on tabs
 * (PLAN.md §5.3); until then the only reader is this module. See
 * docs/DECISIONS.md.
 */
interface BrowserTab {
  id?: number;
  windowId?: number;
  index?: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  favIconUrl?: string;
  pinned?: boolean;
  audible?: boolean;
  active?: boolean;
  discarded?: boolean;
  hidden?: boolean;
  groupId?: number;
  cookieStoreId?: string;
  incognito?: boolean;
  openerTabId?: number;
  lastAccessed?: number;
}

/**
 * The tabs the core reasons about: the ones with an id, minus the ones another
 * extension hid, which PLAN.md §5.5 excludes everywhere.
 */
function asTabInfos(browserTabs: readonly BrowserTab[]): readonly TabInfo[] {
  return browserTabs
    .filter((tab): tab is BrowserTab & { id: number } => tab.id !== undefined)
    .filter((tab) => tab.hidden !== true)
    .map((tab) => ({
      id: tab.id,
      windowId: tab.windowId ?? NO_WINDOW,
      index: tab.index ?? 0,
      url: tab.url ?? '',
      pendingUrl: tab.pendingUrl,
      title: tab.title ?? '',
      favIconUrl: tab.favIconUrl,
      pinned: tab.pinned === true,
      audible: tab.audible === true,
      active: tab.active === true,
      discarded: tab.discarded === true,
      hidden: false,
      groupId: tab.groupId ?? NO_GROUP_ID,
      cookieStoreId: tab.cookieStoreId,
      incognito: tab.incognito === true,
      openerTabId: tab.openerTabId,
      lastAccessed: tab.lastAccessed,
    }));
}

/**
 * The window the panel is docked in. It does not change for the panel's
 * lifetime, but it is read with the rest so the snapshot stays one function of
 * one moment; `windows.getCurrent` needs no permission and no window at all on
 * Firefox's sidebar, hence the fallback.
 */
async function currentWindowId(): Promise<number | undefined> {
  try {
    const current = (await browser.windows.getCurrent()) as { id?: number };
    return current.id;
  } catch {
    return undefined;
  }
}

function failed(error: unknown): void {
  console.error('TabDeclutter: panel state', error);
}

function ignore(): void {
  /* keeps the queue alive after a failed read */
}
