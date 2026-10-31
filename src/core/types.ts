/**
 * The shapes `src/core/` works on, and their default values.
 *
 * `src/core/` is pure TypeScript (TASKS.md §2.4): it never sees a `browser.tabs.Tab`.
 * `platform/tabs.ts` maps the two browsers' tab objects onto `TabInfo`, so the rules
 * below are written once and tested without an extension context.
 *
 * Every default lives here, in one module, so the settings UI, the storage defaults and
 * the tests cannot drift apart.
 */

import { DAY, HOUR } from './time';

/** `groupId` of a tab that is in no tab group (Chrome's `TAB_GROUP_ID_NONE`). */
export const NO_GROUP_ID = -1;

/**
 * A browser tab, reduced to what the core reasons about.
 *
 * Optional fields are the ones a browser may genuinely not provide:
 * `lastAccessed` disappears when a tab is discarded (PLAN.md §6.1), `pendingUrl` is
 * Chrome-only, `cookieStoreId` is Firefox's container (PLAN.md §5.5).
 */
export interface TabInfo {
  id: number;
  windowId: number;
  /** Position in its window, needed to restore a closed tab and to move a kept one. */
  index: number;
  url: string;
  /** Chrome: the URL a new tab is about to load. Unreliable or absent on Firefox. */
  pendingUrl?: string;
  title: string;
  favIconUrl?: string;
  pinned: boolean;
  /** Playing sound right now: a protection, not a suggestion (PLAN.md §6.4). */
  audible: boolean;
  active: boolean;
  /** Suspended by the browser to save memory. */
  discarded: boolean;
  /** Firefox only: hidden by another extension. Excluded everywhere (PLAN.md §5.5). */
  hidden: boolean;
  /** `NO_GROUP_ID` when the tab is in no group. */
  groupId: number;
  /** Firefox containers: the same URL in two containers is not a duplicate. */
  cookieStoreId?: string;
  incognito: boolean;
  /** The tab this one was opened from, when the browser reports it. */
  openerTabId?: number;
  /** ms epoch, last time the browser saw it in the foreground. */
  lastAccessed?: number;
}

/**
 * What the background tracker remembers about a tab, because the browser does not
 * (PLAN.md §6.1): `lastAccessed` is dropped on discard and absent from event payloads.
 */
export interface TabActivity {
  tabId: number;
  /** Last known URL, which is what reconciliation after a restart matches on. */
  url: string;
  /** ms epoch. */
  createdAt: number;
  /** ms epoch, last time the tab was in the foreground. */
  lastActiveAt: number;
  /** How many times the tab was activated. */
  activations: number;
  /** Cumulative foreground time in ms, approximate: it is counted without polling. */
  foregroundMs: number;
  /**
   * ms epoch at which this record was invented on first run rather than observed, from
   * `tab.lastAccessed` or from the clock. Such a tab is not suggested for the first
   * `BOOTSTRAP_GRACE_MS` (PLAN.md §6.4), because its history is guesswork.
   */
  bootstrappedAt?: number;
}

/**
 * What counts as the same URL, and therefore as a duplicate (PLAN.md §8.3, "URL
 * comparison"). One set of options for the Declutter list and for the live guard, so
 * that "duplicate" means one thing in the whole extension (TASKS.md §2.9).
 */
export interface MatchOptions {
  /** Compare the whole URL case-insensitively, not just the host. */
  ignoreCase: boolean;
  /** Treat `www.example.com` and `example.com` as the same host. */
  ignoreWww: boolean;
  /** Drop `#fragment`, except an SPA route (`#/…` on the root path). */
  ignoreHash: boolean;
  /** Drop `utm_*`, `fbclid` and the rest of `TRACKING_PARAMS`. */
  ignoreTrackingParams: boolean;
  /** Drop the query string entirely. */
  ignoreAllParams: boolean;
  /** Compare scheme and host only. Very aggressive; the UI warns about it. */
  ignorePath: boolean;
}

export const DEFAULT_MATCH_OPTIONS: MatchOptions = {
  ignoreCase: false,
  ignoreWww: true,
  ignoreHash: true,
  ignoreTrackingParams: true,
  ignoreAllParams: false,
  ignorePath: false,
};

/** What the guard does when it finds a duplicate (PLAN.md §8.1). */
export type GuardMode = 'off' | 'warn' | 'auto';

/** What happens to the surviving tab after a close (PLAN.md §8.3, §8.4.4). */
export type GuardAfterAction = 'none' | 'activate' | 'move-activate';

/** Which tab of a duplicate pair survives on age alone (PLAN.md §8.3). */
export type GuardKeepWhich = 'oldest' | 'newest' | 'oldest-reloaded';

/** How far the guard looks for a duplicate (PLAN.md §8.3). */
export type GuardScope = 'window' | 'all-windows';

/** The "Protezione duplicati" settings (PLAN.md §8.3). */
export interface GuardSettings {
  mode: GuardMode;
  after: GuardAfterAction;
  scope: GuardScope;
  keep: GuardKeepWhich;
  /** Keep the `https` tab, and treat `http` and `https` as equivalent. */
  preferHttps: boolean;
  keepPinned: boolean;
  /** Keep the tab the user is working on (only when an existing tab navigates). */
  keepActive: boolean;
  /** Only meaningful with the `all-windows` scope. */
  preferActiveWindow: boolean;
  /** Never close `about:blank` or a new tab page. */
  ignoreEmptyTabs: boolean;
  /** Never close a login or OAuth page, so sign-in flows are not interrupted. */
  ignoreAuthPages: boolean;
  /** Chrome only: respect a duplicate made with the browser's "Duplicate tab". */
  allowIntentionalDuplicates: boolean;
  /** Firefox only: the same URL in two containers is not a duplicate. */
  containersAreSeparate: boolean;
}

export const DEFAULT_GUARD_SETTINGS: GuardSettings = {
  // PLAN.md §8.3 leaves the mode to onboarding, with "Chiudi automaticamente"
  // preselected. Until the user has answered, the stored default may not close a tab
  // on its own (TASKS.md §2.2), so it warns.
  mode: 'warn',
  after: 'activate',
  scope: 'all-windows',
  keep: 'oldest',
  preferHttps: true,
  keepPinned: true,
  keepActive: true,
  preferActiveWindow: true,
  ignoreEmptyTabs: true,
  ignoreAuthPages: true,
  allowIntentionalDuplicates: true,
  containersAreSeparate: true,
};

/** The language of the panel: `auto` follows the browser's UI language. */
export type LanguageSetting = 'auto' | 'en' | 'it';

/**
 * `local:settings` (PLAN.md §10). The protected sites, the keeps and the duplicate
 * whitelist are storage keys of their own, so they are not repeated here.
 */
export interface Settings {
  /** A tab is "old" after this many days (PLAN.md §4.6: 1 / 3 / 7 / 14 / 30). */
  staleDays: number;
  /** A tab opened less than this long ago is never suggested, in ms. */
  graceMs: number;
  /** Include tabs that are in a group, with a reduced weight. */
  includeGroupedTabs: boolean;
  showBadge: boolean;
  /** Use the on-device model when the browser has one. */
  useOnDeviceAi: boolean;
  archiveRetentionDays: number;
  language: LanguageSetting;
  guard: GuardSettings;
  match: MatchOptions;
}

export const DEFAULT_SETTINGS: Settings = {
  staleDays: 7,
  graceMs: 2 * HOUR,
  includeGroupedTabs: true,
  showBadge: true,
  useOnDeviceAi: true,
  archiveRetentionDays: 30,
  language: 'auto',
  guard: DEFAULT_GUARD_SETTINGS,
  match: DEFAULT_MATCH_OPTIONS,
};

/** How long a record invented on first run is left out of the suggestions. */
export const BOOTSTRAP_GRACE_MS = DAY;

/** The archive holds at most this many entries, oldest dropped first (PLAN.md §10). */
export const ARCHIVE_CAP = 1000;

/** Why a tab was closed, which the Archive view filters on (PLAN.md §4.5, §8.5). */
export type ArchiveReason =
  /** The user closed it from the panel. */
  | 'manual'
  /** The guard closed it by itself, in `auto` mode. */
  | 'duplicate-auto'
  /** The user asked for "Chiudi tutti i duplicati". */
  | 'duplicate-manual'
  /** It went with its window. */
  | 'window';

/** A closed tab, kept so it can be restored (PLAN.md §9). */
export interface ArchivedTab {
  /** Our own id, not a tab id: tab ids are reused. */
  id: string;
  url: string;
  title: string;
  /** Only ever a `data:` URL: a remote favicon would mean a network request. */
  favIconUrl?: string;
  /** ms epoch. */
  closedAt: number;
  reason: ArchiveReason;
  windowId: number;
  index: number;
  /** The title of the group it was in, since group ids do not survive a restart. */
  groupTitle?: string;
  /** For `duplicate-*`: the URL of the tab that was kept instead. */
  duplicateOfUrl?: string;
}

/**
 * `local:keeps` (PLAN.md §10): normalized URL → ms epoch at which the keep expires, or
 * `null` for "Sempre".
 */
export type Keeps = Record<string, number | null>;

/** How long "Mantieni" lasts by default (PLAN.md §6.4). */
export const DEFAULT_KEEP_MS = 7 * DAY;

/** `local:activity` (PLAN.md §10), keyed by tab id. */
export type ActivityStore = Record<number, TabActivity>;

/** A tab the guard must leave alone for a while (PLAN.md §8.6). */
export interface GuardExemption {
  tabId?: number;
  url?: string;
  /** ms epoch. */
  until: number;
}

/** `session:guardState` (PLAN.md §10). Lost on restart, on purpose. */
export interface GuardState {
  /** ms epoch, while the guard is paused. */
  pausedUntil?: number;
  /** The mode to return to when the pause ends. */
  resumeMode?: GuardMode;
  exemptions: GuardExemption[];
  /** The `ArchivedTab.id` of the last automatic close, for "Riapri l'ultimo duplicato". */
  lastAutoClosedId?: string;
}

export const DEFAULT_GUARD_STATE: GuardState = { exemptions: [] };

/** Tabs opened or restored by the extension are exempt for this long (PLAN.md §8.6). */
export const EXEMPTION_TTL_MS = 10_000;

/** No automatic close in the first seconds after the browser starts (PLAN.md §8.6). */
export const STARTUP_GRACE_MS = 15_000;
