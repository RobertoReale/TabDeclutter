/**
 * How useless a tab is, 0 to 100, and why (PLAN.md §6.4, §6.5).
 *
 * Three steps, in this order:
 *
 * 1. Protections. A pinned, playing, active, young, protected or kept tab scores 0 and
 *    is never suggested. This step wins over everything below it.
 * 2. Strong rules. A duplicate, or an empty tab nobody came back to, gets its score set
 *    outright — no additions, no multiplier.
 * 3. Additions. Inactivity, plus the signals that say the page has already served its
 *    purpose, capped at 100 and lowered for tabs the user filed in a group.
 *
 * Every number lives in `scoring.config.ts`; this module only reads them. The clock is
 * injected (`now`), so the same inputs always give the same answer — the property the
 * tests and the fixtures rest on. One pass over the tabs, plus the window roll-up, so the
 * whole thing stays O(n) (PLAN.md §11: 1000 tabs under 15 ms).
 *
 * The result carries the reason *data*, never a sentence: the wording is i18n's (PLAN.md
 * §6.5, invariant 11), and `src/core/` has no strings to translate.
 */

import { classify, type PageType } from './classify';
import {
  chooseTabToKeep,
  duplicateKey,
  duplicateOptions,
  tabUrl,
  type DuplicateOptions,
  type DuplicateSet,
} from './duplicates';
import { DEFAULT_SCORING_CONFIG, type ScoringConfig } from './scoring.config';
import { clamp, DAY } from './time';
import {
  BOOTSTRAP_GRACE_MS,
  DEFAULT_MATCH_OPTIONS,
  NO_GROUP_ID,
  type ActivityStore,
  type Keeps,
  type Settings,
  type TabInfo,
} from './types';
import { isSuspendedUrl, normalizeUrl } from './url';

/** Where a score puts a tab in Declutter (PLAN.md §4.2). */
export type Bucket = 'close' | 'review' | 'keep';

/** Why a tab scored 0 and is not on the list at all (PLAN.md §6.4, step 1). */
export type ProtectionCode =
  | 'hidden'
  | 'pinned'
  | 'audible'
  | 'active'
  | 'own-page'
  | 'protected-site'
  | 'kept'
  | 'grace'
  | 'bootstrap'
  | 'grouped';

/**
 * One signal that pushed the score up, with what the sentence about it needs.
 *
 * Durations are raw milliseconds and counts are raw counts: the UI formats them for the
 * current language, and nothing here presumes "12 giorni" over "12 days".
 */
export type Reason =
  /** Another tab is showing the same page, and that one is the keeper. */
  | { readonly code: 'duplicate'; readonly points: number; readonly keptTabId: number }
  /** Same page as `otherTabId` bar the query string or the fragment. */
  | { readonly code: 'near-duplicate'; readonly points: number; readonly otherTabId: number }
  /** An empty tab, long untouched. */
  | { readonly code: 'blank'; readonly points: number }
  /** Untouched for `idleMs`. */
  | { readonly code: 'stale'; readonly points: number; readonly idleMs: number }
  /** A page that has already done its job (PLAN.md §6.3). */
  | { readonly code: 'search' | 'auth' | 'browser-internal' | 'error'; readonly points: number }
  /** Opened, barely looked at. */
  | {
      readonly code: 'low-engagement';
      readonly points: number;
      readonly activations: number;
      readonly foregroundMs: number;
    }
  /** Already in the bookmarks, so closing it loses nothing. */
  | { readonly code: 'bookmarked'; readonly points: number }
  /** The browser has already dropped the page from memory. */
  | { readonly code: 'discarded'; readonly points: number }
  /** Every tab of its window is stale (PLAN.md §4.3). */
  | {
      readonly code: 'forgotten-window';
      readonly points: number;
      readonly tabCount: number;
      readonly idleMs: number;
    };

export type ReasonCode = Reason['code'];

/**
 * The one line Declutter shows under the title (PLAN.md §6.4, "primary reason").
 *
 * Not a `ReasonCode`: the spec's priority list names what the row says, which is coarser
 * than the signals — `transient` stands for any already-consulted page, `stale-unread`
 * for the pair "old and never read", `protected` for step 1 (see `protectedBy` for
 * which protection) and `review` for a tab with no headline reason.
 */
export type PrimaryReason =
  'protected' | 'duplicate' | 'blank' | 'transient' | 'stale-unread' | 'stale' | 'review';

/** One tab's verdict. */
export interface ScoredTab {
  readonly tabId: number;
  readonly windowId: number;
  /** 0 to 100, an integer. */
  readonly score: number;
  readonly bucket: Bucket;
  readonly primaryReason: PrimaryReason;
  /** Everything that counted, in the order the rules ran. Empty for a protected tab. */
  readonly reasons: readonly Reason[];
  /** Set only when the tab is protected, and then the score is 0. */
  readonly protectedBy?: ProtectionCode;
  /** What the page is (PLAN.md §6.3), so the UI need not classify it again. */
  readonly pageType: PageType;
  /** How long since the tab was last in the foreground. */
  readonly idleMs: number;
  /** What the additions were multiplied by: 1, or the group discount. */
  readonly multiplier: number;
}

/**
 * A window's roll-up, which is what the §4.3 card ("Finestra con 12 schede non toccata
 * da 3 settimane") is built from.
 *
 * §4.3 words the condition as "all the tabs of a window are to close", but taken
 * literally that can never happen: every window has an active tab, and step 1 protects
 * it. `forgotten` is the condition the score itself uses — every tab of the window
 * untouched for longer than `staleDays` — and `closeCount` is there for the sentence.
 * See docs/DECISIONS.md.
 */
export interface ScoredWindow {
  readonly windowId: number;
  readonly tabCount: number;
  /** How many of its tabs landed in the `close` bucket. */
  readonly closeCount: number;
  /** Since the most recently used tab of the window was used. */
  readonly idleMs: number;
  readonly forgotten: boolean;
}

export interface ScoringResult {
  readonly tabs: readonly ScoredTab[];
  /** In the order the windows first appear in `tabs`. */
  readonly windows: readonly ScoredWindow[];
}

/** What the score cannot read off the tabs themselves. */
export interface ScoringContext {
  /**
   * The duplicate sets, when the caller has already computed them (the guard has, and
   * invariant 9 says there is only one definition). Computed here when absent, with the
   * same `findDuplicateSets`.
   */
  readonly duplicates?: readonly DuplicateSet[];
  /** `patterns.compile(whitelist).match`: URLs allowed to have duplicates (PLAN.md §8.3). */
  readonly isWhitelisted?: (url: string) => boolean;
  /** "Siti protetti" (PLAN.md §4.6): domain patterns such as `*.atlassian.net`. */
  readonly protectedSites?: readonly string[];
  /** `local:keeps` (PLAN.md §10): the user's "Mantieni", by `keepKey`. */
  readonly keeps?: Keeps;
  /** The bookmarked URLs, by `keepKey`, when the caller asked for the permission. */
  readonly bookmarkedUrls?: ReadonlySet<string>;
  /** `browser.runtime.getURL('')`, so the extension's own pages are protected. */
  readonly ownOrigin?: string;
  /** The window the user is looking at, for the duplicate keeper's priority. */
  readonly focusedWindowId?: number;
  /** The tabs that navigated to their URL, for the duplicate keeper's priority. */
  readonly navigatedTabIds?: ReadonlySet<number>;
}

/**
 * How a URL is keyed in `keeps` and in `bookmarkedUrls`.
 *
 * Deliberately the *default* comparison options and not the user's: a keep is a promise
 * about one page, and changing a match setting must not silently forget it. Whoever
 * writes those stores has to key them with this same function.
 */
export function keepKey(url: string): string {
  return normalizeUrl(url, DEFAULT_MATCH_OPTIONS);
}

/** The host of `url`, lower-case, or `''` when it has none (`about:blank`, a file). */
function hostOf(url: string): string {
  try {
    return new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Normalizes a "Siti protetti" list once per `scoreTabs` call: `*.atlassian.net` and
 * `atlassian.net` mean the same domain, and empty entries are dropped upfront.
 */
function normalizeProtectedSites(sites: readonly string[] | undefined): readonly string[] {
  if (sites === undefined || sites.length === 0) return [];
  const normalized: string[] = [];
  for (const pattern of sites) {
    let domain = pattern.trim().toLowerCase();
    if (domain.startsWith('*.')) domain = domain.slice(2);
    if (domain !== '') normalized.push(domain);
  }
  return normalized;
}

/** A pre-normalized "Siti protetti" domain against a lower-cased host. */
function matchesNormalizedSite(domain: string, host: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Everything about one tab the rules need, read once. */
interface TabFacts {
  readonly tab: TabInfo;
  readonly url: string;
  readonly type: PageType;
  /** Since it was last in the foreground. Never negative. */
  readonly idleMs: number;
  /** Since it was opened. Never negative. */
  readonly ageMs: number;
  readonly activations: number;
  readonly foregroundMs: number;
  readonly bootstrappedAt?: number;
}

function factsOf(tab: TabInfo, activity: ActivityStore, now: number, ownOrigin?: string): TabFacts {
  const url = tabUrl(tab);
  const record = activity[tab.id];

  // PLAN.md §6.1: the browser's own `lastAccessed` counts too, so a tab the tracker was
  // not running for is not reported as ancient. A tab with neither is one nothing is
  // known about: treated as touched now, which the grace period then protects, because a
  // wrong suggestion costs the user more than a missing one (PLAN.md §3).
  const seen = Math.max(record?.lastActiveAt ?? 0, tab.lastAccessed ?? 0);
  const lastActive = seen > 0 ? seen : now;
  const createdAt = record?.createdAt ?? lastActive;

  return {
    tab,
    url,
    type: classify({ url, title: tab.title }, { ownOrigin }),
    idleMs: Math.max(0, now - lastActive),
    ageMs: Math.max(0, now - createdAt),
    activations: record?.activations ?? 0,
    foregroundMs: record?.foregroundMs ?? 0,
    bootstrappedAt: record?.bootstrappedAt,
  };
}

/** The window roll-up, before any tab has a bucket. */
interface WindowFacts {
  windowId: number;
  tabCount: number;
  /** The smallest `idleMs` of its tabs: "how long since this window was touched". */
  idleMs: number;
  closeCount: number;
}

/** A tab with its window's roll-up in hand, so no rule has to look a window up again. */
interface RolledTab {
  readonly fact: TabFacts;
  readonly window: WindowFacts;
}

function rollUpWindows(facts: readonly TabFacts[]): {
  rolled: readonly RolledTab[];
  /** In the order the windows first appear in `facts`. */
  windows: readonly WindowFacts[];
} {
  const byId = new Map<number, WindowFacts>();
  const rolled: RolledTab[] = [];

  for (const fact of facts) {
    const windowId = fact.tab.windowId;
    let window = byId.get(windowId);
    if (window === undefined) {
      window = { windowId, tabCount: 1, idleMs: fact.idleMs, closeCount: 0 };
      byId.set(windowId, window);
    } else {
      window.tabCount += 1;
      window.idleMs = Math.min(window.idleMs, fact.idleMs);
    }
    rolled.push({ fact, window });
  }

  return { rolled, windows: [...byId.values()] };
}

/** For each duplicate set, which tab survives: the others are the duplicates. */
function mapDuplicates(
  sets: readonly DuplicateSet[],
  settings: Settings,
  createdAt: Record<number, number>,
  context: ScoringContext,
): Map<number, number> {
  const duplicateOf = new Map<number, number>();
  const keepContext = {
    settings: settings.guard,
    createdAt,
    navigatedTabIds: context.navigatedTabIds,
    focusedWindowId: context.focusedWindowId,
  };

  for (const set of sets) {
    const keeper = chooseTabToKeep(set.tabs, keepContext);
    if (keeper === null) continue;
    for (const tab of set.tabs) {
      if (tab.id !== keeper.id) duplicateOf.set(tab.id, keeper.id);
    }
  }
  return duplicateOf;
}

/** The tabs sharing a page bar the query string, and two of them to point at. */
interface NearGroup {
  readonly first: { readonly id: number; readonly key: string };
  /** The first member whose exact key differs from `first`'s, when there is one. */
  other?: { readonly id: number; readonly key: string };
}

/** One tab's place in its near-duplicate group. */
interface NearPlace {
  readonly group: NearGroup;
  /** Its own `duplicateKey`, to tell "same page" from "nearly the same page". */
  readonly exact: string;
}

/**
 * Groups the tabs by exact duplicate key (when `context.duplicates` was not supplied) and by
 * "same host and path" in a single pass, computing `exact` once per tab and skipping the
 * second URL parse for clean URLs without `?` or `#` (PLAN.md §6.4, §11).
 */
function indexDuplicatesAndNear(
  facts: readonly TabFacts[],
  options: DuplicateOptions,
  isWhitelisted: (url: string) => boolean,
  needSets: boolean,
): { readonly sets: readonly DuplicateSet[]; readonly near: Map<number, NearPlace> } {
  const nearOptions: DuplicateOptions = { ...options, ignoreAllParams: true, ignoreHash: true };
  const exactByKey = needSets ? new Map<string, TabInfo[]>() : null;
  const nearGroups = new Map<string, NearGroup>();
  const places = new Map<number, NearPlace>();

  for (const fact of facts) {
    if (fact.tab.hidden || isWhitelisted(fact.url)) continue;

    const exact = duplicateKey(fact.url, options, fact.tab.cookieStoreId);
    if (exactByKey !== null) {
      const bucket = exactByKey.get(exact);
      if (bucket === undefined) exactByKey.set(exact, [fact.tab]);
      else bucket.push(fact.tab);
    }

    // Empty tabs are left out of near-duplicates: several new tabs are not variants of one page.
    if (fact.type === 'blank') continue;

    // A URL with neither `?` nor `#` produces the exact same key when params and hash are ignored.
    const near =
      fact.url.includes('?') || fact.url.includes('#')
        ? duplicateKey(fact.url, nearOptions, fact.tab.cookieStoreId)
        : exact;

    let group = nearGroups.get(near);
    if (group === undefined) {
      group = { first: { id: fact.tab.id, key: exact } };
      nearGroups.set(near, group);
    } else if (group.other === undefined && group.first.key !== exact) {
      group.other = { id: fact.tab.id, key: exact };
    }
    places.set(fact.tab.id, { group, exact });
  }

  const sets: DuplicateSet[] = [];
  if (exactByKey !== null) {
    for (const [key, group] of exactByKey) {
      if (group.length > 1) sets.push({ key, tabs: group });
    }
  }
  return { sets, near: places };
}

/** The other tab showing nearly this page, or `undefined` when there is none. */
function nearDuplicateOf(tabId: number, places: Map<number, NearPlace>): number | undefined {
  // A tab with no place is one the grouping left out: hidden, empty or whitelisted.
  const place = places.get(tabId);
  if (place === undefined) return undefined;
  if (place.group.first.key !== place.exact) return place.group.first.id;
  return place.group.other?.id;
}

/** Step 1, in the order PLAN.md §6.4 lists it. `undefined` means "not protected". */
function protectionOf(
  fact: TabFacts,
  pass: Pass,
  keepKeyOf: () => string,
): ProtectionCode | undefined {
  const { tab } = fact;
  const { settings, now, context, protectedSites, hasKeeps } = pass;

  // Not a policy but a fact: a hidden tab is not on screen (PLAN.md §5.5).
  if (tab.hidden) return 'hidden';
  if (tab.pinned) return 'pinned';
  if (tab.audible) return 'audible';
  if (tab.active) return 'active';
  if (fact.type === 'own') return 'own-page';

  // The host is parsed only for a user who has protected sites: on a thousand tabs that
  // is a thousand URL parses saved (PLAN.md §11).
  if (protectedSites.length > 0) {
    const host = hostOf(fact.url);
    if (host !== '' && protectedSites.some((domain) => matchesNormalizedSite(domain, host))) {
      return 'protected-site';
    }
  }

  if (hasKeeps && context.keeps !== undefined) {
    // `null` is "Sempre"; a number is when the keep runs out (PLAN.md §10).
    const until = context.keeps[keepKeyOf()];
    if (until === null || (until !== undefined && until > now)) return 'kept';
  }

  if (fact.ageMs < settings.graceMs) return 'grace';
  if (fact.bootstrappedAt !== undefined && now - fact.bootstrappedAt < BOOTSTRAP_GRACE_MS) {
    return 'bootstrap';
  }
  if (tab.groupId !== NO_GROUP_ID && !settings.includeGroupedTabs) return 'grouped';

  return undefined;
}

/**
 * Step 3's inactivity curve (PLAN.md §6.4): nothing at all when the tab was just used,
 * the full weight once it has been idle for `staleDays`, and a logarithm in between so
 * the first days count for more than the later ones.
 */
function inactivityPoints(idleMs: number, staleDays: number, config: ScoringConfig): number {
  const days = idleMs / DAY;
  // `staleDays` comes from the settings, where the UI offers 1 to 30; a 0 would divide by
  // zero, so it is read as the shortest span the curve can describe.
  const span = Math.log(1 + Math.max(1, staleDays));
  return Math.round(config.inactivityPoints * clamp(Math.log(1 + days) / span, 0, 1));
}

/** The transient page types and what each is worth, once the tab has gone quiet. */
function transientReason(fact: TabFacts, config: ScoringConfig): Reason | undefined {
  if (fact.idleMs <= config.transientMinIdleMs) return undefined;
  switch (fact.type) {
    case 'search':
    case 'auth':
      return { code: fact.type, points: config.transientPoints };
    case 'browser-internal':
      // Extension document viewers (`chrome-extension://…` / `moz-extension://…`, e.g. Office
      // or PDF viewers) are not browser settings pages and should not be treated as transient.
      if (
        fact.url.toLowerCase().startsWith('chrome-extension:') ||
        fact.url.toLowerCase().startsWith('moz-extension:')
      ) {
        return undefined;
      }
      return { code: 'browser-internal', points: config.transientPoints };
    case 'error':
      return { code: 'error', points: config.errorPoints };
    default:
      return undefined;
  }
}

function bucketOf(score: number, config: ScoringConfig): Bucket {
  if (score >= config.closeBucketMin) return 'close';
  if (score >= config.reviewBucketMin) return 'review';
  return 'keep';
}

/**
 * The headline reason, by the priority of PLAN.md §6.4 — the one place that priority is
 * written down, which is why step 2 asks this function too instead of naming its own.
 *
 * `transient` is only ever the headline for a page that was consulted and left behind: an
 * error page gets its points but never the sentence, because "this page failed" says
 * nothing about whether to close it.
 */
function primaryReasonOf(reasons: readonly Reason[]): PrimaryReason {
  const has = (code: ReasonCode): boolean => reasons.some((reason) => reason.code === code);

  if (has('duplicate')) return 'duplicate';
  if (has('blank')) return 'blank';
  if (has('search') || has('auth') || has('browser-internal')) return 'transient';
  if (has('stale')) return has('low-engagement') ? 'stale-unread' : 'stale';
  return 'review';
}

/**
 * The uselessness score of every tab, and the window roll-up the §4.3 card needs.
 *
 * `now` is injected and nothing else reads a clock, so the answer is a function of the
 * arguments alone. Tabs come back in the order they were given.
 */
export function scoreTabs(
  tabs: readonly TabInfo[],
  activity: ActivityStore,
  settings: Settings,
  now: number,
  context: ScoringContext = {},
): ScoringResult {
  const config = DEFAULT_SCORING_CONFIG;
  const isWhitelisted = context.isWhitelisted ?? ((): boolean => false);
  const staleMs = Math.max(1, settings.staleDays) * DAY;

  const facts = tabs.map((tab) => factsOf(tab, activity, now, context.ownOrigin));
  const { rolled, windows } = rollUpWindows(facts);

  const createdAt: Record<number, number> = {};
  for (const tab of tabs) {
    const record = activity[tab.id];
    if (record !== undefined) createdAt[tab.id] = record.createdAt;
  }

  const indexed = indexDuplicatesAndNear(
    facts,
    duplicateOptions(settings),
    isWhitelisted,
    context.duplicates === undefined,
  );
  const sets = context.duplicates ?? indexed.sets;
  const pass: Pass = {
    config,
    settings,
    now,
    context,
    staleMs,
    protectedSites: normalizeProtectedSites(context.protectedSites),
    hasKeeps: context.keeps !== undefined && Object.keys(context.keeps).length > 0,
    hasBookmarks: context.bookmarkedUrls !== undefined && context.bookmarkedUrls.size > 0,
    duplicateOf: mapDuplicates(sets, settings, createdAt, context),
    near: indexed.near,
  };

  const scored: ScoredTab[] = [];
  for (const { fact, window } of rolled) {
    const tab = scoreOne(fact, window, pass);
    if (tab.bucket === 'close') window.closeCount += 1;
    scored.push(tab);
  }

  return {
    tabs: scored,
    windows: windows.map((window) => ({
      windowId: window.windowId,
      tabCount: window.tabCount,
      closeCount: window.closeCount,
      idleMs: window.idleMs,
      forgotten: window.idleMs > staleMs,
    })),
  };
}

/** What `scoreOne` needs that is the same for every tab of the call. */
interface Pass {
  readonly config: ScoringConfig;
  readonly settings: Settings;
  readonly now: number;
  readonly context: ScoringContext;
  readonly staleMs: number;
  readonly protectedSites: readonly string[];
  readonly hasKeeps: boolean;
  readonly hasBookmarks: boolean;
  readonly duplicateOf: Map<number, number>;
  readonly near: Map<number, NearPlace>;
}

function scoreOne(fact: TabFacts, window: WindowFacts, pass: Pass): ScoredTab {
  const { config, settings, context } = pass;
  const common = {
    tabId: fact.tab.id,
    windowId: fact.tab.windowId,
    pageType: fact.type,
    idleMs: fact.idleMs,
  };
  let cachedKeepKey: string | undefined;
  const keepKeyOf = (): string => (cachedKeepKey ??= keepKey(fact.url));

  // Step 1. A protected tab is not scored at all, and no reason is collected for it:
  // nothing about it is on the list to explain.
  const protectedBy = protectionOf(fact, pass, keepKeyOf);
  if (protectedBy !== undefined) {
    return {
      ...common,
      score: 0,
      bucket: 'keep',
      primaryReason: 'protected',
      reasons: [],
      protectedBy,
      multiplier: 1,
    };
  }

  // Step 2. Both rules set the score outright: no additions, and no group discount —
  // a duplicate inside a group is still the same page twice.
  const keptTabId = fact.type === 'blank' ? undefined : pass.duplicateOf.get(fact.tab.id);
  if (keptTabId !== undefined) {
    const reasons: readonly Reason[] = [
      { code: 'duplicate', points: config.duplicatePoints, keptTabId },
    ];
    return {
      ...common,
      score: config.duplicatePoints,
      bucket: bucketOf(config.duplicatePoints, config),
      primaryReason: primaryReasonOf(reasons),
      reasons,
      multiplier: 1,
    };
  }

  // "Empty and inactive": an empty tab the user came back to minutes ago is a tab they
  // are using, whatever its age (PLAN.md §6.4, docs/DECISIONS.md).
  if (fact.type === 'blank' && fact.idleMs > config.transientMinIdleMs) {
    const reasons: readonly Reason[] = [{ code: 'blank', points: config.blankPoints }];
    return {
      ...common,
      score: config.blankPoints,
      bucket: bucketOf(config.blankPoints, config),
      primaryReason: primaryReasonOf(reasons),
      reasons,
      multiplier: 1,
    };
  }

  // Step 3. Every rule that fires adds its own points, and the score is their sum, so
  // the "why" panel of §6.5 adds up to the number the user is shown.
  const reasons: Reason[] = [];

  const stalePoints = inactivityPoints(fact.idleMs, settings.staleDays, config);
  if (stalePoints > 0) reasons.push({ code: 'stale', points: stalePoints, idleMs: fact.idleMs });

  const transient = transientReason(fact, config);
  if (transient !== undefined) reasons.push(transient);

  if (
    fact.activations <= config.lowEngagementMaxActivations &&
    fact.foregroundMs < config.lowEngagementMaxForegroundMs
  ) {
    reasons.push({
      code: 'low-engagement',
      points: config.lowEngagementPoints,
      activations: fact.activations,
      foregroundMs: fact.foregroundMs,
    });
  }

  const otherTabId = nearDuplicateOf(fact.tab.id, pass.near);
  if (otherTabId !== undefined) {
    reasons.push({ code: 'near-duplicate', points: config.nearDuplicatePoints, otherTabId });
  }

  if (pass.hasBookmarks && context.bookmarkedUrls?.has(keepKeyOf()) === true) {
    reasons.push({ code: 'bookmarked', points: config.bookmarkedPoints });
  }

  if (fact.tab.discarded || isSuspendedUrl(fact.tab.url)) {
    reasons.push({ code: 'discarded', points: config.discardedPoints });
  }

  if (window.idleMs > pass.staleMs) {
    reasons.push({
      code: 'forgotten-window',
      points: config.forgottenWindowPoints,
      tabCount: window.tabCount,
      idleMs: window.idleMs,
    });
  }

  const total = reasons.reduce((sum, reason) => sum + reason.points, 0);
  const grouped = fact.tab.groupId !== NO_GROUP_ID;
  const multiplier = grouped ? config.groupedMultiplier : 1;
  const score = clamp(Math.round(total * multiplier), 0, config.maxScore);

  return {
    ...common,
    score,
    bucket: bucketOf(score, config),
    primaryReason: primaryReasonOf(reasons),
    reasons,
    multiplier,
  };
}
