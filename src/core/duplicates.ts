/**
 * What "duplicate" means, and which of two duplicates survives.
 *
 * Both answers live here once (TASKS.md §2.9, PLAN.md §6.2): the "Duplicati" section of
 * Declutter and the live guard call the same `duplicateKey` with the same options, and
 * both order their candidates with the same comparator, so the list the user reads and
 * the tab the guard closes can never disagree.
 *
 * This module answers only those two questions. The guard's exit filters — mode, empty
 * tabs, `auth` pages, incognito, exemptions, intentional duplicates (PLAN.md §8.4.1,
 * §8.6) — are the decision of `core/duplicate-guard.ts`, which is built on top of this
 * one; what Declutter chooses to leave out of its list is its own affair too. The only
 * exclusions here are the two that are not a policy but a fact: a `hidden` tab is not on
 * screen at all (PLAN.md §5.5), and a whitelisted URL is by definition allowed to have
 * duplicates (PLAN.md §8.3).
 */

import type { GuardSettings, MatchOptions, Settings, TabInfo } from './types';
import { normalizeUrl, unwrapSuspendedUrl } from './url';

/**
 * How to compare two URLs, and what else belongs to the identity of a page.
 *
 * `MatchOptions` is the "URL comparison" table of PLAN.md §8.3, stored as the user set
 * it. The two flags added here are not comparison options in the settings UI: they come
 * from the "Priority and exclusions" table, where one checkbox ("Prefer the HTTPS tab")
 * also says that `http` and `https` are equivalent, and another ("Treat containers as
 * separate") decides whether the container is part of the page's identity. Use
 * `duplicateOptions()` to derive them, so no caller has to remember which is which.
 *
 * Both default to `true` when absent, as in `DEFAULT_GUARD_SETTINGS`.
 */
export interface DuplicateOptions extends MatchOptions {
  /** `http://example.com` and `https://example.com` are the same page. */
  readonly treatHttpAsHttps?: boolean;
  /** Firefox: the same URL in two containers is a different session, not a duplicate. */
  readonly containersAreSeparate?: boolean;
}

/** The comparison options the stored settings add up to (PLAN.md §8.3). */
export function duplicateOptions(settings: Pick<Settings, 'match' | 'guard'>): DuplicateOptions {
  return {
    ...settings.match,
    treatHttpAsHttps: settings.guard.preferHttps,
    containersAreSeparate: settings.guard.containersAreSeparate,
  };
}

/** The two schemes that count as one, longest first so the prefixes cannot overlap. */
const HTTP_SCHEMES = ['https://', 'http://'] as const;

/** Stands in for both of them in a key. Not a scheme, and not meant to be read back. */
const EITHER_HTTP_SCHEME = 'http(s)://';

/**
 * Joins the container id to the rest of the key. A NUL cannot occur in a URL and no
 * browser puts one in a `cookieStoreId`, so no other pair of the two can spell the same
 * key.
 */
const SEPARATOR = '\u0000';

/**
 * The identity of the page a tab is showing: two tabs are duplicates when, and only
 * when, this returns the same string for both.
 *
 * It is an opaque key — only equality means anything, and nothing should be parsed back
 * out of it. `cookieStoreId` is Firefox's container (PLAN.md §5.5): included when the
 * caller passes one, because two accounts of the same site are two different pages. On
 * Chrome there is none to pass, which is why the core needs no browser check here.
 */
export function duplicateKey(
  url: string,
  options: DuplicateOptions,
  cookieStoreId?: string,
): string {
  let key = normalizeUrl(url, options);

  // Only the scheme: an explicit port is left as the URL gave it, `normalizeUrl` having
  // already dropped the one that is the scheme's own default. So `http://x:443` and
  // `https://x:443` remain two keys — they really are two endpoints, and neither is the
  // ordinary form of the other.
  if (options.treatHttpAsHttps ?? true) {
    for (const scheme of HTTP_SCHEMES) {
      if (key.startsWith(scheme)) {
        key = EITHER_HTTP_SCHEME + key.slice(scheme.length);
        break;
      }
    }
  }

  if ((options.containersAreSeparate ?? true) && cookieStoreId !== undefined) {
    return `${cookieStoreId}${SEPARATOR}${key}`;
  }
  return key;
}

/**
 * The URL a tab is showing, or the one it is about to show.
 *
 * A tab the browser has just created has an empty `url` and, on Chrome, the address in
 * `pendingUrl` (PLAN.md §5.5): without this it would be "the empty page" and would
 * duplicate every other loading tab.
 */
export function tabUrl(tab: Pick<TabInfo, 'url' | 'pendingUrl'>): string {
  const raw = tab.url !== '' ? tab.url : (tab.pendingUrl ?? '');
  return unwrapSuspendedUrl(raw);
}

/** Tabs showing one page, in the order they were given. */
export interface DuplicateSet {
  /** Their shared `duplicateKey`. Opaque. */
  readonly key: string;
  /** At least two. Not ordered by priority: that needs a `KeepContext`. */
  readonly tabs: readonly TabInfo[];
}

/**
 * Groups `tabs` by page, keeping only the pages that more than one tab is showing.
 *
 * Leaves out `hidden` tabs and the URLs `isWhitelisted` accepts (that predicate is
 * `patterns.compile(...).match`, which expects the tab's raw URL and not the key).
 * Everything else is returned: deciding what to do with a set — and which tab of it to
 * keep — is the caller's.
 *
 * The sets come out in the order their first tab appears, and each set holds its tabs in
 * the order they were given, so an unchanged tab list gives an unchanged answer.
 */
export function findDuplicateSets(
  tabs: readonly TabInfo[],
  options: DuplicateOptions,
  isWhitelisted: (url: string) => boolean,
): readonly DuplicateSet[] {
  const byKey = new Map<string, TabInfo[]>();

  for (const tab of tabs) {
    if (tab.hidden) continue;
    const url = tabUrl(tab);
    if (isWhitelisted(url)) continue;

    const key = duplicateKey(url, options, tab.cookieStoreId);
    const group = byKey.get(key);
    if (group === undefined) byKey.set(key, [tab]);
    else group.push(tab);
  }

  const sets: DuplicateSet[] = [];
  for (const [key, group] of byKey) {
    if (group.length > 1) sets.push({ key, tabs: group });
  }
  return sets;
}

/** What choosing between two duplicates needs beyond the tabs themselves. */
export interface KeepContext {
  /** Which of the rules below are on, and what "age" means (PLAN.md §8.3). */
  readonly settings: GuardSettings;
  /**
   * When each tab was opened, in ms epoch, by tab id — the tracker's `TabActivity`,
   * because the browser does not keep it (PLAN.md §6.1). A tab this does not cover has
   * an unknown age, and the age rule then cannot tell it apart from anything.
   */
  readonly createdAt?: Readonly<Record<number, number>>;
  /**
   * The tabs that reached their current URL by *navigating*, rather than by having just
   * been created with it. PLAN.md §8.4.3.2: only such a tab counts as "the tab the user
   * is working on", otherwise every link opened in the foreground would close the tab it
   * came from.
   */
  readonly navigatedTabIds?: ReadonlySet<number>;
  /** The window the user is looking at, when there is one. */
  readonly focusedWindowId?: number;
}

/** Negative keeps `a`: `true` wins, and two alike cannot be told apart. */
function preferring(a: boolean, b: boolean): number {
  if (a === b) return 0;
  return a ? -1 : 1;
}

/** Negative keeps `a`: the smaller value wins unless the rule is reversed. */
function ordering(a: number, b: number, reversed: boolean): number {
  if (a === b) return 0;
  const smallerFirst = a < b ? -1 : 1;
  return reversed ? -smallerFirst : smallerFirst;
}

function isNavigatedActive(tab: TabInfo, ctx: KeepContext): boolean {
  return tab.active && (ctx.navigatedTabIds?.has(tab.id) ?? false);
}

function isHttps(tab: TabInfo): boolean {
  return tabUrl(tab).trim().toLowerCase().startsWith('https:');
}

/**
 * PLAN.md §8.4.3, in order. Each returns a comparator result, or 0 for "this rule does
 * not tell them apart" — which is also what a rule the user switched off returns, so the
 * next one decides.
 */
const KEEP_RULES: readonly ((a: TabInfo, b: TabInfo, ctx: KeepContext) => number)[] = [
  // 1. The pinned tab. The user put it there.
  (a, b, ctx) => (ctx.settings.keepPinned ? preferring(a.pinned, b.pinned) : 0),

  // 2. The active tab that was navigated to this URL (see `navigatedTabIds`).
  (a, b, ctx) =>
    ctx.settings.keepActive ? preferring(isNavigatedActive(a, ctx), isNavigatedActive(b, ctx)) : 0,

  // 3. The secure one. Two tabs of one set can only ever differ by `http` vs `https`,
  // since that is the one scheme difference `duplicateKey` erases.
  (a, b, ctx) => (ctx.settings.preferHttps ? preferring(isHttps(a), isHttps(b)) : 0),

  // 4. Age. "Più vecchia ricaricata" keeps the same tab as "Più vecchia"; the reload of
  // the kept tab is an action, and belongs to the guard.
  (a, b, ctx) => {
    const ageA = ctx.createdAt?.[a.id];
    const ageB = ctx.createdAt?.[b.id];
    if (ageA === undefined || ageB === undefined) return 0;
    return ordering(ageA, ageB, ctx.settings.keep === 'newest');
  },

  // 5. The window in front, and only when the search spanned the others (PLAN.md §8.3).
  (a, b, ctx) => {
    if (!ctx.settings.preferActiveWindow || ctx.settings.scope !== 'all-windows') return 0;
    const focused = ctx.focusedWindowId;
    if (focused === undefined) return 0;
    return preferring(a.windowId === focused, b.windowId === focused);
  },

  // 6. Not in §8.4.3: the last word, so that two tabs nothing else separates are not
  // decided by the order the events happened to arrive in (PLAN.md §8.2 fires the guard
  // on several of them). A tab id grows with time, so this agrees with the age rule
  // whenever the tracker has no record to compare; see docs/DECISIONS.md.
  (a, b, ctx) => ordering(a.id, b.id, ctx.settings.keep === 'newest'),
];

/**
 * Which of two duplicates to keep: negative keeps `a`, positive keeps `b`, 0 only when
 * they are the same tab. A total order, so it can be used to sort a set.
 *
 * The first rule of PLAN.md §8.4.3 that tells them apart wins, and a rule the settings
 * switch off never tells anything apart. Exported whole, because the guard compares the
 * tab that triggered it against the best candidate with exactly these rules (§8.4.2).
 */
export function compareKeepPriority(a: TabInfo, b: TabInfo, ctx: KeepContext): number {
  for (const rule of KEEP_RULES) {
    const result = rule(a, b, ctx);
    if (result !== 0) return result;
  }
  return 0;
}

/**
 * The tab of `tabs` to keep, or `null` when there are none. The others are the ones that
 * may be closed.
 */
export function chooseTabToKeep(tabs: readonly TabInfo[], ctx: KeepContext): TabInfo | null {
  let best: TabInfo | null = null;
  for (const tab of tabs) {
    if (best === null || compareKeepPriority(tab, best, ctx) < 0) best = tab;
  }
  return best;
}
