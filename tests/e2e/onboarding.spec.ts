import type { Page } from '@playwright/test';

import { expect, message, test } from './fixtures/extension';

/**
 * The first run in the real browser (PLAN.md §17): a fresh profile opens on the onboarding
 * screen, the two answers become settings, and the screen never comes back.
 *
 * `test.use({ onboarded: false })` is what makes the profile a fresh install: every other spec
 * launches with the "first run is over" flag already written (`fixtures/extension.ts`), because
 * otherwise this screen would be the only thing their panels ever showed.
 *
 * Nothing here is seeded. The screen is answered the way a person answers it — a `<select>` and
 * a radio — and what it was worth is read back out of the settings page, so the test proves the
 * two halves agree rather than that a particular key was written (TASKS.md M6.2).
 */

test.use({ onboarded: false });

/** The gear of §4.2, which only exists once the first run is over. */
async function openSettings(panel: Page, locale: 'en' | 'it'): Promise<void> {
  await panel.getByRole('button', { name: message(locale, 'navSettings') }).click();
  await expect(panel.locator('.td-settings')).toBeVisible();
}

test.describe('in English', () => {
  test('first run → choices → "Inizia" → the settings, and it does not come back', async ({
    panel,
    context,
    extensionId,
  }) => {
    // §17.1: the screen itself, and nothing of the shell — there is nothing to navigate yet.
    await expect(panel.getByText(message('en', 'onboardingIntro'))).toBeVisible();
    await expect(panel.getByRole('button', { name: message('en', 'navDeclutter') })).toHaveCount(0);

    // §17.2: three thresholds, the default among them. The labels are the panel's own
    // (`format.ts`), which says "2 weeks" where §17 writes 14 days — the same value, in the
    // words every other duration in the panel uses.
    const threshold = panel.getByLabel(message('en', 'onboardingThreshold'));
    await expect(threshold.locator('option')).toHaveText(['3 days', '7 days', '2 weeks']);
    await expect(threshold).toHaveValue('7');

    // §17.3: "Chiudila e torna a quella esistente" is the preselected answer.
    const auto = panel.getByRole('radio', { name: message('en', 'onboardingGuardAuto') });
    await expect(auto).toBeChecked();
    // §17.4.
    await expect(panel.getByText(message('en', 'onboardingPartialData'))).toBeVisible();

    // The user's two answers, neither of them the preselected one.
    await threshold.selectOption('14');
    await panel.getByRole('radio', { name: message('en', 'onboardingGuardOff') }).check();

    await panel.getByRole('button', { name: message('en', 'onboardingStart') }).click();

    // §17.5: the panel opens on Declutter, which is the shell with its navigation.
    await expect(
      panel.getByRole('button', { name: message('en', 'navDeclutter') }),
    ).toHaveAttribute('aria-current', 'page');

    // The settings reflect both choices.
    await openSettings(panel, 'en');
    await expect(panel.getByLabel(message('en', 'settingsFieldStale'))).toHaveValue('14');
    await panel.getByRole('button', { name: message('en', 'settingsOpenDuplicates') }).click();
    await expect(panel.getByLabel(message('en', 'guardFieldMode'))).toHaveValue('off');

    // Reopened — a new document on the same profile — the onboarding is gone and Declutter is
    // what the panel shows.
    const again = await context.newPage();
    await again.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await expect(
      again.getByRole('button', { name: message('en', 'navDeclutter') }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(again.getByText(message('en', 'onboardingIntro'))).toHaveCount(0);
  });
});

test.describe('in Italian', () => {
  test.use({ uiLanguage: 'it' });

  test('asks §17 in the words the plan gives it', async ({ panel }) => {
    await expect(panel.getByText(message('it', 'onboardingIntro'))).toBeVisible();
    // The question names the group a screen reader hears, and the three answers are in §17.3's
    // order, the first one preselected.
    await expect(
      panel.getByRole('group', { name: message('it', 'onboardingGuard') }),
    ).toBeVisible();
    await expect(panel.locator('.td-onboarding-group .td-check')).toHaveText([
      message('it', 'onboardingGuardAuto'),
      message('it', 'onboardingGuardWarn'),
      message('it', 'onboardingGuardOff'),
    ]);
    await expect(
      panel.getByRole('radio', { name: message('it', 'onboardingGuardAuto') }),
    ).toBeChecked();
    await expect(
      panel.getByRole('button', { name: message('it', 'onboardingStart') }),
    ).toBeVisible();
  });
});
