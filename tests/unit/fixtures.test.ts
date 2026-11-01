/**
 * The fixtures are data, so what there is to test is that they say what they claim to
 * say (`tests/fixtures/schema.ts`) and that `pnpm fixtures` rewrites them byte for byte
 * (TASKS.md M1.5). Without the second half, a regeneration could silently reshuffle
 * three thousand tabs and nobody would notice which labels moved.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  FIXTURE_SPECS,
  fixturePath,
  generateFixture,
  serializeFixture,
} from '../../scripts/generate-fixtures';
import { DAY } from '../../src/core/time';
import { DEFAULT_SETTINGS, NO_GROUP_ID } from '../../src/core/types';
import {
  DAY_MS,
  FIXTURE_STALE_DAYS,
  UNGROUPED,
  validateFixture,
  type TabsFixture,
} from '../fixtures/schema';

function committed(name: string): { text: string; value: unknown } {
  const text = readFileSync(fixturePath(name), 'utf8');
  return { text, value: JSON.parse(text) as unknown };
}

describe('the mirrored constants', () => {
  // `scripts/generate-fixtures.ts` runs under node's type stripping, which cannot
  // resolve `src/core/`'s extensionless imports, so the schema module repeats three
  // values by hand (docs/DECISIONS.md). These are the assertions that keep the copies
  // honest.
  it('still match src/core/', () => {
    expect(UNGROUPED).toBe(NO_GROUP_ID);
    expect(DAY_MS).toBe(DAY);
    expect(FIXTURE_STALE_DAYS).toBe(DEFAULT_SETTINGS.staleDays);
  });
});

describe.each(FIXTURE_SPECS)('$name', (spec) => {
  it('matches the fixture schema', () => {
    expect(
      validateFixture(committed(spec.name).value, { name: spec.name, count: spec.count }),
    ).toEqual([]);
  });

  it('is exactly what the generator produces, byte for byte', () => {
    const generated = serializeFixture(generateFixture(spec));
    const { text, value } = committed(spec.name);
    // Compared as data first: a diff of 300 tabs is unreadable, a diff of one field is not.
    expect(generateFixture(spec)).toEqual(value);
    expect(generated).toBe(text);
  });

  it('is identical on a second run with the same seed', () => {
    expect(serializeFixture(generateFixture(spec))).toBe(serializeFixture(generateFixture(spec)));
  });

  it('labels every tab, or none of them', () => {
    const fixture = committed(spec.name).value as TabsFixture;
    const labelled = fixture.tabs.filter((entry) => entry.expected !== undefined);
    expect(fixture.labelled).toBe(spec.labelled);
    expect(labelled).toHaveLength(spec.labelled ? spec.count : 0);
  });
});

describe('tabs-300, the labelled fixture', () => {
  const fixture = committed('tabs-300').value as TabsFixture;

  it('has both answers well represented, so precision is measurable', () => {
    const suggest = fixture.tabs.filter((entry) => entry.expected === 'suggest');
    const keep = fixture.tabs.filter((entry) => entry.expected === 'keep');
    expect(suggest.length).toBeGreaterThanOrEqual(90);
    expect(keep.length).toBeGreaterThanOrEqual(90);
    expect(suggest.length + keep.length).toBe(fixture.tabs.length);
  });

  it('never asks to close a protected tab (PLAN.md §6.4)', () => {
    const protectedTabs = fixture.tabs.filter(
      (entry) => entry.tab.pinned || entry.tab.audible || entry.tab.active,
    );
    expect(protectedTabs.length).toBeGreaterThan(0);
    expect(protectedTabs.filter((entry) => entry.expected === 'suggest')).toEqual([]);
  });

  it('keeps one tab of every duplicate set and suggests the others', () => {
    // Empty tabs are left out on purpose: several `about:blank` are not a duplicate set,
    // and the guard never closes them anyway (PLAN.md §8.3, `ignoreEmptyTabs`).
    const byUrl = new Map<string, typeof fixture.tabs>();
    for (const entry of fixture.tabs) {
      if (entry.template === 'blank' || entry.tab.url === 'chrome://newtab/') continue;
      const set = byUrl.get(entry.tab.url) ?? [];
      set.push(entry);
      byUrl.set(entry.tab.url, set);
    }
    const sets = [...byUrl.values()].filter((set) => set.length > 1);
    expect(sets.length).toBeGreaterThanOrEqual(2);
    for (const set of sets) {
      expect(set.filter((entry) => entry.expected === 'keep')).toHaveLength(1);
    }
  });

  it('explains every label in a sentence', () => {
    for (const entry of fixture.tabs) {
      expect(entry.rationale ?? '').not.toBe('');
    }
  });
});
