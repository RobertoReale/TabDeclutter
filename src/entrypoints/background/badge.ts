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

import { compileMatcher } from '@/core/patterns';
import { scoreTabs } from '@/core/scoring';
import {
  activityItem,
  duplicateWhitelistItem,
  keepsItem,
  protectedDomainsItem,
  readScoringInputs,
  readSettings,
  settingsItem,
} from '@/platform/storage';
import { queryTabs } from '@/platform/tabs';

import {
  backgroundError,
  createDebouncer,
  createSerialQueue,
  ensurePeriodicAlarm,
  focusedWindow,
  watchLocalKeys,
} from './report';

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

const WATCHED_ITEMS = [
  activityItem,
  keepsItem,
  settingsItem,
  protectedDomainsItem,
  duplicateWhitelistItem,
];

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

  /** One recompute at a time, so a late score cannot overwrite a newer one. */
  const run = createSerialQueue();

  function refresh(): Promise<void> {
    return run(recompute);
  }

  async function recompute(): Promise<void> {
    // The setting first and on its own: when the badge is off there is nothing to count,
    // and a tab event must not cost a score for an answer nobody will see (PLAN.md §11).
    const settings = await readSettings();
    if (!settings.showBadge) {
      await api().action.setBadgeText({ text: '' });
      return;
    }

    const at = now();
    const [tabs, inputs, focusedWindowId] = await Promise.all([
      queryTabs(),
      readScoringInputs(at),
      focusedWindow(),
    ]);

    const scoring = scoreTabs(tabs, inputs.activity, settings, at, {
      // Compiled once per score, never once per tab (PLAN.md §8.3).
      isWhitelisted: compileMatcher(inputs.whitelist),
      protectedSites: inputs.protectedSites,
      keeps: inputs.keeps,
      ownOrigin: browser.runtime.getURL(''),
      focusedWindowId,
    });
    const count = scoring.tabs.filter((scored) => scored.bucket === 'close').length;

    // §4.1: no badge at 0. An empty text is how both browsers hide one.
    await api().action.setBadgeText({ text: count === 0 ? '' : String(count) });
    if (count > 0) await paint(NEUTRAL_COLOUR);
  }

  const trigger = (): void => {
    void refresh().catch(failed);
  };

  /** What every listener does: ask for a recompute, at most once per window. */
  const schedule = createDebouncer(debounceMs, trigger);

  async function flash(): Promise<void> {
    // Nothing to flash when the user turned the badge off: §8.5's signal is the badge.
    if (!(await readSettings()).showBadge) return;
    await paint(FLASH_COLOUR);
    await wait(flashMs);
    await paint(NEUTRAL_COLOUR);
  }

  for (const event of [
    browser.tabs.onCreated,
    browser.tabs.onRemoved,
    browser.tabs.onMoved,
    browser.tabs.onActivated,
    browser.tabs.onAttached,
    browser.tabs.onDetached,
    browser.tabs.onReplaced,
  ]) {
    event?.addListener(schedule);
  }
  browser.tabs.onUpdated.addListener((_tabId: number, change?: object) => {
    if (isScoringTabUpdate(change as Record<string, unknown> | undefined)) schedule();
  });

  watchLocalKeys(WATCHED_ITEMS, schedule);

  browser.alarms.onAlarm.addListener((alarm: { name: string }) => {
    if (alarm.name === ALARM_NAME) trigger();
  });

  browser.runtime.onStartup.addListener(trigger);
  browser.runtime.onInstalled.addListener(trigger);

  void ensurePeriodicAlarm(ALARM_NAME, REFRESH_PERIOD_MINUTES).catch(failed);

  return { refresh, flash };
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
}

function api(): BadgeApi {
  return browser as unknown as BadgeApi;
}

const IGNORED_TAB_UPDATE_KEYS: ReadonlySet<string> = new Set([
  'favIconUrl',
  'mutedInfo',
  'autoDiscardable',
]);

function isScoringTabUpdate(change: Record<string, unknown> | undefined): boolean {
  if (change === undefined) return true;
  const keys = Object.keys(change);
  return keys.length === 0 || keys.some((key) => !IGNORED_TAB_UPDATE_KEYS.has(key));
}

const failed = backgroundError('badge');
