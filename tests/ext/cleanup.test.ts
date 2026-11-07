import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { keepKey } from '../../src/core/scoring';
import { DAY, HOUR } from '../../src/core/time';
import type { ActivityStore, ArchivedTab } from '../../src/core/types';
import { DEFAULT_SETTINGS } from '../../src/core/types';
import type { Cleanup, CleanupOptions } from '../../src/entrypoints/background/cleanup';
import { registerCleanup } from '../../src/entrypoints/background/cleanup';
import {
  activityItem,
  addKeep,
  addToArchive,
  archiveItem,
  keepsItem,
  saveSettings,
} from '../../src/platform/storage';

/**
 * The housekeeping of PLAN.md §10: that the alarm is the 6 h one, that it is not reset on
 * every worker, that the three stores are swept, and that a restart sweeps too — a profile
 * that was off for a month must not wait another 6 h to honour a 30-day retention.
 *
 * The clock is injected, so "31 days old" is an assignment and not a wait.
 */

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
let clock = NOW;

const ALARM = 'cleanup';

/** PLAN.md §10's own number: 6 h in the minutes `alarms` counts. */
const PERIOD = 360;

beforeEach(() => {
  fakeBrowser.reset();
  clock = NOW;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The cleanup, with the injected clock. */
function start(overrides: Partial<CleanupOptions> = {}): Cleanup {
  return registerCleanup({ now: () => clock, ...overrides });
}

/**
 * The cleanup with its sweep at registration already behind it, so what a later `run()`
 * reports is what that run found and not what registration left for it.
 */
async function started(overrides: Partial<CleanupOptions> = {}): Promise<Cleanup> {
  const cleanup = start(overrides);
  await settle();
  return cleanup;
}

function archived(id: string, closedAt: number): ArchivedTab {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `Tab ${id}`,
    closedAt,
    reason: 'manual',
    windowId: 1,
    index: 0,
  };
}

/** An alarm as the browser hands it to a listener, now. */
function firing(name: string) {
  return { name, scheduledTime: clock, persistAcrossSessions: false };
}

/** Lets the work a listener started without being awaited finish. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Something for each of the three stores to give back, and one of each to keep: a sweep
 * that dropped everything would pass a test that only counted.
 */
async function seed(): Promise<void> {
  await addToArchive([archived('fresh', NOW - DAY), archived('stale', NOW - 31 * DAY)]);
  await addKeep('https://example.com/standing', NOW);
  await addKeep('https://example.com/expired', NOW - 8 * DAY);
  const activity: ActivityStore = {
    1: record(1),
    99: record(99),
  };
  await activityItem.setValue(activity);
  // Tab 1 is open and tab 99 is not: `fakeBrowser` starts with one tab, which `query`
  // reports with its own id, so what is open is stated outright.
  reportTabs([{ id: 1 }]);
}

function record(tabId: number) {
  return {
    tabId,
    url: `https://example.com/${String(tabId)}`,
    createdAt: NOW - DAY,
    lastActiveAt: NOW - HOUR,
    activations: 3,
    foregroundMs: 42,
  };
}

/**
 * Replaces what the browser reports as open. `tabs.query` also has a callback overload, so
 * its mocked return type is `void` and the cast is unavoidable.
 */
function reportTabs(open: readonly unknown[]): void {
  vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation((() => Promise.resolve(open)) as never);
}

async function archivedIds(): Promise<string[]> {
  return (await archiveItem.getValue()).map((entry) => entry.id);
}

describe('the alarm', () => {
  it('is asked for every 6 h (§10)', async () => {
    start();
    await settle();

    expect((await fakeBrowser.alarms.get(ALARM))?.periodInMinutes).toBe(PERIOD);
  });

  it('is left alone when the worker starts again', async () => {
    start();
    await settle();
    const first = await fakeBrowser.alarms.get(ALARM);
    const create = vi.spyOn(fakeBrowser.alarms, 'create');

    // A `create` here would start the six hours again on every worker, and the sweep would
    // be pushed further away until it never fired.
    start();
    await settle();

    expect(create).not.toHaveBeenCalled();
    expect(await fakeBrowser.alarms.get(ALARM)).toEqual(first);
  });

  it('sweeps when it fires', async () => {
    await seed();
    start();
    await settle();
    // What the sweep at registration left: the one stale entry is already gone, so a
    // second one has something of its own to find.
    await addToArchive([archived('older', NOW - 90 * DAY)]);

    await fakeBrowser.alarms.onAlarm.trigger(firing(ALARM));
    await settle();

    expect(await archivedIds()).toEqual(['fresh']);
  });

  it('leaves an alarm with another name to its owner', async () => {
    await seed();
    start();
    await settle();
    await addToArchive([archived('older', NOW - 90 * DAY)]);

    await fakeBrowser.alarms.onAlarm.trigger(firing('something-else'));
    await settle();

    expect(await archivedIds()).toContain('older');
  });
});

describe('a sweep', () => {
  it('gives back what each of the three stores no longer needs', async () => {
    const cleanup = await started();
    await seed();

    expect(await cleanup.run()).toEqual({ archive: 1, keeps: 1, activity: 1 });

    expect(await archivedIds()).toEqual(['fresh']);
    expect(Object.keys(await keepsItem.getValue())).toEqual([
      keepKey('https://example.com/standing'),
    ]);
    expect(Object.keys(await activityItem.getValue())).toEqual(['1']);
  });

  it('happens once at registration, so a long-off profile is right straight away', async () => {
    await seed();

    start();
    await settle();

    expect(await archivedIds()).toEqual(['fresh']);
  });

  it('honours the retention the settings ask for, not only the default', async () => {
    reportTabs([]);
    const cleanup = await started();
    await saveSettings({ ...DEFAULT_SETTINGS, archiveRetentionDays: 7 });
    await addToArchive([archived('recent', NOW - DAY), archived('a-fortnight', NOW - 14 * DAY)]);

    expect((await cleanup.run()).archive).toBe(1);
    expect(await archivedIds()).toEqual(['recent']);
  });

  it('answers to the injected clock', async () => {
    reportTabs([]);
    const cleanup = await started();
    await addToArchive([archived('a', NOW)]);
    await cleanup.run();
    expect(await archivedIds()).toEqual(['a']);

    clock = NOW + 31 * DAY;

    expect((await cleanup.run()).archive).toBe(1);
    expect(await archivedIds()).toEqual([]);
  });

  it('has nothing to drop in an empty profile', async () => {
    reportTabs([]);
    const cleanup = await started();

    expect(await cleanup.run()).toEqual({ archive: 0, keeps: 0, activity: 0 });
  });

  it('runs one at a time, so two triggers cannot read the same store at once', async () => {
    const cleanup = await started();
    await seed();

    const [first, second] = await Promise.all([cleanup.run(), cleanup.run()]);

    // Whichever went first found the stale entry; the other found an archive already swept.
    expect([first.archive, second.archive].toSorted()).toEqual([0, 1]);
    expect(await archivedIds()).toEqual(['fresh']);
  });

  it('keeps sweeping after one has failed', async () => {
    const cleanup = await started();
    await seed();
    const broken = vi
      .spyOn(fakeBrowser.storage.local, 'get')
      .mockRejectedValueOnce(new Error('storage is busy'));

    await expect(cleanup.run()).rejects.toThrow('storage is busy');
    broken.mockRestore();

    expect((await cleanup.run()).archive).toBe(1);
  });
});

describe('a restart and an update', () => {
  it('sweeps on startup', async () => {
    await seed();
    start();
    await settle();
    await addToArchive([archived('older', NOW - 90 * DAY)]);

    await fakeBrowser.runtime.onStartup.trigger();
    await settle();

    expect(await archivedIds()).toEqual(['fresh']);
  });

  it('sweeps when the extension is installed or updated', async () => {
    await seed();
    start();
    await settle();
    await addToArchive([archived('older', NOW - 90 * DAY)]);

    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'update', previousVersion: '0.0.9' });
    await settle();

    expect(await archivedIds()).toEqual(['fresh']);
  });
});
