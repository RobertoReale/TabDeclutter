/**
 * How a measured millisecond becomes a verdict: `judgeBudget` of `tests/perf/budget.ts`,
 * which is the whole decision behind the `perf budgets` gate and the one part of it that
 * can be tested without being at the mercy of how fast this machine is running right now
 * (docs/DECISIONS.md, F.1).
 *
 * The budgets of PLAN.md §11 are untouched numbers; what they are compared against is the
 * limit times how slow the machine was, measured by a reference workload interleaved with
 * the measurement. So the cases are: within, over, a machine faster than nominal (where the
 * factor must not drop below 1), a machine too slow for the comparison to mean anything,
 * and battery.
 *
 * The workload itself is checked too, for the one property nothing else would notice: it
 * has to be self-contained, because the panel budget ships its source text into the browser
 * and anything it referenced from this module would be a `ReferenceError` there.
 */

import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  judgeBudget,
  MAX_FACTOR,
  MIN_FACTOR,
  NOT_ENFORCED_BATTERY,
  NOT_ENFORCED_TOO_SLOW,
  referenceWorkload,
  referenceWorkloadExpression,
  type PowerSource,
} from '../perf/budget';

/** A budget of 15 ms, PLAN.md §11's score, and a yardstick that costs 10 ms at nominal. */
const LIMIT_MS = 15;
const NOMINAL_MS = 10;

function judge(measuredMs: number, referenceMs: number, powerSource: PowerSource = 'mains') {
  return judgeBudget({
    measuredMs,
    limitMs: LIMIT_MS,
    referenceMs,
    nominalReferenceMs: NOMINAL_MS,
    powerSource,
  });
}

describe('the verdict on a perf budget (PLAN.md §11)', () => {
  it('passes a measurement within the budget at nominal speed', () => {
    const verdict = judge(14.2, NOMINAL_MS);

    expect(verdict.factor).toBe(1);
    expect(verdict.effectiveLimitMs).toBe(LIMIT_MS);
    expect(verdict.withinBudget).toBe(true);
    expect(verdict.enforced).toBe(true);
    expect(verdict.passed).toBe(true);
    // Nothing to excuse: the line only appears when a number was over its limit.
    expect(verdict.excuse).toBeUndefined();
  });

  it('fails a measurement over the budget at nominal speed', () => {
    const verdict = judge(15.4, NOMINAL_MS);

    expect(verdict.withinBudget).toBe(false);
    expect(verdict.enforced).toBe(true);
    expect(verdict.passed).toBe(false);
    expect(verdict.excuse).toBeUndefined();
  });

  it('enlarges the limit on a machine running slower than nominal', () => {
    // Half speed: the same code is allowed twice the milliseconds, and no more.
    const verdict = judge(29, NOMINAL_MS * 2);

    expect(verdict.rawFactor).toBe(2);
    expect(verdict.factor).toBe(2);
    expect(verdict.effectiveLimitMs).toBe(30);
    expect(verdict.passed).toBe(true);
    expect(judge(31, NOMINAL_MS * 2).passed).toBe(false);
  });

  it('never judges a machine faster than nominal against more than the plan', () => {
    // CI, or a later laptop: the yardstick costs a quarter of what it costs here, and the
    // budget stays at 15 ms rather than shrinking to 3.75.
    const verdict = judge(15.4, NOMINAL_MS / 4);

    expect(verdict.rawFactor).toBeCloseTo(0.25, 10);
    expect(verdict.factor).toBe(MIN_FACTOR);
    expect(verdict.effectiveLimitMs).toBe(LIMIT_MS);
    expect(verdict.withinBudget).toBe(false);
    expect(verdict.enforced).toBe(true);
    expect(verdict.passed).toBe(false);
  });

  it('measures and does not enforce on a machine too slow to judge', () => {
    const verdict = judge(400, NOMINAL_MS * (MAX_FACTOR + 2));

    expect(verdict.rawFactor).toBe(MAX_FACTOR + 2);
    // Clamped, so the limit printed is the largest one that still means something.
    expect(verdict.factor).toBe(MAX_FACTOR);
    expect(verdict.effectiveLimitMs).toBe(LIMIT_MS * MAX_FACTOR);
    expect(verdict.withinBudget).toBe(false);
    expect(verdict.enforced).toBe(false);
    expect(verdict.passed).toBe(true);
    expect(verdict.excuse).toBe(`${NOT_ENFORCED_TOO_SLOW} (factor ${(MAX_FACTOR + 2).toFixed(1)})`);
  });

  it('still enforces a machine exactly at the upper clamp', () => {
    const verdict = judge(LIMIT_MS * MAX_FACTOR + 1, NOMINAL_MS * MAX_FACTOR);

    expect(verdict.factor).toBe(MAX_FACTOR);
    expect(verdict.enforced).toBe(true);
    expect(verdict.passed).toBe(false);
  });

  it('measures and does not enforce on battery', () => {
    const verdict = judge(40, NOMINAL_MS, 'battery');

    expect(verdict.withinBudget).toBe(false);
    expect(verdict.enforced).toBe(false);
    expect(verdict.passed).toBe(true);
    expect(verdict.excuse).toBe(NOT_ENFORCED_BATTERY);
  });

  it('keeps the budget strict when the reference could not be measured', () => {
    // A reference of zero, of nothing, or of a timer that went backwards is not an excuse
    // to loosen anything: the factor is 1 and the plan's number stands.
    for (const broken of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const verdict = judge(15.4, broken);

      expect(verdict.factor, `reference ${String(broken)}`).toBe(MIN_FACTOR);
      expect(verdict.effectiveLimitMs, `reference ${String(broken)}`).toBe(LIMIT_MS);
      expect(verdict.passed, `reference ${String(broken)}`).toBe(false);
    }
  });
});

/**
 * These three tests actually run the yardstick, so they are the only ones here whose wall
 * time depends on the machine. What they assert is structural — the workload is
 * deterministic, self-contained, and reports one run — and none of it is a speed claim, so
 * the default 5 s timeout was gating a shape check on how loaded the CPU happened to be.
 * `pnpm test` spawns one worker per file, and `referenceWorkloadExpression` runs the
 * workload `PAGE_REFERENCE_RUNS` times in a cold VM context with no JIT warm-up: with 33
 * workers competing, that crossed 5 s and turned the whole gate red (docs/DECISIONS.md,
 * M3b.1). A generous timeout costs nothing when the machine is idle and still catches a
 * genuine hang.
 */
const WORKLOAD_TIMEOUT_MS = 30_000;

describe('the reference workload', () => {
  it('always costs the same and answers the same', { timeout: WORKLOAD_TIMEOUT_MS }, () => {
    const first = referenceWorkload();

    expect(Number.isInteger(first)).toBe(true);
    expect(referenceWorkload()).toBe(first);
  });

  it(
    'is self-contained, so the panel budget can run it inside the browser',
    { timeout: WORKLOAD_TIMEOUT_MS },
    () => {
      // An empty context with nothing of this module in it: a reference to anything outside
      // the function throws here, which is what it would do in the page.
      const source = `const workload = ${referenceWorkload.toString()}; workload();`;
      expect(runInNewContext(source, {})).toBe(referenceWorkload());
    },
  );

  it(
    'times itself on the clock of whoever evaluates its expression',
    { timeout: WORKLOAD_TIMEOUT_MS },
    () => {
      let reads = 0;
      const ms = runInNewContext(referenceWorkloadExpression(), {
        performance: {
          now: () => {
            reads += 1;
            // 80 ms over however many runs the expression makes: what it reports is one run.
            return reads === 1 ? 1_000 : 1_080;
          },
        },
      }) as number;

      expect(reads).toBe(2);
      expect(ms).toBeGreaterThan(0);
      expect(80 % ms).toBe(0);
    },
  );
});
