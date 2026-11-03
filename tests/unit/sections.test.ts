import { describe, expect, it } from 'vitest';

import type { Bucket, PrimaryReason, ScoredTab, ScoredWindow } from '../../src/core/scoring';
import { scoreTabs } from '../../src/core/scoring';
import { DAY, HOUR } from '../../src/core/time';
import {
  DEFAULT_SETTINGS,
  NO_GROUP_ID,
  type ActivityStore,
  type TabInfo,
} from '../../src/core/types';
import { EMPTY_LIST, toSections, type SectionId } from '../../src/entrypoints/sidepanel/sections';

/**
 * The list Declutter draws, from the scores (PLAN.md §4.3).
 *
 * The scores are written out rather than computed: a row here says "a duplicate at 95"
 * and the sections are checked against that, so a change to a weight in
 * `scoring.config.ts` cannot quietly change what this file is asserting. One test at the
 * end goes through the real `scoreTabs`, so the two cannot drift apart either.
 */

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

/** A score, said in the two terms the list reads: the headline reason and the bucket. */
function score(
  tabId: number,
  primaryReason: PrimaryReason,
  value: number,
  bucket: Bucket = value >= 70 ? 'close' : 'review',
): ScoredTab {
  return {
    tabId,
    windowId: 1,
    score: value,
    bucket,
    primaryReason,
    reasons: [],
    pageType: 'content',
    idleMs: 3 * DAY,
    multiplier: 1,
  };
}

function window(overrides: Partial<ScoredWindow> = {}): ScoredWindow {
  return {
    windowId: 1,
    tabCount: 12,
    closeCount: 4,
    idleMs: 21 * DAY,
    forgotten: true,
    ...overrides,
  };
}

/** The sections, by id, which is what most of these tests are about. */
function ids(tabs: readonly ScoredTab[], windows: readonly ScoredWindow[] = []): SectionId[] {
  const list = toSections(
    tabs.map((scored) => tab(scored.tabId)),
    { tabs, windows },
  );
  return list.sections.map((section) => section.id);
}

describe('toSections: which sections appear', () => {
  it('puts every headline reason in its own section, in the order of §4.3', () => {
    expect(
      ids([
        score(1, 'review', 50),
        score(2, 'stale', 72),
        score(3, 'stale-unread', 75),
        score(4, 'transient', 80),
        score(5, 'duplicate', 95),
      ]),
    ).toEqual(['duplicates', 'transient', 'stale-unread', 'stale', 'review']);
  });

  it('leaves out a section with no rows, rather than drawing an empty heading', () => {
    expect(ids([score(1, 'duplicate', 95), score(2, 'review', 50)])).toEqual([
      'duplicates',
      'review',
    ]);
  });

  it('counts a blank tab as a temporary page: §4.3 has five sections, not six', () => {
    expect(ids([score(1, 'blank', 90)])).toEqual(['transient']);
  });

  it('gives nothing back for no tabs at all', () => {
    expect(toSections([], { tabs: [], windows: [] })).toEqual(EMPTY_LIST);
  });
});

describe('toSections: which rows appear', () => {
  it('lists everything the score did not put in keep, and counts them', () => {
    const list = toSections([tab(1), tab(2), tab(3)], {
      tabs: [score(1, 'duplicate', 95), score(2, 'review', 40), score(3, 'stale', 30, 'keep')],
      windows: [],
    });

    expect(list.total).toBe(2);
    expect(list.sections.flatMap((section) => section.rows.map((row) => row.tab.id))).toEqual([
      1, 2,
    ]);
  });

  it('never lists a protected tab, which is not on the list at all', () => {
    // A protection sets the bucket to keep as well; neither reason alone may let it in.
    expect(ids([score(1, 'protected', 0, 'keep'), score(2, 'protected', 80, 'close')])).toEqual([]);
  });

  it('drops a score whose tab is gone, rather than inventing a row for it', () => {
    const list = toSections([tab(1)], {
      tabs: [score(1, 'duplicate', 95), score(99, 'duplicate', 95)],
      windows: [],
    });
    expect(list.total).toBe(1);
    expect(list.sections[0]?.rows.map((row) => row.tab.id)).toEqual([1]);
  });

  it('carries the tab and its score together, so a row can explain itself', () => {
    const scored = score(1, 'duplicate', 95);
    const list = toSections([tab(1, { title: 'Page one' })], { tabs: [scored], windows: [] });

    expect(list.sections[0]?.rows[0]?.tab.title).toBe('Page one');
    expect(list.sections[0]?.rows[0]?.scored).toBe(scored);
  });
});

describe('toSections: the order inside a section', () => {
  it('puts the highest score first', () => {
    const list = toSections([tab(1), tab(2), tab(3)], {
      tabs: [score(1, 'stale', 60), score(2, 'stale', 80), score(3, 'stale', 70)],
      windows: [],
    });
    expect(list.sections[0]?.rows.map((row) => row.tab.id)).toEqual([2, 3, 1]);
  });

  it("breaks a tie with the browser's own order, so the list does not shuffle", () => {
    const tabs = [tab(7), tab(3), tab(5)];
    const list = toSections(tabs, {
      tabs: [score(5, 'stale', 60), score(7, 'stale', 60), score(3, 'stale', 60)],
      windows: [],
    });
    // The order of `tabs`, which is the order of the tab strip — not of the scores.
    expect(list.sections[0]?.rows.map((row) => row.tab.id)).toEqual([7, 3, 5]);
  });
});

describe('toSections: which sections start folded', () => {
  function collapsed(tabs: readonly ScoredTab[]): readonly boolean[] {
    const list = toSections(
      tabs.map((scored) => tab(scored.tabId)),
      { tabs, windows: [] },
    );
    return list.sections.map((section) => section.collapsed);
  }

  it('opens a section the score is sure about, and folds "Da valutare"', () => {
    expect(collapsed([score(1, 'duplicate', 95), score(2, 'review', 50)])).toEqual([false, true]);
  });

  it('folds a section whose rows are all only worth a look', () => {
    expect(collapsed([score(1, 'stale', 55), score(2, 'stale', 45)])).toEqual([true]);
  });

  it('opens it as soon as one of its rows is to close', () => {
    expect(collapsed([score(1, 'stale', 55), score(2, 'stale', 80)])).toEqual([false]);
  });
});

describe('toSections: the forgotten windows', () => {
  it('offers a window every tab of which has gone cold', () => {
    const list = toSections([tab(1)], {
      tabs: [score(1, 'stale', 80)],
      windows: [window({ windowId: 4, tabCount: 12, idleMs: 21 * DAY })],
    });
    expect(list.windows).toEqual([{ windowId: 4, tabCount: 12, idleMs: 21 * DAY }]);
  });

  it('says nothing about a window still in use', () => {
    const list = toSections([tab(1)], {
      tabs: [score(1, 'stale', 80)],
      windows: [window({ forgotten: false, idleMs: 2 * HOUR })],
    });
    expect(list.windows).toEqual([]);
  });

  /* PLAN.md §3: a suggestion the user has to refuse is the one that costs most. */
  it('says nothing about a forgotten window holding nothing to close', () => {
    const list = toSections([tab(1)], {
      tabs: [score(1, 'review', 50)],
      windows: [window({ closeCount: 0 })],
    });
    expect(list.windows).toEqual([]);
  });
});

describe('toSections over the real scoreTabs', () => {
  const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

  it('turns a plausible window into the sections the user would expect', () => {
    const tabs: readonly TabInfo[] = [
      tab(1, { active: true, url: 'https://example.com/reading' }),
      tab(2, { url: 'https://example.com/same' }),
      tab(3, { url: 'https://example.com/same' }),
      tab(4, { url: 'https://www.google.com/search?q=chiudere+le+schede' }),
      tab(5, { url: 'about:blank', title: '' }),
      tab(6, { url: 'https://example.com/old' }),
    ];
    const activity: ActivityStore = {};
    for (const entry of tabs) {
      activity[entry.id] = {
        tabId: entry.id,
        url: entry.url,
        createdAt: NOW - 30 * DAY,
        lastActiveAt: NOW - 12 * DAY,
        activations: 0,
        foregroundMs: 0,
      };
    }

    const list = toSections(tabs, scoreTabs(tabs, activity, DEFAULT_SETTINGS, NOW));

    expect(list.sections.map((section) => section.id)).toEqual([
      'duplicates',
      'transient',
      'stale-unread',
    ]);
    // Every tab but the active one, which step 1 protects.
    expect(list.total).toBe(tabs.length - 1);
    // Each section holds something the score is sure about, so none of them is folded.
    expect(list.sections.map((section) => section.collapsed)).toEqual([false, false, false]);
    expect(list.windows).toEqual([{ windowId: 1, tabCount: 6, idleMs: 12 * DAY }]);
  });
});
