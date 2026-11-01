/**
 * Every number the uselessness score uses, in one place (PLAN.md §6.4).
 *
 * The score is tuned against `tests/fixtures/tabs-300.json`, and tuning means
 * editing this file and nothing else: `scoring.ts` reads the weights and never
 * writes one down. The comments say which rule each value belongs to, because a
 * bare `15` tells the next reader nothing.
 */

import { HOUR } from './time';

export interface ScoringConfig {
  /** Step 2: a tab whose URL another tab already has open. */
  readonly duplicatePoints: number;
  /** Step 2: an empty tab nobody has touched in `transientMinIdleMs`. */
  readonly blankPoints: number;

  /** Step 3: the most inactivity alone can ever be worth. */
  readonly inactivityPoints: number;
  /**
   * Step 3: a page that has already done its job — a search result page, a
   * sign-in page, a browser page. Worth nothing until the tab has been idle for
   * `transientMinIdleMs`, because the user may be reading it right now.
   */
  readonly transientPoints: number;
  /** Step 3: an error page. Lower than the others: a reload may be pending. */
  readonly errorPoints: number;
  /** How long a transient or empty page has to sit untouched before it counts. */
  readonly transientMinIdleMs: number;

  /** Step 3: opened, glanced at, never read. */
  readonly lowEngagementPoints: number;
  /** At most this many activations for the tab to count as unread. */
  readonly lowEngagementMaxActivations: number;
  /** And less than this much time in the foreground. */
  readonly lowEngagementMaxForegroundMs: number;

  /** Step 3: same page as another tab bar the query string or the fragment. */
  readonly nearDuplicatePoints: number;
  /** Step 3: the page is in the bookmarks, so closing it loses nothing. */
  readonly bookmarkedPoints: number;
  /** Step 3: the browser has already dropped the page from memory. */
  readonly discardedPoints: number;
  /** Step 3: every tab of the window is stale (PLAN.md §4.3). */
  readonly forgottenWindowPoints: number;

  /**
   * Step 3, applied to the total: tabs the user filed in a group on purpose are
   * worth more to them than loose ones.
   */
  readonly groupedMultiplier: number;

  /** The score can never exceed this, whatever the rules add up to. */
  readonly maxScore: number;
  /** From this score up, the tab is in the `close` bucket. */
  readonly closeBucketMin: number;
  /** From this score up (and below `closeBucketMin`), the `review` bucket. */
  readonly reviewBucketMin: number;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  duplicatePoints: 95,
  blankPoints: 90,

  inactivityPoints: 55,
  transientPoints: 25,
  errorPoints: 15,
  transientMinIdleMs: HOUR,

  lowEngagementPoints: 15,
  lowEngagementMaxActivations: 1,
  lowEngagementMaxForegroundMs: 15_000,

  nearDuplicatePoints: 15,
  bookmarkedPoints: 10,
  discardedPoints: 5,
  forgottenWindowPoints: 10,

  groupedMultiplier: 0.6,

  maxScore: 100,
  closeBucketMin: 70,
  reviewBucketMin: 40,
};
