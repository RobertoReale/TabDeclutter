/**
 * How every budget of PLAN.md §11 is measured. The score is the first one; the panel
 * opening (M2.5, ≤ 150 ms) and the clustering (M4.1, ≤ 50 ms) use this too.
 *
 * Four rules, and they are why this is a module and not a loop copied three times:
 *
 * - the number asserted is the number in the plan, with no allowance on top. That is only
 *   honest with coverage off and one file at a time, which is what `vitest.perf.config.ts`
 *   is for;
 * - what is asserted is the **CPU time of this process**, user plus system, and not the
 *   wall clock. The budget is a claim about the code, and a wall clock also charges it for
 *   every millisecond the operating system gave to something else: the score measured
 *   9.8-12.5 ms on an idle machine and 16-69 ms while a browser and an editor held the
 *   CPU, without a line of `src/core/` having changed. CPU time leaves out exactly the
 *   interval during which the process was not running. The wall median is measured too and
 *   printed beside it, for information;
 * - a median of several batches after a warm-up, because the first runs pay for the JIT and
 *   for every regex a module compiles on its first call;
 * - the whole measurement, warm-up included, is repeated up to three times and the best
 *   attempt decides. A machine that was busy for a moment loses one attempt; code that
 *   actually got slower is over budget in all three.
 *
 * **Why a batch and not one run.** `process.cpuUsage()` reads in microseconds but is
 * charged in scheduler ticks: on Windows it moves in steps of about 15.6 ms, so a single
 * 12 ms run measures either 0 or 15.6 and never 12. A batch long enough to cover many
 * ticks and divided by its size answers to a run again, with an error of about one tick
 * spread over the batch. The size is not hard-coded: `calibrateBatch` doubles until a batch
 * is worth reading, which is also the only way this stays honest for an operation a
 * hundred times quicker than the score.
 *
 * **The second mode: `measureWallBudget`.** An operation that spends its time waiting
 * rather than computing uses no CPU while it waits, and `process.cpuUsage()` only ever sees
 * this process — neither reads a budget on a browser doing the work. The panel opening
 * (M2.5) is exactly that: a document loads, a module is compiled, a list is rendered and
 * painted, all in a Chromium that Node only drives. So that mode takes the millisecond from
 * whoever can see the clock that matters — the page — and keeps the rest of the rules here:
 * a median of several openings after a warm-up, up to three attempts, best attempt decides,
 * and the number printed whatever the verdict.
 *
 * **On battery the budget is measured and not enforced.** CPU time counts time and not
 * cycles, and Windows runs this laptop at about half its nominal frequency when it is
 * unplugged: the same commit measured 9.75 ms on mains and 29-68 ms on battery with the
 * machine idle. Enforcing there would stop the unattended sequence on the power cable
 * rather than on the code, so a measurement over budget on battery passes with
 * `perf budget NOT ENFORCED` and its medians on stdout. The measurement always happens and
 * is always printed; mains behaves exactly as it always did.
 *
 * Nothing here retries a failing assertion: the repetition is inside the measurement, and
 * every median measured is printed, so a run that only just made it is visible in the log.
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';

/**
 * Twenty runs, because five were not enough: with five, the first attempt measured
 * 17-21 ms for the score and the next ones 12-14 ms, V8 still tiering the same code up.
 * Twenty puts the first attempt at the steady state (11.0-11.3 ms), which is what a user
 * with the extension already running experiences.
 */
const WARM_UP_RUNS = 20;
const SAMPLES = 11;
const ATTEMPTS = 3;

/**
 * How much CPU time one batch has to cost before its total is worth dividing. 120 ms is
 * about eight of Windows' 15.6 ms ticks, so the error a tick leaves on a single run is
 * around 1 ms once the batch is divided — small against a 15 ms budget, and cheap enough
 * that the whole measurement still takes a couple of seconds on an idle machine.
 */
const MIN_BATCH_CPU_MS = 120;

/**
 * The smallest batch that is allowed to be a batch at all: sixteen runs cover eight ticks
 * for anything near the score's 10 ms, so the tick leaves about 1 ms on a single run
 * whatever the calibration thought a run cost.
 */
const MIN_BATCH_RUNS = 16;

/** A batch is doubled, so this is the last size tried: enough for a 60 µs operation. */
const MAX_BATCH_RUNS = 4096;

/**
 * How long the power-source question may take before it is answered "mains". A WMI query
 * normally answers in a few hundred milliseconds; a gate must not hang on it.
 */
const POWER_QUERY_TIMEOUT_MS = 5_000;

/** The line that tells the log, unmistakably, that the number below it was not enforced. */
const NOT_ENFORCED = 'perf budget NOT ENFORCED: running on battery (CPU throttled)';

export type PowerSource = 'battery' | 'mains';

export interface BudgetSpec {
  /** What is measured, as it appears in the output: `scoring 1000 tabs`. */
  readonly what: string;
  /** The budget of PLAN.md §11, in milliseconds, exactly as the plan states it. */
  readonly limitMs: number;
  readonly warmUpRuns?: number;
  readonly samples?: number;
  readonly attempts?: number;
  /** Runs per batch. Calibrated when left out, which is what it should be. */
  readonly batchRuns?: number;
  /**
   * Where the power comes from. Asked of the machine when left out, which is what a budget
   * does; given only by the test that has to exercise both answers on one machine.
   */
  readonly powerSource?: PowerSource;
}

export interface BudgetReport {
  /** True when any one attempt came in at or under the budget. */
  readonly withinBudget: boolean;
  /** Where the power came from, which is what decides whether the budget is enforced. */
  readonly powerSource: PowerSource;
  /** False on battery: the number was measured and reported, and nothing rests on it. */
  readonly enforced: boolean;
  /** What a test asserts: within budget, or measured on battery. */
  readonly passed: boolean;
  /** One median CPU time per run per attempt, in the order they were measured. */
  readonly medians: readonly number[];
  /** The same attempts on the wall clock. Reported, never asserted. */
  readonly wallMedians: readonly number[];
  /** The best of the CPU medians: the one the verdict rests on. */
  readonly bestMs: number;
  /** How many runs one batch held, so the log says how the number was obtained. */
  readonly batchRuns: number;
  /** The whole measurement in one line, for the assertion message and the log. */
  readonly message: string;
}

interface Taken {
  readonly cpuMs: number;
  readonly wallMs: number;
}

/**
 * Measures `run` against `spec` and reports. Asserting is the test's business: it should
 * read `expect(report.passed, report.message).toBe(true)`, which is the budget on mains and
 * the measurement alone on battery (`withinBudget` is the verdict either way).
 *
 * `run` may be synchronous or return a promise; an asynchronous one is awaited inside the
 * measured interval.
 */
export async function measureBudget(spec: BudgetSpec, run: () => unknown): Promise<BudgetReport> {
  // Asked before anything is timed: it spawns a process, and no measured interval should
  // ever contain one.
  const powerSource = spec.powerSource ?? readPowerSource();
  const warmUpRuns = spec.warmUpRuns ?? WARM_UP_RUNS;
  const samples = spec.samples ?? SAMPLES;
  const attempts = spec.attempts ?? ATTEMPTS;
  // Warmed up before the batch size is calibrated, and warmed up again inside every
  // attempt as it always was. The first run of all is the slowest thing that will happen —
  // V8 has not seen the code and every regex a module keeps is still a string — and it can
  // cost more CPU than a whole batch is meant to, which would calibrate the batch down to
  // one run and hand the budget straight back to the scheduler tick.
  for (let i = 0; i < warmUpRuns; i += 1) await timeOne(run);
  const batchRuns = spec.batchRuns ?? (await calibrateBatch(run));

  const medians: number[] = [];
  const wallMedians: number[] = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    for (let i = 0; i < warmUpRuns; i += 1) await timeOne(run);

    const cpu: number[] = [];
    const wall: number[] = [];
    for (let i = 0; i < samples; i += 1) {
      const batch = await timeBatch(run, batchRuns);
      cpu.push(batch.cpuMs / batchRuns);
      wall.push(batch.wallMs / batchRuns);
    }

    const measured = median(cpu);
    medians.push(measured);
    wallMedians.push(median(wall));
    if (measured <= spec.limitMs) break;
  }

  const bestMs = Math.min(...medians);
  const withinBudget = bestMs <= spec.limitMs;
  const enforced = powerSource === 'mains';
  const passed = withinBudget || !enforced;
  const message = describeMeasurement(spec, medians, wallMedians, withinBudget, {
    warmUpRuns,
    samples,
    attempts,
    batchRuns,
  });
  // On stdout, not only in the assertion message, so that a green gate reports the number
  // it measured and `tools/gates.mjs` can quote it. The excuse goes first and in capitals,
  // because a green gate hiding a number over budget has to be impossible to miss.
  if (!withinBudget && !enforced) console.log(NOT_ENFORCED);
  console.log(message);
  return {
    withinBudget,
    powerSource,
    enforced,
    passed,
    medians,
    wallMedians,
    bestMs,
    batchRuns,
    message,
  };
}

/**
 * How many openings are thrown away before the first one is counted. Two, not twenty: an
 * opening costs seconds rather than milliseconds, and what it warms is the browser — the
 * extension's service worker up, V8's code cache for the panel's chunk written, the
 * profile's storage read once — which is the state a user's browser is always in and which
 * two openings already reach.
 */
const WALL_WARM_UP_RUNS = 2;

/** Nine openings per attempt: an odd number, so the median is one of them. */
const WALL_SAMPLES = 9;

export interface WallBudgetSpec {
  /** What is measured, as it appears in the output: `opening the panel with 300 tabs`. */
  readonly what: string;
  /** The budget of PLAN.md §11, in milliseconds, exactly as the plan states it. */
  readonly limitMs: number;
  readonly warmUpRuns?: number;
  readonly samples?: number;
  readonly attempts?: number;
  readonly powerSource?: PowerSource;
}

export interface WallBudgetReport {
  /** True when any one attempt's median came in at or under the budget. */
  readonly withinBudget: boolean;
  readonly powerSource: PowerSource;
  /** False on battery: the number was measured and reported, and nothing rests on it. */
  readonly enforced: boolean;
  /** What a test asserts: within budget, or measured on battery. */
  readonly passed: boolean;
  /** One median per attempt, in the order they were measured. */
  readonly medians: readonly number[];
  /** Every opening measured, attempt by attempt, so the log shows the spread. */
  readonly samples: readonly (readonly number[])[];
  /** The best of the medians: the one the verdict rests on. */
  readonly bestMs: number;
  readonly message: string;
}

/**
 * Measures a budget whose milliseconds only the thing being measured can read, and reports
 * the same way `measureBudget` does — a test should read
 * `expect(report.passed, report.message).toBe(true)`.
 *
 * `open` performs one whole operation and answers with how long it took. Returning the
 * number rather than being timed from here is the point: a wall clock around an
 * `await page.goto()` would also charge the operation for Playwright's round trips, and
 * what the plan promises is what the user waits for, which is what the page's own
 * `performance.now()` counts.
 */
export async function measureWallBudget(
  spec: WallBudgetSpec,
  open: () => Promise<number>,
): Promise<WallBudgetReport> {
  // Before anything is timed: it spawns a process.
  const powerSource = spec.powerSource ?? readPowerSource();
  const warmUpRuns = spec.warmUpRuns ?? WALL_WARM_UP_RUNS;
  const sampleCount = spec.samples ?? WALL_SAMPLES;
  const attempts = spec.attempts ?? ATTEMPTS;

  for (let i = 0; i < warmUpRuns; i += 1) await open();

  const medians: number[] = [];
  const samples: number[][] = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const measured: number[] = [];
    for (let i = 0; i < sampleCount; i += 1) measured.push(await open());
    samples.push(measured);
    const middle = median(measured);
    medians.push(middle);
    if (middle <= spec.limitMs) break;
  }

  const bestMs = Math.min(...medians);
  const withinBudget = bestMs <= spec.limitMs;
  const enforced = powerSource === 'mains';
  const passed = withinBudget || !enforced;
  const label = medians.length === 1 ? 'wall median' : 'wall medians';
  const list = medians.map((value) => value.toFixed(1)).join(', ');
  const spread = samples
    .map((attempt) => attempt.map((value) => value.toFixed(0)).join(' '))
    .join(' | ');
  const how = `${String(sampleCount)} openings after ${String(warmUpRuns)} warm-up, ${String(medians.length)} of ${String(attempts)} attempts`;
  const verdict = withinBudget ? 'within budget' : 'over budget on every attempt';
  const message = `perf budget: ${spec.what} — limit ${String(spec.limitMs)} ms, ${label} ${list} ms (${how}), ${verdict}\n  openings: ${spread}`;
  // The excuse first and in capitals, exactly as the CPU mode prints it: a green gate
  // hiding a number over budget has to be impossible to miss.
  if (!withinBudget && !enforced) console.log(NOT_ENFORCED);
  console.log(message);
  return { withinBudget, powerSource, enforced, passed, medians, samples, bestMs, message };
}

/**
 * Whether this machine is running on its battery, which is the one state where a budget in
 * milliseconds says more about the power cable than about the code.
 *
 * Windows only: `Win32_Battery.BatteryStatus` is 1 while the battery discharges and
 * something else (2 on mains) otherwise. Everywhere else, and whenever the question cannot
 * be answered, the answer is mains — the budget is then enforced, which is the behaviour
 * that cannot hide a regression.
 */
function readPowerSource(): PowerSource {
  if (process.platform !== 'win32') return 'mains';
  return powerSourceFrom(queryBatteryStatus);
}

/**
 * The decision, with the query handed in so that every branch of it can be tested:
 * `tests/unit/perf-budget-power.test.ts`.
 *
 * A desktop reports no battery at all and answers nothing, a laptop with two reports one
 * line each, and anything that is not a number is not an answer. Only a 1 means battery.
 */
export function powerSourceFrom(readBatteryStatus: () => string): PowerSource {
  let raw: string;
  try {
    raw = readBatteryStatus();
  } catch {
    return 'mains';
  }
  const discharging = raw
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .some((status) => status === 1);
  return discharging ? 'battery' : 'mains';
}

/** `Win32_Battery.BatteryStatus`, one line per battery, or nothing at all. */
function queryBatteryStatus(): string {
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Battery | Select-Object -ExpandProperty BatteryStatus',
    ],
    { encoding: 'utf8', timeout: POWER_QUERY_TIMEOUT_MS, windowsHide: true },
  );
  // A timeout kills the child and leaves a null status; an empty answer is a desktop, and
  // `powerSourceFrom` reads both as mains.
  if (result.error !== undefined || result.status !== 0) return '';
  return result.stdout;
}

/**
 * How many runs make a batch whose CPU time can be read: the first size whose batch costs
 * `MIN_BATCH_CPU_MS`, doubling.
 *
 * It starts at `MIN_BATCH_RUNS` rather than at one because the size must not depend on how
 * busy the machine was during the calibration. A loaded machine makes a run look several
 * times more expensive than it is, which would choose a batch of three or four runs — and
 * a batch that small is back to reporting ticks: the attempt that exposed this measured
 * 15.50 ms for a 11.75 ms score. A batch of sixteen covers eight ticks even if the
 * estimate behind it was wrong, and the only operation that keeps one run per batch is one
 * that already costs a whole batch on its own, where a tick is noise anyway.
 */
async function calibrateBatch(run: () => unknown): Promise<number> {
  // The cheapest of three, because a run that happened to be preempted is charged for the
  // wait and would answer this question with someone else's work.
  const singles: number[] = [];
  for (let i = 0; i < 3; i += 1) singles.push((await timeBatch(run, 1)).cpuMs);
  if (Math.min(...singles) >= MIN_BATCH_CPU_MS) return 1;

  let runs = MIN_BATCH_RUNS;
  for (;;) {
    const { cpuMs } = await timeBatch(run, runs);
    if (cpuMs >= MIN_BATCH_CPU_MS || runs >= MAX_BATCH_RUNS) return runs;
    // From a measurement that was too short to trust, so the next size is a guess: double,
    // rather than scaling by a ratio computed from a number quantised to a tick.
    runs *= 2;
  }
}

async function timeBatch(run: () => unknown, runs: number): Promise<Taken> {
  const startedCpu = process.cpuUsage();
  const startedWall = performance.now();
  for (let i = 0; i < runs; i += 1) {
    const outcome = run();
    // `await` costs a microtask turn even on a plain value, so only an asynchronous budget
    // pays for one: the clock stops right after the call for a synchronous one.
    if (isPromiseLike(outcome)) await outcome;
  }
  const wallMs = performance.now() - startedWall;
  const spent = process.cpuUsage(startedCpu);
  // `cpuUsage` answers in microseconds, both fields, and the budget is about the work the
  // process did: time in the kernel on its behalf counts as much as time in V8.
  return { cpuMs: (spent.user + spent.system) / 1000, wallMs };
}

/** One run, for the warm-up, where nothing is measured. */
async function timeOne(run: () => unknown): Promise<void> {
  const outcome = run();
  if (isPromiseLike(outcome)) await outcome;
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
  wallMedians: readonly number[],
  withinBudget: boolean,
  counts: { warmUpRuns: number; samples: number; attempts: number; batchRuns: number },
): string {
  const label = medians.length === 1 ? 'CPU median' : 'CPU medians';
  const list = medians.map((value) => value.toFixed(2)).join(', ');
  const wall = wallMedians.map((value) => value.toFixed(2)).join(', ');
  const batch = counts.batchRuns === 1 ? 'runs' : `batches of ${String(counts.batchRuns)} runs`;
  const how = `${String(counts.samples)} ${batch} after ${String(counts.warmUpRuns)} warm-up, ${String(medians.length)} of ${String(counts.attempts)} attempts`;
  const verdict = withinBudget ? 'within budget' : 'over budget on every attempt';
  return `perf budget: ${spec.what} — limit ${String(spec.limitMs)} ms, ${label} ${list} ms (wall ${wall} ms) (${how}), ${verdict}`;
}
