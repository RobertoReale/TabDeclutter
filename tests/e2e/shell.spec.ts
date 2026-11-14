import type { Page } from '@playwright/test';

import type { Locale, MessageKey } from '../../src/platform/i18n';
import { expect, message, test } from './fixtures/extension';

/**
 * The panel's shell, in the real browser: that the header says what is actually
 * open and keeps saying it, that the navigation and the title are localized, and
 * that the theme follows `prefers-color-scheme` (PLAN.md §4.2, §4.7).
 *
 * The counts are built from the shipped catalogues rather than written out, so a
 * retranslated string fails the test instead of passing a stale expectation.
 */

/** `countTabsOne` / `countTabsOther` and friends, as the panel builds them. */
function counted(locale: Locale, value: number, one: MessageKey, other: MessageKey): string {
  const key = new Intl.PluralRules(locale).select(value) === 'one' ? one : other;
  return message(locale, key).replace('$1', new Intl.NumberFormat(locale).format(value));
}

/** The header's "87 schede · 4 finestre". */
function counts(locale: Locale, tabs: number, windows: number): string {
  return message(locale, 'panelCounts')
    .replace('$TABS$', counted(locale, tabs, 'countTabsOne', 'countTabsOther'))
    .replace('$WINDOWS$', counted(locale, windows, 'countWindowsOne', 'countWindowsOther'));
}

/** The relative luminance of a `rgb(...)`, as WCAG defines it. */
async function luminance(panel: Page, selector: string, property: string): Promise<number> {
  const colour = await panel
    .locator(selector)
    .evaluate((element, prop) => getComputedStyle(element).getPropertyValue(prop), property);
  const channels = [...colour.matchAll(/\d+(?:\.\d+)?/g)].slice(0, 3).map((match) => {
    const value = Number(match[0]) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [r = 0, g = 0, b = 0] = channels;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test.describe('in English', () => {
  test.use({ uiLanguage: 'en' });

  test('the header counts the tabs and windows that are open', async ({ panel, context }) => {
    // The panel is itself one of them: it is open in an ordinary tab.
    const open = context.pages().length;
    await expect(panel.locator('.td-counts')).toHaveText(counts('en', open, 1));

    // The assertions retry, which is also what absorbs the 150 ms debounce.
    const extra = await context.newPage();
    await expect(panel.locator('.td-counts')).toHaveText(counts('en', open + 1, 1));

    await extra.close();
    await expect(panel.locator('.td-counts')).toHaveText(counts('en', open, 1));
  });

  test('the header counts a second window', async ({ panel, context, extensionId }) => {
    const open = context.pages().length;
    // A second browser window, which is what `windows.getAll()` would see: the
    // count has to follow the windows, not just the tabs.
    const other = await context.newPage();
    await other.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await other.evaluate(() => {
      window.open('about:blank', '_blank', 'popup=yes,width=400,height=300');
    });

    await expect(panel.locator('.td-counts')).toHaveText(counts('en', open + 2, 2));
  });

  test('the navigation offers the three views, Riordina first', async ({ panel }) => {
    const items = panel
      .getByRole('navigation', { name: message('en', 'navLabel') })
      .getByRole('button');
    await expect(items).toHaveText([
      message('en', 'navDeclutter'),
      message('en', 'navOrganize'),
      message('en', 'navArchive'),
    ]);
    await expect(items.first()).toHaveAttribute('aria-current', 'page');
  });

  test('the other views are empty and the settings are reachable', async ({ panel }) => {
    const main = panel.getByRole('main');
    // Freshly opened tabs are all within the grace period, so nothing is due.
    await expect(main).toHaveText(message('en', 'declutterEmpty'));

    // Organize keeps its question — the scope, the mode and the options of §4.4 — and says
    // it has nothing to propose in place of the preview. What the view does with a window
    // worth grouping is `organize.spec.ts`'s business.
    await panel.getByRole('button', { name: message('en', 'navOrganize') }).click();
    await expect(main.locator('.td-empty')).toHaveText(message('en', 'organizeEmpty'));
    await expect(main.locator('.td-group')).toHaveCount(0);

    await panel.getByRole('button', { name: message('en', 'navArchive') }).click();
    await expect(main).toHaveText(message('en', 'archiveEmpty'));

    // The gear leads to the settings, whose only sub-page so far is "Duplicate protection"
    // (§8.3; the rest is M6.1). What that page contains is `guard-ui.spec.ts`'s business.
    await panel.getByRole('button', { name: message('en', 'navSettings') }).click();
    await expect(
      panel.getByRole('heading', { name: message('en', 'settingsDuplicates') }),
    ).toBeVisible();
    // And it is not one of the three views: no navigation item claims the page.
    await expect(panel.locator('.td-nav-item[aria-current="page"]')).toHaveCount(0);
  });

  test('the panel is titled and labelled with the extension name', async ({ panel }) => {
    await expect(panel).toHaveTitle(message('en', 'extName'));
    await expect(panel.getByRole('heading', { level: 1 })).toHaveText(message('en', 'extName'));
    await expect(panel.locator('html')).toHaveAttribute('lang', /^en\b/);
  });
});

test.describe('in Italian', () => {
  test.use({ uiLanguage: 'it' });

  test('the header and the navigation are in Italian, and lang says so', async ({
    panel,
    context,
  }) => {
    await expect(panel.locator('.td-counts')).toHaveText(counts('it', context.pages().length, 1));
    await expect(
      panel.getByRole('navigation', { name: message('it', 'navLabel') }).getByRole('button'),
    ).toHaveText([
      message('it', 'navDeclutter'),
      message('it', 'navOrganize'),
      message('it', 'navArchive'),
    ]);
    await expect(panel.locator('html')).toHaveAttribute('lang', /^it\b/);
  });
});

/*
 * §4.7: light and dark follow `prefers-color-scheme`, with no switch of our own.
 * The assertions are on luminance rather than on a hex value, so the palette can
 * be retuned without rewriting the test — what must not change is which of the
 * two is the light one.
 */
test.describe('with a dark system theme', () => {
  test.use({ colorScheme: 'dark' });

  test('the panel is dark, light text on a dark surface', async ({ panel }) => {
    await expect(panel.locator('.td-counts')).toBeVisible();
    expect(await panel.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(
      true,
    );
    expect(await luminance(panel, 'body', 'background-color')).toBeLessThan(0.1);
    expect(await luminance(panel, 'body', 'color')).toBeGreaterThan(0.6);
  });
});

test.describe('with a light system theme', () => {
  test.use({ colorScheme: 'light' });

  test('the panel is light, dark text on a light surface', async ({ panel }) => {
    await expect(panel.locator('.td-counts')).toBeVisible();
    expect(await luminance(panel, 'body', 'background-color')).toBeGreaterThan(0.8);
    expect(await luminance(panel, 'body', 'color')).toBeLessThan(0.1);
  });
});
