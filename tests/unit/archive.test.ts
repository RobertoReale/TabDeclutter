import { describe, expect, it } from 'vitest';

import {
  ANY_ARCHIVE,
  exportArchive,
  filterArchive,
  originOf,
  pruneArchiveEntries,
  startOfDay,
  sweepActivity,
} from '../../src/core/archive';
import { DAY, HOUR, MINUTE } from '../../src/core/time';
import type { ActivityStore, ArchivedTab, TabActivity } from '../../src/core/types';

/**
 * A fixed clock, local-noon on purpose: "Oggi" is a calendar day in the browser's own
 * time zone, so a boundary test has to be able to step back from midnight without the
 * date itself moving (`archive.ts`, `startOfDay`).
 */
const NOW = new Date(2026, 0, 15, 12, 0, 0).getTime();
const TODAY = new Date(2026, 0, 15, 0, 0, 0).getTime();

function entry(id: string, overrides: Partial<ArchivedTab> = {}): ArchivedTab {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `Page ${id}`,
    closedAt: NOW - HOUR,
    reason: 'manual',
    windowId: 1,
    index: 0,
    ...overrides,
  };
}

function ids(entries: readonly ArchivedTab[]): readonly string[] {
  return entries.map((item) => item.id);
}

function record(tabId: number, overrides: Partial<TabActivity> = {}): TabActivity {
  return {
    tabId,
    url: `https://example.com/${tabId}`,
    createdAt: NOW - 2 * HOUR,
    lastActiveAt: NOW - HOUR,
    activations: 2,
    foregroundMs: 5 * MINUTE,
    ...overrides,
  };
}

describe('where an entry came from', () => {
  it('counts only the guard as automatic', () => {
    expect(originOf('duplicate-auto')).toBe('duplicates');
  });

  it.each(['manual', 'duplicate-manual', 'window'] as const)('counts %s as the user', (reason) => {
    expect(originOf(reason)).toBe('mine');
  });
});

describe('the start of the day', () => {
  it('is the midnight before the moment given', () => {
    expect(startOfDay(NOW)).toBe(TODAY);
  });

  it('is itself at midnight', () => {
    expect(startOfDay(TODAY)).toBe(TODAY);
  });
});

describe('the date filter', () => {
  const entries = [
    entry('now', { closedAt: NOW - MINUTE }),
    entry('midnight', { closedAt: TODAY }),
    entry('yesterday', { closedAt: TODAY - MINUTE }),
    entry('six-days', { closedAt: TODAY - 6 * DAY }),
    entry('seven-days', { closedAt: TODAY - 6 * DAY - MINUTE }),
  ];

  it('shows everything when nothing is asked', () => {
    expect(ids(filterArchive(entries, ANY_ARCHIVE, NOW))).toEqual(ids(entries));
  });

  it('keeps today from its own midnight', () => {
    const shown = filterArchive(entries, { ...ANY_ARCHIVE, when: 'today' }, NOW);
    expect(ids(shown)).toEqual(['now', 'midnight']);
  });

  it('keeps the last seven calendar days, today included', () => {
    const shown = filterArchive(entries, { ...ANY_ARCHIVE, when: 'week' }, NOW);
    expect(ids(shown)).toEqual(['now', 'midnight', 'yesterday', 'six-days']);
  });

  it('is exactly complemented by "older"', () => {
    const week = ids(filterArchive(entries, { ...ANY_ARCHIVE, when: 'week' }, NOW));
    const older = ids(filterArchive(entries, { ...ANY_ARCHIVE, when: 'older' }, NOW));
    expect(older).toEqual(['seven-days']);
    expect([...week, ...older].sort()).toEqual(ids(entries).slice().sort());
  });

  it('answers to the moment it is given, not to the clock', () => {
    const later = NOW + DAY;
    const shown = filterArchive(entries, { ...ANY_ARCHIVE, when: 'today' }, later);
    expect(ids(shown)).toEqual([]);
  });
});

describe('the origin filter', () => {
  const entries = [
    entry('mine', { reason: 'manual' }),
    entry('window', { reason: 'window' }),
    entry('by-hand', { reason: 'duplicate-manual' }),
    entry('guard', { reason: 'duplicate-auto' }),
  ];

  it('keeps what the user closed', () => {
    const shown = filterArchive(entries, { ...ANY_ARCHIVE, origin: 'mine' }, NOW);
    expect(ids(shown)).toEqual(['mine', 'window', 'by-hand']);
  });

  it('keeps what the guard closed', () => {
    const shown = filterArchive(entries, { ...ANY_ARCHIVE, origin: 'duplicates' }, NOW);
    expect(ids(shown)).toEqual(['guard']);
  });
});

describe('the search', () => {
  const entries = [
    entry('a', { title: 'Quarterly Report', url: 'https://docs.example.com/q3' }),
    entry('b', { title: 'Release notes', url: 'https://blog.example.org/report-2026' }),
    entry('c', { title: 'Shopping list', url: 'https://shop.example.net/cart' }),
  ];

  it('matches the title', () => {
    expect(ids(filterArchive(entries, { ...ANY_ARCHIVE, query: 'quarterly' }, NOW))).toEqual(['a']);
  });

  it('matches the URL', () => {
    expect(ids(filterArchive(entries, { ...ANY_ARCHIVE, query: 'blog' }, NOW))).toEqual(['b']);
  });

  it('ignores case', () => {
    expect(ids(filterArchive(entries, { ...ANY_ARCHIVE, query: 'REPORT' }, NOW))).toEqual([
      'a',
      'b',
    ]);
  });

  it('narrows with a second term rather than widening', () => {
    const shown = filterArchive(entries, { ...ANY_ARCHIVE, query: 'report docs' }, NOW);
    expect(ids(shown)).toEqual(['a']);
  });

  it('ignores surrounding whitespace', () => {
    expect(ids(filterArchive(entries, { ...ANY_ARCHIVE, query: '   ' }, NOW))).toEqual(
      ids(entries),
    );
  });

  it('does not match a term spanning the title and the URL', () => {
    const entries = [entry('a', { title: 'end', url: 'https://start.example.com/' })];
    expect(ids(filterArchive(entries, { ...ANY_ARCHIVE, query: 'endhttps' }, NOW))).toEqual([]);
  });

  it('applies with the filters, not instead of them', () => {
    const entries = [
      entry('a', { title: 'Report', reason: 'manual' }),
      entry('b', { title: 'Report', reason: 'duplicate-auto' }),
    ];
    const shown = filterArchive(entries, { query: 'report', when: 'today', origin: 'mine' }, NOW);
    expect(ids(shown)).toEqual(['a']);
  });
});

describe('the Markdown export', () => {
  it('writes one link per entry, in the order shown', () => {
    const entries = [
      entry('a', { title: 'First', url: 'https://example.com/1' }),
      entry('b', { title: 'Second', url: 'https://example.com/2' }),
    ];
    expect(exportArchive(entries)).toBe(
      '- [First](https://example.com/1)\n- [Second](https://example.com/2)',
    );
  });

  it('is empty for nothing', () => {
    expect(exportArchive([])).toBe('');
  });

  it('names an untitled tab by its domain', () => {
    const entries = [entry('a', { title: '   ', url: 'https://www.example.com/path' })];
    expect(exportArchive(entries)).toBe('- [example.com](https://www.example.com/path)');
  });

  it('falls back to the URL when there is no domain either', () => {
    const entries = [entry('a', { title: '', url: 'about:blank' })];
    expect(exportArchive(entries)).toBe('- [about:blank](about:blank)');
  });

  it('escapes the brackets a title could end the link with', () => {
    const entries = [entry('a', { title: 'Buy [now](evil)', url: 'https://example.com/1' })];
    expect(exportArchive(entries)).toBe('- [Buy \\[now\\](evil)](https://example.com/1)');
  });

  it('escapes a backslash so the escape itself cannot be forged', () => {
    const entries = [entry('a', { title: 'a\\[b', url: 'https://example.com/1' })];
    expect(exportArchive(entries)).toBe('- [a\\\\\\[b](https://example.com/1)');
  });

  it('leaves a plain URL alone', () => {
    const entries = [entry('a', { title: 'Plain', url: 'https://example.com/a?b=c#d' })];
    expect(exportArchive(entries)).toBe('- [Plain](https://example.com/a?b=c#d)');
  });

  it('wraps a URL with a parenthesis in angle brackets', () => {
    const entries = [entry('a', { title: 'Wiki', url: 'https://example.com/a_(b)' })];
    expect(exportArchive(entries)).toBe('- [Wiki](<https://example.com/a_(b)>)');
  });

  it('percent-encodes what would end the angle brackets', () => {
    const entries = [entry('a', { title: 'Odd', url: 'https://example.com/a (b)<c>' })];
    expect(exportArchive(entries)).toBe('- [Odd](<https://example.com/a%20(b)%3Cc%3E>)');
  });
});

describe('pruning the archive', () => {
  it('keeps an entry on the retention boundary and drops the one past it', () => {
    const entries = [
      entry('fresh', { closedAt: NOW - 30 * DAY + MINUTE }),
      entry('edge', { closedAt: NOW - 30 * DAY }),
      entry('old', { closedAt: NOW - 30 * DAY - MINUTE }),
    ];
    const pruned = pruneArchiveEntries(entries, { now: NOW, retentionDays: 30 });
    expect(ids(pruned.kept)).toEqual(['fresh']);
    expect(pruned.dropped).toBe(2);
  });

  it('answers to the moment it is given', () => {
    const entries = [entry('a', { closedAt: NOW - HOUR })];
    const pruned = pruneArchiveEntries(entries, { now: NOW + 31 * DAY, retentionDays: 30 });
    expect(pruned.kept).toEqual([]);
    expect(pruned.dropped).toBe(1);
  });

  it('drops everything when retention is zero', () => {
    const entries = [entry('a', { closedAt: NOW - MINUTE })];
    expect(pruneArchiveEntries(entries, { now: NOW, retentionDays: 0 }).dropped).toBe(1);
  });

  it('reads a negative retention as zero rather than as the future', () => {
    const entries = [entry('a', { closedAt: NOW - MINUTE })];
    expect(pruneArchiveEntries(entries, { now: NOW, retentionDays: -5 }).dropped).toBe(1);
  });

  it('keeps the newest up to the cap', () => {
    const entries = [
      entry('c', { closedAt: NOW - 3 * HOUR }),
      entry('a', { closedAt: NOW - HOUR }),
      entry('b', { closedAt: NOW - 2 * HOUR }),
    ];
    const pruned = pruneArchiveEntries(entries, { now: NOW, retentionDays: 30, cap: 2 });
    // Still in the order they were stored, and it is the oldest that went.
    expect(ids(pruned.kept)).toEqual(['a', 'b']);
    expect(pruned.dropped).toBe(1);
  });

  it('breaks a tie on the cap by the stored order', () => {
    const entries = [
      entry('first', { closedAt: NOW - HOUR }),
      entry('second', { closedAt: NOW - HOUR }),
    ];
    const pruned = pruneArchiveEntries(entries, { now: NOW, retentionDays: 30, cap: 1 });
    expect(ids(pruned.kept)).toEqual(['first']);
  });

  it('applies retention before the cap', () => {
    const entries = [
      entry('fresh', { closedAt: NOW - HOUR }),
      entry('stale', { closedAt: NOW - 40 * DAY }),
    ];
    const pruned = pruneArchiveEntries(entries, { now: NOW, retentionDays: 30, cap: 1 });
    expect(ids(pruned.kept)).toEqual(['fresh']);
    expect(pruned.dropped).toBe(1);
  });

  it('empties the archive at a cap of zero', () => {
    const entries = [entry('a')];
    expect(pruneArchiveEntries(entries, { now: NOW, retentionDays: 30, cap: 0 }).kept).toEqual([]);
  });

  it('reads a negative cap as zero', () => {
    const entries = [entry('a')];
    expect(pruneArchiveEntries(entries, { now: NOW, retentionDays: 30, cap: -1 }).kept).toEqual([]);
  });

  it('defaults to the product cap and drops nothing under it', () => {
    const entries = [entry('a'), entry('b')];
    const pruned = pruneArchiveEntries(entries, { now: NOW, retentionDays: 30 });
    expect(ids(pruned.kept)).toEqual(['a', 'b']);
    expect(pruned.dropped).toBe(0);
  });

  it('has nothing to do on an empty archive', () => {
    expect(pruneArchiveEntries([], { now: NOW, retentionDays: 30 })).toEqual({
      kept: [],
      dropped: 0,
    });
  });
});

describe('sweeping the activity records', () => {
  it('keeps a record whose tab is open', () => {
    const saved: ActivityStore = { 1: record(1), 2: record(2) };
    const swept = sweepActivity(saved, [1, 2]);
    expect(Object.keys(swept.kept)).toEqual(['1', '2']);
    expect(swept.dropped).toBe(0);
  });

  it('drops a record left behind by a tab that is gone', () => {
    const saved: ActivityStore = { 1: record(1), 7: record(7) };
    const swept = sweepActivity(saved, [1]);
    expect(Object.keys(swept.kept)).toEqual(['1']);
    expect(swept.dropped).toBe(1);
  });

  it('drops anything that is not a record, even for an open tab', () => {
    const saved = { 1: record(1), 2: 'not a record' } as unknown as ActivityStore;
    const swept = sweepActivity(saved, [1, 2]);
    expect(Object.keys(swept.kept)).toEqual(['1']);
    expect(swept.dropped).toBe(1);
  });

  it('drops a key that is not a tab id at all', () => {
    const saved = { settings: record(1) } as unknown as ActivityStore;
    const swept = sweepActivity(saved, [1]);
    expect(swept.kept).toEqual({});
    expect(swept.dropped).toBe(1);
  });

  it('empties the store when no tab is open', () => {
    const saved: ActivityStore = { 1: record(1) };
    expect(sweepActivity(saved, []).kept).toEqual({});
  });

  it('has nothing to do on an empty store', () => {
    expect(sweepActivity({}, [1])).toEqual({ kept: {}, dropped: 0 });
  });
});
