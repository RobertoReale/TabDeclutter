/**
 * What a row says about itself (PLAN.md §6.4, "Reason texts").
 *
 * Two things come out of one score: the **sentence** — the headline reason, one line
 * under the title — and the **chips**, the short secondary facts §4.3 draws next to it.
 * Both are pure functions of a `ScoredTab`, `t` and the language, so the shipped Italian
 * can be asserted in a unit test.
 *
 * Nothing invents a reason the score did not give. A chip exists only where a `Reason`
 * exists, which is what keeps "explained suggestions" (PLAN.md §3) honest.
 *
 * Relative imports, not `@/`: this module is tested in the `unit` vitest project, which
 * runs without WXT's alias.
 */

import type { Reason, ScoredTab } from '../../core/scoring';
import type { MessageKey, Translate } from '../../platform/i18n';
import { durationText, formatCount, relativeAge, tabsText } from './format';

/** One chip: its text, and a stable key for the list. */
export interface RowChip {
  readonly id: string;
  readonly text: string;
}

/**
 * The headline reason, or `''` when the score has no headline to give.
 *
 * `review` is that case: a tab in "Da valutare" got there by adding up small signals, so
 * the honest line is the age chip and the section it is in, not a sentence that would
 * have to say "no strong reason". `protected` cannot reach a row at all.
 *
 * `stale` and `stale-unread` carry the age in the sentence (§6.4: "Non la apri da 12
 * giorni"), which is why `chipsOf` leaves the age chip off those rows.
 */
export function reasonText(scored: ScoredTab, t: Translate, language: string): string {
  switch (scored.primaryReason) {
    case 'duplicate':
      return t('reasonDuplicate');
    case 'blank':
      return t('reasonBlank');
    case 'transient':
      return t(transientKey(scored.pageType));
    case 'stale':
      return t('reasonStale', durationText(scored.idleMs, language));
    case 'stale-unread':
      return t('reasonStaleUnread', durationText(scored.idleMs, language));
    case 'review':
    case 'protected':
      return '';
  }
}

/**
 * Which transient page it is. `error` is in the list because `classify` can return it,
 * but an error page never becomes the primary reason (`src/core/scoring.ts` only counts
 * it as points), so it falls through to the generic line rather than claiming more than
 * the title pattern knows.
 */
function transientKey(pageType: ScoredTab['pageType']): MessageKey {
  switch (pageType) {
    case 'search':
      return 'reasonSearch';
    case 'auth':
      return 'reasonAuth';
    case 'browser-internal':
      return 'reasonBrowserPage';
    default:
      return 'reasonTransient';
  }
}

/**
 * The chips of §4.3, in the order the mockup draws them: the age first, then the
 * secondary reasons in the order the rules found them.
 *
 * The age is `Intl`'s, not a message of ours, so it reads the way the browser's own
 * surfaces write an age in that language.
 */
export function chipsOf(scored: ScoredTab, t: Translate, language: string): readonly RowChip[] {
  const chips: RowChip[] = [];

  if (!carriesAge(scored)) {
    chips.push({ id: 'age', text: relativeAge(scored.idleMs, language) });
  }

  for (const reason of scored.reasons) {
    const text = chipText(reason, t, language);
    if (text !== '') chips.push({ id: reason.code, text });
  }

  return chips;
}

/** Whether the sentence already says how old the tab is. */
function carriesAge(scored: ScoredTab): boolean {
  return scored.primaryReason === 'stale' || scored.primaryReason === 'stale-unread';
}

/**
 * The chip for one signal, or `''` for a signal that is not worth a chip: `stale` and
 * the transient pages are already the sentence or the age, and `forgotten-window` is the
 * card above the list rather than something about this tab.
 */
function chipText(reason: Reason, t: Translate, language: string): string {
  switch (reason.code) {
    case 'low-engagement':
      return openedText(reason.activations, t, language);
    case 'near-duplicate':
      return t('chipNearDuplicate');
    case 'bookmarked':
      return t('chipBookmarked');
    case 'discarded':
      return t('chipDiscarded');
    case 'error':
      return t('chipError');
    case 'duplicate':
    case 'blank':
    case 'stale':
    case 'search':
    case 'auth':
    case 'browser-internal':
    case 'forgotten-window':
      return '';
  }
}

/** §6.4's "Aperta 1 volta": how many times the tab was ever in the foreground. */
function openedText(activations: number, t: Translate, language: string): string {
  if (activations === 0) return t('chipOpenedNever');
  const plural = new Intl.PluralRules(language).select(activations) === 'one';
  return t(plural ? 'chipOpenedOne' : 'chipOpenedOther', formatCount(activations, language));
}

/** The §4.3 card: "Finestra con 12 schede non toccata da 3 settimane". */
export function forgottenWindowText(
  tabCount: number,
  idleMs: number,
  t: Translate,
  language: string,
): string {
  return t('windowForgotten', tabsText(tabCount, t, language), durationText(idleMs, language));
}
