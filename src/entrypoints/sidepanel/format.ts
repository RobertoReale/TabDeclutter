/**
 * Numbers and counted nouns, in the panel's language.
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

/** The health bar's "23 da rivedere" (PLAN.md §4.2). */
export function reviewText(count: number, t: Translate, language: string): string {
  return t('healthReview', formatCount(count, language));
}
