/**
 * The settings page's own rules (PLAN.md §4.6): which values it offers, how they are written,
 * and how the "Siti protetti" text becomes a stored list.
 *
 * In the `unit` project, which has no extension API: the module is pure on purpose, so the
 * rules are checked without a DOM (TASKS.md M6.1).
 */

import { describe, expect, it } from 'vitest';

import { DAY, HOUR, MINUTE } from '../../src/core/time';
import { DEFAULT_SETTINGS } from '../../src/core/types';
import {
  aiStateKey,
  domainsText,
  durationChoices,
  GRACE_MS,
  IN_DAYS,
  IN_MS,
  LANGUAGE_CHOICES,
  ONBOARDING_DEFAULT_MODE,
  ONBOARDING_MODE_CHOICES,
  ONBOARDING_STALE_DAYS,
  parseDomains,
  RETENTION_DAYS,
  STALE_DAYS,
} from '../../src/entrypoints/sidepanel/settings-fields';

describe('the values the fields offer', () => {
  it('are the five of §4.6 for "vecchia dopo", and include the default', () => {
    expect(STALE_DAYS).toEqual([1, 3, 7, 14, 30]);
    expect(STALE_DAYS).toContain(DEFAULT_SETTINGS.staleDays);
  });

  it('include the defaults §4.6 fixes for the grace period and the archive', () => {
    expect(GRACE_MS).toContain(DEFAULT_SETTINGS.graceMs);
    expect(DEFAULT_SETTINGS.graceMs).toBe(2 * HOUR);
    expect(RETENTION_DAYS).toContain(DEFAULT_SETTINGS.archiveRetentionDays);
    expect(DEFAULT_SETTINGS.archiveRetentionDays).toBe(30);
  });

  it('offer "automatica, IT, EN" for the language, automatic first', () => {
    expect(LANGUAGE_CHOICES.map((choice) => choice.value)).toEqual(['auto', 'en', 'it']);
    expect(LANGUAGE_CHOICES[0]?.value).toBe(DEFAULT_SETTINGS.language);
  });
});

describe('what the first run asks (§17)', () => {
  it('offers the three thresholds of §17.2, the default among them', () => {
    expect(ONBOARDING_STALE_DAYS).toEqual([3, 7, 14]);
    expect(ONBOARDING_STALE_DAYS).toContain(DEFAULT_SETTINGS.staleDays);
    // A subset of §4.6's, so no first run can store a threshold the settings page cannot show
    // as one of its own options.
    for (const days of ONBOARDING_STALE_DAYS) expect(STALE_DAYS).toContain(days);
  });

  it('asks the duplicate question in §17.3 order, "chiudila" first and preselected', () => {
    expect(ONBOARDING_MODE_CHOICES.map((choice) => choice.value)).toEqual(['auto', 'warn', 'off']);
    expect(ONBOARDING_DEFAULT_MODE).toBe('auto');
    expect(ONBOARDING_MODE_CHOICES[0]?.value).toBe(ONBOARDING_DEFAULT_MODE);
  });

  it("offers the three modes in words of its own, not the settings page's", () => {
    expect(ONBOARDING_MODE_CHOICES.map((choice) => choice.label)).toEqual([
      'onboardingGuardAuto',
      'onboardingGuardWarn',
      'onboardingGuardOff',
    ]);
  });

  it('leaves the stored default at "warn" until the question is answered (invariant 2)', () => {
    // Preselected is not chosen: nothing closes a tab on its own before "Inizia".
    expect(DEFAULT_SETTINGS.guard.mode).toBe('warn');
  });
});

describe('durationChoices', () => {
  it('writes every value in the panel language', () => {
    expect(durationChoices([1, 7], 7, IN_DAYS, 'en')).toEqual([
      { value: 1, label: '1 day' },
      { value: 7, label: '7 days' },
    ]);
    expect(durationChoices([1, 7], 7, IN_DAYS, 'it')).toEqual([
      { value: 1, label: '1 giorno' },
      { value: 7, label: '7 giorni' },
    ]);
  });

  it('writes the grace period from milliseconds', () => {
    expect(durationChoices(GRACE_MS, 2 * HOUR, IN_MS, 'en').map((choice) => choice.label)).toEqual([
      '30 minutes',
      '2 hours',
      '8 hours',
      '1 day',
    ]);
  });

  it('keeps a stored value the list does not offer, in its place', () => {
    const choices = durationChoices(STALE_DAYS, 10, IN_DAYS, 'en');

    expect(choices.map((choice) => choice.value)).toEqual([1, 3, 7, 10, 14, 30]);
  });

  it('offers a value once when it is already in the list', () => {
    const choices = durationChoices(RETENTION_DAYS, 30, IN_DAYS, 'en');

    expect(choices.map((choice) => choice.value)).toEqual([...RETENTION_DAYS]);
  });

  it('converts days to milliseconds the way the core counts them', () => {
    expect(IN_DAYS(3)).toBe(3 * DAY);
    expect(IN_MS(30 * MINUTE)).toBe(30 * MINUTE);
  });
});

describe('aiStateKey', () => {
  it('says available, to download or not supported (§4.6)', () => {
    expect(aiStateKey('available')).toBe('settingsAiAvailable');
    expect(aiStateKey('downloadable')).toBe('settingsAiDownloadable');
    expect(aiStateKey('downloading')).toBe('settingsAiDownloadable');
    expect(aiStateKey('unsupported')).toBe('settingsAiUnsupported');
    expect(aiStateKey('unavailable')).toBe('settingsAiUnsupported');
  });

  it('says nothing until the browser has been asked', () => {
    expect(aiStateKey(null)).toBeNull();
  });
});

describe('the protected-sites editor', () => {
  it('reads one domain per line, trimmed and lower-cased', () => {
    expect(parseDomains('  Mail.Google.com \n*.ATLASSIAN.net\n')).toEqual([
      'mail.google.com',
      '*.atlassian.net',
    ]);
  });

  it('drops the blank lines and keeps each domain once', () => {
    expect(parseDomains('a.com\n\n  \nb.com\nA.com\n')).toEqual(['a.com', 'b.com']);
  });

  it('is empty for empty text, so clearing the box clears the list', () => {
    expect(parseDomains('')).toEqual([]);
    expect(parseDomains('\n \n')).toEqual([]);
  });

  it('shows the stored list back the way it is typed', () => {
    expect(domainsText(['a.com', 'b.com'])).toBe('a.com\nb.com');
    expect(parseDomains(domainsText(['a.com', 'b.com']))).toEqual(['a.com', 'b.com']);
  });
});
