/**
 * The first run, PLAN.md §17: one screen, in the panel, with the two choices the extension cannot
 * guess — how old is old, and what to do with a duplicate.
 *
 * It replaces the shell rather than sitting inside it: there is nothing to navigate to yet, and
 * the header's counts and chip would describe a state the user has not chosen. "Inizia" writes
 * both answers and the panel opens on Declutter (`state/onboarding.ts`).
 *
 * The threshold is a `<select>` like §4.6's, so the same three durations are written out by `Intl`
 * in both languages; the protection is three radios, because §17.3 is a question with one answer
 * and the preselected one has to be visible without opening anything.
 */

import { t } from '@/platform/i18n';
import {
  durationChoices,
  IN_DAYS,
  ONBOARDING_MODE_CHOICES,
  ONBOARDING_STALE_DAYS,
} from '../settings-fields';
import { completeOnboarding, draftGuardMode, draftStaleDays } from '../state/onboarding';

export function OnboardingView({ language }: { language: string }) {
  const days = draftStaleDays.value;
  const mode = draftGuardMode.value;

  return (
    <div class="td-panel">
      <main class="td-main td-onboarding">
        <h1 class="td-title">{t('extName')}</h1>
        <p>{t('onboardingIntro')}</p>

        {/* The `<label>` wraps the control, which is what associates the two without an id. */}
        <label class="td-field">
          <span class="td-field-label">{t('onboardingThreshold')}</span>
          <select
            class="td-filter"
            value={String(days)}
            onChange={(event) => {
              draftStaleDays.value = Number(event.currentTarget.value);
            }}
          >
            {durationChoices(ONBOARDING_STALE_DAYS, days, IN_DAYS, language).map((choice) => (
              <option key={choice.value} value={String(choice.value)}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>

        {/* A `<fieldset>`, so the question is the group's name for a screen reader (§4.8). */}
        <fieldset class="td-onboarding-group">
          <legend class="td-field-label">{t('onboardingGuard')}</legend>
          {ONBOARDING_MODE_CHOICES.map((choice) => (
            <label key={choice.value} class="td-check">
              <input
                type="radio"
                name="td-onboarding-guard"
                value={choice.value}
                checked={mode === choice.value}
                onChange={() => {
                  draftGuardMode.value = choice.value;
                }}
              />
              <span>{t(choice.label)}</span>
            </label>
          ))}
        </fieldset>

        <p class="td-note">{t('onboardingPartialData')}</p>

        <div class="td-onboarding-actions">
          <button type="button" class="td-button" onClick={completeOnboarding}>
            {t('onboardingStart')}
          </button>
        </div>
      </main>
    </div>
  );
}
