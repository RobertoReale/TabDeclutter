/**
 * The time budget of PLAN.md §11 for the group proposals: 300 tabs clustered, without AI,
 * in 50 ms (TASKS.md M4.1).
 *
 * It is measured here rather than next to the unit tests for the reason
 * `tests/perf/scoring.perf.test.ts` gives: `pnpm test` instruments `src/core/` with V8
 * coverage and runs its files in parallel workers, and a number measured under that is a
 * number about the harness. `pnpm perf` measures with coverage off, one file at a time,
 * against the plan's millisecond with no allowance on top (docs/DECISIONS.md, M1.8).
 *
 * **Why pinned and grouped tabs are included.** By default a proposal leaves them alone
 * (PLAN.md §4.4), and on this fixture that would quietly drop 21 of the 300 tabs the
 * budget is about. The options are turned on so that all 300 are clustered.
 *
 * **Why the same 300 tabs are also measured in one window.** Clustering runs per window
 * (PLAN.md §7.4), and the fixture's 300 tabs are spread over six: the largest window is
 * about 60 tabs, so six windows of 60 cost a fraction of what the O(n²) linkage of §7.2.3
 * costs on 300 tabs at once. The plan's row says "clustering 300 tabs", and §7.2.3 claims
 * the quadratic cost is acceptable "with n ≤ 500" — so the number that has to hold is the
 * one for a user with 300 tabs in a single window, and that is what the second case
 * measures. The first is kept because it is what the fixture describes and what the panel
 * will usually ask for.
 */

import { describe, expect, it } from 'vitest';

import { groupBySite, groupByTopic, type ClusterOptions } from '../../src/core/cluster';
import type { TabInfo } from '../../src/core/types';
import { loadFixture } from '../fixtures/scoring-input';
import { measureBudget, type BudgetReport } from './budget';

/** PLAN.md §11: "Clustering 300 tabs (without AI): ≤ 50 ms". */
const BUDGET_MS = 50;

/** Everything the fixture has is clustered, so the budget is about 300 tabs and not 279. */
const OPTIONS: ClusterOptions = { includePinned: true, includeGrouped: true };

const tabs: readonly TabInfo[] = loadFixture('tabs-300').tabs.map((entry) => entry.tab);

/** The same tabs as one window's worth, which is the quadratic worst case for 300 tabs. */
const oneWindow: readonly TabInfo[] = tabs.map((tab) => ({ ...tab, windowId: 1 }));

describe('the time budget (PLAN.md §11)', () => {
  it('clusters 300 tabs by topic inside the budget', async () => {
    expect(tabs).toHaveLength(300);
    // What is being timed has to be the real proposal, not an early return on an empty
    // input: the fixture's windows do earn groups.
    expect(groupByTopic(tabs, OPTIONS).groups.length).toBeGreaterThan(0);

    const report = await measure('clustering 300 tabs by topic, 6 windows', () =>
      groupByTopic(tabs, OPTIONS),
    );

    // `passed`, not `withinBudget`: on battery Windows halves the clock and the budget is
    // measured and printed instead of enforced (tests/perf/budget.ts).
    expect(report.passed, report.message).toBe(true);
  });

  it('clusters 300 tabs of one window by topic inside the budget', async () => {
    expect(groupByTopic(oneWindow, OPTIONS).groups.length).toBeGreaterThan(0);

    const report = await measure('clustering 300 tabs by topic, 1 window', () =>
      groupByTopic(oneWindow, OPTIONS),
    );

    expect(report.passed, report.message).toBe(true);
  });

  it('clusters 300 tabs by site inside the budget', async () => {
    expect(groupBySite(tabs, OPTIONS).groups.length).toBeGreaterThan(0);

    const report = await measure('clustering 300 tabs by site', () => groupBySite(tabs, OPTIONS));

    expect(report.passed, report.message).toBe(true);
  });
});

/** `measureBudget` against this file's one budget, so each case names only what it runs. */
function measure(what: string, run: () => unknown): Promise<BudgetReport> {
  return measureBudget({ what, limitMs: BUDGET_MS }, run);
}
