/**
 * The shape of the settings page of PLAN.md §4.6: which values each field offers, how they are
 * written in the user's language, and how the "Siti protetti" editor turns text into a list.
 *
 * Data and pure functions, as in `guard-settings.ts`, so the view is only markup and the rules
 * the spec states are tested without a DOM.
 *
 * Relative imports, not `@/`: the `unit` vitest project runs without WXT's plugin and so without
 * WXT's alias, and this module is tested there.
 */

import type { GuardMode, LanguageSetting, YouTubeDurationOrder } from '../../core/types';
import type { AiAvailability } from '../../platform/llm';
import type { MessageKey } from '../../platform/i18n';
import { durationText } from './format';
import type { Choice } from './guard-settings';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** One value of a duration field, already written out: "7 days", "2 ore". */
export interface DurationChoice {
  /** What is stored. Days for `staleDays` and the retention, milliseconds for the grace. */
  readonly value: number;
  readonly label: string;
}

/** §4.6: "Consider a tab old after — 7 days — 1 / 3 / 7 / 14 / 30". */
export const STALE_DAYS: readonly number[] = [1, 3, 7, 14, 30];

/**
 * §4.6 fixes the grace period's default at 2 hours and leaves the rest open: these are the four
 * that read as answers to "how new is new" — the rest of a working session, a whole one, a
 * working day, a day (docs/DECISIONS.md M6.1).
 */
export const GRACE_MS: readonly number[] = [30 * MINUTE, 2 * HOUR, 8 * HOUR, 24 * HOUR];

/** §4.6 fixes the retention's default at 30 days; a week, a quarter and a year frame it. */
export const RETENTION_DAYS: readonly number[] = [7, 30, 90, 365];

/**
 * §17.2: the first run asks for the threshold among three values, not the five of §4.6. It is a
 * "quick choice", and `STALE_DAYS`'s own default is among them, so nobody has to decide between
 * 1 and 30 days before having seen a single suggestion.
 */
export const ONBOARDING_STALE_DAYS: readonly number[] = [3, 7, 14];

/**
 * §17.3: "Quando apri una scheda già aperta", in the order and the words the spec gives them —
 * which is not `MODE_CHOICES`'s order, because the first run leads with the answer it preselects
 * and the settings page lists the three modes from the quietest up.
 */
export const ONBOARDING_MODE_CHOICES: readonly Choice<GuardMode>[] = [
  { value: 'auto', label: 'onboardingGuardAuto' },
  { value: 'warn', label: 'onboardingGuardWarn' },
  { value: 'off', label: 'onboardingGuardOff' },
];

/** "Chiudila e torna a quella esistente (preselezionato)", §17.3 and §8.1. */
export const ONBOARDING_DEFAULT_MODE: GuardMode = 'auto';

/** §4.6's "Lingua: automatica, IT, EN". */
export const LANGUAGE_CHOICES: readonly Choice<LanguageSetting>[] = [
  { value: 'auto', label: 'settingsLanguageAuto' },
  { value: 'en', label: 'settingsLanguageEn' },
  { value: 'it', label: 'settingsLanguageIt' },
];

/** Sort direction options for YouTube video duration sorting. */
export const YOUTUBE_ORDER_CHOICES: readonly Choice<YouTubeDurationOrder>[] = [
  { value: 'asc', label: 'settingsYouTubeOrderAsc' },
  { value: 'desc', label: 'settingsYouTubeOrderDesc' },
];

/** How a field's stored number becomes milliseconds: days for two of them, nothing for the grace. */
export const IN_DAYS = (days: number): number => days * DAY;
export const IN_MS = (ms: number): number => ms;

/**
 * A duration field's options, written by `Intl` rather than translated: "1 day"/"1 giorno" and
 * "30 minutes"/"30 minuti" come out of the same numbers in both languages, so the lists cannot
 * drift apart and no catalogue key is spent on them (see `format.ts`).
 *
 * `current` is always among them, even when it is not one of the offered values: a number an
 * older release stored, or one chosen before the list changed, has to stay visible rather than
 * be read silently as something else.
 */
export function durationChoices(
  values: readonly number[],
  current: number,
  toMs: (value: number) => number,
  language: string,
): DurationChoice[] {
  const all = values.includes(current) ? [...values] : [...values, current].sort((a, b) => a - b);
  return all.map((value) => ({ value, label: durationText(toMs(value), language) }));
}

/** §4.6: the AI row "shows the state: available / downloadable / not supported". */
export function aiStateKey(availability: AiAvailability | null): MessageKey | null {
  switch (availability) {
    case 'available':
      return 'settingsAiAvailable';
    case 'downloadable':
    case 'downloading':
      return 'settingsAiDownloadable';
    case 'unsupported':
    case 'unavailable':
      return 'settingsAiUnsupported';
    default:
      // Nobody has asked the browser yet: the row says nothing rather than guessing.
      return null;
  }
}

/**
 * "Siti protetti" as the editor's text becomes a stored list: one domain per line, trimmed and
 * lower-cased — which is how `core/scoring.ts` compares a pattern against a host — with the
 * blank lines dropped and each domain kept once.
 */
export function parseDomains(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const domain = line.trim().toLowerCase();
    if (domain !== '') seen.add(domain);
  }
  return [...seen];
}

/** The stored list as the editor shows it. */
export function domainsText(domains: readonly string[]): string {
  return domains.join('\n');
}
