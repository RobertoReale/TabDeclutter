import { describe, expect, it } from 'vitest';

import type { ScoredTab } from '../../src/core/scoring';
import { DAY } from '../../src/core/time';
import { NO_GROUP_ID, type TabInfo } from '../../src/core/types';
import {
  activeStop,
  nextStop,
  rowStopId,
  sectionStopId,
  stopsOf,
  type OpenSection,
} from '../../src/entrypoints/sidepanel/keyboard';
import type { DeclutterSection, SectionId } from '../../src/entrypoints/sidepanel/sections';

/**
 * The sequence ↑/↓ walk in the Declutter list (PLAN.md §4.8).
 *
 * What is checked here is the arithmetic of the roving tabindex — which places exist, in
 * which order, which one holds the tab stop and where a key moves it. That the browser
 * really follows it with the focus, and that `Enter` does what the stop says, is
 * `tests/e2e/declutter.spec.ts`.
 */

function tab(id: number): TabInfo {
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
  };
}

function scored(tabId: number): ScoredTab {
  return {
    tabId,
    windowId: 1,
    score: 90,
    bucket: 'close',
    primaryReason: 'duplicate',
    reasons: [],
    pageType: 'content',
    idleMs: 3 * DAY,
    multiplier: 1,
  };
}

function section(id: SectionId, tabIds: readonly number[]): DeclutterSection {
  return {
    id,
    rows: tabIds.map((tabId) => ({ tab: tab(tabId), scored: scored(tabId) })),
    collapsed: false,
  };
}

/** A list of sections, every one of them open. */
function open(...sections: readonly DeclutterSection[]): OpenSection[] {
  return sections.map((it) => ({ section: it, open: true }));
}

function ids(sections: readonly OpenSection[]): string[] {
  return stopsOf(sections).map((stop) => stop.id);
}

describe('stopsOf', () => {
  it('walks each section header and then its rows, section after section', () => {
    expect(ids(open(section('duplicates', [1, 2]), section('stale', [3])))).toEqual([
      sectionStopId('duplicates'),
      rowStopId(1),
      rowStopId(2),
      sectionStopId('stale'),
      rowStopId(3),
    ]);
  });

  it('leaves out the rows of a folded section, which are not in the document', () => {
    const sections: OpenSection[] = [
      { section: section('duplicates', [1]), open: true },
      { section: section('review', [2, 3]), open: false },
    ];

    expect(ids(sections)).toEqual([
      sectionStopId('duplicates'),
      rowStopId(1),
      sectionStopId('review'),
    ]);
  });

  it('says of each stop what it is, so Enter knows what to do with it', () => {
    const [header, row] = stopsOf(open(section('duplicates', [7])));

    expect(header?.kind).toBe('section');
    expect(header).toMatchObject({ section: 'duplicates' });
    expect(row?.kind).toBe('row');
    // The whole tab, because "go to the tab" needs its window as well as its id.
    expect(row).toMatchObject({ tab: { id: 7, windowId: 1 } });
  });

  it('has no stops at all for an empty list', () => {
    expect(stopsOf([])).toEqual([]);
  });
});

describe('activeStop', () => {
  const sections = open(section('duplicates', [1, 2]));

  it('is where the user left the keyboard', () => {
    expect(activeStop(stopsOf(sections), rowStopId(2))?.id).toBe(rowStopId(2));
  });

  it('is the top of the list before the user has touched it', () => {
    expect(activeStop(stopsOf(sections), null)?.id).toBe(sectionStopId('duplicates'));
  });

  it('falls back to the top when the stop is gone, so there is always a way in', () => {
    // The tab was closed, or its section folded, while the panel was open.
    expect(activeStop(stopsOf(sections), rowStopId(99))?.id).toBe(sectionStopId('duplicates'));
  });

  it('is nothing when there is nothing to focus', () => {
    expect(activeStop([], rowStopId(1))).toBeNull();
  });
});

describe('nextStop', () => {
  const stops = stopsOf(open(section('duplicates', [1, 2]), section('stale', [3])));

  it('goes down from a row to the next row', () => {
    expect(nextStop(stops, rowStopId(1), 1)?.id).toBe(rowStopId(2));
  });

  it('crosses into the next section: one list, not five', () => {
    expect(nextStop(stops, rowStopId(2), 1)?.id).toBe(sectionStopId('stale'));
    expect(nextStop(stops, sectionStopId('stale'), -1)?.id).toBe(rowStopId(2));
  });

  it('does not wrap at either end', () => {
    expect(nextStop(stops, sectionStopId('duplicates'), -1)).toBeNull();
    expect(nextStop(stops, rowStopId(3), 1)).toBeNull();
  });

  it('starts at the top when it is asked to move from a stop that is gone', () => {
    expect(nextStop(stops, rowStopId(99), 1)?.id).toBe(sectionStopId('duplicates'));
    expect(nextStop(stops, null, -1)?.id).toBe(sectionStopId('duplicates'));
  });

  it('gives nothing back for an empty list', () => {
    expect(nextStop([], null, 1)).toBeNull();
  });
});
