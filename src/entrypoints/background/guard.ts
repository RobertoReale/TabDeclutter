/**
 * The live duplicate guard (PLAN.md §8.1, §8.2, §8.6): the moment a tab becomes a duplicate
 * of another, the losing one is closed.
 *
 * This is the one place in TabDeclutter that closes a tab the user did not point at
 * (invariant 2), which is why the decision itself is not here. `core/duplicate-guard.ts`
 * answers *whether* to close and which of the two goes, as a pure function over §8.4's
 * rules; this file owns the events, the index, the queue and the browser calls, and obeys
 * the answer. Every reason not to close — the mode, the pause, the grace period, the
 * exemptions, the whitelist, `auth` pages, incognito — is that function's, not this one's.
 *
 * **The serial queue is the whole of §8.2.** Twenty tabs of one page opened at once arrive
 * as twenty events; two of them evaluated in parallel would each see the other's tab as the
 * one to keep, and both would close. So every event goes through one promise chain, and the
 * tab a step closes leaves the index inside that same step.
 *
 * **Nothing is believed that can be read.** The index narrows an event down to the few tabs
 * that might be duplicates of it (`Map<duplicateKey, Set<tabId>>`, §8.2); the tabs
 * themselves are read again before anything is decided. A tab's `active`, `pinned` and
 * position change through events the guard does not listen to, and the whole point of
 * §8.4.3 is to keep the tab the user is working on.
 *
 * **Nothing lives only in a variable** (invariant 6). The index and the settings are a
 * cache, rebuilt when the service worker wakes up; the pause, the grace period, the
 * exemptions and the last automatic close are in `storage.session`, where they outlive the
 * worker and die with the browser — which is exactly what each of them means.
 *
 * **The gestures go through the same queue.** `GuardActions` is what a shortcut or an icon
 * menu item asks for (PLAN.md §4.1, §8.5, §8.7): pause, toggle, close every duplicate at
 * once, reopen the last one closed. They are not events, but a sweep running beside a live
 * close would let two steps each pick the other's tab as the one to keep, so they queue too.
 */

import { isBlankUrl } from '@/core/classify';
import type { DuplicateResolution, GuardContext } from '@/core/duplicate-guard';
import { resolveAllDuplicates, resolveDuplicate } from '@/core/duplicate-guard';
import type { DuplicateOptions } from '@/core/duplicates';
import { duplicateKey, duplicateOptions, tabUrl } from '@/core/duplicates';
import { compile } from '@/core/patterns';
import type { ArchivedTab, GuardMode, GuardSettings, MatchOptions, TabInfo } from '@/core/types';
import { STARTUP_GRACE_MS } from '@/core/types';
import type { Capabilities } from '@/platform/capabilities';
import { caps } from '@/platform/capabilities';
import {
  activityItem,
  duplicateWhitelistItem,
  pauseGuard,
  readArchive,
  readGuardState,
  readSettings,
  readSettingsAndWhitelist,
  rememberAutoClosed,
  resumeGuard,
  settingsItem,
  startGuardGrace,
} from '@/platform/storage';
import {
  activateTab,
  closeTabs,
  getTab,
  moveTab,
  navigateTab,
  queryTabs,
  restoreTabs,
} from '@/platform/tabs';

import { reportBackgroundError } from './report';

/** The alarm that ends a timed pause (PLAN.md §8.1). */
const RESUME_ALARM = 'guard-resume';

/**
 * "Fino al riavvio" (PLAN.md §8.1) as a deadline.
 *
 * `storage.session` is cleared when the browser restarts, so such a pause cannot outlive
 * the session whatever date is written: a year away is simply a date no session reaches,
 * and it needs no alarm.
 */
const UNTIL_RESTART_MS = 365 * 24 * 60 * 60 * 1_000;

/** `local:settings` → `settings`: the key the browser reports a change under. */
function bareKey(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}

/**
 * The stored values the guard reads once and keeps: the settings and the whitelist, which
 * PLAN.md §8.3 compiles only on `storage.onChanged`.
 */
const WATCHED: readonly string[] = [settingsItem, duplicateWhitelistItem].map((item) =>
  bareKey(item.key),
);

/** Why a tab is being looked at, which is what tells a creation from a navigation. */
type Origin = 'created' | 'navigated' | 'moved';

/** What a tab event carries, whichever browser's type it came from. */
interface TabLike {
  id?: number;
}

/**
 * `Map<duplicateKey, Set<tabId>>` (PLAN.md §8.2), plus the two things no browser reports
 * and this worker therefore has to remember itself.
 *
 * **Ids, not tabs.** A stale entry costs a `tabs.get` and can at worst hide a candidate;
 * it can never make the guard close the wrong tab, because the tabs are read again before
 * the decision. That is also what makes `invalidate()` free: throwing the index away is
 * never incorrect, only slower.
 */
interface GuardIndex {
  /** The tabs that might be duplicates of `tab`, by id, `tab` itself excluded. */
  bucket(tab: TabInfo): readonly number[];
  /** Files a tab under its key, taking it off the key it was under before. */
  put(tab: TabInfo): void;
  drop(tabId: number): void;
  /** `onReplaced`: the page is the same, the tab id is not (PLAN.md §5.5, §8.6). */
  rename(from: number, to: number): void;
  /** PLAN.md §8.4.3.2: the tabs that reached their URL by navigating to it. */
  readonly navigated: Set<number>;
  /** The URL the index last filed the tab under: what the browser last said about it. */
  knownUrl(tabId: number): string | undefined;
  /** Tabs with no address yet, waiting for their first `onUpdated` (PLAN.md §8.2). */
  readonly awaiting: Set<number>;
}

function createIndex(tabs: readonly TabInfo[], keyOptions: DuplicateOptions): GuardIndex {
  const byKey = new Map<string, Set<number>>();
  const keys = new Map<number, string>();
  const urls = new Map<number, string>();
  const navigated = new Set<number>();
  const awaiting = new Set<number>();

  /** §8.2: "key computed on `url || pendingUrl`", through the one definition (invariant 9). */
  function keyOf(tab: TabInfo): string {
    return duplicateKey(tabUrl(tab), keyOptions, tab.cookieStoreId);
  }

  function unlink(tabId: number): void {
    const key = keys.get(tabId);
    if (key === undefined) return;
    keys.delete(tabId);
    const bucket = byKey.get(key);
    if (bucket === undefined) return;
    bucket.delete(tabId);
    if (bucket.size === 0) byKey.delete(key);
  }

  function link(tabId: number, key: string): void {
    keys.set(tabId, key);
    const bucket = byKey.get(key);
    if (bucket === undefined) byKey.set(key, new Set([tabId]));
    else bucket.add(tabId);
  }

  function put(tab: TabInfo): void {
    unlink(tab.id);
    link(tab.id, keyOf(tab));
    urls.set(tab.id, tabUrl(tab));
  }

  function drop(tabId: number): void {
    unlink(tabId);
    urls.delete(tabId);
    navigated.delete(tabId);
    awaiting.delete(tabId);
  }

  function rename(from: number, to: number): void {
    const key = keys.get(from);
    const url = urls.get(from);
    const wasNavigated = navigated.has(from);
    drop(from);
    if (key === undefined) return;
    unlink(to);
    link(to, key);
    if (url !== undefined) urls.set(to, url);
    if (wasNavigated) navigated.add(to);
  }

  function bucket(tab: TabInfo): readonly number[] {
    const found = byKey.get(keyOf(tab));
    if (found === undefined) return [];
    return [...found].filter((tabId) => tabId !== tab.id);
  }

  const index: GuardIndex = {
    bucket,
    put,
    drop,
    rename,
    navigated,
    awaiting,
    knownUrl: (tabId) => urls.get(tabId),
  };
  for (const tab of tabs) {
    index.put(tab);
    // A tab found by `tabs.query` rather than watched into existence has had its URL for as
    // long as this worker knows anything, unless it is still on a blank / new-tab page.
    if (isBlankUrl(tabUrl(tab))) {
      awaiting.add(tab.id);
    } else {
      navigated.add(tab.id);
    }
  }
  return index;
}

/** Everything the guard reads once per worker rather than once per event. */
interface Loaded {
  readonly guard: GuardSettings;
  readonly match: MatchOptions;
  /** `guard` and `match` joined, as `duplicateKey` wants them. */
  readonly keyOptions: DuplicateOptions;
  readonly isWhitelisted: (url: string) => boolean;
  readonly ownOrigin: string;
}

export interface GuardOptions {
  /** The clock, injected so the tests can be exact about the pause and the grace period. */
  readonly now?: () => number;
  readonly capabilities?: Capabilities;
  /**
   * PLAN.md §8.5's badge flash, on every automatic close. The badge owns it; the guard is
   * given it so it does not have to know there is a badge at all.
   */
  readonly flash?: () => Promise<void>;
}

/** What the icon menu of PLAN.md §8.1 shows and acts on. */
export interface GuardStatus {
  readonly mode: GuardMode;
  readonly paused: boolean;
  /** ms epoch, only while paused. */
  readonly pausedUntil?: number;
  /** The mode the pause will end in, only while paused. */
  readonly resumeMode?: GuardMode;
}

/**
 * What a shortcut or a menu item can ask of the guard (PLAN.md §4.1, §8.7).
 *
 * Named apart from `Guard` so `menus.ts` and `commands.ts` depend on the four gestures and
 * not on `invalidate`/`settled`, which are the background's own business.
 */
export interface GuardActions {
  /**
   * "In pausa" (PLAN.md §8.1): nothing closes for `durationMs`, `null` for until the
   * browser restarts. Sets the alarm that ends it.
   */
  pause(durationMs: number | null): Promise<void>;
  /** The shortcut's one key for both directions: pauses until restart, or ends the pause. */
  toggle(): Promise<void>;
  /**
   * "Chiudi tutti i duplicati" (PLAN.md §8.7), in every mode. Answers with what it archived,
   * oldest close first, empty when there was nothing to close.
   */
  closeAllDuplicates(): Promise<readonly ArchivedTab[]>;
  /**
   * "Riapri l'ultimo duplicato chiuso" (PLAN.md §8.5), with the exemption that keeps the
   * guard from closing it again. `null` when there is nothing to reopen.
   */
  reopenLastDuplicate(): Promise<ArchivedTab | null>;
}

export interface Guard extends GuardActions {
  /** Ends a pause, whether the alarm brought it or the user did. */
  resume(): Promise<void>;
  status(): Promise<GuardStatus>;
  /** Forgets the index and the cached settings. The next event rebuilds both. */
  invalidate(): void;
  /**
   * Waits for everything the listeners started, the badge flash included.
   *
   * What the tests await, and what a caller uses to keep the service worker alive until a
   * close has really happened — an event handler that returns leaves the worker free to be
   * torn down.
   */
  settled(): Promise<void>;
}

/**
 * Registers the guard. Called at the top level of the background, before any `await`,
 * because a service worker that wakes up for an event must already be listening for it
 * (invariant 6, PLAN.md §8.2).
 */
export function registerGuard(options: GuardOptions = {}): Guard {
  const now = options.now ?? Date.now;
  const capabilities = options.capabilities ?? caps;
  const flash = options.flash ?? noFlash;

  /** `null` until this worker has read the settings. */
  let loading: Promise<Loaded> | null = null;
  /** `null` until this worker has indexed the tabs (PLAN.md §8.2: rebuilt on wake-up). */
  let index: GuardIndex | null = null;
  /** One event at a time. See the module comment: this is §8.2's serial queue. */
  let chain: Promise<unknown> = Promise.resolve();
  /** The flash in flight, if any. Outside the queue, see `startFlash`. */
  let flashing: Promise<void> | null = null;

  function run<T>(action: () => Promise<T>): Promise<T> {
    const next = chain.then(action, action);
    chain = next.then(ignore, ignore);
    return next;
  }

  /** How a listener hands its work over: in order, and never unhandled. */
  function handle(action: () => Promise<boolean>): void {
    void run(action)
      .then((closed) => {
        if (closed) startFlash();
      })
      .catch(failed);
  }

  /**
   * PLAN.md §8.5's flash, started after the queued step and not inside it.
   *
   * It lasts 1.5 s. Awaiting it in the queue would hold the next event up for thirty times
   * the 50 ms §11 allows, and would turn twenty closes into half a minute of flashing one
   * after another — so a flash already running is left to finish instead. `settled()` still
   * waits for it, which is what keeps the worker alive until the colour is back.
   */
  function startFlash(): void {
    if (flashing !== null) return;
    flashing = flash()
      .catch(failed)
      .then(() => {
        flashing = null;
      });
  }

  /**
   * The settings, the compiled whitelist and our own origin: PLAN.md §8.2's single `ready`
   * promise, awaited by every handler.
   *
   * A failed read is not remembered — the item is defined but unreadable, which is a
   * storage that will answer next time — so the next event tries again rather than leaving
   * the guard off for the life of the worker.
   */
  function ready(): Promise<Loaded> {
    loading ??= load().catch((error: unknown) => {
      loading = null;
      throw error;
    });
    return loading;
  }

  async function load(): Promise<Loaded> {
    const { settings, whitelist } = await readSettingsAndWhitelist();
    const guard: GuardSettings = {
      ...settings.guard,
      // The "Duplicate tab" heuristic of §8.6 reads an opener and a URL set at creation,
      // which only Chrome reports; the setting is hidden on Firefox (§8.3), so the flag is
      // turned off here rather than left to mean something it cannot mean. The core never
      // asks which browser it is on (invariant 5).
      allowIntentionalDuplicates:
        settings.guard.allowIntentionalDuplicates && capabilities.duplicateCommandDetection,
    };
    return {
      guard,
      match: settings.match,
      keyOptions: duplicateOptions({ match: settings.match, guard }),
      // Compiled once and kept, because the guard runs on every navigation (§8.3).
      isWhitelisted: compile(whitelist).match,
      ownOrigin: browser.runtime.getURL(''),
    };
  }

  function invalidate(): void {
    loading = null;
    index = null;
  }

  /**
   * PLAN.md §8.2: one `tabs.query({})` when the service worker wakes up. `known` is that
   * same list when the caller has just read it, so a sweep queries once and not twice.
   */
  async function indexed(loaded: Loaded, known?: readonly TabInfo[]): Promise<GuardIndex> {
    // Not `??=`: the rebuild is awaited, and two events must not each start one.
    if (index === null) index = createIndex(known ?? (await queryTabs()), loaded.keyOptions);
    return index;
  }

  /**
   * One event, from the id it arrived with to the tab that is or is not closed. `true` when
   * a tab was closed, which is what the badge flashes for.
   */
  async function evaluate(tabId: number, origin: Origin, at: number): Promise<boolean> {
    const loaded = await ready();
    // OFF and "Solo avvisi" cost nothing at all: no index, no `tabs.get`, no storage read.
    // Both still show duplicates in Declutter, which is the panel's own reading of the
    // same rules (PLAN.md §8.1). A change of mode invalidates this.
    if (loaded.guard.mode !== 'auto') return false;

    const current = await indexed(loaded);
    const tab = await getTab(tabId);
    if (tab === null) {
      // Gone between the event and now — very often the tab this same burst just closed.
      current.drop(tabId);
      return false;
    }

    const blank = isBlankUrl(tabUrl(tab));
    remember(current, tab, origin, blank, loaded.keyOptions);
    // §8.2: a tab with no address of its own is nobody's duplicate yet, and the first
    // `onUpdated` with a URL will bring it back here. Only when the user left "Ignora
    // schede vuote" on, which is what decides whether an empty tab can be closed at all.
    if (blank && loaded.guard.ignoreEmptyTabs) return false;

    const resolution = await decide(current, tab, loaded, at);
    if (resolution === null) return false;
    return await carryOut(resolution, tab, current, at);
  }

  /**
   * Updates what the index knows about the tab the event is about, including the one thing
   * the browser never says: whether the tab reached this URL by navigating (§8.4.3.2).
   */
  function remember(
    current: GuardIndex,
    tab: TabInfo,
    origin: Origin,
    blank: boolean,
    keyOptions: DuplicateOptions,
  ): void {
    const url = tabUrl(tab);
    // What the browser said about this tab last time, read before `put` overwrites it.
    const before = current.knownUrl(tab.id);
    current.put(tab);

    // Firefox has no `pendingUrl` (PLAN.md §5.5): every tab is created on `about:blank` and
    // its address arrives with the first `onUpdated`, so that URL is the creation finishing
    // rather than a navigation. On Chrome too, navigating away from `chrome://newtab` is the
    // initial opening of a page in a new tab.
    const arriving = current.awaiting.has(tab.id) || (before !== undefined && isBlankUrl(before));
    if (blank) current.awaiting.add(tab.id);
    else current.awaiting.delete(tab.id);

    // An `onUpdated` carrying the URL the tab already had (or a canonical redirect of the
    // same duplicateKey, such as http -> https or adding www.) is the load of the page it
    // was created on finishing.
    const samePage =
      before !== undefined &&
      !isBlankUrl(before) &&
      duplicateKey(url, keyOptions, tab.cookieStoreId) ===
        duplicateKey(before, keyOptions, tab.cookieStoreId);
    const moved = url !== before && !samePage;

    if (origin === 'created') current.navigated.delete(tab.id);
    else if (origin === 'navigated' && !arriving && moved) current.navigated.add(tab.id);
  }

  /** §8.4's decision, over tabs read now and the session state read now. */
  async function decide(
    current: GuardIndex,
    tab: TabInfo,
    loaded: Loaded,
    at: number,
  ): Promise<DuplicateResolution | null> {
    const candidates = await candidatesOf(current, tab);
    if (candidates.length === 0) return null;

    const [state, activity, focusedWindowId] = await Promise.all([
      readGuardState(),
      activityItem.getValue(),
      focusedWindow(),
    ]);

    const createdAt: Record<number, number> = {};
    const hasActivity = Object.keys(activity).length > 0;
    for (const known of [tab, ...candidates]) {
      const record = activity[known.id];
      if (record !== undefined) {
        createdAt[known.id] = record.createdAt;
      } else if (hasActivity) {
        // The activity tracker debounces storage writes by 1 s, so a newly created tab is
        // not in `local:activity` yet when the guard runs: its creation timestamp is `at`.
        createdAt[known.id] = at;
      }
    }

    const ctx: GuardContext = {
      now: at,
      settings: loaded.guard,
      match: loaded.match,
      createdAt,
      navigatedTabIds: current.navigated,
      focusedWindowId,
      isWhitelisted: loaded.isWhitelisted,
      ownOrigin: loaded.ownOrigin,
      exemptions: state.exemptions,
      pausedUntil: state.pausedUntil,
      autoClosesAllowedFrom: state.graceUntil,
    };
    return resolveDuplicate(tab, candidates, ctx);
  }

  /**
   * The tabs the index points at, as they are right now.
   *
   * One round trip for all of them, and an id that answers nothing leaves the index: that
   * is PLAN.md §8.6's "ignore the error and rebuild the index", done one entry at a time
   * instead of all at once. A tab another extension has hidden answers nothing either, for
   * the same reason it is excluded everywhere (§5.5).
   */
  async function candidatesOf(current: GuardIndex, tab: TabInfo): Promise<readonly TabInfo[]> {
    const ids = current.bucket(tab);
    if (ids.length === 0) return [];

    const found = await Promise.all(ids.map((id) => getTab(id)));
    const tabs: TabInfo[] = [];
    for (const [n, id] of ids.entries()) {
      const candidate = found[n] ?? null;
      if (candidate === null) current.drop(id);
      else tabs.push(candidate);
    }
    return tabs;
  }

  /**
   * The close and what follows it (PLAN.md §8.4.4, §8.4.5).
   *
   * Both tabs are read again first (§8.6, "Tab closed in the meantime"): the user may have
   * closed either of them while the decision was being made. A tab that is gone cancels the
   * close, including when it is the tab that would have been **kept** — closing the other
   * one then would leave the page nowhere.
   */
  async function carryOut(
    resolution: DuplicateResolution,
    trigger: TabInfo,
    current: GuardIndex,
    at: number,
  ): Promise<boolean> {
    const target = await reread(resolution.closeTabId, trigger, current);
    const keep = await reread(resolution.keepTabId, trigger, current);
    if (target === null || keep === null) return false;

    const [entry] = await closeTabs([target], at, {
      reason: 'duplicate-auto',
      // §8.4.5: "a reference to the kept tab", so the archive can say what it was a
      // duplicate of and the Archive view can filter on it.
      duplicateOfUrl: new Map([[target.id, tabUrl(keep)]]),
      capabilities,
    });
    // Dropped here, in the same step, and not left to `onRemoved`: the next event of this
    // burst must not find the tab this one closed still in the index, or two duplicates
    // would close each other and nothing would be left (PLAN.md §8.2).
    current.drop(target.id);
    if (entry !== undefined) await rememberAutoClosed(entry.id);

    await afterClose(resolution, target, keep, current);
    return true;
  }

  /** The tab as it is now, or `null` if it is gone. The trigger was read this step already. */
  async function reread(
    tabId: number,
    trigger: TabInfo,
    current: GuardIndex,
  ): Promise<TabInfo | null> {
    if (tabId === trigger.id) return trigger;
    const tab = await getTab(tabId);
    if (tab === null) current.drop(tabId);
    return tab;
  }

  /**
   * What happens to the tab that stays (PLAN.md §8.4.4), in the order the user perceives:
   * it loads the URL that triggered the close, it takes the closed tab's place, and only
   * then does it come to the front.
   *
   * Each step is allowed to fail — the tab may go at any moment — and each one that worked
   * is carried into the next, so the single `put` at the end files the tab under the key it
   * really has now.
   */
  async function afterClose(
    resolution: DuplicateResolution,
    closed: TabInfo,
    keep: TabInfo,
    current: GuardIndex,
  ): Promise<void> {
    let kept = keep;
    const reload = resolution.reloadKeptWith;

    if (reload !== undefined && (await navigateTab(kept.id, reload))) {
      kept = { ...kept, url: reload };
      // It got there by navigating, which is exactly what §8.4.3.2 counts.
      current.navigated.add(kept.id);
      current.awaiting.delete(kept.id);
    }

    if (
      resolution.after === 'move-activate' &&
      (await moveTab(kept.id, closed.windowId, closed.index))
    ) {
      kept = { ...kept, windowId: closed.windowId, index: closed.index };
    }

    if (resolution.after !== 'none' || closed.active) {
      await activate(kept);
      kept = { ...kept, active: true };
    }

    current.put(kept);
  }

  async function pause(durationMs: number | null): Promise<void> {
    // The stored mode, which is the one to come back to. Read rather than taken from the
    // cache: a pause is a user gesture, and the cache may be a mode ago.
    const settings = await readSettings();
    const until = now() + (durationMs ?? UNTIL_RESTART_MS);
    await pauseGuard(until, settings.guard.mode);
    // An alarm and not a timer: 15 min of pause outlives the service worker many times
    // over (invariant 6). "Fino al riavvio" needs none, see `UNTIL_RESTART_MS`.
    if (durationMs !== null) await api().alarms.create(RESUME_ALARM, { when: until });
  }

  async function resume(): Promise<void> {
    await resumeGuard();
    await api().alarms.clear(RESUME_ALARM);
  }

  async function status(): Promise<GuardStatus> {
    const [settings, state] = await Promise.all([readSettings(), readGuardState()]);
    const until = state.pausedUntil;
    if (until === undefined || until <= now()) return { mode: settings.guard.mode, paused: false };
    return {
      mode: settings.guard.mode,
      paused: true,
      pausedUntil: until,
      // The mode the pause remembers, or the stored one for a pause written by an older
      // release that did not record it.
      resumeMode: state.resumeMode ?? settings.guard.mode,
    };
  }

  /** The shortcut's single key (PLAN.md §4.1), which has no duration to offer. */
  async function toggle(): Promise<void> {
    const current = await status();
    if (current.paused) await resume();
    else await pause(null);
  }

  /**
   * "Chiudi tutti i duplicati" (PLAN.md §8.7), the whole tab list at once.
   *
   * Inside the queue like every other close, so it cannot interleave with a live-guard close
   * and leave a set with no tab at all. One `tabs.query({})`, reused for the index, and one
   * `closeTabs`, so the archive gets a single write and the user a single "Annulla".
   */
  async function sweep(at: number): Promise<readonly ArchivedTab[]> {
    const loaded = await ready();
    const tabs = await queryTabs();
    const current = await indexed(loaded, tabs);

    const [state, activity, focusedWindowId] = await Promise.all([
      readGuardState(),
      activityItem.getValue(),
      focusedWindow(),
    ]);
    const createdAt: Record<number, number> = {};
    for (const tab of tabs) {
      const record = activity[tab.id];
      if (record !== undefined) createdAt[tab.id] = record.createdAt;
    }

    const closes = resolveAllDuplicates(tabs, {
      now: at,
      settings: loaded.guard,
      match: loaded.match,
      createdAt,
      navigatedTabIds: current.navigated,
      focusedWindowId,
      isWhitelisted: loaded.isWhitelisted,
      ownOrigin: loaded.ownOrigin,
      exemptions: state.exemptions,
      // No `pausedUntil` and no `autoClosesAllowedFrom`: the mode, the pause and the
      // start-up grace do not hold back a key the user has just pressed. See
      // `resolveAllDuplicates`.
    });
    if (closes.length === 0) return [];

    const byId = new Map(tabs.map((tab) => [tab.id, tab]));
    const targets: TabInfo[] = [];
    const duplicateOfUrl = new Map<number, string>();
    let keptToActivate: TabInfo | undefined;
    for (const close of closes) {
      const target = byId.get(close.closeTabId);
      const keep = byId.get(close.keepTabId);
      // Both came out of `tabs`, so both are there; the lookups are how TypeScript learns it.
      if (target === undefined || keep === undefined) continue;
      targets.push(target);
      duplicateOfUrl.set(target.id, tabUrl(keep));
      if (target.active || keptToActivate === undefined) keptToActivate = keep;
    }

    const entries = await closeTabs(targets, at, {
      // §8.7 is a gesture, not the guard acting on its own, and the Archive view says so.
      reason: 'duplicate-manual',
      duplicateOfUrl,
      capabilities,
    });
    for (const target of targets) current.drop(target.id);
    if (keptToActivate !== undefined) await activate(keptToActivate);
    // §8.7: "undo goes through the icon menu", which reopens one tab — the last one closed.
    // Everything else stays reachable from the panel's "Annulla" and the Archive view.
    const last = entries.at(-1);
    if (last !== undefined) await rememberAutoClosed(last.id);
    return entries;
  }

  function closeAllDuplicates(): Promise<readonly ArchivedTab[]> {
    const at = now();
    return run(() => sweep(at));
  }

  /**
   * "Riapri l'ultimo duplicato chiuso" (PLAN.md §8.5).
   *
   * `restoreTabs` writes the URL exemption before it creates anything, which is what keeps
   * the guard from closing the tab again the moment it appears (§8.6).
   */
  function reopenLastDuplicate(): Promise<ArchivedTab | null> {
    const at = now();
    return run(async () => {
      const state = await readGuardState();
      const id = state.lastAutoClosedId;
      if (id === undefined) return null;
      // Read from the archive and not remembered here: the entry may have been reopened
      // already, or pruned, and `storage.session` outlives neither.
      const entry = (await readArchive()).find((archived) => archived.id === id);
      if (entry === undefined) return null;
      const restored = await restoreTabs([entry], at, { capabilities });
      return restored.length === 0 ? null : entry;
    });
  }

  async function settled(): Promise<void> {
    let seen: Promise<unknown> | null = null;
    // The chain grows while it is being awaited — a close starts a flash, and the flash is
    // deliberately not part of it — so it is awaited until nothing is left moving.
    while (seen !== chain || flashing !== null) {
      seen = chain;
      await seen;
      await flashing;
    }
  }

  // §8.2's three events, and nothing else: a new tab, a tab that navigated, a tab dragged
  // into another window. Everything else about a tab leaves what it is showing untouched.
  browser.tabs.onCreated.addListener((tab: TabLike) => {
    const at = now();
    const tabId = tab.id;
    if (tabId === undefined) return;
    handle(() => evaluate(tabId, 'created', at));
  });

  browser.tabs.onUpdated.addListener((tabId: number, change: { url?: string }) => {
    // Only a URL can make a tab a duplicate. `onUpdated` also fires for the title, the
    // favicon and the loading state, several times per page (PLAN.md §11).
    if (change.url === undefined) return;
    const at = now();
    handle(() => evaluate(tabId, 'navigated', at));
  });

  // Relevant with the "Stessa finestra" scope, where the tab has just arrived next to tabs
  // it was not being compared with (PLAN.md §8.2).
  browser.tabs.onAttached.addListener((tabId: number) => {
    const at = now();
    handle(() => evaluate(tabId, 'moved', at));
  });

  // Chrome gives a discarded or prerendered page a new tab id (PLAN.md §5.5). Nothing has
  // appeared and nothing has navigated, so this "updates the index without evaluating
  // duplicates" (§8.6) — a swap the user never asked for must not cost them a tab.
  // Firefox keeps the id and never fires this.
  browser.tabs.onReplaced?.addListener((addedTabId: number, removedTabId: number) => {
    handle(async () => {
      // Only when this worker has an index: without one there is nothing to correct, and
      // the rebuild the next event does learns the new id from the browser itself.
      index?.rename(removedTabId, addedTabId);
      return false;
    });
  });

  // Queued like the rest, so that a close and the event announcing it cannot cross.
  browser.tabs.onRemoved.addListener((tabId: number) => {
    handle(async () => {
      index?.drop(tabId);
      return false;
    });
  });

  // PLAN.md §8.6: the first seconds after a start-up are a session restore, and a restored
  // session is full of duplicates the user never made. The deadline goes to
  // `storage.session` because the worker may well be torn down and woken inside those 15 s.
  browser.runtime.onStartup.addListener(() => {
    const at = now();
    handle(async () => {
      // New tab ids, and a `storage.session` the browser has just cleared: everything this
      // worker believes is from before the restart.
      invalidate();
      await startGuardGrace(at + STARTUP_GRACE_MS);
      return false;
    });
  });

  browser.alarms.onAlarm.addListener((alarm: { name: string }) => {
    if (alarm.name !== RESUME_ALARM) return;
    // Through the queue, so that the end of the pause cannot land halfway through an event
    // that read `pausedUntil` a moment ago.
    handle(async () => {
      await resume();
      return false;
    });
  });

  // §8.3: the whitelist is recompiled only on a change, and a change of mode must take
  // effect at once. The guard writes neither of these keys, so there is no loop.
  browser.storage.onChanged.addListener((changes: Record<string, unknown>, area: string) => {
    if (area !== 'local') return;
    if (WATCHED.some((key) => key in changes)) invalidate();
  });

  return {
    pause,
    resume,
    toggle,
    status,
    closeAllDuplicates,
    reopenLastDuplicate,
    invalidate,
    settled,
  };
}

/**
 * The window the user is looking at, for the "Prefer the active window" rule (§8.4.3.5).
 *
 * `windows.getCurrent()` in a service worker answers with whatever window the event came
 * from, which is not the question. A browser with no window open at all has no answer.
 */
async function focusedWindow(): Promise<number | undefined> {
  try {
    return (await api().windows.getLastFocused()).id;
  } catch {
    return undefined;
  }
}

/** "Attivala" (PLAN.md §8.4.4). A tab that went while we were acting is not an error (§8.6). */
async function activate(tab: TabInfo): Promise<void> {
  try {
    await activateTab(tab.id, tab.windowId);
  } catch {
    // Gone. The close it followed still stands, and that was the point.
  }
}

/** The pieces of the extension API this module cannot name through WXT's types. */
interface GuardApi {
  readonly alarms: {
    /** A promise from Chrome 111 and from Firefox, nothing before that. */
    create(name: string, info: { when: number }): Promise<void> | void;
    clear(name: string): Promise<boolean> | void;
  };
  readonly windows: {
    getLastFocused(): Promise<{ id?: number }>;
  };
}

function api(): GuardApi {
  return browser as unknown as GuardApi;
}

/** A guard registered without a badge: §8.5's flash is the badge's, and it may not be there. */
function noFlash(): Promise<void> {
  return Promise.resolve();
}

function failed(error: unknown): void {
  void reportBackgroundError('guard', error);
}

function ignore(): void {
  /* keeps the queue alive after a failed event */
}
