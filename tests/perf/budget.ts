/**
 * How every wall-clock budget of PLAN.md §11 is measured. The score is the first one;
 * the panel opening (M2.5, ≤ 150 ms) and the clustering (M4.1, ≤ 50 ms) use this too.
 *
 * Three rules, and they are why this is a module and not a loop copied three times:
 *
 * - the number asserted is the number in the plan, with no allowance on top. That is only
 *   honest with coverage off and one file at a time, which is what `vitest.perf.config.ts`
 *   is for;
 * - a median of several runs after a warm-up, because the first runs pay for the JIT and
 *   for every regex a module compiles on its first call;
 * - the whole measurement, warm-up included, is repeated up to three times and the best
 *   attempt decides. A machine that was busy for a moment loses one attempt; code that
 *   actually got slower is over budget in all three.
 *
 * Nothing here retries a failing assertion: the repetition is inside the measurement, and
 * every median measured is printed, so a run that only just made it is visible in the log.
 */

/**
 * Twenty runs, because five were not enough: with five, the first attempt measured
 * 17-21 ms for the score and the next ones 12-14 ms, V8 still tiering the same code up.
 * Twenty puts the first attempt at the steady state (11.0-11.3 ms), which is what a user
 * with the extension already running experiences.
 */
const WARM_UP_RUNS = 20;
const SAMPLES = 11;
const ATTEMPTS = 3;

export interface BudgetSpec {
  /** What is measured, as it appears in the output: `scoring 1000 tabs`. */
  readonly what: string;
  /** The budget of PLAN.md §11, in milliseconds, exactly as the plan states it. */
  readonly limitMs: number;
  readonly warmUpRuns?: number;
  readonly samples?: number;
  readonly attempts?: number;
}

export interface BudgetReport {
  /** True when any one attempt came in at or under the budget. */
  readonly withinBudget: boolean;
  /** One median per attempt, in the order they were measured. */
  readonly medians: readonly number[];
  /** The best of them: the one the verdict rests on. */
  readonly bestMs: number;
  /** The whole measurement in one line, for the assertion message and the log. */
  readonly message: string;
}

/**
 * Measures `run` against `spec` and reports. Asserting is the test's business: it should
 * read `expect(report.withinBudget, report.message).toBe(true)`.
 *
 * `run` may be synchronous or return a promise; an asynchronous one is awaited inside the
 * measured interval.
 */
export async function measureBudget(spec: BudgetSpec, run: () => unknown): Promise<BudgetReport> {
  const warmUpRuns = spec.warmUpRuns ?? WARM_UP_RUNS;
  const samples = spec.samples ?? SAMPLES;
  const attempts = spec.attempts ?? ATTEMPTS;
  const medians: number[] = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    for (let i = 0; i < warmUpRuns; i += 1) await timeOne(run);

    const taken: number[] = [];
    for (let i = 0; i < samples; i += 1) taken.push(await timeOne(run));

    const measured = median(taken);
    medians.push(measured);
    if (measured <= spec.limitMs) break;
  }

  const bestMs = Math.min(...medians);
  const withinBudget = bestMs <= spec.limitMs;
  const message = describeMeasurement(spec, medians, withinBudget, {
    warmUpRuns,
    samples,
    attempts,
  });
  // On stdout, not only in the assertion message, so that a green gate reports the number
  // it measured and `tools/gates.mjs` can quote it.
  console.log(message);
  return { withinBudget, medians, bestMs, message };
}

async function timeOne(run: () => unknown): Promise<number> {
  const started = performance.now();
  const outcome = run();
  // `await` costs a microtask turn even on a plain value, so only an asynchronous budget
  // pays for one: the clock stops right after the call for a synchronous one.
  if (isPromiseLike(outcome)) await outcome;
  return performance.now() - started;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null | undefined)?.then === 'function';
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = (sorted.length - 1) / 2;
  const low = sorted[Math.floor(middle)];
  const high = sorted[Math.ceil(middle)];
  // Unreachable with at least one sample; `undefined` here would otherwise pass as 0.
  if (low === undefined || high === undefined) return Number.POSITIVE_INFINITY;
  return (low + high) / 2;
}

function describeMeasurement(
  spec: BudgetSpec,
  medians: readonly number[],
  withinBudget: boolean,
  counts: { warmUpRuns: number; samples: number; attempts: number },
): string {
  const label = medians.length === 1 ? 'median' : 'medians';
  const list = medians.map((value) => value.toFixed(2)).join(', ');
  const how = `${counts.samples} runs after ${counts.warmUpRuns} warm-up, ${medians.length} of ${counts.attempts} attempts`;
  const verdict = withinBudget ? 'within budget' : 'over budget on every attempt';
  return `perf budget: ${spec.what} — limit ${spec.limitMs} ms, ${label} ${list} ms (${how}), ${verdict}`;
}
