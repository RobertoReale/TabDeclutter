/**
 * The number on the icon, PLAN.md §4.1.
 *
 * How many tabs are in the `close` bucket — "Da chiudere" — in a neutral colour, nothing
 * at all when that number is 0 or when the user turned the badge off. It is the only thing
 * the extension says without being asked, so it says the one number PLAN.md §3 calls
 * actionable and never a total.
 *
 * **The same `core/` as the panel.** The count is `scoreTabs` over one snapshot of the same
 * inputs the Declutter list reads (invariant 9: one definition of a verdict). The two are
 * computed in different contexts at different moments, so they can be a couple of seconds
 * apart, but never a different rule.
 *
 * **No polling** (PLAN.md §11). A recompute is asked for by the things that can change the
 * answer: the tab events, the stored values a score depends on, and an alarm every 30
 * minutes, because a tab becomes old while nothing at all happens. The tab events are
 * coalesced over 2 s, so a window being restored costs one score and not thirty.
 *
 * **Nothing lives only in a variable** (invariant 6). The badge itself is the state: the
 * browser keeps the text and the colour while it runs, and every refresh re-asserts both,
 * so a worker that died mid-flash leaves nothing to repair.
 */

import { compile } from '@/core/patterns';
import { scoreTabs } from '@/core/scoring';
import {
  activityItem,
  duplicateWhitelistItem,
  keepsItem,
  protectedDomainsItem,
  readKeeps,
  readSettings,
  settingsItem,
} from '@/platform/storage';
import { queryTabs } from '@/platform/tabs';

/** PLAN.md §11 asks for a 2 s debounce on the tab events. */
const RECOMPUTE_DEBOUNCE_MS = 2_000;

/** PLAN.md §11 asks for a recompute every 30 min. `alarms` allows no less than 1. */
const REFRESH_PERIOD_MINUTES = 30;

/** PLAN.md §8.5: the flash lasts 1.5 s. */
const FLASH_MS = 1_500;

const ALARM_NAME = 'badge-refresh';

/**
 * The neutral colour of §4.1: the panel's own `--td-text-muted`. Grey rather than the
 * accent, because a badge the user has not asked for must not look like an alert; the
 * accent is kept for the flash, so the flash is visibly a change.
 */
const NEUTRAL_COLOUR = '#5f6368';

/** PLAN.md §8.5's flash: `--td-accent`, the colour the panel marks its own actions with. */
const FLASH_COLOUR = '#1a73e8';

/** White on both of the above, which is the contrast §4.7 asks of anything readable. */
const TEXT_COLOUR = '#ffffff';

/** `local:activity` → `activity`: the key the browser reports a change under. */
function bareKey(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}

/**
 * The stored values the count depends on, under the names `onChanged` reports. The same
 * list the panel watches, plus nothing: the badge reads exactly what a score reads.
 */
const WATCHED: readonly string[] = [
  activityItem,
  keepsItem,
  settingsItem,
  protectedDomainsItem,
  duplicateWhitelistItem,
].map((item) => bareKey(item.key));

export interface BadgeOptions {
  /** The clock, injected so the tests can be exact. */
  readonly now?: () => number;
  /** How long tab events are coalesced. Defaults to `RECOMPUTE_DEBOUNCE_MS`. */
  readonly debounceMs?: number;
  /** How long the flash lasts. Defaults to `FLASH_MS`. */
  readonly flashMs?: number;
}

export interface Badge {
  /** Recomputes the count now, without waiting for the debounce. */
  refresh(): Promise<void>;
  /**
   * PLAN.md §8.5: the colour changes for `flashMs` and goes back to neutral, so an
   * automatic close is noticed without a notification. The guard awaits it, which is what
   * keeps the service worker alive until the colour has been put back; a worker that dies
   * anyway leaves the next refresh to restore it.
   */
  flash(): Promise<void>;
}

/**
 * Registers the badge. Called at the top level of the background, before any `await`,
 * because a service worker that wakes up for an event must already be listening for it
 * (invariant 6).
 */
export function registerBadge(options: BadgeOptions = {}): Badge {
  const now = options.now ?? Date.now;
  const debounceMs = options.debounceMs ?? RECOMPUTE_DEBOUNCE_MS;
  const flashMs = options.flashMs ?? FLASH_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  /** One recompute at a time, so a late score cannot overwrite a newer one. */
  let chain: Promise<unknown> = Promise.resolve();

  function run(action: () => Promise<void>): Promise<void> {
    const next = chain.then(action, action);
    chain = next.then(ignore, ignore);
    return next;
  }

  function refresh(): Promise<void> {
    return run(recompute);
  }

  async function recompute(): Promise<void> {
    // The setting first and on its own: when the badge is off there is nothing to count,
    // and a tab event must not cost a score for an answer nobody will see (PLAN.md §11).
    const settings = await readSettings();
    if (!settings.showBadge) {
      await hide();
      return;
    }

    const at = now();
    const [tabs, activity, keeps, protectedSites, whitelist, focusedWindowId] = await Promise.all([
      queryTabs(),
      activityItem.getValue(),
      readKeeps(at),
      protectedDomainsItem.getValue(),
      duplicateWhitelistItem.getValue(),
      focusedWindow(),
    ]);

    const scoring = scoreTabs(tabs, activity, settings, at, {
      // Compiled once per score, never once per tab (PLAN.md §8.3).
      isWhitelisted: compile(whitelist).match,
      protectedSites,
      keeps,
      ownOrigin: browser.runtime.getURL(''),
      focusedWindowId,
    });
    const count = scoring.tabs.filter((scored) => scored.bucket === 'close').length;

    // §4.1: no badge at 0. An empty text is how both browsers hide one.
    await api().action.setBadgeText({ text: count === 0 ? '' : String(count) });
    if (count > 0) await paint(NEUTRAL_COLOUR);
  }

  async function hide(): Promise<void> {
    await api().action.setBadgeText({ text: '' });
  }

  /** What every listener does: ask for a recompute, at most once per window. */
  function schedule(): void {
    timer ??= setTimeout(() => {
      timer = undefined;
      void refresh().catch(failed);
    }, debounceMs);
  }

  async function flash(): Promise<void> {
    // Nothing to flash when the user turned the badge off: §8.5's signal is the badge.
    if (!(await readSettings()).showBadge) return;
    await paint(FLASH_COLOUR);
    await wait(flashMs);
    await paint(NEUTRAL_COLOUR);
  }

  // Everything that can change which tabs are open, where they are, or what they show —
  // the same set the panel follows, because the same rules read all of it. `onUpdated`
  // carries the title and the URL, so it is the noisiest and the reason for the debounce.
  browser.tabs.onCreated.addListener(schedule);
  browser.tabs.onRemoved.addListener(schedule);
  browser.tabs.onMoved.addListener(schedule);
  browser.tabs.onUpdated.addListener(schedule);
  browser.tabs.onActivated.addListener(schedule);
  browser.tabs.onAttached.addListener(schedule);
  browser.tabs.onDetached.addListener(schedule);
  // Chrome gives a discarded tab a new id; Firefox never fires this (PLAN.md §5.5).
  browser.tabs.onReplaced?.addListener(schedule);

  // The settings, the keeps, the protected sites and the activity the tracker writes: a
  // change to any of them changes the verdict without a tab having moved. This is also
  // what makes "Mostra badge" take effect at once. The badge writes nothing, so there is
  // no loop to guard against.
  browser.storage.onChanged.addListener((changes: Record<string, unknown>, area: string) => {
    if (area !== 'local') return;
    if (WATCHED.some((key) => key in changes)) schedule();
  });

  // PLAN.md §11: age grows while nothing happens, so the count has to be revisited even in
  // a browser nobody is touching.
  browser.alarms.onAlarm.addListener((alarm: { name: string }) => {
    if (alarm.name === ALARM_NAME) void refresh().catch(failed);
  });

  // A restart and a first run: the icon is bare and no tab event may come for a while.
  browser.runtime.onStartup.addListener(() => {
    void refresh().catch(failed);
  });
  browser.runtime.onInstalled.addListener(() => {
    void refresh().catch(failed);
  });

  void ensureAlarm().catch(failed);

  return { refresh, flash };
}

/**
 * Creates the 30-minute alarm, once.
 *
 * Guarded by a read, because `alarms.create` with a name that already exists replaces the
 * alarm and starts its countdown again: a worker that wakes every few minutes for a tab
 * event would push the next refresh forever out of reach. Alarms outlive the worker and,
 * on Chrome, the browser session, so the read is almost always the whole of the work.
 */
async function ensureAlarm(): Promise<void> {
  const alarms = api().alarms;
  if ((await alarms.get(ALARM_NAME)) !== undefined) return;
  await alarms.create(ALARM_NAME, { periodInMinutes: REFRESH_PERIOD_MINUTES });
}

/**
 * The badge's colours. Set together and on every refresh rather than once at install:
 * the service worker is the only place that knows them, and re-asserting them is what
 * makes a flash interrupted by the worker's death repair itself.
 *
 * `setBadgeTextColor` is missing from older Chrome, where the browser picks the text
 * colour itself, so it is optional and its absence is not a failure.
 */
async function paint(colour: string): Promise<void> {
  const action = api().action;
  await action.setBadgeBackgroundColor({ color: colour });
  await action.setBadgeTextColor?.({ color: TEXT_COLOUR });
}

/**
 * The window the user is looking at, for the duplicate keeper's priority (PLAN.md §8.4.3).
 *
 * `windows.getCurrent()` in a service worker answers with whatever window the event came
 * from, which is not the same question; `getLastFocused` is. A browser with no window open
 * at all — Chrome on macOS, a worker woken by an alarm — simply has no answer.
 */
async function focusedWindow(): Promise<number | undefined> {
  try {
    return (await api().windows.getLastFocused()).id;
  } catch {
    return undefined;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The pieces of the extension API this module cannot name through WXT's types. */
interface BadgeApi {
  readonly action: {
    setBadgeText(details: { text: string }): Promise<void>;
    setBadgeBackgroundColor(details: { color: string }): Promise<void>;
    /** Chrome 110 and Firefox. Absent elsewhere. */
    setBadgeTextColor?(details: { color: string }): Promise<void>;
  };
  readonly alarms: {
    get(name: string): Promise<{ name: string } | undefined>;
    /** A promise from Chrome 111 and from Firefox, nothing before that. */
    create(name: string, info: { periodInMinutes: number }): Promise<void> | void;
  };
  readonly windows: {
    getLastFocused(): Promise<{ id?: number }>;
  };
}

function api(): BadgeApi {
  return browser as unknown as BadgeApi;
}

function failed(error: unknown): void {
  console.error('TabDeclutter: badge', error);
}

function ignore(): void {
  /* keeps the queue alive after a failed recompute */
}
