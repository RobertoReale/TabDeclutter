/**
 * The score against the hand-labelled tabs (TASKS.md M1.6).
 *
 * `tests/fixtures/tabs-300.json` is three hundred tabs a person labelled "suggest" or
 * "keep" before this code existed, which makes it the one check that the rules agree
 * with a careful user and not merely with themselves. Precision on the `close` bucket is
 * what matters: a wrong suggestion costs the user more than a missing one (PLAN.md §3).
 *
 * The time budget of PLAN.md §11 is measured in `tests/perf/`, not here: a wall-clock
 * number means nothing in a run that is instrumented for coverage and spread over
 * parallel workers (docs/DECISIONS.md, M1.8).
 */

import { describe, expect, it } from 'vitest';

import { inputOf, loadFixture, score } from '../fixtures/scoring-input';
import type { FixtureLabel } from '../fixtures/schema';

describe('tabs-300, the hand-labelled fixture', () => {
  const fixture = loadFixture('tabs-300');
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
