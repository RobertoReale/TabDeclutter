/**
 * `src/core/cluster.ts`: the group proposals of PLAN.md §7.1 and §7.2.
 *
 * What is pinned down here is what the user would notice if it changed: the same tabs
 * always give the same groups, in the same order, with the same titles and the same
 * colours; a site needs three tabs and a topic two; a window never shows more than eight
 * groups; and the stopwords never end up naming anything.
 */

import { describe, expect, it } from 'vitest';

import type { ClusterOptions, GroupProposal } from '../../src/core/cluster';
import {
  colorFor,
  GROUP_COLORS,
  groupBySite,
  groupByTopic,
  proposeGroups,
  siteKey,
  siteName,
  stripSiteSuffix,
  tokenize,
} from '../../src/core/cluster';
import type { TabInfo } from '../../src/core/types';
import { NO_GROUP_ID } from '../../src/core/types';

/** A tab that is nothing in particular, so a test only states what it is testing. */
function tab(id: number, url: string, title: string, overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id,
    windowId: 1,
    index: id,
    url,
    title,
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

/** The titles of the proposal's groups, in the order it put them. */
function titles(proposal: GroupProposal): string[] {
  return proposal.groups.map((group) => group.title);
}

/** Group title → its tabs, which is what the assertions about membership read. */
function membership(proposal: GroupProposal): Record<string, readonly number[]> {
  return Object.fromEntries(proposal.groups.map((group) => [group.title, group.tabIds]));
}

/**
 * `n` tabs on one domain, about one thing, so a window can be filled predictably. The
 * tabs of one topic carry the same words on purpose: these tests are about the thresholds
 * and the limits, not about how well synthetic titles separate.
 */
function topicTabs(from: number, topic: string, domain: string, count: number): TabInfo[] {
  return Array.from({ length: count }, (_, at) =>
    tab(from + at, `https://${domain}/${topic}/${topic}-${at}`, `${topic} ${topic}`),
  );
}

describe('the colour of a group (PLAN.md §7.1)', () => {
  it('is one of the nine colours Chrome accepts', () => {
    for (const key of ['github.com', 'example.org', '', 'Rust · Async', 'localhost']) {
      expect(GROUP_COLORS).toContain(colorFor(key));
    }
  });

  it('is the same colour for the same key, every time', () => {
    expect(colorFor('github.com')).toBe(colorFor('github.com'));
    expect(colorFor('youtube.com')).toBe(colorFor('youtube.com'));
  });

  it('spreads the keys over the palette instead of favouring one colour', () => {
    const keys = Array.from({ length: 200 }, (_, at) => `site-${at}.example`);
    const used = new Set(keys.map(colorFor));
    expect(used.size).toBe(GROUP_COLORS.length);
  });
});

describe('the site of a tab', () => {
  it('is the registrable domain', () => {
    expect(siteKey('https://gist.github.com/user/1')).toBe('github.com');
    expect(siteKey('https://www.bbc.co.uk/news')).toBe('bbc.co.uk');
  });

  it('is the host when there is no registrable domain', () => {
    expect(siteKey('http://localhost:5173/panel')).toBe('localhost');
    expect(siteKey('http://192.168.1.4/router')).toBe('192.168.1.4');
  });

  it('is empty when the URL has no host at all', () => {
    expect(siteKey('about:blank')).toBe('');
    expect(siteKey('')).toBe('');
    expect(siteKey('chrome-extension://bbomjaikkcabgmfaomdich/index.html')).toBe('');
    expect(siteKey('chrome://extensions')).toBe('');
  });
});

describe('the name of a site (PLAN.md §7.1)', () => {
  it('uses the known name when there is one', () => {
    expect(siteName('github.com')).toBe('GitHub');
    expect(siteName('stackoverflow.com')).toBe('Stack Overflow');
    expect(siteName('npmjs.com')).toBe('npm');
  });

  it('uses the brand once for all its country suffixes', () => {
    expect(siteName('amazon.it')).toBe('Amazon');
    expect(siteName('amazon.co.uk')).toBe('Amazon');
  });

  it('falls back to the domain without its TLD, capitalised', () => {
    expect(siteName('qualcosadelgenere.it')).toBe('Qualcosadelgenere');
    expect(siteName('jira.example.com')).toBe('Jira');
  });

  it('keeps a host that has no TLD to drop', () => {
    expect(siteName('localhost')).toBe('Localhost');
    expect(siteName('192.168.1.4')).toBe('192');
  });

  it('has no name for a tab with no site', () => {
    expect(siteName('')).toBe('');
  });
});

describe('the site suffix of a title (PLAN.md §7.2.1)', () => {
  it('drops the site name after a dash or a pipe', () => {
    expect(stripSiteSuffix('Rust async book - YouTube', 'https://www.youtube.com/watch?v=1')).toBe(
      'Rust async book',
    );
    expect(stripSiteSuffix('Why monads | Medium', 'https://medium.com/@a/why-monads')).toBe(
      'Why monads',
    );
  });

  it('drops the suffix whatever the site calls itself', () => {
    // The domain, the label and the host, not only the readable name.
    expect(stripSiteSuffix('Issue 12 · wxt.dev', 'https://wxt.dev/issues/12')).toBe('Issue 12');
    expect(stripSiteSuffix('Pricing - example', 'https://example.org/pricing')).toBe('Pricing');
    expect(stripSiteSuffix('Panel - localhost', 'http://localhost:5173/panel')).toBe('Panel');
  });

  it('drops the site but keeps what the title says before it', () => {
    expect(
      stripSiteSuffix('Add a budget · user/repo · GitHub', 'https://github.com/user/repo/pull/3'),
    ).toBe('Add a budget · user/repo');
  });

  it('drops two suffixes when the site really does repeat itself', () => {
    expect(stripSiteSuffix('Panel - localhost - localhost', 'http://localhost:5173/panel')).toBe(
      'Panel',
    );
  });

  it('leaves a page called nothing but its site with that name', () => {
    expect(stripSiteSuffix('GitHub', 'https://github.com/')).toBe('GitHub');
    expect(stripSiteSuffix('GitHub · GitHub', 'https://github.com/')).toBe('GitHub');
  });

  it('leaves a title that only looks like it has a suffix alone', () => {
    expect(stripSiteSuffix('Rust - the language', 'https://example.org/rust')).toBe(
      'Rust - the language',
    );
    expect(stripSiteSuffix('well-known limits', 'https://example.org/limits')).toBe(
      'well-known limits',
    );
  });

  it('cuts at the last separator, whichever kind it is', () => {
    // A pipe earlier in the title must not win over the dash that carries the site.
    expect(stripSiteSuffix('Issue | Repo - GitHub', 'https://github.com/user/repo')).toBe(
      'Issue | Repo',
    );
  });

  it('has nothing to strip when the tab has no site', () => {
    expect(stripSiteSuffix('  Nuova scheda  ', 'about:blank')).toBe('Nuova scheda');
  });
});

describe('the tokens of a tab (PLAN.md §7.2.1)', () => {
  it('takes the title and the path, lower-cased', () => {
    const tokens = tokenize(tab(1, 'https://example.org/async/runtime', 'Async Rust'));
    expect(tokens).toContain('async');
    expect(tokens).toContain('rust');
    expect(tokens).toContain('runtime');
  });

  it('drops the Italian and English stopwords', () => {
    const tokens = tokenize(
      tab(1, 'https://example.org/', 'Questo è quello che the other should have been'),
    );
    for (const stopword of ['questo', 'quello', 'che', 'the', 'other', 'should', 'have', 'been']) {
      expect(tokens).not.toContain(stopword);
    }
  });

  it('drops the tokens shorter than the minimum', () => {
    expect(tokenize(tab(1, 'https://example.org/a/bc', 'Go to it'))).toEqual([]);
    expect(tokenize(tab(1, 'https://example.org/a/bc', 'Go to it'), { minTokenLength: 2 })).toEqual(
      ['go', 'to', 'it', 'bc'],
    );
  });

  it('counts a word the title and the path share twice', () => {
    const tokens = tokenize(tab(1, 'https://example.org/rust', 'Rust'));
    expect(tokens.filter((token) => token === 'rust')).toHaveLength(2);
  });

  it('reads a percent-encoded path, and survives a broken one', () => {
    expect(tokenize(tab(1, 'https://example.org/ricette%20veloci', ''))).toContain('ricette');
    expect(tokenize(tab(1, 'https://example.org/sconto%zz/pasta', ''))).toContain('pasta');
  });

  it('has no path to read when the URL is not one', () => {
    expect(tokenize(tab(1, 'not a url at all', 'Pasta fresca'))).toEqual(['pasta', 'fresca']);
  });
});

describe('grouping by site (PLAN.md §7.1)', () => {
  const tabs = [
    tab(1, 'https://github.com/user/one', 'one'),
    tab(2, 'https://gist.github.com/user/two', 'two'),
    tab(3, 'https://github.com/user/three', 'three'),
    tab(4, 'https://www.youtube.com/watch?v=a', 'a'),
    tab(5, 'https://youtube.com/watch?v=b', 'b'),
    tab(6, 'https://stackoverflow.com/q/1', 'q'),
    tab(7, 'about:blank', ''),
  ];

  it('groups a site with at least three tabs and leaves the rest out', () => {
    const proposal = groupBySite(tabs);
    expect(proposal.mode).toBe('site');
    expect(titles(proposal)).toEqual(['GitHub']);
    expect(membership(proposal)).toEqual({ GitHub: [1, 2, 3] });
    // YouTube has two, Stack Overflow one, and `about:blank` has no site at all.
    expect([...proposal.ungrouped].sort((a, b) => a - b)).toEqual([4, 5, 6, 7]);
  });

  it('takes the minimum from the options', () => {
    const proposal = groupBySite(tabs, { minSiteTabs: 2 });
    expect(titles(proposal)).toEqual(['GitHub', 'YouTube']);
    expect([...proposal.ungrouped].sort((a, b) => a - b)).toEqual([6, 7]);
  });

  it('gives each group the site colour, whatever else is in the window', () => {
    const alone = groupBySite(tabs.slice(0, 3)).groups[0];
    const crowded = groupBySite(tabs).groups[0];
    expect(alone?.color).toBe(colorFor('github.com'));
    expect(crowded?.color).toBe(alone?.color);
  });

  it('puts the largest group first and breaks a tie by position', () => {
    const proposal = groupBySite(
      [
        ...topicTabs(1, 'alpha', 'alpha.example', 3),
        ...topicTabs(10, 'beta', 'beta.example', 4),
        ...topicTabs(20, 'gamma', 'gamma.example', 3),
      ],
      { minSiteTabs: 3 },
    );
    expect(titles(proposal)).toEqual(['Beta', 'Alpha', 'Gamma']);
  });

  it('leaves out the pinned and the already grouped tabs unless asked', () => {
    const mixed = [
      tab(1, 'https://github.com/one', 'one', { pinned: true }),
      tab(2, 'https://github.com/two', 'two', { groupId: 7 }),
      tab(3, 'https://github.com/three', 'three'),
      tab(4, 'https://github.com/four', 'four'),
    ];
    expect(groupBySite(mixed).groups).toEqual([]);
    expect(groupBySite(mixed).ungrouped).toEqual([3, 4]);

    const all = groupBySite(mixed, { includePinned: true, includeGrouped: true });
    expect(membership(all)).toEqual({ GitHub: [1, 2, 3, 4] });
  });

  it('never looks at a hidden tab', () => {
    const withHidden = [
      ...topicTabs(1, 'alpha', 'alpha.example', 2),
      tab(3, 'https://alpha.example/third', 'third', { hidden: true }),
    ];
    const proposal = groupBySite(withHidden);
    expect(proposal.groups).toEqual([]);
    expect(proposal.ungrouped).toEqual([1, 2]);
  });

  it('runs per window: one group each, never one across two (PLAN.md §7.4)', () => {
    const twoWindows = [
      ...topicTabs(1, 'alpha', 'github.com', 3),
      ...topicTabs(10, 'beta', 'github.com', 3).map((entry) => ({ ...entry, windowId: 2 })),
      tab(20, 'https://github.com/lonely', 'lonely', { windowId: 3 }),
    ];
    const proposal = groupBySite(twoWindows);
    expect(proposal.groups).toHaveLength(2);
    expect(proposal.groups.map((group) => group.windowId)).toEqual([1, 2]);
    expect(proposal.groups.map((group) => group.tabIds)).toEqual([
      [1, 2, 3],
      [10, 11, 12],
    ]);
    // The third window has one tab: a group of one is not a group.
    expect(proposal.ungrouped).toEqual([20]);
  });

  it('proposes nothing for no tabs', () => {
    expect(groupBySite([])).toEqual({ mode: 'site', groups: [], ungrouped: [] });
  });
});

describe('grouping by topic (PLAN.md §7.2)', () => {
  /** Three topics on three sites, which is the case the clustering must get right. */
  const window = [
    ...topicTabs(1, 'ricette', 'cucina.example', 3),
    ...topicTabs(10, 'kubernetes', 'devops.example', 4),
    ...topicTabs(20, 'portogallo', 'viaggi.example', 3),
  ];

  it('finds the topics and names them after their own words', () => {
    const proposal = groupByTopic(window);
    expect(proposal.mode).toBe('topic');
    expect(proposal.groups).toHaveLength(3);
    // Largest first: Kubernetes has four tabs.
    expect(proposal.groups.map((group) => group.tabIds)).toEqual([
      [10, 11, 12, 13],
      [1, 2, 3],
      [20, 21, 22],
    ]);
    expect(titles(proposal)).toEqual(['Kubernetes', 'Ricette', 'Portogallo']);
  });

  it('gives the same answer every time, down to the titles and the colours', () => {
    const once = groupByTopic(window);
    const again = groupByTopic(window);
    expect(again).toEqual(once);
    // And it does not depend on a `Map`'s insertion order being the input order.
    const reversed = groupByTopic([...window].reverse());
    expect(titles(reversed).sort()).toEqual(titles(once).sort());
  });

  it('never proposes a group of one (PLAN.md §7.2.4)', () => {
    const withStrays = [
      ...topicTabs(1, 'ricette', 'cucina.example', 3),
      tab(50, 'https://chiunque.example/bilancio-trimestrale', 'Bilancio trimestrale'),
    ];
    const proposal = groupByTopic(withStrays);
    expect(proposal.groups).toHaveLength(1);
    expect(proposal.groups[0]?.tabIds).toEqual([1, 2, 3]);
    expect(proposal.ungrouped).toEqual([50]);
    for (const group of proposal.groups) expect(group.tabIds.length).toBeGreaterThanOrEqual(2);
  });

  it('takes the minimum size from the options', () => {
    const pairs = [...topicTabs(1, 'ricette', 'cucina.example', 2)];
    expect(groupByTopic(pairs).groups).toHaveLength(1);
    expect(groupByTopic(pairs, { minClusterTabs: 3 }).groups).toEqual([]);
    expect(groupByTopic(pairs, { minClusterTabs: 3 }).ungrouped).toEqual([1, 2]);
  });

  it('proposes at most eight groups and sends the smallest to "Altro" (PLAN.md §7.2.6)', () => {
    const many = Array.from({ length: 10 }, (_, at) =>
      // The first topics have more tabs, so the two cut are the last two.
      topicTabs(at * 100 + 1, `argomento${at}`, `sito${at}.example`, 10 - at + 2),
    ).flat();
    const proposal = groupByTopic(many);
    expect(proposal.groups).toHaveLength(8);
    expect(new Set(titles(proposal)).size).toBe(8);
    // The 3-tab and the 4-tab topics, the two smallest, are the ones left out.
    expect([...proposal.ungrouped].sort((a, b) => a - b)).toEqual([
      801, 802, 803, 804, 901, 902, 903,
    ]);
    expect(groupByTopic(many, { maxGroups: 2 }).groups).toHaveLength(2);
  });

  it('tells two groups apart when their heaviest word is the same', () => {
    const sameWord = [
      ...topicTabs(1, 'pasta', 'cucina.example', 3),
      ...topicTabs(10, 'pasta', 'ricette.example', 3),
    ];
    // High enough that the two sites stay apart, low enough that each site's own tabs
    // still merge: what is being tested is the second name, not the threshold.
    const proposal = groupByTopic(sameWord, { threshold: 0.99 });
    expect(proposal.groups).toHaveLength(2);
    // Nothing but the word "pasta" to go on, so the site tells them apart.
    expect(titles(proposal)).toEqual(['Pasta', 'Pasta · Ricette']);
  });

  it('leaves out a tab it has no word for', () => {
    // Two tabs of the same site with no title and no path: identical, so they cluster,
    // and there is nothing to call the group by.
    const nameless = [tab(1, 'https://example.org/', ''), tab(2, 'https://example.org/', '')];
    const proposal = groupByTopic(nameless);
    expect(proposal.groups).toEqual([]);
    expect(proposal.ungrouped).toEqual([1, 2]);
  });

  it('does not cluster a tab whose every word was a stopword', () => {
    const stopwordsOnly = [
      ...topicTabs(1, 'ricette', 'cucina.example', 3),
      tab(50, 'https://cucina.example/', 'Questo quello come che per non'),
    ];
    const proposal = groupByTopic(stopwordsOnly);
    expect(proposal.groups[0]?.tabIds).toEqual([1, 2, 3]);
    expect(proposal.ungrouped).toEqual([50]);
  });

  it('merges nothing when the threshold asks for more than a title can give', () => {
    const proposal = groupByTopic(window, { threshold: 1.1 });
    expect(proposal.groups).toEqual([]);
    expect(proposal.ungrouped).toHaveLength(window.length);
  });

  it('merges everything when the threshold asks for nothing', () => {
    const proposal = groupByTopic(window, { threshold: 0 });
    expect(proposal.groups).toHaveLength(1);
    expect(proposal.groups[0]?.tabIds).toHaveLength(window.length);
  });

  it('weighs the domain token: the same words on one site cluster more readily', () => {
    const sameWords = [
      tab(1, 'https://uno.example/rust/async', 'Async Rust pitfalls'),
      tab(2, 'https://due.example/rust/async', 'Async Rust pitfalls'),
    ];
    expect(groupByTopic(sameWords, { domainWeight: 0 }).groups).toHaveLength(1);
    // The domain token is the only thing that tells these two apart, so with it weighed
    // their similarity falls short of the near-perfect one the plain words would give.
    expect(groupByTopic(sameWords, { domainWeight: 0.5, threshold: 0.99 }).groups).toEqual([]);
    expect(groupByTopic(sameWords, { domainWeight: 0, threshold: 0.99 }).groups).toHaveLength(1);
  });

  it('runs per window (PLAN.md §7.4)', () => {
    const twoWindows = [
      ...topicTabs(1, 'ricette', 'cucina.example', 3),
      ...topicTabs(10, 'ricette', 'cucina.example', 3).map((entry) => ({ ...entry, windowId: 2 })),
    ];
    const proposal = groupByTopic(twoWindows);
    expect(proposal.groups).toHaveLength(2);
    expect(proposal.groups.map((group) => group.windowId)).toEqual([1, 2]);
    expect(proposal.groups.map((group) => group.tabIds)).toEqual([
      [1, 2, 3],
      [10, 11, 12],
    ]);
  });

  it('leaves out the pinned, the grouped and the hidden tabs like the site mode does', () => {
    const mixed = [
      ...topicTabs(1, 'ricette', 'cucina.example', 3),
      tab(50, 'https://cucina.example/ricette/ricette-9', 'ricette ricette', { pinned: true }),
    ];
    expect(groupByTopic(mixed).groups[0]?.tabIds).toEqual([1, 2, 3]);
    expect(groupByTopic(mixed, { includePinned: true }).groups[0]?.tabIds).toEqual([1, 2, 3, 50]);
  });

  it('proposes nothing for no tabs', () => {
    expect(groupByTopic([])).toEqual({ mode: 'topic', groups: [], ungrouped: [] });
  });

  it('proposes nothing for a window whose every tab is left out', () => {
    const pinnedOnly = topicTabs(1, 'ricette', 'cucina.example', 3).map((entry) => ({
      ...entry,
      pinned: true,
    }));
    expect(groupByTopic(pinnedOnly)).toEqual({ mode: 'topic', groups: [], ungrouped: [] });
  });

  it('groups tabs that have no site at all by their words alone', () => {
    const hostless = [
      tab(1, 'about:blank', 'Pasta pasta pasta'),
      tab(2, 'about:blank', 'Pasta pasta pasta'),
    ];
    const proposal = groupByTopic(hostless);
    // No domain token to weigh and no site to fall back on for the title: the words decide.
    expect(titles(proposal)).toEqual(['Pasta']);
    expect(proposal.groups[0]?.tabIds).toEqual([1, 2]);
  });

  it('keeps the colour of a group tied to its title, not to its position', () => {
    const proposal = groupByTopic(window);
    for (const group of proposal.groups) {
      expect(group.key).toBe(group.title.toLowerCase());
      expect(group.color).toBe(colorFor(group.key));
    }
  });
});

describe('the two modes together (PLAN.md §4.4.2)', () => {
  const tabs = [
    ...topicTabs(1, 'ricette', 'cucina.example', 3),
    ...topicTabs(10, 'kubernetes', 'devops.example', 3),
  ];

  it('dispatches on the mode', () => {
    const options: ClusterOptions = { minSiteTabs: 3 };
    expect(proposeGroups(tabs, 'site', options)).toEqual(groupBySite(tabs, options));
    expect(proposeGroups(tabs, 'topic', options)).toEqual(groupByTopic(tabs, options));
  });

  it('accounts for every tab exactly once, in both modes', () => {
    for (const mode of ['site', 'topic'] as const) {
      const proposal = proposeGroups(tabs, mode);
      const seen = [
        ...proposal.groups.flatMap((group) => [...group.tabIds]),
        ...proposal.ungrouped,
      ];
      expect(seen.sort((a, b) => a - b)).toEqual(tabs.map((entry) => entry.id));
    }
  });
});
