import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import type {
  SessionTabValues,
  Tracker,
  TrackerOptions,
} from '../../src/entrypoints/background/tracker';
import { registerTracker } from '../../src/entrypoints/background/tracker';
import { HOUR, MINUTE } from '../../src/core/time';
import type { TabActivity } from '../../src/core/types';
import type { Capabilities } from '../../src/platform/capabilities';
import { activityItem, foregroundItem } from '../../src/platform/storage';

/** A fixed clock, moved by hand with `tick`: the tracker takes `now` as an option. */
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
let clock = NOW;

/** Short, so a test that waits for the debounce says so. The default is a second. */
const DEBOUNCE = 1_000;

/** `fakeBrowser` gives every tab and window it creates by default id 0. */
const WINDOW = 0;
const NO_WINDOW = fakeBrowser.windows.WINDOW_ID_NONE;

/** The listener the tracker registered for `tabs.onReplaced`, see `beforeEach`. */
let replaced: ((addedTabId: number, removedTabId: number) => void) | undefined;

beforeEach(() => {
  fakeBrowser.reset();
  clock = NOW;
  replaced = undefined;
  vi.useFakeTimers();
  // `fakeBrowser` stubs `tabs.onReplaced` with an `addListener` that throws, so the test
  // takes the listener the tracker registers and fires it itself.
  vi.spyOn(fakeBrowser.tabs.onReplaced, 'addListener').mockImplementation((listener) => {
    replaced = listener;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function tick(ms: number): void {
  clock += ms;
}

function capabilities(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    sidePanel: true,
    sidebarAction: false,
    faviconApi: true,
    promptApi: false,
    tabGroups: true,
    containers: false,
    sessionTabValues: false,
    duplicateCommandDetection: true,
    ...overrides,
  };
}

function start(overrides: Partial<TrackerOptions> = {}): Tracker {
  return registerTracker({
    now: () => clock,
    debounceMs: DEBOUNCE,
    capabilities: capabilities(),
    ...overrides,
  });
}

function record(tabId: number, url: string, overrides: Partial<TabActivity> = {}): TabActivity {
  return {
    tabId,
    url,
    createdAt: NOW - 2 * HOUR,
    lastActiveAt: NOW - HOUR,
    activations: 3,
    foregroundMs: 5 * MINUTE,
    ...overrides,
  };
}

async function openTab(url: string, options: { active?: boolean } = {}): Promise<number> {
  const created = await fakeBrowser.tabs.create({ url, active: options.active ?? false });
  return created.id ?? 0;
}

function activate(tabId: number): Promise<unknown> {
  return fakeBrowser.tabs.onActivated.trigger({ tabId, windowId: WINDOW });
}

/** A navigation: `onUpdated` with a URL, in a tab the user is or is not looking at. */
async function navigate(tabId: number, url: string, active: boolean): Promise<void> {
  const tab = await fakeBrowser.tabs.get(tabId);
  await fakeBrowser.tabs.onUpdated.trigger(tabId, { url }, { ...tab, url, active });
}

/** Chrome discarding a tab: the page comes back under a new id (PLAN.md §5.5). */
function replaceTab(addedTabId: number, removedTabId: number): void {
  if (replaced === undefined) throw new Error('the tracker did not listen for tabs.onReplaced');
  replaced(addedTabId, removedTabId);
}

function stored(): Promise<Record<number, TabActivity>> {
  return activityItem.getValue();
}

/** Counts the writes, like `tests/ext/storage.test.ts`: one `set` is one write. */
function countWrites() {
  return vi.spyOn(fakeBrowser.storage.local, 'set');
}

/** Firefox's per-tab session store, which the fake browser does not implement. */
function fakeSessions(): SessionTabValues & {
  values: Map<number, unknown>;
  getTabValue: ReturnType<typeof vi.fn>;
  setTabValue: ReturnType<typeof vi.fn>;
} {
  const values = new Map<number, unknown>();
  return {
    values,
    getTabValue: vi.fn((tabId: number, _key: string) => Promise.resolve(values.get(tabId))),
    setTabValue: vi.fn((tabId: number, _key: string, value: unknown) => {
      values.set(tabId, value);
      return Promise.resolve();
    }),
  };
}

describe('what the tracker records', () => {
  it('opens a record when a tab is created', async () => {
    const tracker = start();

    const id = await openTab('https://a.test/');
    await tracker.flush();

    expect(await stored()).toEqual({
      [id]: {
        tabId: id,
        url: 'https://a.test/',
        createdAt: NOW,
        lastActiveAt: NOW,
        activations: 0,
        foregroundMs: 0,
      },
    });
  });

  it('counts an activation and starts the foreground clock', async () => {
    const tracker = start();
    const id = await openTab('https://a.test/');

    tick(MINUTE);
    await activate(id);
    await tracker.flush();

    expect((await stored())[id]).toMatchObject({
      activations: 1,
      lastActiveAt: NOW + MINUTE,
      foregroundMs: 0,
    });
    expect(await foregroundItem.getValue()).toEqual({
      tabId: id,
      windowId: WINDOW,
      since: NOW + MINUTE,
    });
  });

  it('charges the time to the tab that was in front when another takes over', async () => {
    const tracker = start();
    const first = await openTab('https://a.test/');
    const second = await openTab('https://b.test/');

    await activate(first);
    tick(5 * MINUTE);
    await activate(second);
    await tracker.flush();

    const store = await stored();
    expect(store[first]).toMatchObject({
      activations: 1,
      foregroundMs: 5 * MINUTE,
      lastActiveAt: NOW + 5 * MINUTE,
    });
    expect(store[second]).toMatchObject({ activations: 1, foregroundMs: 0 });
  });

  it('counts a tab the extension never saw open', async () => {
    // The service worker that handled `onCreated` is gone, or the tab is older than the
    // extension: the record is invented from what the browser still knows.
    const id = await openTab('https://a.test/');
    const tracker = start();

    await activate(id);
    await tracker.flush();

    expect((await stored())[id]).toMatchObject({
      tabId: id,
      url: 'https://a.test/',
      activations: 1,
      bootstrappedAt: NOW,
    });
  });

  it('stops the clock while no window has the focus and starts it again after', async () => {
    const tracker = start();
    const id = await openTab('https://a.test/', { active: true });

    tick(5 * MINUTE);
    await fakeBrowser.windows.onFocusChanged.trigger(NO_WINDOW);
    await tracker.flush();

    expect((await stored())[id]).toMatchObject({ foregroundMs: 5 * MINUTE });
    expect(await foregroundItem.getValue()).toBeNull();

    // Ten minutes in another application, which are not the tab's.
    tick(10 * MINUTE);
    await fakeBrowser.windows.onFocusChanged.trigger(WINDOW);
    tick(2 * MINUTE);
    await fakeBrowser.windows.onFocusChanged.trigger(NO_WINDOW);
    await tracker.flush();

    expect((await stored())[id]).toMatchObject({
      foregroundMs: 7 * MINUTE,
      lastActiveAt: NOW + 17 * MINUTE,
    });
  });

  it('does nothing when the window that takes the focus has no tab', async () => {
    const tracker = start();
    const id = await openTab('https://a.test/');

    await fakeBrowser.windows.onFocusChanged.trigger(WINDOW);
    await tracker.flush();

    expect(await foregroundItem.getValue()).toBeNull();
    expect((await stored())[id]).toMatchObject({ foregroundMs: 0 });
  });

  it('follows a navigation without calling it activity in a background tab', async () => {
    const tracker = start();
    const id = await openTab('https://a.test/');

    tick(MINUTE);
    await navigate(id, 'https://a.test/next', false);
    await tracker.flush();

    expect((await stored())[id]).toMatchObject({
      url: 'https://a.test/next',
      lastActiveAt: NOW,
    });
  });

  it('counts a navigation in the tab the user is looking at', async () => {
    const tracker = start();
    const id = await openTab('https://a.test/', { active: true });

    tick(MINUTE);
    await navigate(id, 'https://a.test/next', true);
    await tracker.flush();

    expect((await stored())[id]).toMatchObject({
      url: 'https://a.test/next',
      lastActiveAt: NOW + MINUTE,
    });
  });

  it('ignores an update that is not a navigation', async () => {
    const tracker = start();
    const id = await openTab('https://a.test/');
    const writes = countWrites();

    const tab = await fakeBrowser.tabs.get(id);
    await fakeBrowser.tabs.onUpdated.trigger(id, { status: 'complete' }, tab);
    await tracker.flush();

    // The creation was still pending, so there is one write and the URL is untouched.
    expect(writes).toHaveBeenCalledTimes(1);
    expect((await stored())[id]?.url).toBe('https://a.test/');
  });

  it('moves the record when a discard gives the page a new id', async () => {
    const tracker = start();
    const id = await openTab('https://a.test/', { active: true });

    tick(MINUTE);
    replaceTab(99, id);
    await tracker.flush();

    const store = await stored();
    expect(store[id]).toBeUndefined();
    expect(store[99]).toMatchObject({
      tabId: 99,
      url: 'https://a.test/',
      createdAt: NOW,
      activations: 1,
    });
    // The foreground clock follows the new id, so the time is not lost or double counted.
    expect(await foregroundItem.getValue()).toMatchObject({ tabId: 99, since: NOW });

    tick(MINUTE);
    await fakeBrowser.windows.onFocusChanged.trigger(NO_WINDOW);
    await tracker.flush();

    expect((await stored())[99]).toMatchObject({ foregroundMs: 2 * MINUTE });
  });

  it('has nothing to move when the replaced tab had no record', async () => {
    const tracker = start();

    replaceTab(99, 42);
    await tracker.flush();

    expect(await stored()).toEqual({});
  });

  it('forgets a tab that was closed', async () => {
    const tracker = start();
    const id = await openTab('https://a.test/', { active: true });

    await fakeBrowser.tabs.onRemoved.trigger(id, { isWindowClosing: false, windowId: WINDOW });
    await tracker.flush();

    expect(await stored()).toEqual({});
    expect(await foregroundItem.getValue()).toBeNull();
  });
});

describe('when the tracker writes', () => {
  it('turns a burst of events into a single write', async () => {
    const tracker = start();
    const writes = countWrites();

    for (const url of ['a', 'b', 'c', 'd', 'e']) await openTab(`https://${url}.test/`);

    expect(writes).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    await tracker.flush();

    expect(writes).toHaveBeenCalledTimes(1);
    expect(Object.keys(await stored())).toHaveLength(5);
  });

  it('writes what it is holding before the worker is suspended', async () => {
    const tracker = start();
    const writes = countWrites();
    const id = await openTab('https://a.test/');

    await fakeBrowser.runtime.onSuspend.trigger();
    // Joins the queue: by now the suspend write is done and nothing is left to write.
    await tracker.flush();

    expect(writes).toHaveBeenCalledTimes(1);
    expect((await stored())[id]).toMatchObject({ url: 'https://a.test/' });

    // The debounce was cancelled by that write, so the timer adds nothing.
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    await tracker.flush();

    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when nothing happened', async () => {
    const tracker = start();
    const writes = countWrites();

    await tracker.flush();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(writes).not.toHaveBeenCalled();
  });
});

describe('when the browser starts again', () => {
  it('gives the tabs that came back the records of the tabs that went away', async () => {
    const tracker = start();
    const a = await openTab('https://a.test/');
    const b = await openTab('https://b.test/');
    await activityItem.setValue({
      101: record(101, 'https://a.test/', { activations: 9 }),
      102: record(102, 'https://gone.test/'),
    });

    await fakeBrowser.runtime.onStartup.trigger();
    await tracker.flush();

    const store = await stored();
    expect(store[a]).toMatchObject({ tabId: a, activations: 9, foregroundMs: 5 * MINUTE });
    // Nothing was known about this one, and the record of the tab that did not come back
    // is gone. The tab `fakeBrowser` always has open is the third key.
    expect(store[b]).toMatchObject({ tabId: b, bootstrappedAt: NOW });
    expect(Object.keys(store).toSorted()).toEqual(
      [String(WINDOW), String(a), String(b)].toSorted(),
    );
  });

  it('starts the foreground clock from scratch', async () => {
    const tracker = start();
    const id = await openTab('https://a.test/', { active: true });
    await tracker.flush();
    expect(await foregroundItem.getValue()).not.toBeNull();

    await fakeBrowser.runtime.onStartup.trigger();
    await tracker.flush();

    // A period from the previous run must not charge the tab for the night.
    expect(await foregroundItem.getValue()).toBeNull();
    expect((await stored())[id]).toBeDefined();
  });

  it('writes the reconciled store at once, without waiting for the debounce', async () => {
    const tracker = start();
    await openTab('https://a.test/');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    const writes = countWrites();

    await fakeBrowser.runtime.onStartup.trigger();
    await tracker.flush();

    expect(writes).toHaveBeenCalledTimes(1);
  });
});

describe('on install', () => {
  it('invents a record for every tab that is already open', async () => {
    const a = await openTab('https://a.test/');
    const b = await openTab('https://b.test/');
    const tracker = start();

    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'install' });
    await tracker.flush();

    const store = await stored();
    expect(store[a]).toEqual({
      tabId: a,
      url: 'https://a.test/',
      createdAt: NOW,
      lastActiveAt: NOW,
      activations: 0,
      foregroundMs: 0,
      bootstrappedAt: NOW,
    });
    expect(store[b]?.bootstrappedAt).toBe(NOW);
  });

  it('keeps what an earlier version had already observed', async () => {
    const id = await openTab('https://a.test/');
    await activityItem.setValue({ [id]: record(id, 'https://a.test/', { activations: 7 }) });
    const tracker = start();

    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'update', previousVersion: '0.1.0' });
    await tracker.flush();

    expect((await stored())[id]).toMatchObject({ activations: 7 });
    expect((await stored())[id]).not.toHaveProperty('bootstrappedAt');
  });
});

describe('on Firefox, where a tab carries its own record', () => {
  it('saves the records that changed next to their tabs', async () => {
    const sessions = fakeSessions();
    const tracker = start({ capabilities: capabilities({ sessionTabValues: true }), sessions });

    const a = await openTab('https://a.test/');
    const b = await openTab('https://b.test/');
    await tracker.flush();

    expect(sessions.setTabValue).toHaveBeenCalledTimes(2);
    expect(sessions.setTabValue).toHaveBeenCalledWith(
      a,
      'td',
      expect.objectContaining({ tabId: a, url: 'https://a.test/' }),
    );

    sessions.setTabValue.mockClear();
    tick(MINUTE);
    await activate(b);
    await tracker.flush();

    // Only the tab whose record changed, not the whole store.
    expect(sessions.setTabValue).toHaveBeenCalledTimes(1);
    expect(sessions.setTabValue).toHaveBeenCalledWith(
      b,
      'td',
      expect.objectContaining({ tabId: b }),
    );
  });

  it('reads the tab values before matching by URL', async () => {
    const sessions = fakeSessions();
    const tracker = start({ capabilities: capabilities({ sessionTabValues: true }), sessions });
    const id = await openTab('https://a.test/');
    sessions.values.set(id, record(55, 'https://a.test/', { activations: 42 }));
    await activityItem.setValue({ 101: record(101, 'https://a.test/', { activations: 1 }) });

    await fakeBrowser.runtime.onStartup.trigger();
    await tracker.flush();

    expect(sessions.getTabValue).toHaveBeenCalledWith(id, 'td');
    expect((await stored())[id]).toMatchObject({ tabId: id, activations: 42 });
  });

  it('accepts a tab value that was stored as a string', async () => {
    const sessions = fakeSessions();
    const tracker = start({ capabilities: capabilities({ sessionTabValues: true }), sessions });
    const id = await openTab('https://a.test/');
    sessions.values.set(id, JSON.stringify(record(55, 'https://a.test/', { activations: 8 })));

    await fakeBrowser.runtime.onStartup.trigger();
    await tracker.flush();

    expect((await stored())[id]).toMatchObject({ activations: 8 });
  });

  it.each([
    ['is not JSON at all', 'not json'],
    ['is JSON but not a record', '{"tabId":1}'],
  ])('falls back to matching by URL when a tab value %s', async (_name, value) => {
    const sessions = fakeSessions();
    const tracker = start({ capabilities: capabilities({ sessionTabValues: true }), sessions });
    const id = await openTab('https://a.test/');
    sessions.values.set(id, value);
    await activityItem.setValue({ 101: record(101, 'https://a.test/', { activations: 1 }) });

    await fakeBrowser.runtime.onStartup.trigger();
    await tracker.flush();

    expect((await stored())[id]).toMatchObject({ activations: 1 });
  });

  it('carries on when a tab value cannot be read or written', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const sessions = fakeSessions();
    sessions.setTabValue.mockRejectedValueOnce(new Error('tab is gone'));
    const tracker = start({ capabilities: capabilities({ sessionTabValues: true }), sessions });
    const id = await openTab('https://a.test/');

    await tracker.flush();
    expect((await stored())[id]).toBeDefined();

    sessions.getTabValue.mockRejectedValueOnce(new Error('tab is gone'));
    await fakeBrowser.runtime.onStartup.trigger();
    await tracker.flush();

    // The session store gave nothing back, so the start-up fell back to matching by URL,
    // which is all Chrome ever has. Both failures were reported and neither stopped it.
    expect((await stored())[id]).toMatchObject({ url: 'https://a.test/' });
    expect(errors).toHaveBeenCalledTimes(2);
  });

  it('does not touch the session store when the browser has no such API', async () => {
    const sessions = fakeSessions();
    const tracker = start({ capabilities: capabilities({ sessionTabValues: false }), sessions });

    await openTab('https://a.test/');
    await tracker.flush();
    await fakeBrowser.runtime.onStartup.trigger();
    await tracker.flush();

    expect(sessions.setTabValue).not.toHaveBeenCalled();
    expect(sessions.getTabValue).not.toHaveBeenCalled();
  });
});

describe('when something goes wrong', () => {
  it('carries on when the browser cannot say what a tab is', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const tracker = start();
    const broken = vi
      .spyOn(fakeBrowser.tabs, 'get')
      .mockRejectedValueOnce(new Error('no such tab') as never);

    // An activation for a tab the tracker has no record of: it asks the browser, and the
    // browser fails.
    await activate(404);
    const id = await openTab('https://a.test/');
    await tracker.flush();

    expect(broken).toHaveBeenCalled();
    expect((await stored())[id]).toMatchObject({ url: 'https://a.test/' });
    expect((await stored())[404]).toBeUndefined();
    expect(errors).not.toHaveBeenCalled();
  });
});
