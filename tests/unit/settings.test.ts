/**
 * Every setting of PLAN.md §4.6 that changes what the core decides, changed (TASKS.md M6.1).
 *
 * `scoring.test.ts` tests the rules; this file tests the *settings*: that the value the page
 * writes is the value the core reads, in both directions. One `it` per setting, so a row that
 * stops mattering is a named failure and not a number that quietly no longer moves.
 *
 * Two of the settings on that page are not the core's: "mostra il badge" belongs to the
 * background (`tests/ext/badge.test.ts`) and "AI on-device" to `platform/llm.ts`
 * (`tests/unit/llm.test.ts`, `tests/ext/ai-state.test.ts`). The language is `i18n.test.ts`'s.
 */

import { describe, expect, it } from 'vitest';

import { pruneArchiveEntries } from '../../src/core/archive';
import { duplicateOptions, findDuplicateSets } from '../../src/core/duplicates';
import { keepKey, scoreTabs, type ScoredTab, type ScoringContext } from '../../src/core/scoring';
import { DEFAULT_SCORING_CONFIG as CONFIG } from '../../src/core/scoring.config';
import { DAY, HOUR, MINUTE } from '../../src/core/time';
import {
  DEFAULT_SETTINGS,
  NO_GROUP_ID,
  type ActivityStore,
  type ArchivedTab,
  type Settings,
  type TabInfo,
} from '../../src/core/types';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

function tab(id: number, overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id,
    windowId: 1,
    index: id,
    url: `https://example.com/page/${id}`,
    title: `Page ${id}`,
    pinned: false,
    audible: false,
    active: false,
    discarded: false,
    hidden: false,
    groupId: NO_GROUP_ID,
    incognito: false,
    ...overrides,
  };
}

/** One tab, used three days ago and opened a month ago: past every default grace. */
function score(
  one: TabInfo,
  settings: Partial<Settings> = {},
  context: ScoringContext = {},
  when: { readonly idleMs?: number; readonly ageMs?: number } = {},
): ScoredTab {
  const idleMs = when.idleMs ?? 3 * DAY;
  const activity: ActivityStore = {
    [one.id]: {
      tabId: one.id,
      url: one.url,
      createdAt: NOW - Math.max(when.ageMs ?? 30 * DAY, idleMs),
      lastActiveAt: NOW - idleMs,
      activations: 12,
      foregroundMs: 5 * MINUTE,
    },
  };
  const result = scoreTabs([one], activity, { ...DEFAULT_SETTINGS, ...settings }, NOW, context);
  const found = result.tabs.find((entry) => entry.tabId === one.id);
  if (found === undefined) throw new Error(`tab ${one.id} was not scored`);
  return found;
}

/** The points the inactivity curve of §6.4 gave, which is the "stale" reason's. */
function staleness(entry: ScoredTab): number {
  return entry.reasons.find((reason) => reason.code === 'stale')?.points ?? 0;
}

describe('the settings of §4.6 that change the core', () => {
  it('staleDays: a shorter threshold makes the same idle time count for more', () => {
    // The curve of §6.4 is `log(1 + idleH / 24) / log(1 + staleDays)`, so three idle days are
    // most of a three-day threshold and little of a thirty-day one.
    const impatient = staleness(score(tab(1), { staleDays: 3 }));
    const patient = staleness(score(tab(1), { staleDays: 30 }));

    expect(impatient).toBeGreaterThan(patient);
    expect(patient).toBeGreaterThan(0);
  });

  it('staleDays: it decides the verdict, which is what the user sees change', () => {
    // The same three idle days: the whole of a one-day threshold, a fraction of a
    // thirty-day one, and that moves the tab between two buckets of §6.4.
    expect(score(tab(1), { staleDays: 1 }).bucket).toBe('review');
    expect(score(tab(1), { staleDays: 30 }).bucket).toBe('keep');
  });

  it('graceMs: a tab younger than the grace period is protected, and only then', () => {
    const when = { idleMs: 2 * HOUR, ageMs: 2 * HOUR };

    expect(score(tab(1), { graceMs: 8 * HOUR }, {}, when).protectedBy).toBe('grace');
    expect(score(tab(1), { graceMs: 30 * MINUTE }, {}, when).protectedBy).toBeUndefined();
  });

  it('includeGroupedTabs: off protects a grouped tab, on only reduces its score', () => {
    const grouped = tab(1, { groupId: 7 });

    expect(score(grouped, { includeGroupedTabs: false }).protectedBy).toBe('grouped');

    const included = score(grouped, { includeGroupedTabs: true });
    expect(included.protectedBy).toBeUndefined();
    expect(included.multiplier).toBe(CONFIG.groupedMultiplier);
  });

  it('useBookmarks: the +10 is the caller passing the bookmarks, which the setting decides', () => {
    // `state/tabs.ts` passes `bookmarkedUrls` only while the setting is on, so the core sees
    // the setting as the presence of the set (`tests/ext/panel-state.test.ts` tests the wiring).
    const bookmarked: ScoringContext = { bookmarkedUrls: new Set([keepKey(tab(1).url)]) };

    expect(score(tab(1), {}, bookmarked).score).toBe(score(tab(1)).score + CONFIG.bookmarkedPoints);
  });

  it('match.ignoreHash: two URLs that differ only by the fragment', () => {
    const tabs = [
      tab(1, { url: 'https://example.com/doc#intro' }),
      tab(2, { url: 'https://example.com/doc#appendix' }),
    ];
    const settings = (ignoreHash: boolean): Settings => ({
      ...DEFAULT_SETTINGS,
      match: { ...DEFAULT_SETTINGS.match, ignoreHash },
    });

    const nothingWhitelisted = (): boolean => false;

    expect(
      findDuplicateSets(tabs, duplicateOptions(settings(true)), nothingWhitelisted),
    ).toHaveLength(1);
    expect(
      findDuplicateSets(tabs, duplicateOptions(settings(false)), nothingWhitelisted),
    ).toHaveLength(0);
  });

  it('archiveRetentionDays: an entry older than the retention is dropped', () => {
    const entries: readonly ArchivedTab[] = [
      archived('fresh', NOW - 3 * DAY),
      archived('old', NOW - 20 * DAY),
    ];

    expect(pruneArchiveEntries(entries, { now: NOW, retentionDays: 30 }).kept).toHaveLength(2);

    const pruned = pruneArchiveEntries(entries, { now: NOW, retentionDays: 7 });
    expect(pruned.dropped).toBe(1);
    expect(pruned.kept.map((entry) => entry.id)).toEqual(['fresh']);
  });
});

function archived(id: string, closedAt: number): ArchivedTab {
  return {
    id,
    url: `https://example.com/${id}`,
    title: id,
    closedAt,
    reason: 'manual',
    windowId: 1,
    index: 0,
  };
}
