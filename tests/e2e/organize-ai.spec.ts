import { createServer } from 'node:http';
import type { Server } from 'node:http';

import type { Page } from '@playwright/test';

import { expect, message, test } from './fixtures/extension';

/**
 * Grouping by topic in a Chromium that has no model (PLAN.md §7.3, §5.5).
 *
 * That is the ordinary case and the one the unit tests cannot judge: test Chromium has no
 * Gemini Nano, and whether it even exposes `LanguageModel` is the browser's business, not
 * ours. Either way the view has to behave the same — §7.2's groups on screen, no "AI
 * on-device" badge over them, nothing offered that cannot be had, and nothing logged. The
 * `health` fixture is what checks the last part: it fails the test on any console error and
 * on any request leaving the extension's own origin (invariant 1).
 *
 * The availability states themselves, the twenty-second timeout and the abort are
 * `tests/unit/llm.test.ts` with a `LanguageModel` of its own, and the wiring is
 * `tests/ext/ai-state.test.ts`. What is left here is only what a real browser decides.
 *
 * The six pages are two sets of three, served locally, so §7.2 has a topic to find and
 * nothing reaches the network.
 */

/**
 * The pages the test server answers, as path → title. Each title names its topic twice,
 * which is what gives §7.2's TF-IDF something to cluster on from six short titles; a real
 * window has many more words to go on.
 */
const PAGES: Record<string, string> = {
  '/preact/signals': 'Preact guide: Preact signals',
  '/preact/hooks': 'Preact guide: Preact hooks',
  '/preact/context': 'Preact guide: Preact context',
  '/espresso/roasting': 'Espresso guide: Espresso roasting',
  '/espresso/grinder': 'Espresso guide: Espresso grinder',
  '/espresso/machine': 'Espresso guide: Espresso machine',
};

let server: Server;
let port = 0;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const title = PAGES[path];
    if (title === undefined) {
      response.writeHead(path === '/favicon.ico' ? 204 : 404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><p>${title}</p></body></html>`,
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server did not get a port');
  }
  port = address.port;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

/** The slice of the extension API the panel page is asked for, inside the browser. */
interface TabsApi {
  tabs: {
    create(properties: { url: string; active: boolean }): Promise<unknown>;
  };
}

/** The pages, opened from the panel's own tab so they land in the window it reads. */
async function openPages(panel: Page): Promise<void> {
  const urls = Object.keys(PAGES).map((path) => `http://127.0.0.1:${String(port)}${path}`);
  await panel.evaluate(async (list) => {
    const api = (globalThis as unknown as { chrome: TabsApi }).chrome;
    for (const url of list) {
      await api.tabs.create({ url, active: false });
    }
  }, urls);
}

test.describe('in English', () => {
  test.use({ uiLanguage: 'en' });

  test('groups by topic without a model, with no badge and nothing logged', async ({ panel }) => {
    await openPages(panel);
    await panel.getByRole('button', { name: message('en', 'navOrganize') }).click();

    await panel
      .getByLabel(message('en', 'organizeMode'))
      .selectOption({ label: message('en', 'organizeModeTopic') });

    // §7.2 answered: the two topics are two groups of three, under names it chose from
    // the titles themselves.
    await expect(panel.locator('.td-group')).toHaveCount(2);
    await expect(panel.locator('.td-groups .td-group-tab')).toHaveCount(6);
    const titles = await panel
      .locator('.td-group .td-group-name')
      .evaluateAll((fields) => fields.map((field) => (field as HTMLInputElement).value).sort());
    expect(titles).toEqual(['Espresso', 'Preact']);

    // §4.4.2: the badge says the model proposed this, so without one it must not be there.
    await expect(panel.locator('.td-ai-badge')).toHaveCount(0);

    // §7.3 and §5.5: a browser that cannot give a model is not told about one. Chromium
    // may expose `LanguageModel` and still answer "unavailable"; either way nothing is
    // offered, and the spinner of a run that cannot happen never appears.
    await expect(panel.locator('.td-ai')).toHaveCount(0);
    await expect(panel.locator('.td-ai-working')).toHaveCount(0);

    // The preview is still a proposal: nothing has been grouped by opening the view.
    await expect(panel.getByRole('button', { name: message('en', 'organizeApply') })).toBeEnabled();
  });
});
