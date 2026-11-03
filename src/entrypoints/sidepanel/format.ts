/**
 * Numbers, counted nouns and ages, in the panel's language.
 *
 * Chrome's i18n has no plural forms: a message is one string, and
 * `getMessage('countTabs', '1')` would say "1 schede". So the catalogues carry
 * one key per plural category and `Intl.PluralRules` picks between them — the
 * same rules the browser itself uses, which is why "1 scheda" and "87 schede"
 * both come out right without the panel knowing any grammar.
 *
 * `t` and the language are arguments rather than imports, so every function here
 * is pure and can be tested without an extension around it.
 */

// Relative, not `@/`: the `unit` vitest project runs without WXT's plugin and
// so without WXT's alias, and this module is tested there.
import type { MessageKey, Translate } from '../../platform/i18n';

/** A number as the panel's language writes it: `1.234` in Italian, `1,234` in English. */
export function formatCount(value: number, language: string): string {
  return new Intl.NumberFormat(language).format(value);
}

/**
 * Which plural form `value` takes. Only `one` and `other` are distinguished,
 * because that is what English and Italian need; a language with more forms
 * falls back to `other`, which is the form its catalogue should then carry.
 */
function plural(value: number, language: string): 'one' | 'other' {
  return new Intl.PluralRules(language).select(value) === 'one' ? 'one' : 'other';
}

/** `countTabsOne` / `countTabsOther` and friends, with the number filled in. */
function counted(
  value: number,
  one: MessageKey,
  other: MessageKey,
  t: Translate,
  language: string,
): string {
  const key = plural(value, language) === 'one' ? one : other;
  return t(key, formatCount(value, language));
}

/** The header's "87 schede · 4 finestre" (PLAN.md §4.2). */
export function countsText(tabs: number, windows: number, t: Translate, language: string): string {
  return t(
    'panelCounts',
    counted(tabs, 'countTabsOne', 'countTabsOther', t, language),
    counted(windows, 'countWindowsOne', 'countWindowsOther', t, language),
  );
}

/** "12 schede", for a sentence that counts tabs (PLAN.md §4.3, the window card). */
export function tabsText(count: number, t: Translate, language: string): string {
  return counted(count, 'countTabsOne', 'countTabsOther', t, language);
}

/** The health bar's "23 da rivedere" (PLAN.md §4.2). */
export function reviewText(count: number, t: Translate, language: string): string {
  return t('healthReview', formatCount(count, language));
}

/*
 * Ages. The panel says the same duration in two shapes — on its own as a chip
 * ("12 gg fa") and inside a sentence ("Non la apri da 12 giorni") — and both come from
 * `Intl`, so neither is a translated string that could disagree with the other or with
 * the browser's own wording. The unit is picked once, by `span`, so the chip and the
 * sentence can never name different units for the same duration.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The unit a duration reads best in, and how many of it. */
interface Span {
  readonly value: number;
  readonly unit: Intl.RelativeTimeFormatUnit;
}

/**
 * The units, largest first, with the duration each one takes over from: 90 minutes is
 * "1 h" and not "90 min", and two weeks is "2 sett." and not "14 giorni".
 *
 * `from` is not simply `ms`, because the spec's own examples are "Non la apri da 12
 * giorni" (§6.4) and "non toccata da 3 settimane" (§4.3): days stay days for a fortnight,
 * where they still say something a week does not, and weeks take over after that
 * (docs/DECISIONS.md). Every unit still reads at least one whole, so the sequence never
 * goes backwards.
 *
 * A month is 30 days and a year 365: this is a rounded age on a row, not a calendar
 * difference, and a tab untouched since February is "7 mesi fa" either way.
 */
const STEPS: readonly {
  readonly unit: Intl.RelativeTimeFormatUnit;
  readonly ms: number;
  readonly from: number;
}[] = [
  { unit: 'year', ms: 365 * DAY, from: 365 * DAY },
  { unit: 'month', ms: 30 * DAY, from: 30 * DAY },
  { unit: 'week', ms: 7 * DAY, from: 14 * DAY },
  { unit: 'day', ms: DAY, from: DAY },
  { unit: 'hour', ms: HOUR, from: HOUR },
];

function span(ms: number): Span {
  const found = STEPS.find((step) => ms >= step.from);
  if (found !== undefined) return { value: Math.floor(ms / found.ms), unit: found.unit };
  // Below an hour, and never "0 minuti": a tab seen seconds ago is "1 min fa".
  return { value: Math.max(1, Math.floor(ms / MINUTE)), unit: 'minute' };
}

/**
 * How long ago something was, as a chip: "12 gg fa", "ieri", "3 sett. fa".
 *
 * `numeric: 'auto'` is what gives "ieri" instead of "1 g fa" where the language has a
 * word for it, and the narrow style is what keeps the chip narrow in a 320 px panel.
 */
export function relativeAge(ms: number, language: string): string {
  const { value, unit } = span(Math.max(0, ms));
  return new Intl.RelativeTimeFormat(language, { numeric: 'auto', style: 'narrow' }).format(
    -value,
    unit,
  );
}

/**
 * The same duration as a plain quantity, for inside a sentence: "12 giorni", "3 ore".
 *
 * `Intl.NumberFormat`'s unit style, not a counted noun of our own: it knows that Italian
 * wants "1 giorno" and "12 giorni" and English "1 day" and "12 days", so §6.4's "Non la
 * apri da 12 giorni" needs one message and no plural keys.
 */
export function durationText(ms: number, language: string): string {
  const { value, unit } = span(Math.max(0, ms));
  return new Intl.NumberFormat(language, {
    style: 'unit',
    unit,
    unitDisplay: 'long',
  }).format(value);
}
