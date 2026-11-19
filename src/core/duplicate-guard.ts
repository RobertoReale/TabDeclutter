/**
 * The decision behind an automatic duplicate close: given the tab that just appeared or
 * navigated, and the tabs that might be duplicates of it, which one closes and what
 * happens to the one that stays (PLAN.md §8.4).
 *
 * Pure, and the only part of the guard that is (TASKS.md §2.4): `now`, the settings, the
 * session state and the compiled whitelist all come in through `ctx`, so every row of
 * §8.4's table is a unit test and not a browser session. The background
 * (`entrypoints/background/guard.ts`, M3b.2) owns the events, the index, the queue and
 * the API calls; it asks this function *whether* to close and obeys the answer.
 *
 * What "duplicate" means and which of two duplicates wins are **not** decided here:
 * `duplicateKey` and `compareKeepPriority` of `core/duplicates.ts` answer both, once, for
 * Declutter and for the guard alike (TASKS.md §2.9). This module adds the two things that
 * are the guard's own: the exit filters of §8.4.1 and §8.6 — the cases where closing a tab
 * by itself would be wrong — and the action that follows a close (§8.4.4).
 *
 * The shape of the answer is deliberately small. A resolution names two tab ids and an
 * intention; it never holds a `TabInfo`, so it cannot go stale between the decision and
 * the `tabs.remove` that carries it out, and the caller re-reads the tab it is about to
 * touch (§8.6: "Tab closed in the meantime").
 */

import { canonicalUrl, classify } from './classify';
import {
  compareKeepPriority,
  chooseTabToKeep,
  duplicateKey,
  duplicateOptions,
  findDuplicateSets,
  tabUrl,
  type KeepContext,
} from './duplicates';
import type { GuardAfterAction, GuardExemption, MatchOptions, TabInfo } from './types';

/**
 * Everything the decision needs beyond the tabs, on top of what choosing between two
 * duplicates already needed (`KeepContext`: the guard settings, the ages the tracker
 * remembers, which tabs navigated, the focused window).
 *
 * Extending `KeepContext` is what lets this be handed straight to `compareKeepPriority`,
 * so the tab the guard closes and the tab Declutter would have kept cannot drift apart.
 *
 * `activeTabIds` of §8.4's sketch is not here: `TabInfo.active` already carries it, and
 * the rule that reads it (§8.4.3.2) needs to know not whether a tab is active but whether
 * it *navigated* while active, which is `KeepContext.navigatedTabIds` (docs/DECISIONS.md).
 */
export interface GuardContext extends KeepContext {
  /** ms epoch, injected: the pause, the grace period and the exemptions all expire. */
  readonly now: number;
  /** How URLs are compared (PLAN.md §8.3). Joined to the guard flags by `duplicateOptions`. */
  readonly match: MatchOptions;
  /** `GuardState.pausedUntil`: while it is in the future, nothing closes (PLAN.md §8.1). */
  readonly pausedUntil?: number;
  /**
   * ms epoch before which no automatic close may happen: the 15 s after `runtime.onStartup`,
   * where a restored session is full of duplicates the user did not create (PLAN.md §8.6).
   * Absent means no grace period is running.
   */
  readonly autoClosesAllowedFrom?: number;
  /**
   * Tabs the extension itself opened or restored, by id and by URL, each with its own
   * expiry (PLAN.md §8.6). The guard ignores them: undoing a close and having the guard
   * immediately redo it would make "Annulla" a no-op.
   */
  readonly exemptions?: readonly GuardExemption[];
  /**
   * The compiled duplicate whitelist, `patterns.compile(...).match` (PLAN.md §8.3). Takes
   * the tab's raw URL, not its key. Compiled by the caller and kept, because the guard runs
   * on every navigation; a line that did not compile is already absent from it, which is
   * how an invalid regular expression ends up ignored rather than fatal.
   */
  readonly isWhitelisted?: (url: string) => boolean;
  /** The extension's own origin, so its pages are recognized as such (`classify`). */
  readonly ownOrigin?: string;
}

/** What the background should do, once (PLAN.md §8.4). */
export interface DuplicateResolution {
  /** The tab to close. It goes to the archive with the reason `duplicate-auto` (§8.4.5). */
  readonly closeTabId: number;
  /** The tab that stays. */
  readonly keepTabId: number;
  /** What to do to the kept tab afterwards (§8.4.4). */
  readonly after: GuardAfterAction;
  /** Present only for "Più vecchia ricaricata": the URL to load in the kept tab (§8.4.3.4). */
  readonly reloadKeptWith?: string;
}

/** One close of "Chiudi tutti i duplicati" (PLAN.md §8.7): a tab goes, another stays. */
export interface DuplicateSweep {
  /** The tab to close. It goes to the archive with the reason `duplicate-manual`. */
  readonly closeTabId: number;
  /** The tab of the same set that stays. */
  readonly keepTabId: number;
}

/** While the user has the guard on hold, every event is someone else's business. */
function isPaused(ctx: GuardContext): boolean {
  return ctx.pausedUntil !== undefined && ctx.pausedUntil > ctx.now;
}

/** PLAN.md §8.6: the first seconds after a start-up are session restore, not the user. */
function inStartupGrace(ctx: GuardContext): boolean {
  return ctx.autoClosesAllowedFrom !== undefined && ctx.now < ctx.autoClosesAllowedFrom;
}

/**
 * Whether a tab is exempt right now: an exemption matches by tab id or by URL, and only
 * until it expires (`EXEMPTION_TTL_MS`). An entry with neither field matches nothing,
 * rather than everything — the safe reading of a record that says nothing.
 */
function isExempt(tab: TabInfo, url: string, ctx: GuardContext): boolean {
  return (ctx.exemptions ?? []).some((exemption) => {
    if (exemption.until <= ctx.now) return false;
    if (exemption.tabId !== undefined && exemption.tabId === tab.id) return true;
    return exemption.url !== undefined && exemption.url === url;
  });
}

/**
 * The empty page. It is the one `blank` URL that "Ignore empty tabs" really governs: every
 * other entry of `BLANK_URLS` is a new tab or home page, and §8.3 makes those unconditional
 * ("always true for `chrome://newtab`"). Canonical, as `canonicalUrl` produces it.
 */
const EMPTY_PAGE = 'about:blank';

/**
 * Whether the guard may close a tab showing this URL at all (PLAN.md §8.4.1).
 *
 * The classes come from `classify`, so "is this a login page" has one definition in the
 * codebase and not two:
 *
 * - `browser-internal` and `own` are never closed, with no setting to say otherwise: they
 *   are the browser's pages and ours, duplicated on purpose all the time;
 * - `blank` is closable only if the user unticked "Ignore empty tabs" *and* the page is
 *   `about:blank` rather than a new tab page (§8.3). In practice the pre-filled whitelist
 *   covers `about:blank` too, so this is reachable only once the user has edited both;
 * - `auth` follows "Ignore login/OAuth pages", so a sign-in flow that redirects through a
 *   URL already open elsewhere is not cut in half (§8.6, "Redirect").
 */
function isGuardedUrl(url: string, ctx: GuardContext): boolean {
  const type = classify({ url }, { ownOrigin: ctx.ownOrigin });

  if (type === 'browser-internal' || type === 'own') return false;
  if (type === 'blank') return !ctx.settings.ignoreEmptyTabs && canonicalUrl(url) === EMPTY_PAGE;
  if (type === 'auth') return !ctx.settings.ignoreAuthPages;
  return true;
}

/** A tab that has not navigated is one the browser has just made (PLAN.md §8.4.3.2). */
function isNewlyCreated(tab: TabInfo, ctx: GuardContext): boolean {
  return !(ctx.navigatedTabIds?.has(tab.id) ?? false);
}

/**
 * Chrome's own "Duplicate tab", which the user asked for on purpose (PLAN.md §8.6).
 *
 * PLAN.md §8.6 asks for that table's heuristic *verified empirically*, and one of its
 * conditions did not survive the browser (see `docs/DECISIONS.md`, M3b.5): Chrome gives the
 * copy the `openerTabId` of whichever tab was **active** when the command ran, not of the
 * tab being duplicated, so requiring the opener to be the tab it duplicates misses every
 * duplicate of a background tab. The three signals that did hold are kept: the copy has an
 * opener at all — a tab an extension made with `tabs.create` has none — it sits immediately
 * after the tab it came from, and it already carries its URL. A tab opened from a link
 * arrives with a `pendingUrl` and an empty `url` instead, so that last condition is what
 * tells those two apart.
 *
 * Firefox has no such command and reports openers differently (PLAN.md §5.5), which is why
 * the setting behind this is Chrome-only and hidden there; the core only honours the flag
 * and never asks which browser it is on (TASKS.md §2.5).
 */
function isIntentionalDuplicate(
  trigger: TabInfo,
  sameKey: readonly TabInfo[],
  ctx: GuardContext,
): boolean {
  if (!ctx.settings.allowIntentionalDuplicates) return false;
  if (!isNewlyCreated(trigger, ctx)) return false;
  if (trigger.url === '') return false;
  if (trigger.openerTabId === undefined) return false;

  return sameKey.some(
    (tab) => tab.windowId === trigger.windowId && tab.index === trigger.index - 1,
  );
}

/**
 * The tabs that could lose to `trigger`: same page, inside the scope, and closable.
 *
 * A candidate is dropped when it is the trigger itself, when it is `hidden` (not on
 * screen at all, PLAN.md §5.5), when it is exempt — an exempt tab is neither closed nor
 * used as a reason to close another — or when the whitelist covers its URL. The whitelist
 * is tested per tab and not once for the set because two tabs of one key can differ by
 * scheme, and a pattern may well match `https://…` and not `http://…`.
 */
function candidatesForTrigger(
  trigger: TabInfo,
  candidates: readonly TabInfo[],
  ctx: GuardContext,
  key: string,
): readonly TabInfo[] {
  const options = duplicateOptions({ match: ctx.match, guard: ctx.settings });
  const sameWindowOnly = ctx.settings.scope === 'window';

  return candidates.filter((tab) => {
    if (tab.id === trigger.id || tab.hidden || tab.incognito) return false;
    if (sameWindowOnly && tab.windowId !== trigger.windowId) return false;

    const url = tabUrl(tab);
    if (url === '' || (ctx.isWhitelisted?.(url) ?? false)) return false;
    if (isExempt(tab, url, ctx)) return false;

    return duplicateKey(url, options, tab.cookieStoreId) === key;
  });
}

/**
 * What to do to the kept tab after the close (PLAN.md §8.4.4).
 *
 * The exception is the one the plan insists on: a tab opened in the background — middle
 * click, Ctrl+click, `active === false` when it was created — must not pull the focus
 * anywhere, because the user deliberately did not switch to it. It only applies when the
 * tab being closed is that newly created background tab; closing an older tab is not an
 * event the user opened in the background at all.
 *
 * It answers `none` rather than a move without a focus change: §8.4's result has no such
 * value, and "Sposta e attiva" exists to put the surviving tab under the user's eyes —
 * moving it silently would shuffle the tab strip for someone who is looking elsewhere
 * (docs/DECISIONS.md).
 */
function actionAfterClose(trigger: TabInfo, closed: TabInfo, ctx: GuardContext): GuardAfterAction {
  const { after } = ctx.settings;
  if (after === 'none') return 'none';

  const openedInBackground =
    closed.id === trigger.id && isNewlyCreated(trigger, ctx) && !trigger.active;
  return openedInBackground ? 'none' : after;
}

/**
 * Whether the kept tab should be reloaded with the URL that triggered the event, and with
 * which URL (PLAN.md §8.4.3.4, "Più vecchia ricaricata con la nuova URL").
 *
 * Only when the old tab is the one that survives: if the trigger is kept it already shows
 * that URL. And only when the two URLs really differ — they can be the same string, the
 * key having matched exactly, and reloading a tab to the page it is already on would throw
 * away its scroll position and its forms for nothing.
 */
function reloadUrlFor(
  trigger: TabInfo,
  keep: TabInfo,
  triggerUrl: string,
  ctx: GuardContext,
): string | undefined {
  if (ctx.settings.keep !== 'oldest-reloaded') return undefined;
  if (keep.id === trigger.id) return undefined;
  const keepRaw = keep.url !== '' ? keep.url : (keep.pendingUrl ?? '');
  return keepRaw === triggerUrl ? undefined : triggerUrl;
}

/**
 * Whether `trigger` and one of `candidates` are duplicates that justify a close, and if
 * so which of the two goes (PLAN.md §8.4).
 *
 * `null` is the common answer and means "do nothing": the mode is not "Chiudi
 * automaticamente", the guard is paused or still inside the start-up grace period, the
 * URL is one the guard never touches, the tab is incognito or exempt or an intentional
 * duplicate, or simply nothing else is showing that page within the scope.
 *
 * **Exactly one tab per event**, as §8.4.2 requires: when several candidates match, the
 * trigger is compared with the best of them under the priority rules, and the loser of
 * that single comparison is the one closed. Everything else is left for the events that
 * will arrive on its own account — three tabs of one page converge to one that way,
 * without this function ever having to reason about more than a pair.
 */
export function resolveDuplicate(
  trigger: TabInfo,
  candidates: readonly TabInfo[],
  ctx: GuardContext,
): DuplicateResolution | null {
  if (ctx.settings.mode !== 'auto') return null;
  if (isPaused(ctx) || inStartupGrace(ctx)) return null;

  // Incognito is a session the extension does not police, and a `hidden` tab is not on
  // screen for the user to have duplicated.
  if (trigger.incognito || trigger.hidden) return null;

  const triggerUrl = tabUrl(trigger);
  if (triggerUrl === '') return null;
  if (ctx.isWhitelisted?.(triggerUrl) ?? false) return null;
  if (!isGuardedUrl(triggerUrl, ctx)) return null;
  if (isExempt(trigger, triggerUrl, ctx)) return null;

  const options = duplicateOptions({ match: ctx.match, guard: ctx.settings });
  const key = duplicateKey(triggerUrl, options, trigger.cookieStoreId);
  const sameKey = candidatesForTrigger(trigger, candidates, ctx, key);
  if (sameKey.length === 0) return null;

  if (isIntentionalDuplicate(trigger, sameKey, ctx)) return null;

  // Non-null: the set is not empty. The comparator is a total order (its last rule is the
  // tab id), so trigger and best, being two different tabs, are always told apart.
  const best = chooseTabToKeep(sameKey, ctx) as TabInfo;
  const triggerWins = compareKeepPriority(trigger, best, ctx) < 0;
  const keep = triggerWins ? trigger : best;
  const closed = triggerWins ? best : trigger;

  // Spread rather than `reloadKeptWith: undefined`: the key is absent when there is
  // nothing to reload, so a resolution compares equal to the plain object a test writes.
  const reloadKeptWith = reloadUrlFor(trigger, keep, triggerUrl, ctx);

  return {
    closeTabId: closed.id,
    keepTabId: keep.id,
    after: actionAfterClose(trigger, closed, ctx),
    ...(reloadKeptWith !== undefined ? { reloadKeptWith } : {}),
  };
}

/**
 * The §8.4.1 and §8.6 filters that are about a single tab, for the sweep below. `hidden` and
 * the whitelist are left to `findDuplicateSets`, which excludes both everywhere already.
 */
function isSweepable(tab: TabInfo, ctx: GuardContext): boolean {
  if (tab.incognito) return false;
  const url = tabUrl(tab);
  if (url === '') return false;
  if (!isGuardedUrl(url, ctx)) return false;
  return !isExempt(tab, url, ctx);
}

/**
 * One set as the scope sees it: a single group, or one group per window for "Stessa finestra"
 * (PLAN.md §8.3). A window left with one tab of the page has no duplicate to close.
 */
function perScope(tabs: readonly TabInfo[], ctx: GuardContext): readonly (readonly TabInfo[])[] {
  if (ctx.settings.scope !== 'window') return [tabs];

  const byWindow = new Map<number, TabInfo[]>();
  for (const tab of tabs) {
    const group = byWindow.get(tab.windowId);
    if (group === undefined) byWindow.set(tab.windowId, [tab]);
    else group.push(tab);
  }
  return [...byWindow.values()].filter((group) => group.length > 1);
}

/** No whitelist was given, so no URL is whitelisted. */
function noWhitelist(): boolean {
  return false;
}

/**
 * Every close "Chiudi tutti i duplicati" would make, over the whole tab list (PLAN.md §8.7).
 *
 * **The same priorities, but not the same gate.** §8.7 says the action "works in OFF/Solo
 * avvisi mode too", so the mode is not consulted — and neither is the pause nor the start-up
 * grace, which exist to stop the guard from acting *on its own* (§8.1, §8.6) and have nothing
 * to say about a key the user has just pressed. Every other exit filter of §8.4.1 and §8.6
 * still holds: the browser's pages and ours, `about:blank`, sign-in pages, the whitelist,
 * `hidden`, incognito, and the tabs the extension itself has just opened — closing one of
 * those would undo an "Annulla" the user made a second ago (docs/DECISIONS.md).
 *
 * **One keep per set, not one close per event.** The live guard closes exactly one tab per
 * event and leaves the rest to the events that follow (§8.4.2); here the whole list is known
 * at once, so each set keeps `chooseTabToKeep`'s winner and every other tab of it goes.
 *
 * Nothing is said about the tab that stays: §8.4.4's "Attivala" and "Sposta e attiva" are a
 * reaction to one close the user did not ask for, and a sweep of twenty of them would shuffle
 * the tab strip twenty times (docs/DECISIONS.md).
 */
export function resolveAllDuplicates(
  tabs: readonly TabInfo[],
  ctx: GuardContext,
): readonly DuplicateSweep[] {
  const options = duplicateOptions({ match: ctx.match, guard: ctx.settings });
  const closable = tabs.filter((tab) => isSweepable(tab, ctx));

  const sweeps: DuplicateSweep[] = [];
  for (const set of findDuplicateSets(closable, options, ctx.isWhitelisted ?? noWhitelist)) {
    for (const group of perScope(set.tabs, ctx)) {
      // Non-null: `findDuplicateSets` only answers with sets of more than one tab, and
      // `perScope` only with groups of more than one.
      const keep = chooseTabToKeep(group, ctx) as TabInfo;
      for (const tab of group) {
        if (tab.id !== keep.id) sweeps.push({ closeTabId: tab.id, keepTabId: keep.id });
      }
    }
  }
  return sweeps;
}
