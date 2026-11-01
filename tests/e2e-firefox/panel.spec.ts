import { afterAll, beforeAll, expect, test } from 'vitest';

import { PANEL_URL, message, openPanel, panelState } from './fixtures/panel';
import type { PanelSession, PanelState } from './fixtures/panel';

/**
 * The Firefox smoke test: the real extension, installed from the build the
 * script has just produced, driven through WebDriver BiDi (PLAN.md §5.1, §14).
 *
 * The shell is what is asserted — the header counts, the navigation, the title
 * — and not the exact numbers: a headless Firefox opens what it likes, and the
 * count that has to be right to the tab is Chromium's test, which can open and
 * close windows (`tests/e2e/shell.spec.ts`). What this proves is that the panel
 * reads `browser.tabs` on Firefox at all and renders from it.
 *
 * Only the `en` catalogue is asserted. Firefox resolves `_locales/` against its
 * application locale, which it negotiates against the locales it actually has
 * installed: measured, `intl.locale.requested: 'it'` leaves both
 * `i18n.getUILanguage()` and the catalogue on `en-US`, because a stock build
 * ships no Italian langpack. `it` is covered by `tests/unit/i18n.test.ts`, by
 * the Chromium suite, which can switch languages, and by a manual check.
 */
let session: PanelSession;
let panel: PanelState;

beforeAll(async () => {
  session = await openPanel();
  panel = await panelState(session.page);
});

afterAll(async () => {
  await session?.close();
});

test('the panel is the extension page the sidebar renders', () => {
  expect(panel.url).toBe(PANEL_URL);
});

test('the header counts what Firefox has open', () => {
  // At least the tab the panel is in, so at least one of each.
  expect(panel.counts).toMatch(/\d/);
  expect(panel.counts).not.toMatch(/\$/);
});

test('the navigation offers the three views, in the browser language', () => {
  expect(panel.nav).toEqual([
    message('en', 'navDeclutter'),
    message('en', 'navOrganize'),
    message('en', 'navArchive'),
  ]);
  expect(panel.uiLanguage).toMatch(/^en\b/);
  expect(panel.lang).toMatch(/^en\b/);
});

test('the panel is titled with the extension name', () => {
  expect(panel.title).toBe(message('en', 'extName'));
});

test('the extension logged no errors', () => {
  expect(session.errors.take()).toEqual([]);
});
