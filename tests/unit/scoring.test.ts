/**
 * Every rule of the score, one at a time, and the three properties it promises
 * (PLAN.md §6.4, TASKS.md M1.6).
 *
 * The rules are tested by situation and not by arithmetic: a row says what the tab is
 * like and what the score should make of it. The numbers come from
 * `scoring.config.ts`, so tuning a weight does not have to be typed in twice — except
 * where a test is *about* the arithmetic (the inactivity curve, the cap, the buckets),
 * and then the expected value is written out.
 */

import { describe, expect, it } from 'vitest';

import { findDuplicateSets, duplicateOptions } from '../../src/core/duplicates';
import {
  keepKey,
  scoreTabs,
  type ReasonCode,
  type ScoredTab,
  type ScoringContext,
  type ScoringResult,
} from '../../src/core/scoring';
import { DEFAULT_SCORING_CONFIG as CONFIG } from '../../src/core/scoring.config';
import { DAY, HOUR, MINUTE } from '../../src/core/time';
import {
  DEFAULT_SETTINGS,
  NO_GROUP_ID,
  type ActivityStore,
  type Settings,
  type TabActivity,
  type TabInfo,
} from '../../src/core/types';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** A plain content tab in the one window, with nothing remarkable about it. */
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

/**
 * What the tracker knows about a tab, said in the terms the rules use. The defaults are
 * "old enough that the grace period is over, used three hours ago, read properly", so a
 * row only has to name what it is actually about.
 */
interface Situation {
  readonly idleMs?: number;
  readonly ageMs?: number;
  readonly activations?: number;
  readonly foregroundMs?: number;
  readonly bootstrappedAt?: number;
}

function activityOf(tab: TabInfo, situation: Situation = {}): TabActivity {
  const idleMs = situation.idleMs ?? 3 * HOUR;
  const ageMs = Math.max(situation.ageMs ?? 30 * DAY, idleMs);
  return {
    tabId: tab.id,
    url: tab.url,
    createdAt: NOW - ageMs,
    lastActiveAt: NOW - idleMs,
    activations: situation.activations ?? 12,
    foregroundMs: situation.foregroundMs ?? 5 * MINUTE,
    ...(situation.bootstrappedAt === undefined ? {} : { bootstrappedAt: situation.bootstrappedAt }),
  };
}

interface Entry {
  readonly tab: TabInfo;
  readonly at?: Situation;
}

interface Options {
  readonly settings?: Partial<Settings>;
  readonly context?: ScoringContext;
  readonly now?: number;
  /** Tabs whose activity the tracker never recorded. */
  readonly untracked?: readonly number[];
}

function run(entries: readonly Entry[], options: Options = {}): ScoringResult {
  const tabs = entries.map((entry) => entry.tab);
  const activity: ActivityStore = {};
  for (const entry of entries) {
    if (options.untracked?.includes(entry.tab.id) === true) continue;
    activity[entry.tab.id] = activityOf(entry.tab, entry.at);
  }
  const settings: Settings = { ...DEFAULT_SETTINGS, ...options.settings };
  return scoreTabs(tabs, activity, settings, options.now ?? NOW, options.context);
}

function scored(result: ScoringResult, id: number): ScoredTab {
  const found = result.tabs.find((entry) => entry.tabId === id);
  if (found === undefined) throw new Error(`tab ${id} was not scored`);
  return found;
}

/** One tab on its own, which is what most rows need. */
function only(entry: Entry, options: Options = {}): ScoredTab {
  return scored(run([entry], options), entry.tab.id);
}

function points(entry: ScoredTab, code: ReasonCode): number {
  return entry.reasons.find((reason) => reason.code === code)?.points ?? 0;
}

function codes(entry: ScoredTab): readonly ReasonCode[] {
  return entry.reasons.map((reason) => reason.code);
}

const SEARCH_URL = 'https://www.google.com/search?q=come+chiudere+le+schede';
const AUTH_URL = 'https://accounts.google.com/signin/v2/identifier';
const INTERNAL_URL = 'chrome://settings/privacy';
const BLANK_URL = 'about:blank';
const ERROR_TITLE = '404 Not Found';

describe('step 1, the protections', () => {
  const protections: readonly [string, Entry, Options, string][] = [
    ['a hidden tab', { tab: tab(1, { hidden: true }) }, {}, 'hidden'],
    ['a pinned tab', { tab: tab(1, { pinned: true }) }, {}, 'pinned'],
    ['a tab playing audio', { tab: tab(1, { audible: true }) }, {}, 'audible'],
    ['the tab in front', { tab: tab(1, { active: true }) }, {}, 'active'],
    [
      "one of the extension's own pages",
      { tab: tab(1, { url: 'chrome-extension://abcdef/panel.html' }) },
      { context: { ownOrigin: 'chrome-extension://abcdef/' } },
      'own-page',
    ],
    [
      'a protected site',
      { tab: tab(1, { url: 'https://mail.google.com/mail/u/0/#inbox' }) },
      { context: { protectedSites: ['mail.google.com'] } },
      'protected-site',
    ],
    [
      'a subdomain of a protected site, written with a wildcard',
      { tab: tab(1, { url: 'https://team.atlassian.net/jira/board' }) },
      { context: { protectedSites: ['*.atlassian.net'] } },
      'protected-site',
    ],
    [
      'a tab the user asked to keep for ever',
      { tab: tab(1) },
      { context: { keeps: { [keepKey('https://example.com/page/1')]: null } } },
      'kept',
    ],
    [
      'a tab the user asked to keep until tomorrow',
      { tab: tab(1) },
      { context: { keeps: { [keepKey('https://example.com/page/1')]: NOW + DAY } } },
      'kept',
    ],
    ['a tab opened an hour ago', { tab: tab(1), at: { ageMs: HOUR, idleMs: HOUR } }, {}, 'grace'],
    [
      'a tab that was already open when the extension arrived',
      { tab: tab(1), at: { idleMs: 20 * DAY, bootstrappedAt: NOW - 2 * HOUR } },
      {},
      'bootstrap',
    ],
    [
      'a grouped tab, when the user excluded groups',
      { tab: tab(1, { groupId: 7 }), at: { idleMs: 20 * DAY } },
      { settings: { includeGroupedTabs: false } },
      'grouped',
    ],
    [
      'a tab nothing is known about',
      { tab: tab(1) },
      { untracked: [1] },
      // No record and no `lastAccessed`: read as "just opened", so the grace period holds.
      'grace',
    ],
  ];

  it.each(protections)('protects %s', (_name, entry, options, protectedBy) => {
    const result = only(entry, options);
    expect(result.protectedBy).toBe(protectedBy);
    expect(result.score).toBe(0);
    expect(result.bucket).toBe('keep');
    expect(result.primaryReason).toBe('protected');
    expect(result.reasons).toEqual([]);
  });

  it('wins over every rule below it', () => {
    // A pinned tab that is also a stale duplicate of a search page.
    const result = run([
      { tab: tab(1, { url: SEARCH_URL, pinned: true }), at: { idleMs: 90 * DAY } },
      { tab: tab(2, { url: SEARCH_URL }), at: { idleMs: 90 * DAY } },
    ]);
    expect(scored(result, 1).score).toBe(0);
    expect(scored(result, 2).score).toBe(CONFIG.duplicatePoints);
  });

  it('lets an expired keep go', () => {
    const result = only(
      { tab: tab(1), at: { idleMs: 20 * DAY } },
      { context: { keeps: { [keepKey('https://example.com/page/1')]: NOW - MINUTE } } },
    );
    expect(result.protectedBy).toBeUndefined();
    expect(result.score).toBeGreaterThan(0);
  });

  const notProtectedSites: readonly [string, string, readonly string[]][] = [
    [
      'a host that merely ends with the same letters',
      'https://notatlassian.net/x',
      ['atlassian.net'],
    ],
    ['a URL with no host at all', 'file:///C:/Users/Roberto/report.pdf', ['atlassian.net']],
    ['an empty pattern', 'https://example.com/page/1', ['   ']],
    ['a bare wildcard', 'https://example.com/page/1', ['*.']],
    // Defensive: a tab caught mid-navigation can report something that is not a URL.
    ['a URL that does not parse', 'not a url', ['atlassian.net']],
  ];

  it.each(notProtectedSites)(
    'does not take %s for a protected site',
    (_name, url, protectedSites) => {
      const result = only(
        { tab: tab(1, { url }), at: { idleMs: 20 * DAY } },
        { context: { protectedSites } },
      );
      expect(result.protectedBy).toBeUndefined();
    },
  );

  it('reads the last use the browser reports when the tracker has nothing newer', () => {
    // PLAN.md §6.1: the record says ten days, the browser says one hour. The tab is in use.
    const result = only({
      tab: tab(1, { lastAccessed: NOW - HOUR }),
      at: { idleMs: 10 * DAY },
    });
    expect(result.idleMs).toBe(HOUR);
    expect(result.bucket).toBe('keep');
  });
});

describe('step 2, the strong rules', () => {
  const twins: readonly Entry[] = [
    { tab: tab(1, { url: 'https://example.com/a' }), at: { ageMs: 10 * DAY } },
    { tab: tab(2, { url: 'https://example.com/a' }), at: { ageMs: 2 * DAY } },
  ];

  it('suggests every duplicate but the one that is kept', () => {
    const result = run(twins);
    const keeper = scored(result, 1);
    const extra = scored(result, 2);

    expect(keeper.reasons.map((reason) => reason.code)).not.toContain('duplicate');
    expect(extra.score).toBe(CONFIG.duplicatePoints);
    expect(extra.bucket).toBe('close');
    expect(extra.primaryReason).toBe('duplicate');
    expect(extra.reasons).toEqual([
      { code: 'duplicate', points: CONFIG.duplicatePoints, keptTabId: 1 },
    ]);
  });

  it('keeps a duplicate at its full score inside a group', () => {
    const result = run(twins.map((entry) => ({ ...entry, tab: { ...entry.tab, groupId: 7 } })));
    expect(scored(result, 2).score).toBe(CONFIG.duplicatePoints);
    expect(scored(result, 2).multiplier).toBe(1);
  });

  it('never reports a whitelisted URL as a duplicate', () => {
    const result = run(twins, {
      context: { isWhitelisted: (url) => url === 'https://example.com/a' },
    });
    for (const id of [1, 2]) {
      expect(codes(scored(result, id))).not.toContain('duplicate');
      expect(codes(scored(result, id))).not.toContain('near-duplicate');
    }
  });

  it('takes the duplicate sets the caller already computed (invariant 9)', () => {
    const tabs = twins.map((entry) => entry.tab);
    const duplicates = findDuplicateSets(tabs, duplicateOptions(DEFAULT_SETTINGS), () => false);
    const result = run(twins, { context: { duplicates } });
    expect(scored(result, 2).score).toBe(CONFIG.duplicatePoints);
  });

  it('takes the caller at their word, even for a set with nothing in it', () => {
    // The sets the caller passes are the whole truth, so these twins are not duplicates
    // here; a set with no tab in it has no keeper and is simply skipped.
    const result = run(twins, { context: { duplicates: [{ key: 'example.com/a', tabs: [] }] } });
    for (const id of [1, 2]) {
      expect(codes(scored(result, id))).not.toContain('duplicate');
    }
  });

  it('does not call several empty tabs duplicates of one another', () => {
    const result = run([
      { tab: tab(1, { url: BLANK_URL }), at: { idleMs: 5 * HOUR } },
      { tab: tab(2, { url: BLANK_URL }), at: { idleMs: 5 * HOUR } },
      { tab: tab(3, { url: 'about:newtab' }), at: { idleMs: 5 * HOUR } },
    ]);
    for (const id of [1, 2, 3]) {
      expect(codes(scored(result, id))).toEqual(['blank']);
      expect(scored(result, id).score).toBe(CONFIG.blankPoints);
      expect(scored(result, id).primaryReason).toBe('blank');
    }
  });

  const blanks: readonly [string, number, boolean][] = [
    ['an empty tab opened minutes ago', 30 * MINUTE, false],
    ['an empty tab nobody came back to', 5 * HOUR, true],
  ];

  it.each(blanks)('%s', (_name, idleMs, suggested) => {
    const result = only({ tab: tab(1, { url: BLANK_URL }), at: { idleMs, ageMs: 20 * DAY } });
    expect(codes(result).includes('blank')).toBe(suggested);
    if (suggested) expect(result.score).toBe(CONFIG.blankPoints);
    else expect(result.bucket).toBe('keep');
  });

  it('does not add inactivity on top of a strong rule', () => {
    const result = only({ tab: tab(1, { url: BLANK_URL }), at: { idleMs: 400 * DAY } });
    expect(result.score).toBe(CONFIG.blankPoints);
    expect(result.reasons).toEqual([{ code: 'blank', points: CONFIG.blankPoints }]);
  });
});

describe('step 3, the additions', () => {
  // The curve of PLAN.md §6.4 with the default staleDays of 7: nothing on a tab just
  // used, the full weight once it is as old as "stale", and never more.
  const curve: readonly [number, number][] = [
    [0, 0],
    [DAY, 18],
    [3 * DAY, 37],
    [7 * DAY, 55],
    [30 * DAY, 55],
  ];

  it.each(curve)('scores %i ms of inactivity as %i points', (idleMs, expected) => {
    expect(points(only({ tab: tab(1), at: { idleMs } }), 'stale')).toBe(expected);
  });

  it('stretches the curve when the user raises staleDays', () => {
    const result = only({ tab: tab(1), at: { idleMs: 7 * DAY } }, { settings: { staleDays: 30 } });
    expect(points(result, 'stale')).toBe(33);
  });

  it('survives a staleDays of zero', () => {
    const result = only({ tab: tab(1), at: { idleMs: DAY } }, { settings: { staleDays: 0 } });
    expect(points(result, 'stale')).toBe(CONFIG.inactivityPoints);
  });

  it('says how long the tab has been idle, and lets the UI word it', () => {
    const result = only({ tab: tab(1), at: { idleMs: 12 * DAY } });
    expect(result.reasons).toContainEqual({
      code: 'stale',
      points: CONFIG.inactivityPoints,
      idleMs: 12 * DAY,
    });
  });

  const transients: readonly [string, Partial<TabInfo>, number, ReasonCode | undefined][] = [
    ['a search page left behind', { url: SEARCH_URL }, 5 * HOUR, 'search'],
    ['a search page opened minutes ago', { url: SEARCH_URL }, 20 * MINUTE, undefined],
    ['a sign-in page left behind', { url: AUTH_URL }, 5 * HOUR, 'auth'],
    ['a browser page left behind', { url: INTERNAL_URL }, 5 * HOUR, 'browser-internal'],
    ['a sign-in page opened minutes ago', { url: AUTH_URL }, 20 * MINUTE, undefined],
    ['an error page left behind', { title: ERROR_TITLE }, 5 * HOUR, 'error'],
  ];

  it.each(transients)('scores %s', (_name, overrides, idleMs, code) => {
    const result = only({ tab: tab(1, overrides), at: { idleMs } });
    if (code === undefined) {
      expect(codes(result)).not.toContain('search');
      expect(codes(result)).not.toContain('auth');
      expect(codes(result)).not.toContain('browser-internal');
      expect(codes(result)).not.toContain('error');
      return;
    }
    expect(points(result, code)).toBe(
      code === 'error' ? CONFIG.errorPoints : CONFIG.transientPoints,
    );
  });

  const headlines: readonly [string, Partial<TabInfo>, Situation, string][] = [
    ['a consulted search page', { url: SEARCH_URL }, { idleMs: 5 * HOUR }, 'transient'],
    ['a sign-in page', { url: AUTH_URL }, { idleMs: 5 * HOUR }, 'transient'],
    [
      'an error page, which is never the headline',
      { title: ERROR_TITLE },
      { idleMs: 5 * HOUR },
      'stale',
    ],
    [
      'an old page nobody read',
      {},
      { idleMs: 9 * DAY, activations: 1, foregroundMs: 3_000 },
      'stale-unread',
    ],
    ['an old page that was read', {}, { idleMs: 9 * DAY }, 'stale'],
    ['a tab with nothing to say about it', {}, { idleMs: 10 * MINUTE }, 'review'],
  ];

  it.each(headlines)('calls %s %s', (_name, overrides, at, primaryReason) => {
    expect(only({ tab: tab(1, overrides), at }).primaryReason).toBe(primaryReason);
  });

  const engagement: readonly [string, Situation, boolean][] = [
    ['opened and never looked at', { activations: 1, foregroundMs: 3_000 }, true],
    ['never activated at all', { activations: 0, foregroundMs: 0 }, true],
    ['activated twice', { activations: 2, foregroundMs: 3_000 }, false],
    ['read for a quarter of a minute', { activations: 1, foregroundMs: 15_000 }, false],
  ];

  it.each(engagement)('scores a tab %s', (_name, at, counted) => {
    const result = only({ tab: tab(1), at: { ...at, idleMs: 2 * DAY } });
    expect(points(result, 'low-engagement')).toBe(counted ? CONFIG.lowEngagementPoints : 0);
    if (counted) {
      expect(result.reasons).toContainEqual({
        code: 'low-engagement',
        points: CONFIG.lowEngagementPoints,
        activations: at.activations ?? 0,
        foregroundMs: at.foregroundMs ?? 0,
      });
    }
  });

  it('spots the same page with another query string', () => {
    const result = run([
      { tab: tab(1, { url: 'https://example.com/a?page=1' }) },
      { tab: tab(2, { url: 'https://example.com/a?page=2' }) },
    ]);
    expect(points(scored(result, 1), 'near-duplicate')).toBe(CONFIG.nearDuplicatePoints);
    expect(scored(result, 1).reasons).toContainEqual({
      code: 'near-duplicate',
      points: CONFIG.nearDuplicatePoints,
      otherTabId: 2,
    });
    expect(scored(result, 2).reasons).toContainEqual({
      code: 'near-duplicate',
      points: CONFIG.nearDuplicatePoints,
      otherTabId: 1,
    });
  });

  it('spots the same page at another anchor, when the user compares fragments', () => {
    const result = run(
      [
        { tab: tab(1, { url: 'https://example.com/guide#intro' }) },
        { tab: tab(2, { url: 'https://example.com/guide#install' }) },
      ],
      { settings: { match: { ...DEFAULT_SETTINGS.match, ignoreHash: false } } },
    );
    expect(points(scored(result, 1), 'near-duplicate')).toBe(CONFIG.nearDuplicatePoints);
    expect(codes(scored(result, 1))).not.toContain('duplicate');
  });

  it('is not a near-duplicate when the two pages are the very same', () => {
    const result = run([
      { tab: tab(1, { url: 'https://example.com/a' }), at: { ageMs: 10 * DAY } },
      { tab: tab(2, { url: 'https://example.com/a' }), at: { ageMs: 2 * DAY } },
    ]);
    expect(codes(scored(result, 1))).not.toContain('near-duplicate');
  });

  it('counts a page that is already in the bookmarks', () => {
    const url = 'https://example.com/recipes/pasta?utm_source=newsletter';
    const result = only(
      { tab: tab(1, { url }) },
      { context: { bookmarkedUrls: new Set([keepKey('https://example.com/recipes/pasta')]) } },
    );
    expect(points(result, 'bookmarked')).toBe(CONFIG.bookmarkedPoints);
  });

  it('counts a tab the browser has already dropped', () => {
    const result = only({ tab: tab(1, { discarded: true }) });
    expect(points(result, 'discarded')).toBe(CONFIG.discardedPoints);
  });

  it('counts the window nobody has opened in weeks', () => {
    const result = run([
      { tab: tab(1, { windowId: 2 }), at: { idleMs: 10 * DAY } },
      { tab: tab(2, { windowId: 2 }), at: { idleMs: 12 * DAY } },
    ]);
    expect(scored(result, 1).reasons).toContainEqual({
      code: 'forgotten-window',
      points: CONFIG.forgottenWindowPoints,
      tabCount: 2,
      idleMs: 10 * DAY,
    });
  });

  it('leaves a window with one tab still in use alone', () => {
    const result = run([
      { tab: tab(1), at: { idleMs: 10 * DAY } },
      { tab: tab(2), at: { idleMs: 10 * MINUTE } },
    ]);
    expect(codes(scored(result, 1))).not.toContain('forgotten-window');
  });

  const grouping: readonly [string, number, number, string][] = [
    ['a loose tab', NO_GROUP_ID, 70, 'close'],
    ['a tab the user filed in a group', 7, 42, 'review'],
  ];

  it.each(grouping)('scores %s %i', (_name, groupId, score, bucket) => {
    const result = only({
      tab: tab(1, { groupId }),
      at: { idleMs: 7 * DAY, activations: 1, foregroundMs: 1_000 },
    });
    expect(result.score).toBe(score);
    expect(result.bucket).toBe(bucket);
    expect(result.multiplier).toBe(groupId === NO_GROUP_ID ? 1 : CONFIG.groupedMultiplier);
  });

  it('never goes past 100, whatever adds up', () => {
    const result = only({
      tab: tab(1, { url: SEARCH_URL, discarded: true, windowId: 3 }),
      at: { idleMs: 60 * DAY, activations: 0, foregroundMs: 0 },
    });
    expect(result.score).toBe(CONFIG.maxScore);
    expect(result.bucket).toBe('close');
  });

  const buckets: readonly [number, Situation, string][] = [
    [37, { idleMs: 3 * DAY }, 'keep'],
    [52, { idleMs: 3 * DAY, activations: 1, foregroundMs: 0 }, 'review'],
    [55, { idleMs: 7 * DAY }, 'review'],
    [70, { idleMs: 7 * DAY, activations: 1, foregroundMs: 0 }, 'close'],
  ];

  it.each(buckets)('puts a score of %i in the %s bucket', (score, at, bucket) => {
    const result = only({ tab: tab(1), at });
    expect(result.score).toBe(score);
    expect(result.bucket).toBe(bucket);
  });
});

describe('the window roll-up', () => {
  it('reports every window, in the order its tabs appear', () => {
    const result = run([
      { tab: tab(1, { windowId: 5 }), at: { idleMs: 30 * DAY, activations: 0, foregroundMs: 0 } },
      { tab: tab(2, { windowId: 2 }), at: { idleMs: 10 * MINUTE } },
      { tab: tab(3, { windowId: 5 }), at: { idleMs: 20 * DAY, activations: 1, foregroundMs: 0 } },
    ]);

    expect(result.windows).toEqual([
      { windowId: 5, tabCount: 2, closeCount: 2, idleMs: 20 * DAY, forgotten: true },
      { windowId: 2, tabCount: 1, closeCount: 0, idleMs: 10 * MINUTE, forgotten: false },
    ]);
  });

  it('counts the tabs it would close, protections included', () => {
    const result = run([
      { tab: tab(1, { pinned: true }), at: { idleMs: 30 * DAY } },
      { tab: tab(2), at: { idleMs: 30 * DAY, activations: 1, foregroundMs: 0 } },
    ]);
    expect(result.windows).toEqual([
      { windowId: 1, tabCount: 2, closeCount: 1, idleMs: 30 * DAY, forgotten: true },
    ]);
  });

  it('has nothing to say about no tabs', () => {
    expect(scoreTabs([], {}, DEFAULT_SETTINGS, NOW)).toEqual({ tabs: [], windows: [] });
  });
});

describe('the properties the score promises', () => {
  const shapes: readonly Partial<TabInfo>[] = [
    {},
    { url: SEARCH_URL },
    { url: BLANK_URL },
    { url: INTERNAL_URL },
    { discarded: true },
    { groupId: 7 },
    { title: ERROR_TITLE },
  ];

  const situations: readonly Situation[] = [
    { idleMs: 0 },
    { idleMs: 30 * MINUTE },
    { idleMs: 3 * HOUR, activations: 1, foregroundMs: 0 },
    { idleMs: 2 * DAY },
    { idleMs: 40 * DAY, activations: 0, foregroundMs: 0 },
  ];

  it('scores a protected tab 0, whatever else is true of it', () => {
    const protections: readonly Partial<TabInfo>[] = [
      { pinned: true },
      { audible: true },
      { active: true },
      { hidden: true },
    ];
    for (const shape of shapes) {
      for (const at of situations) {
        for (const protection of protections) {
          const result = only({ tab: tab(1, { ...shape, ...protection }), at });
          expect(result.score).toBe(0);
          expect(result.bucket).toBe('keep');
        }
      }
    }
  });

  it('never lowers a score because the tab sat untouched for longer', () => {
    const ladder = [0, HOUR, 6 * HOUR, DAY, 3 * DAY, 7 * DAY, 30 * DAY, 365 * DAY];
    for (const shape of shapes) {
      let previous = -1;
      for (const idleMs of ladder) {
        const result = only({
          tab: tab(1, shape),
          at: { idleMs, activations: 1, foregroundMs: 0 },
        });
        expect(result.score).toBeGreaterThanOrEqual(previous);
        previous = result.score;
      }
    }
  });

  it('gives the same answer twice for the same inputs', () => {
    const entries: Entry[] = [];
    for (const [index, shape] of shapes.entries()) {
      for (const [turn, at] of situations.entries()) {
        const id = index * 10 + turn + 1;
        entries.push({ tab: tab(id, { ...shape, windowId: (id % 3) + 1 }), at });
      }
    }
    expect(run(entries)).toEqual(run(entries));
  });
});

describe('keepKey', () => {
  it('is the same key for the same page, however it was reached', () => {
    expect(keepKey('https://WWW.Example.com/a?utm_source=x#top')).toBe(
      keepKey('https://example.com/a'),
    );
  });
});
