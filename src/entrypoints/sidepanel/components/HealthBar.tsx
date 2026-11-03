/**
 * The "health bar" of PLAN.md §4.2: `███████████░░░░░  23 da rivedere`.
 *
 * The filled part is the share of open tabs the score left alone, so a tidy browser's bar
 * is nearly full and the number beside it is small. It is the number that carries the
 * meaning — the bar is `aria-hidden` decoration, because a screen reader reading out a
 * percentage of nothing in particular would say less than "23 da rivedere" already does.
 */

import { t } from '@/platform/i18n';
import { reviewText } from '../format';

export function HealthBar({
  review,
  total,
  language,
}: {
  /** How many tabs the score suggests looking at. */
  review: number;
  /** How many tabs are open in all. */
  total: number;
  language: string;
}) {
  const tidy = total === 0 ? 1 : Math.max(0, total - review) / total;

  return (
    <div class="td-health">
      <div class="td-health-bar" aria-hidden="true">
        {/* A percentage, so the bar is as wide as the panel happens to be (§4.7). */}
        <div class="td-health-fill" style={`width: ${(tidy * 100).toFixed(1)}%`} />
      </div>
      {/*
        §4.8: the counts are a polite live region, so a tab opening or closing is
        announced as a new number rather than only redrawn. It is the sentence that is
        live, not the bar, for the same reason the bar is `aria-hidden`.
      */}
      <p class="td-health-text" aria-live="polite">
        {reviewText(review, t, language)}
      </p>
    </div>
  );
}
