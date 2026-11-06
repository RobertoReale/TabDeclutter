/**
 * Which answers to `Win32_Battery.BatteryStatus` mean the machine is on its battery, and
 * therefore that the budgets of PLAN.md §11 are measured and not enforced
 * (tests/perf/budget.ts, docs/DECISIONS.md M2.4).
 *
 * Only a 1 means battery. Everything else — mains, a desktop with no battery, an answer
 * that is not a number, a query that fails — means mains, which is the reading that keeps
 * the budget enforced and so cannot hide a regression.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { measureBudget, powerSourceFrom, REFERENCE_CPU_MS } from '../perf/budget';

describe('the power source behind a perf budget', () => {
  it('reads a discharging battery as battery', () => {
    expect(powerSourceFrom(() => '1')).toBe('battery');
  });

  it('reads mains as mains', () => {
    expect(powerSourceFrom(() => '2')).toBe('mains');
  });

  it('reads no battery at all as mains', () => {
    expect(powerSourceFrom(() => '')).toBe('mains');
  });

  it('reads an answer that is not a number as mains', () => {
    expect(powerSourceFrom(() => 'Get-CimInstance : Invalid class')).toBe('mains');
  });

  it('reads a query that throws as mains', () => {
    expect(
      powerSourceFrom(() => {
        throw new Error('powershell is not on the path');
      }),
    ).toBe('mains');
  });

  it('reads two batteries as battery when either one is discharging', () => {
    expect(powerSourceFrom(() => '2\r\n1\r\n')).toBe('battery');
  });
});

describe('a budget that is missed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * A run too expensive for a budget of 0 ms, measured once, with nothing to warm up.
   *
   * `referenceMs` is given rather than measured: this test is about the power source, and a
   * reference measured on whatever machine happens to run it would decide the verdict
   * instead (`REFERENCE_CPU_MS`, so a factor of exactly 1, and a limit still at 0 ms).
   */
  async function missTheBudget(powerSource: 'battery' | 'mains') {
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    const report = await measureBudget(
      {
        what: 'a run that cannot fit',
        limitMs: 0,
        warmUpRuns: 0,
        samples: 1,
        attempts: 1,
        batchRuns: 1,
        powerSource,
        referenceMs: REFERENCE_CPU_MS,
      },
      () => {
        const until = performance.now() + 25;
        while (performance.now() < until);
      },
    );
    return { report, printed };
  }

  it('fails on mains, where the number means something', async () => {
    const { report } = await missTheBudget('mains');

    expect(report.withinBudget).toBe(false);
    expect(report.enforced).toBe(true);
    expect(report.passed).toBe(false);
  });

  it('passes on battery, and says on stdout that it was not enforced', async () => {
    const { report, printed } = await missTheBudget('battery');

    expect(report.withinBudget).toBe(false);
    expect(report.enforced).toBe(false);
    expect(report.passed).toBe(true);
    expect(printed[0]).toBe('perf budget NOT ENFORCED: running on battery (CPU throttled)');
    // Measured and reported all the same: the medians follow the line that excuses them.
    expect(printed[1]).toContain('over budget on every attempt');
  });
});
