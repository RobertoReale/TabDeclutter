import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { DAY } from '../../src/core/time';
import type { ActivityStore } from '../../src/core/types';
import type { PanelStateHandle } from '../../src/entrypoints/sidepanel/state/tabs';
import {
  loaded,
  panelData,
  reviewCount,
  startPanelState,
  tabCount,
  windowCount,
} from '../../src/entrypoints/sidepanel/state/tabs';
import { activityItem, archiveItem, protectedDomainsItem } from '../../src/platform/storage';

/**
 * The panel's own view of the browser: that it reads everything a score needs,
 * that it follows `tabs.on*` and `storage.onChanged`, and that a window being
 * restored costs one read rather than thirty.
 */

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
let clock = NOW;

/** Short and recognizable, so a test that waits for the debounce says so. */
const DEBOUNCE = 150;

/** `fakeBrowser` gives every tab and window it creates by default id 0. */
const WINDOW = 0;

let handle: PanelStateHandle | undefined;

/**
 * The `tabs` events `fakeBrowser` has no in-memory implementation for: its
 * `addListener` throws, so the test takes the listener and fires it itself.
 */
const STUBBED = ['onMoved', 'onAttached', 'onDetached', 'onReplaced'] as const;

/** The listeners the panel registered for those events, by event name. */
const stubbed = new Map<(typeof STUBBED)[number], () => void>();

beforeEach(async () => {
  fakeBrowser.reset();
  // `reset` leaves the window `fakeBrowser` starts with and its one tab. The
  // counts are the point of several of these tests, so they start from nothing.
  const existing = await fakeBrowser.tabs.query({});
  for (const tab of existing) {
    if (tab.id !== undefined) await fakeBrowser.tabs.remove(tab.id);
  }
  clock = NOW;
  stubbed.clear();
  // The signals are module state, shared by every test in the file.
  panelData.value = null;
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
  handle?.stop();
  handle = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Starts the panel state and waits for its first read to land. */
async function start(): Promise<PanelStateHandle> {
  handle = startPanelState({ now: () => clock, debounceMs: DEBOUNCE });
  await handle.refresh();
  return handle;
}

/**
 * Replaces what the browser reports as open. `tabs.query` also has a callback
 * overload, so its mocked return type is `void` and the cast is unavoidable.
 */
function reportTabs(open: readonly unknown[]): void {
  vi.spyOn(fakeBrowser.tabs, 'query').mockImplementation((() => Promise.resolve(open)) as never);
}

/** Lets the debounce fire and the read it asks for settle. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(DEBOUNCE);
  await handle?.refresh();
}

describe('the first read', () => {
  it('has nothing until it comes back', () => {
    expect(loaded.value).toBe(false);
    expect(tabCount.value).toBe(0);
    expect(windowCount.value).toBe(0);
  });

  it('loads the open tabs', async () => {
    await fakeBrowser.tabs.create({ url: 'https://example.com/one' });
    await fakeBrowser.tabs.create({ url: 'https://example.com/two' });
    await start();

    expect(loaded.value).toBe(true);
    expect(tabCount.value).toBe(2);
    expect(panelData.value?.tabs.map((tab) => tab.url)).toEqual([
      'https://example.com/one',
      'https://example.com/two',
    ]);
  });

  it('loads the activity and the settings the score needs', async () => {
    const activity: ActivityStore = {
      1: {
        tabId: 1,
        url: 'https://example.com/one',
        createdAt: NOW - 30 * DAY,
        lastActiveAt: NOW - 30 * DAY,
        activations: 1,
        foregroundMs: 0,
      },
    };
    await activityItem.setValue(activity);
    await protectedDomainsItem.setValue(['*.example.org']);
    await start();

    expect(panelData.value?.activity).toEqual(activity);
    expect(panelData.value?.protectedSites).toEqual(['*.example.org']);
    // Not stored, so the defaults: the merge `readSettings` does.
    expect(panelData.value?.settings.staleDays).toBe(7);
    expect(panelData.value?.at).toBe(NOW);
  });

  it('leaves out the tabs another extension hid, as §5.5 asks', async () => {
    const tab = await fakeBrowser.tabs.create({ url: 'https://example.com/hidden' });
    // `fakeBrowser` has no `tabs.hide`, so the flag is set where it is read from.
    reportTabs([{ ...tab, hidden: true }]);
    await start();

    expect(tabCount.value).toBe(0);
  });

  it('counts the windows the tabs are spread over', async () => {
    const other = await fakeBrowser.windows.create({});
    expect(other?.id).toBeTypeOf('number');
    await fakeBrowser.tabs.create({ url: 'https://example.com/one', windowId: WINDOW });
    await fakeBrowser.tabs.create({ url: 'https://example.com/two', windowId: WINDOW });
    await fakeBrowser.tabs.create({ url: 'https://example.com/three', windowId: other?.id });
    await start();

    expect(tabCount.value).toBe(3);
    expect(windowCount.value).toBe(2);
  });
});

describe('following the browser', () => {
  it('sees a tab that was opened', async () => {
    await start();
    expect(tabCount.value).toBe(0);

    await fakeBrowser.tabs.create({ url: 'https://example.com/new' });
    await settle();

    expect(tabCount.value).toBe(1);
  });

  it('sees a tab that was closed', async () => {
    const tab = await fakeBrowser.tabs.create({ url: 'https://example.com/one' });
    const other = await fakeBrowser.tabs.create({ url: 'https://example.com/two' });
    await start();
    expect(tabCount.value).toBe(2);

    // `fakeBrowser.tabs.remove` only works on a tab whose id matches its
    // window's, so the close is played back the way the panel sees it: the
    // event, and a browser that no longer lists the tab.
    reportTabs([other]);
    await fakeBrowser.tabs.onRemoved.trigger(tab.id as number, {
      isWindowClosing: false,
      windowId: WINDOW,
    });
    await settle();

    expect(tabCount.value).toBe(1);
  });

  it('costs one read for a whole window being restored', async () => {
    await start();
    const query = vi.spyOn(fakeBrowser.tabs, 'query');

    for (let n = 0; n < 30; n++) {
      await fakeBrowser.tabs.create({ url: `https://example.com/${String(n)}` });
    }
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(STUBBED)('reads again for tabs.%s', async (event) => {
    await start();
    const query = vi.spyOn(fakeBrowser.tabs, 'query');

    // `onReplaced` is Chrome-only — a discarded tab comes back with a new id
    // (PLAN.md §5.5) — and the panel subscribes to it only where it exists.
    const listener = stubbed.get(event);
    expect(listener, event).toBeTypeOf('function');
    listener?.();
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('reads again for an event that arrives after the window closed', async () => {
    await start();
    const query = vi.spyOn(fakeBrowser.tabs, 'query');

    await fakeBrowser.tabs.create({ url: 'https://example.com/one' });
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    await fakeBrowser.tabs.create({ url: 'https://example.com/two' });
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('following the background', () => {
  it('reads again when the activity it wrote changes', async () => {
    await start();
    const query = vi.spyOn(fakeBrowser.tabs, 'query');

    await activityItem.setValue({});
    await settle();

    expect(query).toHaveBeenCalled();
  });

  it('ignores a change to something no score depends on', async () => {
    await start();
    const query = vi.spyOn(fakeBrowser.tabs, 'query');

    await archiveItem.setValue([]);
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(query).not.toHaveBeenCalled();
  });
});

describe('the score', () => {
  /** One tab, last touched `idleDays` ago. */
  async function withIdleTab(idleDays: number): Promise<void> {
    const tab = await fakeBrowser.tabs.create({ url: 'https://example.com/article' });
    const id = tab.id as number;
    await activityItem.setValue({
      [id]: {
        tabId: id,
        url: 'https://example.com/article',
        createdAt: NOW - idleDays * DAY,
        lastActiveAt: NOW - idleDays * DAY,
        activations: 1,
        foregroundMs: 0,
      },
    });
    await start();
  }

  it('suggests nothing for a tab that was just used', async () => {
    await withIdleTab(0);
    expect(reviewCount.value).toBe(0);
  });

  it('suggests a tab nobody has looked at for a month', async () => {
    await withIdleTab(30);
    expect(reviewCount.value).toBe(1);
    expect(panelData.value?.tabs).toHaveLength(1);
  });
});
