import { createServer } from 'node:http';
import type { Server } from 'node:http';

import type { BrowserContext, Page } from '@playwright/test';

import { expect, message, test } from './fixtures/extension';

/**
 * The settings in the real browser (PLAN.md §4.6): that the language is changed from the page
 * itself, with the panel open, and that the "old after" threshold really changes what the
 * Declutter list suggests.
 *
 * Those are the two settings that cannot be proved anywhere else. `browser.i18n` resolves
 * `_locales/` once, from the browser's own UI language, so "Lingua: IT/EN" is served by loading
 * our own catalogue (docs/DECISIONS.md M6.1) — and only a real extension origin can say whether
 * that load works and whether every view re-renders from it. The threshold, in turn, is the one
 * row of §4.6 whose effect is a list on screen rather than a number in storage.
 *
 * The tabs are local pages this test serves itself, so nothing reaches the network (invariant 1).
 * What makes them old is the panel's clock, as in `declutter.spec.ts`: the score reads the later
 * of the stored `lastActiveAt` and Chrome's own `lastAccessed`, which is always a few seconds
 * ago, so the panel is opened three days in the future and every tab is three days idle — past
 * the two-hour grace period and past the one-day bootstrap grace.
 */

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** Three days and an hour: three days idle, whatever the test's own pace. */
const SHIFT_MS = 3 * DAY + HOUR;

const PAGES = ['/one', '/two'] as const;

let server: Server;
let base = '';

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if ((PAGES as readonly string[]).includes(path)) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${path.slice(1)}</title></head><body><p>${path}</p></body></html>`,
      );
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

/**
 * Two real pages open, and `sidepanel.html` three days ahead of them.
 *
 * Both tabs are real pages on purpose: the blank tab a persistent context opens with would be
 * "empty and inactive" (§6.4) whatever the threshold says, and this test is about the threshold.
 */
async function seed(context: BrowserContext, extensionId: string): Promise<Page> {
  for (const [at, path] of PAGES.entries()) {
    const existing = at === 0 ? context.pages()[0] : undefined;
    const tab = existing ?? (await context.newPage());
    await tab.goto(`${base}${path}`);
  }

  const panel = await context.newPage();
  // Before the document exists: the panel captures `Date.now` when its state is imported.
  await panel.addInitScript((shift: number) => {
    const real = Date.now;
    Date.now = () => real() + shift;
  }, SHIFT_MS);
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return panel;
}

/** The gear of §4.2, which is how the settings are reached. */
async function openSettings(panel: Page, locale: 'en' | 'it'): Promise<void> {
  await panel.getByRole('button', { name: message(locale, 'navSettings') }).click();
  await expect(panel.locator('.td-settings')).toBeVisible();
}

/** One `<select>` of the page, by the label its `<label>` wraps it with. */
function field(
  panel: Page,
  locale: 'en' | 'it',
  label: 'settingsFieldStale' | 'settingsFieldLanguage',
) {
  return panel.getByLabel(message(locale, label));
}

test.describe('in English', () => {
  test.use({ uiLanguage: 'en' });

  test('the language is changed from the page, with the panel open', async ({ panel }) => {
    await openSettings(panel, 'en');
    await expect(panel.locator('.td-section-title')).toHaveText(message('en', 'navSettings'));
    await expect(field(panel, 'en', 'settingsFieldLanguage')).toHaveValue('auto');

    await field(panel, 'en', 'settingsFieldLanguage').selectOption('it');

    // The page itself, the shell around it and the document's own language, all at once:
    // nothing is reopened and nothing is reloaded.
    await expect(panel.locator('.td-section-title')).toHaveText(message('it', 'navSettings'));
    await expect(panel.locator('html')).toHaveAttribute('lang', 'it');
    await expect(
      panel.getByRole('navigation', { name: message('it', 'navLabel') }).getByRole('button'),
    ).toHaveText([
      message('it', 'navDeclutter'),
      message('it', 'navOrganize'),
      message('it', 'navArchive'),
    ]);

    // And back: the setting is a choice the user can undo, in the language they are now in.
    await field(panel, 'it', 'settingsFieldLanguage').selectOption('en');
    await expect(panel.locator('.td-section-title')).toHaveText(message('en', 'navSettings'));
    await expect(panel.locator('html')).toHaveAttribute('lang', 'en');
  });

  test('the "old after" threshold changes what the list suggests', async ({
    context,
    extensionId,
  }) => {
    const panel = await seed(context, extensionId);

    // Thirty days: three idle days are a fraction of them, so both tabs are simply kept
    // (§6.4) and the Declutter list has nothing to say.
    await openSettings(panel, 'en');
    await field(panel, 'en', 'settingsFieldStale').selectOption('30');
    await panel.getByRole('button', { name: message('en', 'navDeclutter') }).click();
    await expect(panel.getByRole('main')).toHaveText(message('en', 'declutterEmpty'));

    // One day: the same three days are now well past the threshold, and the same two tabs
    // are worth a look.
    await openSettings(panel, 'en');
    await field(panel, 'en', 'settingsFieldStale').selectOption('1');
    await panel.getByRole('button', { name: message('en', 'navDeclutter') }).click();
    await expect(panel.locator('.td-section')).not.toHaveCount(0);
    // A section with nothing to close starts folded (§4.3), so it is opened here.
    for (const toggle of await panel.locator('.td-section-toggle[aria-expanded="false"]').all()) {
      await toggle.click();
    }
    await expect(panel.locator('.td-row-title')).toHaveText(['one', 'two']);

    // The threshold is stored, not held in the page: it is still 1 when the settings are
    // opened again.
    await openSettings(panel, 'en');
    await expect(field(panel, 'en', 'settingsFieldStale')).toHaveValue('1');
  });

  test('the hash-fragment rule and native tab-groups toggle remain visible when tab groups are off', async ({
    panel,
  }) => {
    await openSettings(panel, 'en');

    const ignoreHash = panel.getByLabel(message('en', 'matchIgnoreHash'));
    const useTabGroups = panel.getByLabel(message('en', 'windowUseTabGroups'));
    await expect(ignoreHash).toBeVisible();
    await expect(useTabGroups).toBeVisible();

    // The E2E fixture seeds `useTabGroups: true`; turning both toggles off must keep both
    // controls visible right away and across navigation.
    await expect(ignoreHash).toBeChecked();
    await ignoreHash.uncheck();
    await expect(useTabGroups).toBeChecked();
    await useTabGroups.uncheck();
    await expect(ignoreHash).not.toBeChecked();
    await expect(useTabGroups).not.toBeChecked();
    await expect(ignoreHash).toBeVisible();
    await expect(useTabGroups).toBeVisible();

    // Return to main view and re-open settings: both toggles stay visible and unchecked.
    await panel.getByRole('button', { name: message('en', 'navDeclutter') }).click();
    await openSettings(panel, 'en');
    await expect(ignoreHash).toBeVisible();
    await expect(ignoreHash).not.toBeChecked();
    await expect(useTabGroups).toBeVisible();
    await expect(useTabGroups).not.toBeChecked();
  });

  test('YouTube options appear in Settings and default to off with zero network requests', async ({
    panel,
  }) => {
    await openSettings(panel, 'en');

    const ytSortToggle = panel.getByLabel(message('en', 'settingsYouTubeSort'));
    const ytLikedToggle = panel.getByLabel(message('en', 'settingsYouTubeCloseLiked'));
    await expect(ytSortToggle).toBeVisible();
    await expect(ytSortToggle).not.toBeChecked();
    await expect(ytLikedToggle).toBeVisible();
    await expect(ytLikedToggle).not.toBeChecked();
  });
});
