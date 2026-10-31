import { describe, expect, it } from 'vitest';

import type { DuplicateOptions, KeepContext } from '../../src/core/duplicates';
import {
  chooseTabToKeep,
  compareKeepPriority,
  duplicateKey,
  duplicateOptions,
  findDuplicateSets,
  tabUrl,
} from '../../src/core/duplicates';
import type { GuardSettings, MatchOptions, TabInfo } from '../../src/core/types';
import {
  DEFAULT_GUARD_SETTINGS,
  DEFAULT_MATCH_OPTIONS,
  DEFAULT_SETTINGS,
  NO_GROUP_ID,
} from '../../src/core/types';

const MATCH = DEFAULT_MATCH_OPTIONS;

/** A tab that is nothing in particular, so a test only states what it is testing. */
function tab(id: number, overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id,
    windowId: 1,
    index: id,
    url: 'https://example.com/',
    title: 'Example',
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

function ctxOf(
  settings: Partial<GuardSettings> = {},
  rest: Partial<KeepContext> = {},
): KeepContext {
  return { settings: { ...DEFAULT_GUARD_SETTINGS, ...settings }, ...rest };
}

/** Nothing is whitelisted, which is the interesting case for everything but the whitelist. */
const nothingWhitelisted = (): boolean => false;

function keysMatch(a: string, b: string, options: DuplicateOptions = MATCH): boolean {
  return duplicateKey(a, options) === duplicateKey(b, options);
}

/**
 * The tab `compareKeepPriority` keeps out of two, checking on the way that the order is
 * one a sort can rely on: antisymmetric, and the same answer `chooseTabToKeep` gives
 * whichever way round the two are handed to it.
 */
function kept(a: TabInfo, b: TabInfo, ctx: KeepContext): number {
  const forward = compareKeepPriority(a, b, ctx);
  const backward = compareKeepPriority(b, a, ctx);
  expect(Math.sign(forward), 'the comparator must be antisymmetric').toBe(-Math.sign(backward));
  expect(forward, 'the rules must tell these two apart').not.toBe(0);
  const winner = forward < 0 ? a : b;
  expect(chooseTabToKeep([a, b], ctx)?.id).toBe(winner.id);
  expect(chooseTabToKeep([b, a], ctx)?.id).toBe(winner.id);
  return winner.id;
}

describe('duplicateKey', () => {
  /** `[what it is, the option, two URLs, whether the option makes them one page]`. */
  type OptionCase = readonly [string, Partial<MatchOptions>, string, string, boolean];

  // One row per option of PLAN.md §8.3 "URL comparison", in both positions, so that a
  // default that changes cannot quietly change what a duplicate is.
  const OPTION_CASES: readonly OptionCase[] = [
    [
      'ignoreCase off: the path is compared as written',
      { ignoreCase: false },
      'https://example.com/Path',
      'https://example.com/path',
      false,
    ],
    [
      'ignoreCase on',
      { ignoreCase: true },
      'https://example.com/Path?Q=One#Frag',
      'https://example.com/path?q=one#frag',
      true,
    ],
    [
      'ignoreWww on (the default)',
      { ignoreWww: true },
      'https://www.example.com/a',
      'https://example.com/a',
      true,
    ],
    [
      'ignoreWww off',
      { ignoreWww: false },
      'https://www.example.com/a',
      'https://example.com/a',
      false,
    ],
    [
      'ignoreHash on (the default)',
      { ignoreHash: true },
      'https://example.com/a#section',
      'https://example.com/a',
      true,
    ],
    [
      'ignoreHash on still keeps an SPA route apart',
      { ignoreHash: true },
      'https://app.example.com/#/inbox',
      'https://app.example.com/#/sent',
      false,
    ],
    [
      'ignoreHash off',
      { ignoreHash: false },
      'https://example.com/a#section',
      'https://example.com/a',
      false,
    ],
    [
      'ignoreTrackingParams on (the default)',
      { ignoreTrackingParams: true },
      'https://example.com/a?utm_source=news&fbclid=1&q=1',
      'https://example.com/a?q=1',
      true,
    ],
    [
      'ignoreTrackingParams off',
      { ignoreTrackingParams: false },
      'https://example.com/a?utm_source=news&q=1',
      'https://example.com/a?q=1',
      false,
    ],
    [
      'ignoreAllParams off (the default)',
      { ignoreAllParams: false },
      'https://example.com/search?q=cats',
      'https://example.com/search?q=dogs',
      false,
    ],
    [
      'ignoreAllParams on',
      { ignoreAllParams: true },
      'https://example.com/search?q=cats',
      'https://example.com/search?q=dogs',
      true,
    ],
    [
      'ignorePath off (the default)',
      { ignorePath: false },
      'https://example.com/a',
      'https://example.com/b',
      false,
    ],
    [
      'ignorePath on compares the site only',
      { ignorePath: true },
      'https://example.com/a?q=1',
      'https://example.com/b#x',
      true,
    ],
  ];

  it.each(OPTION_CASES)('%s', (_name, option, a, b, same) => {
    expect(keysMatch(a, b, { ...MATCH, ...option })).toBe(same);
  });

  it('is the same string for the same page, and a stable one', () => {
    expect(duplicateKey('https://www.example.com/a/?utm_source=n', MATCH)).toBe(
      duplicateKey('https://example.com/a', MATCH),
    );
  });

  describe('http and https', () => {
    it('are one page by default, as "Prefer the HTTPS tab" implies', () => {
      expect(keysMatch('http://example.com/a', 'https://example.com/a')).toBe(true);
    });

    it('are one page when asked explicitly', () => {
      expect(
        keysMatch('http://example.com/a', 'https://example.com/a', {
          ...MATCH,
          treatHttpAsHttps: true,
        }),
      ).toBe(true);
    });

    it('are two pages when the option is off', () => {
      expect(
        keysMatch('http://example.com/a', 'https://example.com/a', {
          ...MATCH,
          treatHttpAsHttps: false,
        }),
      ).toBe(false);
    });

    it('are one page across each scheme’s own default port', () => {
      expect(keysMatch('http://example.com:80/a', 'https://example.com:443/a')).toBe(true);
    });

    it('keep an explicit port that is not the default apart', () => {
      expect(keysMatch('http://example.com:443/a', 'https://example.com:443/a')).toBe(false);
      expect(keysMatch('https://example.com:8443/a', 'https://example.com/a')).toBe(false);
    });

    it('does not make other schemes equivalent', () => {
      expect(keysMatch('file:///tmp/a.pdf', 'https://example.com/a.pdf')).toBe(false);
      expect(keysMatch('about:blank', 'https://blank')).toBe(false);
    });
  });

  describe('containers (Firefox)', () => {
    const url = 'https://mail.example.com/inbox';

    it('make the same URL two pages', () => {
      expect(duplicateKey(url, MATCH, 'firefox-container-1')).not.toBe(
        duplicateKey(url, MATCH, 'firefox-container-2'),
      );
    });

    it('leave the same URL in one container a duplicate', () => {
      expect(duplicateKey(url, MATCH, 'firefox-container-1')).toBe(
        duplicateKey(url, MATCH, 'firefox-container-1'),
      );
    });

    it('are absent on Chrome, where every tab shares one key', () => {
      expect(duplicateKey(url, MATCH)).toBe(duplicateKey(url, MATCH, undefined));
    });

    it('never spell the key of a tab that has no container', () => {
      expect(duplicateKey(url, MATCH, 'firefox-default')).not.toBe(duplicateKey(url, MATCH));
    });

    it('are ignored when "treat containers as separate" is off', () => {
      const options: DuplicateOptions = { ...MATCH, containersAreSeparate: false };
      expect(duplicateKey(url, options, 'firefox-container-1')).toBe(
        duplicateKey(url, options, 'firefox-container-2'),
      );
    });

    it('do not let a container id borrow part of the URL', () => {
      // The two halves are joined by a character no URL and no container id contains.
      expect(duplicateKey('b', MATCH, 'a')).not.toBe(duplicateKey('', MATCH, 'ab'));
    });
  });

  describe('URLs no parser accepts', () => {
    it('are their own key, so two tabs showing one of them still match', () => {
      expect(keysMatch('not a url', 'not a url')).toBe(true);
      expect(keysMatch('not a url', 'not a url either')).toBe(false);
    });
  });
});

describe('duplicateOptions', () => {
  it('takes the comparison from the match settings and the rest from the guard', () => {
    expect(duplicateOptions(DEFAULT_SETTINGS)).toEqual({
      ...DEFAULT_MATCH_OPTIONS,
      treatHttpAsHttps: true,
      containersAreSeparate: true,
    });
  });

  it('follows "Prefer the HTTPS tab" and "Treat containers as separate"', () => {
    const options = duplicateOptions({
      match: { ...DEFAULT_MATCH_OPTIONS, ignoreCase: true },
      guard: { ...DEFAULT_GUARD_SETTINGS, preferHttps: false, containersAreSeparate: false },
    });
    expect(options.ignoreCase).toBe(true);
    expect(options.treatHttpAsHttps).toBe(false);
    expect(options.containersAreSeparate).toBe(false);
  });
});

describe('tabUrl', () => {
  it('is the URL the tab is showing', () => {
    expect(tabUrl({ url: 'https://example.com/a', pendingUrl: 'https://example.com/b' })).toBe(
      'https://example.com/a',
    );
  });

  it('falls back to the URL a new tab is about to show', () => {
    expect(tabUrl({ url: '', pendingUrl: 'https://example.com/b' })).toBe('https://example.com/b');
  });

  it('is empty when the tab has neither', () => {
    expect(tabUrl({ url: '' })).toBe('');
  });
});

describe('findDuplicateSets', () => {
  it('finds the pages more than one tab is showing', () => {
    const tabs = [
      tab(1, { url: 'https://example.com/a' }),
      tab(2, { url: 'https://other.example/b' }),
      tab(3, { url: 'https://www.example.com/a/?utm_source=news' }),
      tab(4, { url: 'http://example.com/a' }),
    ];
    const sets = findDuplicateSets(tabs, MATCH, nothingWhitelisted);
    expect(sets).toHaveLength(1);
    expect(sets[0]?.tabs.map((t) => t.id)).toEqual([1, 3, 4]);
    expect(sets[0]?.key).toBe(duplicateKey('https://example.com/a', MATCH));
  });

  it('leaves out a page only one tab is showing', () => {
    const tabs = [
      tab(1, { url: 'https://example.com/a' }),
      tab(2, { url: 'https://example.com/b' }),
    ];
    expect(findDuplicateSets(tabs, MATCH, nothingWhitelisted)).toEqual([]);
  });

  it('returns the sets and their tabs in the order they were given', () => {
    const tabs = [
      tab(5, { url: 'https://b.example/' }),
      tab(4, { url: 'https://a.example/' }),
      tab(3, { url: 'https://b.example/' }),
      tab(2, { url: 'https://a.example/' }),
    ];
    const sets = findDuplicateSets(tabs, MATCH, nothingWhitelisted);
    expect(sets.map((set) => set.tabs.map((t) => t.id))).toEqual([
      [5, 3],
      [4, 2],
    ]);
  });

  it('excludes hidden tabs, which are not on screen at all', () => {
    const tabs = [
      tab(1, { url: 'https://example.com/a' }),
      tab(2, { url: 'https://example.com/a', hidden: true }),
    ];
    expect(findDuplicateSets(tabs, MATCH, nothingWhitelisted)).toEqual([]);
  });

  it('counts the visible tabs of a set even when a hidden one shares the page', () => {
    const tabs = [
      tab(1, { url: 'https://example.com/a' }),
      tab(2, { url: 'https://example.com/a', hidden: true }),
      tab(3, { url: 'https://example.com/a' }),
    ];
    const sets = findDuplicateSets(tabs, MATCH, nothingWhitelisted);
    expect(sets.map((set) => set.tabs.map((t) => t.id))).toEqual([[1, 3]]);
  });

  it('excludes the URLs the whitelist allows duplicates for', () => {
    const tabs = [
      tab(1, { url: 'about:blank' }),
      tab(2, { url: 'about:blank' }),
      tab(3, { url: 'https://example.com/a' }),
      tab(4, { url: 'https://example.com/a' }),
    ];
    const sets = findDuplicateSets(tabs, MATCH, (url) => url === 'about:blank');
    expect(sets.map((set) => set.tabs.map((t) => t.id))).toEqual([[3, 4]]);
  });

  it('asks the whitelist about the raw URL, not about the key', () => {
    const seen: string[] = [];
    const tabs = [tab(1, { url: 'https://www.example.com/a/?utm_source=news' })];
    findDuplicateSets(tabs, MATCH, (url) => {
      seen.push(url);
      return false;
    });
    expect(seen).toEqual(['https://www.example.com/a/?utm_source=news']);
  });

  it('keeps the same URL in two containers apart', () => {
    const tabs = [
      tab(1, { url: 'https://mail.example.com/', cookieStoreId: 'firefox-container-1' }),
      tab(2, { url: 'https://mail.example.com/', cookieStoreId: 'firefox-container-2' }),
    ];
    expect(findDuplicateSets(tabs, MATCH, nothingWhitelisted)).toEqual([]);
  });

  it('finds duplicates inside one container', () => {
    const tabs = [
      tab(1, { url: 'https://mail.example.com/', cookieStoreId: 'firefox-container-1' }),
      tab(2, { url: 'https://mail.example.com/', cookieStoreId: 'firefox-container-2' }),
      tab(3, { url: 'https://mail.example.com/', cookieStoreId: 'firefox-container-1' }),
    ];
    const sets = findDuplicateSets(tabs, MATCH, nothingWhitelisted);
    expect(sets.map((set) => set.tabs.map((t) => t.id))).toEqual([[1, 3]]);
  });

  it('matches a tab that is still loading by the URL it is about to show', () => {
    const tabs = [
      tab(1, { url: 'https://example.com/a' }),
      tab(2, { url: '', pendingUrl: 'https://example.com/a' }),
      tab(3, { url: '', pendingUrl: 'https://example.com/b' }),
    ];
    const sets = findDuplicateSets(tabs, MATCH, nothingWhitelisted);
    expect(sets.map((set) => set.tabs.map((t) => t.id))).toEqual([[1, 2]]);
  });

  it('finds nothing in an empty tab list', () => {
    expect(findDuplicateSets([], MATCH, nothingWhitelisted)).toEqual([]);
  });
});

describe('compareKeepPriority', () => {
  describe('1. the pinned tab', () => {
    const pinned = tab(2, { pinned: true });
    const loose = tab(1);

    it('stays', () => {
      expect(kept(pinned, loose, ctxOf())).toBe(2);
    });

    it('has no privilege when "Keep the pinned tab" is off', () => {
      expect(kept(pinned, loose, ctxOf({ keepPinned: false }))).toBe(1);
    });

    it('does not decide between two pinned tabs', () => {
      const other = tab(1, { pinned: true });
      expect(kept(pinned, other, ctxOf())).toBe(1);
    });
  });

  describe('2. the active tab the user navigated', () => {
    const active = tab(2, { active: true });
    const other = tab(1);
    const navigated = ctxOf({}, { navigatedTabIds: new Set([2]) });

    it('stays', () => {
      expect(kept(active, other, navigated)).toBe(2);
    });

    it('does not count when the tab was merely created active', () => {
      // PLAN.md §8.4.3.2: otherwise every link opened in the foreground would close the
      // tab it was opened from.
      expect(kept(active, other, ctxOf())).toBe(1);
    });

    it('does not count when the navigated tab is not the active one', () => {
      expect(kept(tab(2), other, ctxOf({}, { navigatedTabIds: new Set([2]) }))).toBe(1);
    });

    it('has no privilege when "Keep the active tab" is off', () => {
      expect(
        kept(active, other, ctxOf({ keepActive: false }, { navigatedTabIds: new Set([2]) })),
      ).toBe(1);
    });
  });

  describe('3. the HTTPS tab', () => {
    const secure = tab(2, { url: 'https://example.com/a' });
    const plain = tab(1, { url: 'http://example.com/a' });

    it('stays', () => {
      expect(kept(secure, plain, ctxOf())).toBe(2);
    });

    it('has no privilege when "Prefer the HTTPS tab" is off', () => {
      expect(kept(secure, plain, ctxOf({ preferHttps: false }))).toBe(1);
    });

    it('does not decide between two HTTPS tabs', () => {
      expect(kept(secure, tab(1, { url: 'https://example.com/a' }), ctxOf())).toBe(1);
    });
  });

  describe('4. age', () => {
    const older = tab(2);
    const newer = tab(1);
    const createdAt = { 2: 1_000, 1: 2_000 };

    it('keeps the oldest by default', () => {
      expect(kept(older, newer, ctxOf({ keep: 'oldest' }, { createdAt }))).toBe(2);
    });

    it('keeps the newest when that is what the user chose', () => {
      expect(kept(older, newer, ctxOf({ keep: 'newest' }, { createdAt }))).toBe(1);
    });

    it('keeps the oldest for "oldest, reloaded": the reload is an action, not a choice', () => {
      expect(kept(older, newer, ctxOf({ keep: 'oldest-reloaded' }, { createdAt }))).toBe(2);
    });

    it('cannot tell apart two tabs opened at the same moment', () => {
      // Decided by the tab id below, so the answer does not depend on event order.
      expect(kept(tab(2), tab(1), ctxOf({}, { createdAt: { 1: 5_000, 2: 5_000 } }))).toBe(1);
    });

    it('cannot tell apart a tab the tracker has no record of', () => {
      expect(kept(tab(2), tab(1), ctxOf({}, { createdAt: { 1: 2_000 } }))).toBe(1);
      expect(kept(tab(2), tab(1), ctxOf())).toBe(1);
    });
  });

  describe('5. the tab in the active window', () => {
    const inFront = tab(2, { windowId: 7 });
    const behind = tab(1, { windowId: 8 });
    const focused = { focusedWindowId: 7 };

    it('stays, when the search spanned every window', () => {
      expect(kept(inFront, behind, ctxOf({ scope: 'all-windows' }, focused))).toBe(2);
    });

    it('has no say with the "same window" scope', () => {
      expect(kept(inFront, behind, ctxOf({ scope: 'window' }, focused))).toBe(1);
    });

    it('has no say when the option is off', () => {
      expect(
        kept(inFront, behind, ctxOf({ scope: 'all-windows', preferActiveWindow: false }, focused)),
      ).toBe(1);
    });

    it('has no say when no window is focused', () => {
      expect(kept(inFront, behind, ctxOf({ scope: 'all-windows' }))).toBe(1);
    });

    it('does not decide between two tabs of the focused window', () => {
      expect(kept(inFront, tab(1, { windowId: 7 }), ctxOf({ scope: 'all-windows' }, focused))).toBe(
        1,
      );
    });
  });

  describe('6. the tab id, once nothing else separates them', () => {
    it('keeps the lower one, which is the older tab, with "oldest"', () => {
      expect(kept(tab(9), tab(4), ctxOf({ keep: 'oldest' }))).toBe(4);
    });

    it('keeps the higher one with "newest"', () => {
      expect(kept(tab(9), tab(4), ctxOf({ keep: 'newest' }))).toBe(9);
    });

    it('is the only tie: one tab compared with itself', () => {
      expect(compareKeepPriority(tab(4), tab(4), ctxOf())).toBe(0);
    });
  });

  describe('the first rule that tells them apart wins', () => {
    it('pinned beats the navigated active tab', () => {
      const pinned = tab(1, { pinned: true });
      const active = tab(2, { active: true });
      const ctx = ctxOf({}, { navigatedTabIds: new Set([2]) });
      expect(kept(pinned, active, ctx)).toBe(1);
      // Without rule 1, the tab the user navigated is the one that stays.
      expect(
        kept(pinned, active, ctxOf({ keepPinned: false }, { navigatedTabIds: new Set([2]) })),
      ).toBe(2);
    });

    it('the navigated active tab beats HTTPS', () => {
      const active = tab(1, { url: 'http://example.com/a', active: true });
      const secure = tab(2, { url: 'https://example.com/a' });
      const ctx = ctxOf({}, { navigatedTabIds: new Set([1]) });
      expect(kept(active, secure, ctx)).toBe(1);
      // With the rule above switched off, the next one that applies decides.
      expect(
        kept(active, secure, { ...ctx, settings: { ...ctx.settings, keepActive: false } }),
      ).toBe(2);
    });

    it('HTTPS beats age', () => {
      const secure = tab(1, { url: 'https://example.com/a' });
      const plainOlder = tab(2, { url: 'http://example.com/a' });
      const ctx = ctxOf({ keep: 'oldest' }, { createdAt: { 1: 2_000, 2: 1_000 } });
      expect(kept(secure, plainOlder, ctx)).toBe(1);
      expect(
        kept(secure, plainOlder, { ...ctx, settings: { ...ctx.settings, preferHttps: false } }),
      ).toBe(2);
    });

    it('age beats the active window', () => {
      const olderBehind = tab(1, { windowId: 8 });
      const newerInFront = tab(2, { windowId: 7 });
      const ctx = ctxOf(
        { scope: 'all-windows', keep: 'oldest' },
        { createdAt: { 1: 1_000, 2: 2_000 }, focusedWindowId: 7 },
      );
      expect(kept(olderBehind, newerInFront, ctx)).toBe(1);
      // Without the ages, the window in front decides instead.
      expect(kept(olderBehind, newerInFront, { ...ctx, createdAt: undefined })).toBe(2);
    });

    it('the active window beats the tab id', () => {
      const higherIdInFront = tab(9, { windowId: 7 });
      const lowerIdBehind = tab(4, { windowId: 8 });
      const ctx = ctxOf({ scope: 'all-windows' }, { focusedWindowId: 7 });
      expect(kept(higherIdInFront, lowerIdBehind, ctx)).toBe(9);
      expect(kept(higherIdInFront, lowerIdBehind, ctxOf({ scope: 'window' }))).toBe(4);
    });

    it('answers a whole set with the first rule that applies to it', () => {
      // A pinned tab among four duplicates: nothing below rule 1 is even consulted.
      const tabs = [
        tab(1, { url: 'http://example.com/a' }),
        tab(2, { url: 'https://example.com/a', windowId: 7, active: true }),
        tab(3, { url: 'https://example.com/a', pinned: true }),
        tab(4, { url: 'https://example.com/a' }),
      ];
      const ctx = ctxOf(
        { scope: 'all-windows' },
        {
          createdAt: { 1: 1_000, 2: 2_000, 3: 3_000, 4: 4_000 },
          navigatedTabIds: new Set([2]),
          focusedWindowId: 7,
        },
      );
      expect(chooseTabToKeep(tabs, ctx)?.id).toBe(3);
      expect(chooseTabToKeep([...tabs].reverse(), ctx)?.id).toBe(3);
    });
  });
});

describe('chooseTabToKeep', () => {
  it('has nothing to keep out of no tabs', () => {
    expect(chooseTabToKeep([], ctxOf())).toBeNull();
  });

  it('keeps the only tab there is', () => {
    expect(chooseTabToKeep([tab(3)], ctxOf())?.id).toBe(3);
  });

  it('decides each duplicate set of a window with the same rules', () => {
    const tabs = [
      tab(1, { url: 'https://example.com/a' }),
      tab(2, { url: 'http://example.com/a' }),
      tab(3, { url: 'https://other.example/b', pinned: true }),
      tab(4, { url: 'https://other.example/b' }),
      tab(5, { url: 'https://only.example/' }),
    ];
    const ctx = ctxOf({}, { createdAt: { 1: 2_000, 2: 1_000, 3: 4_000, 4: 3_000 } });
    const sets = findDuplicateSets(tabs, MATCH, nothingWhitelisted);
    expect(sets.map((set) => chooseTabToKeep(set.tabs, ctx)?.id)).toEqual([1, 3]);
  });
});
