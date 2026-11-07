/**
 * Which answers to `Win32_Battery.BatteryStatus` mean the machine is on its battery, and
 * therefore that the budgets of PLAN.md §11 are measured and not enforced
 * (tests/perf/budget.ts, docs/DECISIONS.md M2.4).
 *
 * Only a 1 means battery. Everything else — mains, a desktop with no battery, an answer
 * that is not a number, a query that fails — means mains, which is the reading that keeps
 * the budget enforced and so cannot hide a regression.
 */

import process from 'node:process';

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
   * How much CPU time the run below burns before it returns: more than two of Windows'
   * ~15.6 ms scheduler ticks, so what `measureBudget` reads can never quantise down to 0.
   */
  const MISS_CPU_MS = 40;

  /**
   * A run too expensive for a budget of 0 ms, measured once, with nothing to warm up.
   *
   * `referenceMs` is given rather than measured: this test is about the power source, and a
   * reference measured on whatever machine happens to run it would decide the verdict
   * instead (`REFERENCE_CPU_MS`, so a factor of exactly 1, and a limit still at 0 ms).
   *
   * **The run burns CPU time, not wall time.** It used to spin until `performance.now()` had
   * moved by 25 ms, and that is not the clock being measured: `measureBudget` asserts
   * `process.cpuUsage()`, charged in ~15.6 ms ticks, and `pnpm test` runs one worker per
   * file. On a saturated CPU a 25 ms *wall* window can be charged less than one tick, read
   * as 0 µs, and meet a limit of 0 ms — which failed this gate on whichever of the two tests
   * below happened to land in the bad window. Spinning on the process's own CPU clock makes
   * the miss a property of the run rather than of the machine's load.
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
        const started = process.cpuUsage();
        for (;;) {
          const spent = process.cpuUsage(started);
          if ((spent.user + spent.system) / 1000 >= MISS_CPU_MS) return;
        }
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
