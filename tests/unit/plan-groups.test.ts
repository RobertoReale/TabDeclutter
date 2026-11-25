import { describe, expect, it } from 'vitest';

import {
  isClusterSavedAsTabGroup,
  planNativeTabGroups,
  type PlanCluster,
} from '../../src/core/plan-groups';
import { NO_GROUP_ID, type TabInfo } from '../../src/core/types';

function makeTab(id: number, overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id,
    windowId: 1,
    index: id - 1,
    url: `https://example.com/${String(id)}`,
    title: `Tab ${String(id)}`,
    pinned: false,
    audible: false,
    active: false,
    discarded: false,
    hidden: false,
    incognito: false,
    groupId: NO_GROUP_ID,
    ...overrides,
  };
}

function makeCluster(
  key: string,
  tabIds: readonly number[],
  overrides: Partial<PlanCluster> = {},
): PlanCluster {
  return {
    key,
    title: key,
    color: 'blue',
    tabIds,
    ...overrides,
  };
}

describe('isClusterSavedAsTabGroup', () => {
  it('returns true when every live eligible tab shares one native group in one window', () => {
    const tabs = [
      makeTab(1, { windowId: 2, groupId: 10 }),
      makeTab(2, { windowId: 2, groupId: 10 }),
      makeTab(3, { windowId: 2, pinned: true, groupId: NO_GROUP_ID }),
      makeTab(4, { windowId: 2, incognito: true, groupId: NO_GROUP_ID }),
    ];
    const byId = new Map(tabs.map((tab) => [tab.id, tab]));

    expect(isClusterSavedAsTabGroup([1, 2], byId)).toBe(true);
    // Pinned, incognito, and already-closed tab IDs are ignored.
    expect(isClusterSavedAsTabGroup([1, 2, 3, 4, 999], byId)).toBe(true);
  });

  it('returns false for empty, ungrouped, split-group, or cross-window tabs', () => {
    const tabs = [
      makeTab(1, { windowId: 1, groupId: NO_GROUP_ID }),
      makeTab(2, { windowId: 1, groupId: 10 }),
      makeTab(3, { windowId: 1, groupId: 11 }),
      makeTab(4, { windowId: 2, groupId: 10 }),
      makeTab(5, { windowId: 1, pinned: true, groupId: NO_GROUP_ID }),
    ];
    const byId = new Map(tabs.map((tab) => [tab.id, tab]));

    expect(isClusterSavedAsTabGroup([], byId)).toBe(false);
    expect(isClusterSavedAsTabGroup([5, 999], byId)).toBe(false);
    expect(isClusterSavedAsTabGroup([1, 2], byId)).toBe(false);
    expect(isClusterSavedAsTabGroup([2, 3], byId)).toBe(false);
    expect(isClusterSavedAsTabGroup([2, 4], byId)).toBe(false);
  });
});

describe('planNativeTabGroups', () => {
  it('plans a single-window cluster with zero cross-window moves', () => {
    const tabs = [makeTab(1, { windowId: 3 }), makeTab(2, { windowId: 3 })];
    const plan = planNativeTabGroups(
      [makeCluster('math', [1, 2], { title: 'Math', color: 'cyan' })],
      tabs,
    );

    expect(plan).toEqual({
      skipped: 0,
      items: [
        {
          key: 'math',
          title: 'Math',
          color: 'cyan',
          targetWindowId: 3,
          reuseGroupId: null,
          moveTabIds: [],
          groupTabIds: [1, 2],
          allTabIds: [1, 2],
        },
      ],
    });
  });

  it('picks the majority window and moves only tabs from minority windows', () => {
    const tabs = [
      makeTab(1, { windowId: 1 }),
      makeTab(2, { windowId: 2 }),
      makeTab(3, { windowId: 2 }),
    ];
    const plan = planNativeTabGroups([makeCluster('math', [1, 2, 3])], tabs, 1);

    expect(plan.items[0]).toMatchObject({
      targetWindowId: 2,
      reuseGroupId: null,
      moveTabIds: [1],
      groupTabIds: [1, 2, 3],
      allTabIds: [1, 2, 3],
    });
  });

  it('breaks equal-size window ties in favour of focusedWindowId, then lowest windowId', () => {
    const tabs = [makeTab(1, { windowId: 5 }), makeTab(2, { windowId: 2 })];

    const withFocus = planNativeTabGroups([makeCluster('a', [1, 2])], tabs, 5);
    expect(withFocus.items[0]?.targetWindowId).toBe(5);
    expect(withFocus.items[0]?.moveTabIds).toEqual([2]);

    const withoutMatchingFocus = planNativeTabGroups([makeCluster('a', [1, 2])], tabs, 99);
    expect(withoutMatchingFocus.items[0]?.targetWindowId).toBe(2);
    expect(withoutMatchingFocus.items[0]?.moveTabIds).toEqual([1]);

    // Reverse input order still deterministically picks lowest windowId when unfocused.
    const reversed = planNativeTabGroups([makeCluster('a', [2, 1])], tabs, 99);
    expect(reversed.items[0]?.targetWindowId).toBe(2);
  });

  it('skips clusters that are already saved as one native tab group', () => {
    const tabs = [
      makeTab(1, { windowId: 1, groupId: 7 }),
      makeTab(2, { windowId: 1, groupId: 7 }),
      makeTab(3, { windowId: 1, groupId: NO_GROUP_ID }),
      makeTab(4, { windowId: 1, groupId: NO_GROUP_ID }),
    ];
    const plan = planNativeTabGroups(
      [makeCluster('saved', [1, 2]), makeCluster('fresh', [3, 4])],
      tabs,
    );

    expect(plan.skipped).toBe(0);
    expect(plan.items.map((item) => item.key)).toEqual(['fresh']);
  });

  it('reuses an existing native group when all its members belong to the cluster', () => {
    const tabs = [
      makeTab(1, { windowId: 2, groupId: 42 }),
      makeTab(2, { windowId: 2, groupId: 42 }),
      makeTab(3, { windowId: 1, groupId: NO_GROUP_ID }),
    ];
    const plan = planNativeTabGroups([makeCluster('math', [1, 2, 3])], tabs, 1);

    expect(plan.items[0]).toEqual({
      key: 'math',
      title: 'math',
      color: 'blue',
      targetWindowId: 2,
      reuseGroupId: 42,
      moveTabIds: [3],
      groupTabIds: [3],
      allTabIds: [1, 2, 3],
    });
  });

  it('picks the largest (or lowest-id) reusable group when a cluster encompasses two smaller groups', () => {
    const tabs = [
      makeTab(1, { windowId: 1, groupId: 20 }),
      makeTab(2, { windowId: 1, groupId: 20 }),
      makeTab(3, { windowId: 2, groupId: 10 }),
      makeTab(4, { windowId: 2, groupId: 10 }),
    ];
    const equalSize = planNativeTabGroups([makeCluster('mix', [1, 2, 3, 4])], tabs);
    expect(equalSize.items[0]?.reuseGroupId).toBe(10);
    expect(equalSize.items[0]?.targetWindowId).toBe(2);
    expect(equalSize.items[0]?.moveTabIds).toEqual([1, 2]);
    expect(equalSize.items[0]?.groupTabIds).toEqual([1, 2]);
  });

  it('does not hijack an unrelated manual group that also holds tabs outside the cluster', () => {
    const tabs = [
      makeTab(1, { windowId: 1, groupId: 50 }),
      makeTab(2, { windowId: 1, groupId: NO_GROUP_ID }),
      // Tab 3 is outside the cluster but belongs to manual group 50.
      makeTab(3, { windowId: 1, groupId: 50 }),
    ];
    const plan = planNativeTabGroups([makeCluster('math', [1, 2])], tabs);

    expect(plan.items[0]).toMatchObject({
      reuseGroupId: null,
      targetWindowId: 1,
      groupTabIds: [1, 2],
    });
  });

  it('counts missing/incognito tabs as skipped, excludes pinned tabs silently, and deduplicates overlapping clusters', () => {
    const tabs = [
      makeTab(1, { windowId: 1 }),
      makeTab(2, { windowId: 1, pinned: true }),
      makeTab(3, { windowId: 1, incognito: true }),
      makeTab(4, { windowId: 1 }),
    ];
    const plan = planNativeTabGroups(
      [
        makeCluster('first', [1, 2, 3, 999]),
        makeCluster('all-gone', [2, 998]),
        makeCluster('overlap', [1, 4]),
      ],
      tabs,
    );

    // Skipped: 3 (incognito), 999 (missing), 998 (missing) = 3; pinned tab 2 is excluded silently.
    expect(plan.skipped).toBe(3);
    expect(plan.items.map((item) => ({ key: item.key, allTabIds: item.allTabIds }))).toEqual([
      { key: 'first', allTabIds: [1] },
      { key: 'overlap', allTabIds: [4] },
    ]);
  });
});
