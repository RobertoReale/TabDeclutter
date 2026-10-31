import { afterAll, beforeAll, expect, test } from 'vitest';

import { PANEL_URL, message, openPanel, panelState } from './fixtures/panel';
import type { PanelSession, PanelState } from './fixtures/panel';

/**
 * The Firefox smoke test: the real extension, installed from the build the
 * script has just produced, driven through WebDriver BiDi (PLAN.md §5.1, §14).
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

test('the panel greets in the browser language and says so in lang', () => {
  expect(panel.main).toBe(message('en', 'hello'));
  expect(panel.uiLanguage).toMatch(/^en\b/);
  expect(panel.lang).toMatch(/^en\b/);
});

test('the panel is titled with the extension name', () => {
  expect(panel.title).toBe(message('en', 'extName'));
});

test('the extension logged no errors', () => {
  expect(session.errors.take()).toEqual([]);
});
