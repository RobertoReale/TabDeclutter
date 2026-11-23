/**
 * The housekeeping of PLAN.md §10: every 6 h, the three stores give back what they no
 * longer need.
 *
 * - the archive: entries past `archiveRetentionDays` or past `ARCHIVE_CAP` (§4.5, §10);
 * - the keeps: the ones whose "Mantieni" has run out (§9);
 * - the activity: the records of tabs that are no longer open.
 *
 * **Why an alarm and not an event.** Nothing happens when a keep expires or an entry
 * turns 31 days old — the only thing that changed is the clock. Every other recompute in
 * the extension is asked for by an event (PLAN.md §11, "no polling"); this one cannot be,
 * so it is the one timer, at the longest period that still honours the retention the
 * settings promise.
 *
 * **Nothing is held in a variable** (invariant 6). Each sweep reads the store, decides and
 * writes; a worker that dies halfway leaves a store that is merely not yet swept, which
 * the next alarm — or the next startup — finishes. The listeners are registered
 * synchronously at the top level of `index.ts`, before the first `await` anywhere.
 *
 * **Nothing here can take a tab.** A sweep deletes records of tabs that have already
 * gone, never the tabs themselves (invariant 2), and the archive entries it drops are
 * ones §4.5 already stopped offering.
 */

import { pruneActivity, pruneArchive, pruneKeeps, readSettings } from '@/platform/storage';
import { queryTabs } from '@/platform/tabs';

import { backgroundError, createSerialQueue, ensurePeriodicAlarm } from './report';

/** PLAN.md §10: "cleanup through `chrome.alarms` every 6 h". */
const CLEANUP_PERIOD_MINUTES = 6 * 60;

const ALARM_NAME = 'cleanup';

/** What one sweep dropped, per store: the shape the tests assert and nothing else reads. */
export interface CleanupReport {
  readonly archive: number;
  readonly keeps: number;
  readonly activity: number;
}

export interface CleanupOptions {
  /** The clock, injected so the tests can be exact about retention. */
  readonly now?: () => number;
}

export interface Cleanup {
  /** Sweeps now, without waiting for the alarm. Used by the tests and by the startup. */
  run(): Promise<CleanupReport>;
}

/**
 * Registers the alarm and the listeners, and sweeps once.
 *
 * The sweep at registration is what makes a long-suspended profile correct: `alarms` only
 * fires while the browser runs, so a machine that was off for a month would otherwise
 * wait another 6 h before honouring a 30-day retention.
 */
export function registerCleanup(options: CleanupOptions = {}): Cleanup {
  const now = options.now ?? Date.now;

  /** One sweep at a time, so two triggers cannot read the same store at once. */
  const enqueue = createSerialQueue();

  function run(): Promise<CleanupReport> {
    return enqueue(sweep);
  }

  async function sweep(): Promise<CleanupReport> {
    const at = now();
    const settings = await readSettings();
    // The open tabs are read before anything is written, so the sweep describes one
    // moment: a tab opened mid-sweep keeps no record yet, and the next sweep finds it.
    const open = await queryTabs();
    const [archive, keeps, activity] = await Promise.all([
      pruneArchive(at, settings.archiveRetentionDays),
      pruneKeeps(at),
      pruneActivity(open.map((tab) => tab.id)),
    ]);
    return { archive, keeps, activity };
  }

  const trigger = (): void => {
    void run().catch(failed);
  };

  browser.alarms.onAlarm.addListener((alarm: { name: string }) => {
    if (alarm.name === ALARM_NAME) trigger();
  });

  browser.runtime.onStartup.addListener(trigger);
  browser.runtime.onInstalled.addListener(trigger);

  void ensurePeriodicAlarm(ALARM_NAME, CLEANUP_PERIOD_MINUTES).catch(failed);
  trigger();

  return { run };
}

const failed = backgroundError('cleanup');
