import { createServer } from 'node:http';
import type { Server } from 'node:http';

import type { BrowserContext, Page } from '@playwright/test';

import { expect, message, test } from './fixtures/extension';

/**
 * PLAN.md §4.7: every animation this panel adds is `--td-duration`, and `base.css` backs
 * that with a blanket rule so `prefers-reduced-motion: reduce` collapses *any* animation or
 * transition to 1 ms, not just the ones that remember to read the token. This is the one
 * check of that promise against the real, rendered styles, rather than against the
 * stylesheet's source.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Clears the two-hour grace, the one-day bootstrap grace and `staleDays`, all at once. */
const SHIFT_MS = 12 * DAY + HOUR;

const ALPHA = { path: '/alpha', title: 'Alpha' };
const BRAVO = { path: '/bravo', title: 'Bravo' };
const CHARLIE = { path: '/charlie', title: 'Charlie' };
const THREE = [ALPHA, BRAVO, CHARLIE];

let server: Server;
let base = '';

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const page = THREE.find((candidate) => candidate.path === path);
    if (page !== undefined) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><title>${page.title}</title>`);
      return;
    }
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

/** The slice of the extension API this spec opens a tab with. */
interface SeedApi {
  tabs: {
    create(options: { url: string; active: boolean }): Promise<unknown>;
  };
}

/** A panel whose clock already reads twelve days ahead, before it loads (mirrors `actions.spec.ts`). */
async function openPanel(context: BrowserContext, extensionId: string): Promise<Page> {
  const panel = context.pages()[0] ?? (await context.newPage());
  await panel.addInitScript((shift: number) => {
    const real = Date.now;
    Date.now = () => real() + shift;
  }, SHIFT_MS);
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return panel;
}

/**
 * Opens `pages` one at a time (mirrors `actions.spec.ts`'s `openTabs`: sequential, not
 * `Promise.all`, so the tab strip — and so `sections.ts`'s score tie-break — keeps them in
 * this order) and waits until the panel has a row, in that order, for each of them.
 */
async function seedThree(panel: Page): Promise<void> {
  for (const page of THREE) {
    await panel.evaluate(async (url) => {
      const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
      await api.tabs.create({ url, active: false });
    }, `${base}${page.path}`);
  }
  await expect(panel.locator('.td-row-title')).toHaveText(THREE.map((page) => page.title));
}

/** The computed duration of whatever `selector` first matches, read from the live document. */
async function durationsOf(
  panel: Page,
  selector: string,
): Promise<{ animation: string; transition: string } | null> {
  return panel.evaluate((target) => {
    const element = document.querySelector(target);
    if (element === null) return null;
    const style = getComputedStyle(element);
    return { animation: style.animationDuration, transition: style.transitionDuration };
  }, selector);
}

test.use({ reducedMotion: 'reduce' });

test('§4.7: reduced motion leaves no real transition or animation on a row, appearing or closing', async ({
  context,
  extensionId,
}) => {
  const panel = await openPanel(context, extensionId);
  await panel.evaluate(async (url) => {
    const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
    await api.tabs.create({ url, active: false });
  }, `${base}${ALPHA.path}`);

  const row = panel.locator('.td-row').filter({ hasText: ALPHA.title });
  await expect(row).toHaveCount(1, { timeout: 20_000 });

  // The row's own entrance animation and the transitions `base.css` gives every `.td-row`.
  expect(await durationsOf(panel, '.td-row')).toEqual({
    animation: '0.001s',
    transition: '0.001s',
  });

  // "Mantieni" takes the row out of `section.rows`, which is what leaves `Section` a ghost
  // to animate out through `.td-row-closing` — the height collapse PLAN.md §4.7 asks for.
  await row.getByRole('button', { name: message('en', 'actionKeep') }).click();

  const ghost = panel.locator('.td-row-closing');
  await expect(ghost).toHaveCount(1);
  expect(await durationsOf(panel, '.td-row-closing')).toEqual({
    animation: '0.001s',
    transition: '0.001s',
  });
});

test('§4.7: a row closed from the middle of its section collapses in its own place', async ({
  context,
  extensionId,
}) => {
  const panel = await openPanel(context, extensionId);
  await seedThree(panel);

  // Bravo is the middle row: "Mantieni" takes it out of `section.rows` while Alpha and
  // Charlie stay, which is exactly the three-row case a single-row list never exercises —
  // a bottom-appended ghost would show up after Charlie, not between the two.
  const bravo = panel.locator('.td-row').filter({ hasText: BRAVO.title });
  await bravo.getByRole('button', { name: message('en', 'actionKeep') }).click();

  await expect(panel.locator('.td-row-closing')).toHaveCount(1);
  await expect(panel.locator('.td-row-title')).toHaveText(THREE.map((page) => page.title));
  expect(await panel.locator('.td-row-closing .td-row-title').textContent()).toBe(BRAVO.title);
});
