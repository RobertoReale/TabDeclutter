import { expect, message, test } from './fixtures/extension';

/**
 * M0's acceptance criterion (PLAN.md §13 M0): the panel shows a localized
 * "Hello". Here the real extension is loaded in Chromium, so this also proves
 * that `_locales/` reaches the built extension and that `browser.i18n` resolves
 * the keys at runtime (invariant 11).
 */
test.describe('in English', () => {
  test.use({ uiLanguage: 'en' });

  test('the panel greets in English and says so in lang', async ({ panel }) => {
    await expect(panel.getByRole('main')).toHaveText(message('en', 'hello'));
    await expect(panel.locator('html')).toHaveAttribute('lang', /^en\b/);
  });
});

test.describe('in Italian', () => {
  test.use({ uiLanguage: 'it' });

  test('the panel greets in Italian and says so in lang', async ({ panel }) => {
    await expect(panel.getByRole('main')).toHaveText(message('it', 'hello'));
    await expect(panel.locator('html')).toHaveAttribute('lang', /^it\b/);
  });
});

test('the panel is titled with the extension name', async ({ panel }) => {
  await expect(panel).toHaveTitle(message('en', 'extName'));
});
