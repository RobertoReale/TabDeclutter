import { createServer } from 'node:http';
import type { Server } from 'node:http';

import type { BrowserContext, Page } from '@playwright/test';

import type { ActivityStore, Settings } from '../../src/core/types';
import { expect, test } from './fixtures/extension';

/**
 * The number on the icon, in the real browser (PLAN.md §4.1, §11).
 *
 * The badge is the one thing the extension says without being asked, and it is said by the
 * service worker: the count is read back out of `chrome.action` from inside the worker
 * itself, so what is checked is what Chrome is actually showing and not what the module
 * thinks it asked for.
 *
 * **What makes the tabs closable here.** The panel can be opened with its clock moved
 * forward; a service worker cannot. The background reads the *later* of the stored
 * `lastActiveAt` and Chrome's own `tab.lastAccessed`, and `lastAccessed` is always a few
 * seconds ago, so no seeded history can make a real tab look idle to the background. The
 * duplicate rule needs no idleness at all: it is 95 points for the copies of a page the
 * moment they are out of the two-hour grace period, and the age the grace period reads
 * (`createdAt`) is known to storage alone. So three tabs on one page, created twenty days
 * ago as far as storage is concerned, are two tabs to close.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Old enough to clear the grace period of §6.4 several times over. */
const HISTORY_MS = 20 * DAY;

/** The one page this test serves, opened three times over. */
const PATH = '/alpha';

/** Two copies of it, which is what the icon has to say. */
const EXPECTED = '2';

let server: Server;
let base = '';

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (path === PATH) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Alpha</title></head><body><p>Alpha</p></body></html>',
      );
      return;
    }
    // Chrome asks for this on its own; answered with "nothing here" (invariant 1).
    response.writeHead(path === '/favicon.ico' ? 204 : 404).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server did not get a port');
  }
  base = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

/** The slice of the extension API this test asks an extension context for. */
interface BadgeApi {
  action: {
    getBadgeText(details: Record<string, never>): Promise<string>;
    getBadgeBackgroundColor(details: Record<string, never>): Promise<number[]>;
  };
  tabs: {
    query(query: Record<string, unknown>): Promise<{ id?: number; url?: string }[]>;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
}

/**
 * The worker the badge is written by. Looked up on every call rather than held: Chrome
 * stops the worker after about 30 s of quiet (invariant 6) and starts another one for the
 * next event, and the badge has to be the same either way.
 */
async function serviceWorker(context: BrowserContext) {
  const [existing] = context.serviceWorkers();
  return existing ?? (await context.waitForEvent('serviceworker'));
}

/** What the icon is showing, read from inside the service worker. */
async function badgeText(context: BrowserContext): Promise<string> {
  const worker = await serviceWorker(context);
  return worker.evaluate(() =>
    (globalThis as unknown as { chrome: BadgeApi }).chrome.action.getBadgeText({}),
  );
}

interface SeedTab {
  readonly id: number;
  readonly url: string;
}

async function openTabs(panel: Page): Promise<readonly SeedTab[]> {
  return panel.evaluate(async () => {
    const tabs = await (globalThis as unknown as { chrome: BadgeApi }).chrome.tabs.query({});
    return tabs.map((tab) => ({ id: tab.id ?? -1, url: tab.url ?? '' }));
  });
}

async function storedActivity(panel: Page): Promise<ActivityStore> {
  return panel.evaluate(async () => {
    const stored = await (globalThis as unknown as { chrome: BadgeApi }).chrome.storage.local.get(
      'activity',
    );
    return (stored.activity ?? {}) as ActivityStore;
  });
}

/**
 * Waits until the background has stopped writing `local:activity`.
 *
 * The tracker holds the store in memory and flushes it a second after the last tab event
 * (`src/entrypoints/background/tracker.ts`), so a seed written while it is still flushing
 * would be thrown away. Two identical, non-empty reads a debounce apart mean the last tab
 * event has landed.
 */
async function trackerQuiet(panel: Page): Promise<void> {
  let previous = '';
  await expect
    .poll(
      async () => {
        const current = JSON.stringify(await storedActivity(panel));
        const quiet = current !== '{}' && current === previous;
        previous = current;
        return quiet;
      },
      { intervals: Array.from({ length: 8 }, () => 1_500), timeout: 15_000 },
    )
    .toBe(true);
}

/**
 * The history that takes the tabs out of the grace period, as the background would have
 * recorded it. The first tab is made an hour older than the others, so §8.4.3's age rule
 * always keeps the same one of the three and the other two are always the duplicates.
 */
function historyFor(tabs: readonly SeedTab[]): ActivityStore {
  const now = Date.now();
  const activity: ActivityStore = {};
  let copies = 0;

  for (const tab of tabs) {
    const first = tab.url.endsWith(PATH) && copies++ === 0;
    const at = now - HISTORY_MS - (first ? HOUR : 0);
    activity[tab.id] = {
      tabId: tab.id,
      url: tab.url,
      createdAt: at,
      lastActiveAt: at,
      activations: 0,
      foregroundMs: 0,
    };
  }
  return activity;
}

test.describe('the badge', () => {
  // Four real tabs, a second of the tracker's debounce to wait out, and the badge's own
  // two (PLAN.md §11).
  test.slow();

  test('says how many tabs are to close, and nothing when there are none', async ({
    context,
    extensionId,
  }) => {
    // Three tabs on one page. The window the persistent context opens with holds the first.
    for (const at of [0, 1, 2]) {
      const existing = at === 0 ? context.pages()[0] : undefined;
      const tab = existing ?? (await context.newPage());
      await tab.goto(`${base}${PATH}`);
    }

    // An extension page, which is how storage is read and written from the outside here.
    // Its own tab is not counted: step 1 of the score protects the extension's own pages.
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

    await trackerQuiet(panel);

    // §4.1: nothing on the icon while there is nothing to close. Every tab was opened
    // seconds ago, so the grace period of §6.4 covers all three.
    expect(await badgeText(context)).toBe('');

    const tabs = await openTabs(panel);
    expect(tabs.filter((tab) => tab.url.endsWith(PATH))).toHaveLength(3);

    // The seed reaches the background as a `storage.onChanged`, which is one of the things
    // §11 lets ask for a recompute: no polling, and no message of our own.
    await panel.evaluate(async (activity) => {
      await (globalThis as unknown as { chrome: BadgeApi }).chrome.storage.local.set({ activity });
    }, historyFor(tabs));

    await expect.poll(async () => badgeText(context)).toBe(EXPECTED);

    // §4.1's neutral colour: a grey, whatever grey the palette settles on. What matters is
    // that a badge nobody asked for does not look like an alert.
    const worker = await serviceWorker(context);
    const colour = await worker.evaluate(() =>
      (globalThis as unknown as { chrome: BadgeApi }).chrome.action.getBadgeBackgroundColor({}),
    );
    const channels = colour.slice(0, 3);
    expect(Math.max(...channels) - Math.min(...channels)).toBeLessThan(16);

    // "Mostra badge" off (§4.6): the count goes away without the tabs changing at all.
    await panel.evaluate(async () => {
      const storage = (globalThis as unknown as { chrome: BadgeApi }).chrome.storage.local;
      const stored = await storage.get('settings');
      const settings = (stored.settings ?? {}) as Partial<Settings>;
      await storage.set({ settings: { ...settings, showBadge: false } });
    });

    await expect.poll(async () => badgeText(context)).toBe('');
  });
});
