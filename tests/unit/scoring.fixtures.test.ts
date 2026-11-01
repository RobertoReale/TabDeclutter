/**
 * The score against the hand-labelled tabs (TASKS.md M1.6).
 *
 * `tests/fixtures/tabs-300.json` is three hundred tabs a person labelled "suggest" or
 * "keep" before this code existed, which makes it the one check that the rules agree
 * with a careful user and not merely with themselves. Precision on the `close` bucket is
 * what matters: a wrong suggestion costs the user more than a missing one (PLAN.md §3).
 *
 * The thousand-tab fixture is the budget of PLAN.md §11.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { fixturePath } from '../../scripts/generate-fixtures';
import { scoreTabs, type ScoringContext, type ScoringResult } from '../../src/core/scoring';
import {
  DEFAULT_SETTINGS,
  type ActivityStore,
  type Settings,
  type TabInfo,
} from '../../src/core/types';
import type { FixtureLabel, TabsFixture } from '../fixtures/schema';

function load(name: string): TabsFixture {
  return JSON.parse(readFileSync(fixturePath(name), 'utf8')) as TabsFixture;
}

interface Input {
  readonly tabs: readonly TabInfo[];
  readonly activity: ActivityStore;
  readonly settings: Settings;
  readonly now: number;
  readonly context: ScoringContext;
}

/**
 * The fixture as the function takes it. No whitelist, no protected sites, no bookmarks
 * and no keeps: the fixture does not carry any, and the labels were written without them.
 */
function inputOf(fixture: TabsFixture): Input {
  const activity: ActivityStore = {};
  for (const entry of fixture.tabs) activity[entry.activity.tabId] = entry.activity;
  return {
    tabs: fixture.tabs.map((entry) => entry.tab),
    activity,
    settings: { ...DEFAULT_SETTINGS, staleDays: fixture.staleDays },
    now: fixture.now,
    context: { focusedWindowId: fixture.windows.find((window) => window.focused)?.id },
  };
}

function score(input: Input): ScoringResult {
  return scoreTabs(input.tabs, input.activity, input.settings, input.now, input.context);
}

describe('tabs-300, the hand-labelled fixture', () => {
  const fixture = load('tabs-300');
  const input = inputOf(fixture);
  const result = score(input);
  const labels = new Map<number, FixtureLabel | undefined>(
    fixture.tabs.map((entry) => [entry.tab.id, entry.expected]),
  );

  const suggested = result.tabs.filter((entry) => entry.bucket === 'close');
  const agreed = suggested.filter((entry) => labels.get(entry.tabId) === 'suggest');
  const wanted = fixture.tabs.filter((entry) => entry.expected === 'suggest');
  const precision = agreed.length / suggested.length;
  const recall = agreed.length / wanted.length;
  const report = `${agreed.length}/${suggested.length} of the close bucket are labelled suggest`;

  it('is precise on the close bucket (TASKS.md M1.6)', () => {
    expect(precision, report).toBeGreaterThanOrEqual(0.9);
  });

  it('still suggests enough to be useful', () => {
    // A rule set that suggests almost nothing would be precise and worthless; the floor
    // is well under what the score reaches today (docs/DECISIONS.md).
    expect(recall, `recall ${recall.toFixed(3)}`).toBeGreaterThanOrEqual(0.5);
  });

  it('never puts a protected tab on the list', () => {
    const protectedTabs = result.tabs.filter((entry) => entry.protectedBy !== undefined);
    expect(protectedTabs.length).toBeGreaterThan(0);
    for (const entry of protectedTabs) {
      expect(entry.score).toBe(0);
      expect(entry.bucket).toBe('keep');
    }
  });

  it('never suggests a tab the labels say to keep for a reason of its own', () => {
    // The strong rules are the ones a user would call a mistake outright: a tab the
    // label keeps must never be reported as a duplicate or as an abandoned empty tab.
    for (const entry of result.tabs) {
      if (labels.get(entry.tabId) !== 'keep') continue;
      expect(entry.primaryReason, `tab ${entry.tabId}`).not.toBe('duplicate');
      expect(entry.primaryReason, `tab ${entry.tabId}`).not.toBe('blank');
    }
  });

  it('finds the same forgotten windows the fixture declares', () => {
    const forgotten = result.windows
      .filter((window) => window.forgotten)
      .map((window) => window.windowId)
      .sort((a, b) => a - b);
    const declared = fixture.windows
      .filter((window) => window.forgotten)
      .map((window) => window.id)
      .sort((a, b) => a - b);
    expect(declared.length).toBeGreaterThan(0);
    expect(forgotten).toEqual(declared);
  });

  it('covers every window of the fixture, and nothing else', () => {
    expect(result.windows.map((window) => window.windowId).sort((a, b) => a - b)).toEqual(
      fixture.windows.map((window) => window.id).sort((a, b) => a - b),
    );
    const counted = result.windows.reduce((sum, window) => sum + window.tabCount, 0);
    expect(counted).toBe(fixture.tabs.length);
  });

  it('is a function of its arguments and nothing else', () => {
    expect(score(input)).toEqual(result);
  });
});

/**
 * The budget is 15 ms for a thousand tabs (PLAN.md §11), and the honest way to measure
 * it is with coverage off:
 *
 *   npx vitest run tests/unit/scoring.fixtures.test.ts --coverage.enabled=false
 *
 * `vitest.config.ts` leaves coverage on for every normal run, and V8 precise coverage
 * makes this loop about two and a half times slower (10 ms becomes 25 ms), so the gate
 * cannot be held to the user-facing number. What it can do is catch a regression of the
 * kind that matters — a rule that starts parsing a URL again per tab, or a quadratic
 * pass — which is why the assertion here allows for the instrumentation and the measured
 * figures live in docs/DECISIONS.md.
 */
const BUDGET_MS = 15;
const COVERAGE_ALLOWANCE = 3;

describe('the time budget (PLAN.md §11)', () => {
  it('scores a thousand tabs well inside the budget', () => {
    const input = inputOf(load('tabs-1000'));
    expect(input.tabs).toHaveLength(1000);

    // Warm-up first: the first runs pay for the JIT and for every regex in `rules.ts`.
    for (let run = 0; run < 5; run += 1) score(input);

    const samples: number[] = [];
    for (let run = 0; run < 11; run += 1) {
      const started = performance.now();
      score(input);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const median = samples[(samples.length - 1) / 2] ?? Number.POSITIVE_INFINITY;

    expect(median, `median ${median.toFixed(2)} ms of ${samples.length} runs`).toBeLessThanOrEqual(
      BUDGET_MS * COVERAGE_ALLOWANCE,
    );
  });
});
