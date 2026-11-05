import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { DAY } from '../../src/core/time';
import type { ActivityStore } from '../../src/core/types';
import { DEFAULT_SETTINGS, NO_GROUP_ID } from '../../src/core/types';
import type { Badge, BadgeOptions } from '../../src/entrypoints/background/badge';
import { registerBadge } from '../../src/entrypoints/background/badge';
import { activityItem, archiveItem, saveSettings } from '../../src/platform/storage';

/**
 * The number on the icon (PLAN.md §4.1, §8.5, §11): that it counts the `close` bucket and
 * nothing else, that it disappears at 0 and when the user turns it off, that a burst of
 * tab events costs one score, that the alarm alone is enough to notice a tab has grown
 * old, and that the flash puts the colour back.
 *
 * The clock is injected, so "a tab is two days older" is an assignment and not a wait.
 */

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
let clock = NOW;

/** PLAN.md §11's own numbers, which is what these tests are here to hold the badge to. */
const DEBOUNCE = 2_000;
const FLASH = 1_500;

/** `fakeBrowser` gives every tab and window it creates by default id 0. */
const WINDOW = 0;

const ALARM = 'badge-refresh';

/**
 * The `tabs` events `fakeBrowser` has no in-memory implementation for: its `addListener`
 * throws, so the test takes the listener and fires it itself.
 */
const STUBBED = ['onMoved', 'onAttached', 'onDetached', 'onReplaced'] as const;

/** The listeners the badge registered for those events, by event name. */
const stubbed = new Map<(typeof STUBBED)[number], () => void>();

beforeEach(async () => {
  fakeBrowser.reset();
  // `reset` leaves the window `fakeBrowser` starts with and its one tab. What is counted
  // is the point of every test here, so they start from an empty browser.
  const existing = await fakeBrowser.tabs.query({});
  for (const tab of existing) {
    if (tab.id !== undefined) await fakeBrowser.tabs.remove(tab.id);
  }
  clock = NOW;
  stubbed.clear();
  vi.useFakeTimers();
  for (const event of STUBBED) {
    vi.spyOn(fakeBrowser.tabs[event], 'addListener').mockImplementation(
      (listener: (...args: never[]) => void) => {
        stubbed.set(event, listener as () => void);
      },
    );
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The badge, with the injected clock and PLAN.md's own debounce and flash. */
function start(overrides: Partial<BadgeOptions> = {}): Badge {
  return registerBadge({ now: () => clock, ...overrides });
}

/** Lets the work a listener started without being awaited finish. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function text(): Promise<string> {
  return fakeBrowser.action.getBadgeText({});
}

/** The badge's background, as `fakeBrowser` keeps it: `[r, g, b, a]`. */
async function colour(): Promise<unknown> {
  return fakeBrowser.action.getBadgeBackgroundColor({});
}

/**
 * How far apart a colour's channels are: 0 for any grey, and large for anything the eye
 * reads as a colour. §4.1 asks for a neutral badge and §8.5 for a flash, which is this
 * number being small and then large — a claim that survives the palette being retuned.
 */
function spread(value: unknown): number {
  const channels = (value as number[]).slice(0, 3);
  return Math.max(...channels) - Math.min(...channels);
}

/**
 * A tab as the browser reports it: whatever `fakeBrowser` made, with the group id it does
 * not keep (see `openTabs`). Only the id is ever read back here; the rest is the score's.
 */
interface ReportedTab {
  readonly id?: number;
  readonly groupId: number;
  readonly [field: string]: unknown;
}

interface Seeded {
  readonly ids: readonly number[];
  /** The tabs as the browser reports them, for `reportTabs`. */
  readonly tabs: readonly ReportedTab[];
}

/**
 * `count` tabs idle for `idleDays`, with a record each, as the tracker would have written
 * it: never read, so the score has both of §6.4's reasons to be sure about them.
 *
 * A different URL per tab, so what puts them in the `close` bucket is their age and not
 * the duplicate rule. Reported rather than only created, because every tab `fakeBrowser`
 * makes claims `groupId: 0` — a real group id — and a grouped tab is scored at 0.6
 * (PLAN.md §6.4), which is a rule of its own and not this file's subject.
 */
async function openTabs(count: number, idleDays: number): Promise<Seeded> {
  const tabs: ReportedTab[] = [];
  const ids: number[] = [];
  const activity: ActivityStore = {};

  for (let n = 0; n < count; n++) {
    const url = `https://example.com/article-${String(n)}`;
    const tab = await fakeBrowser.tabs.create({ url, active: false });
    const id = tab.id ?? 0;
    tabs.push({ ...tab, groupId: NO_GROUP_ID });
    ids.push(id);
    activity[id] = {
      tabId: id,
      url,
      createdAt: NOW - idleDays * DAY,
      lastActiveAt: NOW - idleDays * DAY,
      activations: 0,
      foregroundMs: 0,
    };
  }

  reportTabs(tabs);
  await activityItem.setValue(activity);
  return { ids, tabs };
}

/** Old enough for §6.4 to be sure: 55 points of inactivity and 15 of "never read". */
function openStaleTabs(count: number): Promise<Seeded> {
  return openTabs(count, 30);
}

/**
 * Replaces what the browser reports as open. `tabs.query` also has a callback overload, so
 * its mocked return type is `void` and the cast is unavoidable.
 */
function reportTabs(open: readonly unknown[]): void {
  vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation((() => Promise.resolve(open)) as never);
}

/** An alarm as the browser hands it to a listener, now. */
function firing(name: string) {
  return { name, scheduledTime: clock, persistAcrossSessions: false };
}

/**
 * Counts the scores from here on. `tabs.query` is how a score announces itself, and
 * `reportTabs` has already spied on it, so the history is cleared rather than started.
 */
function watchScores(): MockInstance {
  const query = vi.spyOn(fakeBrowser.tabs, 'query');
  query.mockClear();
  return query;
}

describe('the count', () => {
  it('is the tabs the score would close', async () => {
    await openStaleTabs(3);
    const badge = start();
    await badge.refresh();

    expect(await text()).toBe('3');
  });

  it('leaves out the tabs the score is only unsure about', async () => {
    // Six days idle against a `staleDays` of 7: 67 points, the `review` bucket. §4.1
    // counts "Da chiudere", so none of these is on the icon.
    await openTabs(4, 6);
    const badge = start();
    await badge.refresh();

    expect(await text()).toBe('');
  });

  it('shows no badge at all when there is nothing to close (§4.1)', async () => {
    await fakeBrowser.tabs.create({ url: 'https://example.com/fresh', active: false });
    const badge = start();
    await badge.refresh();

    expect(await text()).toBe('');
  });

  it('is written in a neutral colour', async () => {
    const before = await colour();
    const textColour = vi.spyOn(fakeBrowser.action, 'setBadgeTextColor');
    await openStaleTabs(2);
    const badge = start();
    await badge.refresh();

    const neutral = await colour();
    // Ours, and a grey: `fakeBrowser` starts from a grey of its own, so both halves are
    // needed to know the badge chose this colour.
    expect(neutral).not.toEqual(before);
    expect(spread(neutral)).toBeLessThan(16);
    expect(textColour).toHaveBeenCalled();
  });
});

describe('the recompute', () => {
  it('costs one score for a whole window being restored (§11)', async () => {
    const badge = start();
    await badge.refresh();
    const query = watchScores();

    for (let n = 0; n < 30; n++) {
      await fakeBrowser.tabs.create({ url: `https://example.com/${String(n)}`, active: false });
    }
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('waits the 2 s of §11 before a tab event reaches the icon', async () => {
    const seeded = await openStaleTabs(3);
    const badge = start();
    await badge.refresh();
    expect(await text()).toBe('3');

    // One of them is closed, the way the badge sees it: the event, and a browser that no
    // longer lists the tab.
    reportTabs(seeded.tabs.filter((tab) => tab.id !== seeded.ids[0]));
    await fakeBrowser.tabs.onRemoved.trigger(seeded.ids[0] ?? 0, {
      isWindowClosing: false,
      windowId: WINDOW,
    });

    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1);
    expect(await text()).toBe('3');
    await vi.advanceTimersByTimeAsync(1);
    expect(await text()).toBe('2');
  });

  it.each(STUBBED)('answers tabs.%s too', async (event) => {
    const badge = start();
    await badge.refresh();
    const query = watchScores();

    // `onReplaced` is Chrome-only — a discarded tab comes back with a new id (PLAN.md
    // §5.5) — and the badge subscribes to it only where it exists.
    const listener = stubbed.get(event);
    expect(listener, event).toBeTypeOf('function');
    listener?.();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('answers a change to the records the tracker writes', async () => {
    const badge = start();
    await badge.refresh();
    expect(await text()).toBe('');

    await openStaleTabs(2);
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(await text()).toBe('2');
  });

  it('ignores a change to something no score depends on', async () => {
    const badge = start();
    await badge.refresh();
    const query = watchScores();

    await archiveItem.setValue([]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(query).not.toHaveBeenCalled();
  });
});

describe('the alarm', () => {
  it('is asked for every 30 min (§11)', async () => {
    start();
    await settle();

    expect((await fakeBrowser.alarms.get(ALARM))?.periodInMinutes).toBe(30);
  });

  it('is left alone when the worker starts again', async () => {
    start();
    await settle();
    const first = await fakeBrowser.alarms.get(ALARM);
    const create = vi.spyOn(fakeBrowser.alarms, 'create');

    // Every event the badge is not listening for costs a new worker, and a `create` there
    // would start the half hour again and again until nothing ever fired.
    start();
    await settle();

    expect(create).not.toHaveBeenCalled();
    expect(await fakeBrowser.alarms.get(ALARM)).toEqual(first);
  });

  it('notices a tab that grew old while nothing happened', async () => {
    // Inside `staleDays`, so the icon is bare, and no event will ever say otherwise.
    await openTabs(1, 6);
    const badge = start();
    await badge.refresh();
    expect(await text()).toBe('');

    clock += 2 * DAY;
    await fakeBrowser.alarms.onAlarm.trigger(firing(ALARM));
    await settle();

    expect(await text()).toBe('1');
  });

  it('leaves an alarm with another name to its owner', async () => {
    await openStaleTabs(2);
    const badge = start();
    await badge.refresh();
    const query = watchScores();

    await fakeBrowser.alarms.onAlarm.trigger(firing('something-else'));
    await settle();

    expect(query).not.toHaveBeenCalled();
  });
});

describe('"Mostra badge" turned off', () => {
  async function turnOff(): Promise<void> {
    await saveSettings({ ...DEFAULT_SETTINGS, showBadge: false });
  }

  it('shows nothing, and does not even score the tabs', async () => {
    await openStaleTabs(3);
    await turnOff();
    const badge = start();
    const query = watchScores();
    await badge.refresh();

    expect(await text()).toBe('');
    expect(query).not.toHaveBeenCalled();
  });

  it('takes away a badge that is already showing', async () => {
    await openStaleTabs(3);
    const badge = start();
    await badge.refresh();
    expect(await text()).toBe('3');

    await turnOff();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(await text()).toBe('');
  });

  it('has nothing to flash', async () => {
    await openStaleTabs(1);
    const badge = start();
    await badge.refresh();
    await turnOff();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    const neutral = await colour();

    const flashing = badge.flash();
    await vi.advanceTimersByTimeAsync(FLASH);
    await flashing;

    expect(await colour()).toEqual(neutral);
  });
});

describe('the flash the guard will use (§8.5)', () => {
  it('changes the colour for 1.5 s and puts it back', async () => {
    await openStaleTabs(1);
    const badge = start();
    await badge.refresh();
    const neutral = await colour();

    const flashing = badge.flash();
    await settle();
    const flash = await colour();
    // Not the neutral, and not a grey: a flash nobody can see is not a flash.
    expect(flash).not.toEqual(neutral);
    expect(spread(flash)).toBeGreaterThan(spread(neutral));

    await vi.advanceTimersByTimeAsync(FLASH - 1);
    expect(await colour()).toEqual(flash);

    await vi.advanceTimersByTimeAsync(1);
    await flashing;
    expect(await colour()).toEqual(neutral);
  });

  it('is repaired by the next recompute if the worker died mid-flash', async () => {
    await openStaleTabs(1);
    const badge = start();
    await badge.refresh();
    const neutral = await colour();

    // The flash starts and its restore never runs, which is what a torn-down service
    // worker leaves behind (invariant 6).
    const flashing = badge.flash();
    await settle();
    expect(await colour()).not.toEqual(neutral);
    vi.clearAllTimers();

    await badge.refresh();

    expect(await colour()).toEqual(neutral);
    await expect(Promise.race([flashing, Promise.resolve('pending')])).resolves.toBe('pending');
  });
});
