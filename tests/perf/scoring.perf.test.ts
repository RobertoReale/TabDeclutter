/**
 * The time budget of PLAN.md §11 for the score: a thousand tabs in 15 ms.
 *
 * It is not next to the precision assertions in `tests/unit/scoring.fixtures.test.ts`
 * because `pnpm test` instruments `src/core/` with V8 coverage and runs its files in
 * parallel workers. The same loop measured about 10 ms on its own and 60-100 ms inside
 * the full gate list once M1.8 added two more test files — a property of the harness, not
 * of `score()`. `pnpm perf` measures with coverage off, one file at a time, against the
 * plan's number with no allowance on top (docs/DECISIONS.md, M1.8).
 */

import { describe, expect, it } from 'vitest';

import { inputOf, loadFixture, score } from '../fixtures/scoring-input';
import { measureBudget } from './budget';

/** PLAN.md §11 and TASKS.md M1.6: the median for 1000 tabs, measured after a warm-up. */
const BUDGET_MS = 15;

describe('the time budget (PLAN.md §11)', () => {
  it('scores a thousand tabs inside the budget', async () => {
    const input = inputOf(loadFixture('tabs-1000'));
    expect(input.tabs).toHaveLength(1000);

    const report = await measureBudget({ what: 'scoring 1000 tabs', limitMs: BUDGET_MS }, () =>
      score(input),
    );

    // `passed`, not `withinBudget`: on battery Windows halves the clock and the budget is
    // measured and printed instead of enforced (tests/perf/budget.ts).
    expect(report.passed, report.message).toBe(true);
  });
});
