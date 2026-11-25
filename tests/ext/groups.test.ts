import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import type { GroupColor, GroupProposal, ProposedGroup } from '../../src/core/cluster';
import { NO_GROUP_ID } from '../../src/core/types';
import type { Capabilities } from '../../src/platform/capabilities';
import type {
  ApplyResult,
  GroupProperties,
  GroupsApi,
  PlanGroupsApi,
} from '../../src/platform/groups';
import {
  applyGroups,
  applyMessage,
  savePlanAsTabGroups,
  undoGroups,
  undoSavedPlanGroups,
} from '../../src/platform/groups';
import type { BrowserTab } from '../../src/platform/tabs';

/**
 * Applying and undoing the groups of PLAN.md §7.4 against a tab strip modelled here.
 *
 * `fakeBrowser` implements none of `tabs.group`, `tabs.ungroup`, `tabs.move` or
 * `tabGroups.*` (DECISIONS, M2.1), and a spy on them would only prove which calls were
 * made — not that the window came back as it was, which is the one thing undo promises.
 * So the strip itself is modelled: a list of tabs per window and the groups they are in,
 * with the browsers' own rules where they matter.
 *
 * - `tabs.group` collects its tabs together, next to the group when they are joining one;
 *   it unpins them, because neither browser keeps a pinned tab in a group; and it rejects
 *   the whole call when one id is gone, as Chrome does (PLAN.md §8.6).
 * - `tabGroups.move` takes the group with every tab in it.
 * - a tab moved to an index before the pinned ones lands after them.
 * - a group nobody is in is deleted, which is what makes undo have to build it again.
 *
 * Every test that undoes compares `describeStrips()` before and after. It names groups by
 * title, colour and collapsed state rather than by id, because a rebuilt group is a new id
 * and PLAN.md §5.5 says so outright: a group id does not survive a restart on Firefox.
 */

/** A browser with native tab groups: Chrome, and Firefox 139+. */
const WITH_GROUPS: Capabilities = {
  sidePanel: true,
  sidebarAction: false,
  faviconApi: true,
  promptApi: false,
  tabGroups: true,
  containers: false,
  sessionTabValues: false,
  duplicateCommandDetection: true,
  tabContextMenu: false,
};

/** Invariant 10: Firefox before 139 has no tab groups at all. */
const WITHOUT_GROUPS: Capabilities = { ...WITH_GROUPS, tabGroups: false };

beforeEach(() => {
  fakeBrowser.reset();
});

interface FakeTab {
  id: number;
  windowId: number;
  pinned: boolean;
  groupId: number;
}

interface FakeGroup {
  id: number;
  windowId: number;
  title: string;
  color: GroupColor;
  collapsed: boolean;
}

interface StripOptions {
  /** A browser with no `tabGroups` namespace at all. */
  readonly noTabGroups?: boolean;
}

function tab(id: number, windowId = 1, overrides: Partial<FakeTab> = {}): FakeTab {
  return { id, windowId, pinned: false, groupId: NO_GROUP_ID, ...overrides };
}

/** The strip, the groups, the API over them, and a log of the calls that were made. */
function fakeStrip(initial: readonly FakeTab[], options: StripOptions = {}) {
  const strips = new Map<number, FakeTab[]>();
  const groups = new Map<number, FakeGroup>();
  const calls: string[] = [];
  let nextGroupId = 7000;

  function strip(windowId: number): FakeTab[] {
    const found = strips.get(windowId);
    if (found !== undefined) return found;
    const created: FakeTab[] = [];
    strips.set(windowId, created);
    return created;
  }

  for (const entry of initial) strip(entry.windowId).push({ ...entry });

  function find(tabId: number): FakeTab | undefined {
    for (const list of strips.values()) {
      const found = list.find((entry) => entry.id === tabId);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** A pinned tab cannot be anywhere but the head of the strip, and vice versa. */
  function place(block: readonly FakeTab[], windowId: number, index: number): void {
    const list = strip(windowId);
    for (const entry of block) {
      const at = list.indexOf(entry);
      if (at >= 0) list.splice(at, 1);
    }
    const pinned = list.filter((entry) => entry.pinned).length;
    const blockPinned = block.every((entry) => entry.pinned);
    const low = blockPinned ? 0 : pinned;
    const high = blockPinned ? pinned : list.length;
    list.splice(Math.min(Math.max(index, low), high), 0, ...block);
  }

  /** Where a block goes when what matters is the tab it has to stay in front of. */
  function placeBefore(block: readonly FakeTab[], windowId: number, after: number): void {
    const list = strip(windowId);
    let successor: FakeTab | null = null;
    for (let position = after + 1; position < list.length; position += 1) {
      const candidate = list[position];
      if (candidate !== undefined && !block.includes(candidate)) {
        successor = candidate;
        break;
      }
    }
    for (const entry of block) {
      const at = list.indexOf(entry);
      if (at >= 0) list.splice(at, 1);
    }
    place(block, windowId, successor === null ? list.length : list.indexOf(successor));
  }

  function forget(groupId: number): void {
    const group = groups.get(groupId);
    if (group === undefined) return;
    const members = strip(group.windowId).filter((entry) => entry.groupId === groupId);
    if (members.length === 0) groups.delete(groupId);
  }

  const api: GroupsApi = {
    tabs: {
      query: (query: Record<string, unknown>) => {
        calls.push(`query ${JSON.stringify(query)}`);
        const found: BrowserTab[] = [];
        for (const [windowId, list] of strips) {
          list.forEach((entry, index) => {
            found.push({
              id: entry.id,
              windowId,
              index,
              url: `https://example.com/${String(entry.id)}`,
              title: `Tab ${String(entry.id)}`,
              pinned: entry.pinned,
              groupId: entry.groupId,
            });
          });
        }
        return Promise.resolve(found);
      },

      group: (request: {
        tabIds: readonly number[];
        groupId?: number;
        createProperties?: { windowId: number };
      }) => {
        calls.push(
          `group ${request.tabIds.join(',')} -> ${
            request.groupId === undefined
              ? `new in w${String(request.createProperties?.windowId)}`
              : String(request.groupId)
          }`,
        );
        const members: FakeTab[] = [];
        for (const tabId of request.tabIds) {
          const found = find(tabId);
          // Chrome rejects the whole call for one missing id (PLAN.md §8.6).
          if (found === undefined) throw new Error(`No tab with id: ${String(tabId)}.`);
          members.push(found);
        }

        let groupId: number;
        let windowId: number;
        if (request.groupId === undefined) {
          windowId = request.createProperties?.windowId ?? -1;
          groupId = nextGroupId++;
          groups.set(groupId, {
            id: groupId,
            windowId,
            title: '',
            color: 'grey',
            collapsed: false,
          });
        } else {
          const target = groups.get(request.groupId);
          if (target === undefined)
            throw new Error(`No group with id: ${String(request.groupId)}.`);
          groupId = target.id;
          windowId = target.windowId;
        }
        if (members.some((entry) => entry.windowId !== windowId)) {
          throw new Error('Tabs can only be grouped in the same window.');
        }

        const list = strip(windowId);
        const existing = list.filter(
          (entry) => entry.groupId === groupId && !members.includes(entry),
        );
        let after = -1;
        if (existing.length > 0) {
          for (const entry of existing) after = Math.max(after, list.indexOf(entry));
        } else {
          after = Math.min(...members.map((entry) => list.indexOf(entry))) - 1;
        }

        const left = new Set(members.map((entry) => entry.groupId));
        for (const entry of members) {
          entry.groupId = groupId;
          entry.pinned = false;
        }
        placeBefore(members, windowId, after);
        for (const previous of left) if (previous !== NO_GROUP_ID) forget(previous);
        return Promise.resolve(groupId);
      },

      ungroup: (tabIds: readonly number[]) => {
        calls.push(`ungroup ${tabIds.join(',')}`);
        const members: FakeTab[] = [];
        for (const tabId of tabIds) {
          const found = find(tabId);
          if (found === undefined) throw new Error(`No tab with id: ${String(tabId)}.`);
          members.push(found);
        }
        const left = new Set(members.map((entry) => entry.groupId));
        for (const entry of members) entry.groupId = NO_GROUP_ID;
        for (const previous of left) if (previous !== NO_GROUP_ID) forget(previous);
        return Promise.resolve(undefined);
      },

      move: (tabId: number, properties: { index: number }) => {
        calls.push(`move ${String(tabId)} -> ${String(properties.index)}`);
        const found = find(tabId);
        if (found === undefined) throw new Error(`No tab with id: ${String(tabId)}.`);
        place([found], found.windowId, properties.index);
        return Promise.resolve(undefined);
      },

      update: (tabId: number, properties: { pinned: boolean }) => {
        calls.push(`update ${String(tabId)} pinned=${String(properties.pinned)}`);
        const found = find(tabId);
        if (found === undefined) throw new Error(`No tab with id: ${String(tabId)}.`);
        found.pinned = properties.pinned;
        if (properties.pinned) {
          const previous = found.groupId;
          found.groupId = NO_GROUP_ID;
          place([found], found.windowId, 0);
          if (previous !== NO_GROUP_ID) forget(previous);
        }
        return Promise.resolve(undefined);
      },
    },

    ...(options.noTabGroups === true
      ? {}
      : {
          tabGroups: {
            query: (query: Record<string, unknown>) => {
              calls.push(`query-groups ${JSON.stringify(query)}`);
              return Promise.resolve([...groups.values()].map((group) => ({ ...group })));
            },
            update: (groupId: number, properties: GroupProperties) => {
              calls.push(
                `update-group ${String(groupId)} ${properties.title ?? ''}/${
                  properties.color ?? ''
                }${properties.collapsed === true ? '/collapsed' : ''}`,
              );
              const group = groups.get(groupId);
              if (group === undefined) throw new Error(`No group with id: ${String(groupId)}.`);
              groups.set(groupId, {
                ...group,
                title: properties.title ?? group.title,
                color: properties.color ?? group.color,
                collapsed: properties.collapsed ?? group.collapsed,
              });
              return Promise.resolve(undefined);
            },
            move: (groupId: number, properties: { index: number }) => {
              calls.push(`move-group ${String(groupId)} -> ${String(properties.index)}`);
              const group = groups.get(groupId);
              if (group === undefined) throw new Error(`No group with id: ${String(groupId)}.`);
              const members = strip(group.windowId).filter((entry) => entry.groupId === groupId);
              place(members, group.windowId, properties.index);
              return Promise.resolve(undefined);
            },
          },
        }),
  };

  /** The strip in words: what a comparison before and after an undo rests on. */
  function describeStrips(): readonly string[] {
    return [...strips.entries()].map(([windowId, list]) => {
      const entries = list.map((entry) => {
        const group = groups.get(entry.groupId);
        const label =
          group === undefined
            ? ''
            : ` [${group.title}/${group.color}${group.collapsed ? '/collapsed' : ''}]`;
        return `${entry.pinned ? 'pinned ' : ''}${String(entry.id)}${label}`;
      });
      return `w${String(windowId)}: ${entries.join(' | ')}`;
    });
  }

  /** A group whose tabs are not next to each other: a group that came apart. */
  function brokenGroups(): readonly number[] {
    const broken: number[] = [];
    for (const list of strips.values()) {
      const seen = new Map<number, number>();
      list.forEach((entry, index) => {
        if (entry.groupId === NO_GROUP_ID) return;
        const last = seen.get(entry.groupId);
        if (last !== undefined && last !== index - 1) broken.push(entry.groupId);
        seen.set(entry.groupId, index);
      });
    }
    return broken;
  }

  function close(tabId: number): void {
    for (const list of strips.values()) {
      const at = list.findIndex((entry) => entry.id === tabId);
      if (at < 0) continue;
      const [removed] = list.splice(at, 1);
      if (removed !== undefined && removed.groupId !== NO_GROUP_ID) forget(removed.groupId);
      return;
    }
  }

  function titles(): readonly string[] {
    return [...groups.values()].map((group) => group.title);
  }

  function membersOf(title: string): readonly number[] {
    const group = [...groups.values()].find((entry) => entry.title === title);
    if (group === undefined) return [];
    return strip(group.windowId)
      .filter((entry) => entry.groupId === group.id)
      .map((entry) => entry.id);
  }

  return { api, calls, groups, strips, describeStrips, brokenGroups, close, titles, membersOf };
}

function proposed(
  key: string,
  title: string,
  color: GroupColor,
  windowId: number,
  tabIds: readonly number[],
): ProposedGroup {
  return { key, title, color, windowId, tabIds };
}

function proposal(...groups: readonly ProposedGroup[]): GroupProposal {
  return { mode: 'site', groups, ungrouped: [] };
}

describe('applyGroups', () => {
  it('creates one native group per proposed group, with its title and colour', async () => {
    const fake = fakeStrip([tab(1), tab(2), tab(3), tab(4)]);

    const result = await applyGroups(
      proposal(
        proposed('example.com', 'Example', 'blue', 1, [1, 3]),
        proposed('other.org', 'Other', 'green', 1, [2, 4]),
      ),
      { api: fake.api, capabilities: WITH_GROUPS },
    );

    expect(result.skipped).toBe(0);
    expect(result.groups.map((group) => group.key)).toEqual(['example.com', 'other.org']);
    expect(result.groups.map((group) => group.tabIds)).toEqual([
      [1, 3],
      [2, 4],
    ]);
    expect(fake.describeStrips()).toEqual([
      'w1: 1 [Example/blue] | 3 [Example/blue] | 2 [Other/green] | 4 [Other/green]',
    ]);
    expect(fake.brokenGroups()).toEqual([]);
  });

  it('collapses the groups it creates when the option asks for it', async () => {
    const fake = fakeStrip([tab(1), tab(2)]);

    await applyGroups(proposal(proposed('example.com', 'Example', 'red', 1, [1, 2])), {
      api: fake.api,
      capabilities: WITH_GROUPS,
      collapse: true,
    });

    expect(fake.describeStrips()).toEqual([
      'w1: 1 [Example/red/collapsed] | 2 [Example/red/collapsed]',
    ]);
  });

  /* PLAN.md §4.4.4: "Ordina le schede nella finestra per gruppo". */
  it('puts the groups it made at the head of the window, after the pinned tabs', async () => {
    const fake = fakeStrip([
      tab(1, 1, { pinned: true }),
      tab(2),
      tab(3),
      tab(4),
      tab(5),
      tab(6, 2),
      tab(7, 2),
    ]);

    await applyGroups(
      proposal(
        proposed('example.com', 'Example', 'blue', 1, [3, 5]),
        proposed('other.org', 'Other', 'green', 2, [6, 7]),
      ),
      { api: fake.api, capabilities: WITH_GROUPS, sortByGroup: true },
    );

    expect(fake.describeStrips()).toEqual([
      'w1: pinned 1 | 3 [Example/blue] | 5 [Example/blue] | 2 | 4',
      'w2: 6 [Other/green] | 7 [Other/green]',
    ]);
  });

  it('moves no group when the window is not sorted by group', async () => {
    const fake = fakeStrip([tab(1), tab(2), tab(3)]);

    await applyGroups(proposal(proposed('example.com', 'Example', 'blue', 1, [2, 3])), {
      api: fake.api,
      capabilities: WITH_GROUPS,
    });

    expect(fake.calls.filter((call) => call.startsWith('move-group'))).toEqual([]);
  });

  /* PLAN.md §7.4: "a tab closed in the meantime". */
  it('groups the tabs that are left when one of them is already gone', async () => {
    const fake = fakeStrip([tab(1), tab(2), tab(3)]);

    const result = await applyGroups(
      proposal(proposed('example.com', 'Example', 'blue', 1, [1, 99, 3])),
      { api: fake.api, capabilities: WITH_GROUPS },
    );

    expect(result.skipped).toBe(1);
    expect(result.groups.map((group) => group.tabIds)).toEqual([[1, 3]]);
    expect(fake.describeStrips()).toEqual(['w1: 1 [Example/blue] | 3 [Example/blue] | 2']);
    expect(applyMessage(result)).toEqual({
      one: 'organizeSkippedOne',
      other: 'organizeSkippedOther',
      count: 1,
    });
  });

  /**
   * The tab goes between the query and the call, which is the case the filter above cannot
   * catch: Chrome refuses the whole batch, so the ids are tried one at a time.
   */
  function racing(fake: ReturnType<typeof fakeStrip>, failing: readonly number[]): GroupsApi {
    return {
      ...fake.api,
      tabs: {
        ...fake.api.tabs,
        group: (request) =>
          request.tabIds.some((tabId) => failing.includes(tabId))
            ? Promise.reject(new Error(`No tab with id: ${String(request.tabIds[0])}.`))
            : fake.api.tabs.group(request),
      },
    };
  }

  it('creates the group one tab at a time when the batch call is refused', async () => {
    const fake = fakeStrip([tab(1), tab(2), tab(3)]);

    const result = await applyGroups(
      proposal(proposed('example.com', 'Example', 'blue', 1, [1, 2, 3])),
      { api: racing(fake, [2]), capabilities: WITH_GROUPS },
    );

    expect(result.groups.map((group) => group.tabIds)).toEqual([[1, 3]]);
    expect(result.skipped).toBe(1);
    expect(fake.membersOf('Example')).toEqual([1, 3]);
    expect(fake.brokenGroups()).toEqual([]);
  });

  it('creates no group when every tab of it is refused', async () => {
    const fake = fakeStrip([tab(1), tab(2)]);

    const result = await applyGroups(
      proposal(proposed('example.com', 'Example', 'blue', 1, [1, 2])),
      { api: racing(fake, [1, 2]), capabilities: WITH_GROUPS },
    );

    expect(result.groups).toEqual([]);
    expect(result.skipped).toBe(2);
    expect(fake.titles()).toEqual([]);
  });

  it('skips a tab that has moved to another window, and groups the rest', async () => {
    const fake = fakeStrip([tab(1), tab(2), tab(3, 2)]);

    const result = await applyGroups(
      proposal(proposed('example.com', 'Example', 'blue', 1, [1, 2, 3])),
      { api: fake.api, capabilities: WITH_GROUPS },
    );

    expect(result.skipped).toBe(1);
    expect(result.groups.map((group) => group.tabIds)).toEqual([[1, 2]]);
  });

  it('reports no message when every proposed tab was grouped', async () => {
    const fake = fakeStrip([tab(1), tab(2)]);

    const result = await applyGroups(
      proposal(proposed('example.com', 'Example', 'blue', 1, [1, 2])),
      {
        api: fake.api,
        capabilities: WITH_GROUPS,
      },
    );

    expect(applyMessage(result)).toBeNull();
  });

  /* PLAN.md §4.4: "Lascia fuori le schede fissate", on by default. */
  it('leaves the pinned tabs out, and takes them when the option is off', async () => {
    const fake = fakeStrip([tab(1, 1, { pinned: true }), tab(2), tab(3)]);

    const left = await applyGroups(
      proposal(proposed('example.com', 'Example', 'blue', 1, [1, 2, 3])),
      {
        api: fake.api,
        capabilities: WITH_GROUPS,
      },
    );
    expect(left.groups.map((group) => group.tabIds)).toEqual([[2, 3]]);
    expect(left.skipped).toBe(0);
    expect(fake.describeStrips()).toEqual(['w1: pinned 1 | 2 [Example/blue] | 3 [Example/blue]']);

    const taken = fakeStrip([tab(1, 1, { pinned: true }), tab(2), tab(3)]);
    const result = await applyGroups(
      proposal(proposed('example.com', 'Example', 'blue', 1, [1, 2, 3])),
      { api: taken.api, capabilities: WITH_GROUPS, includePinned: true },
    );
    expect(result.groups.map((group) => group.tabIds)).toEqual([[1, 2, 3]]);
    expect(taken.describeStrips()).toEqual([
      'w1: 1 [Example/blue] | 2 [Example/blue] | 3 [Example/blue]',
    ]);
  });

  /* PLAN.md §4.4: a tab already in one of the user's groups is left alone by default. */
  it("does not touch the user's own groups, and takes them when the option asks", async () => {
    const own = [tab(1), tab(2), tab(3, 1, { groupId: 500 })];
    const fake = fakeStrip(own);
    fake.groups.set(500, {
      id: 500,
      windowId: 1,
      title: 'Reading',
      color: 'purple',
      collapsed: false,
    });

    const left = await applyGroups(
      proposal(proposed('example.com', 'Example', 'blue', 1, [1, 2, 3])),
      {
        api: fake.api,
        capabilities: WITH_GROUPS,
      },
    );
    expect(left.groups.map((group) => group.tabIds)).toEqual([[1, 2]]);
    expect(left.skipped).toBe(0);
    expect(fake.membersOf('Reading')).toEqual([3]);

    const taken = fakeStrip(own);
    taken.groups.set(500, {
      id: 500,
      windowId: 1,
      title: 'Reading',
      color: 'purple',
      collapsed: false,
    });
    const result = await applyGroups(
      proposal(proposed('example.com', 'Example', 'blue', 1, [1, 2, 3])),
      { api: taken.api, capabilities: WITH_GROUPS, includeGrouped: true },
    );
    expect(result.groups.map((group) => group.tabIds)).toEqual([[1, 2, 3]]);
    expect(taken.titles()).toEqual(['Example']);
  });

  /* Invariant 10: Firefox before 139 has no tab groups, so nothing is grouped. */
  it('groups nothing and calls nothing where there are no native groups', async () => {
    const fake = fakeStrip([tab(1), tab(2)], { noTabGroups: true });

    const result = await applyGroups(
      proposal(proposed('example.com', 'Example', 'blue', 1, [1, 2])),
      {
        api: fake.api,
        capabilities: WITHOUT_GROUPS,
      },
    );

    expect(result).toEqual({ snapshot: [], groups: [], skipped: 2 });
    expect(fake.calls).toEqual([]);
  });

  it('calls nothing for a proposal with no tabs in it', async () => {
    const fake = fakeStrip([tab(1)]);

    const result = await applyGroups(proposal(), { api: fake.api, capabilities: WITH_GROUPS });

    expect(result).toEqual({ snapshot: [], groups: [], skipped: 0 });
    expect(fake.calls).toEqual([]);
    expect(applyMessage(result)).toBeNull();
  });
});

describe('undoGroups', () => {
  /** Apply, then undo, and compare the strip with the one that was there before. */
  async function roundTrip(
    fake: ReturnType<typeof fakeStrip>,
    groupProposal: GroupProposal,
    options: Parameters<typeof applyGroups>[1] = {},
  ): Promise<ApplyResult> {
    const before = fake.describeStrips();
    const result = await applyGroups(groupProposal, {
      api: fake.api,
      capabilities: WITH_GROUPS,
      ...options,
    });
    await undoGroups(result, { api: fake.api, capabilities: WITH_GROUPS });
    expect(fake.describeStrips()).toEqual(before);
    expect(fake.brokenGroups()).toEqual([]);
    return result;
  }

  it('puts the order back exactly as it was', async () => {
    const fake = fakeStrip([tab(1), tab(2), tab(3), tab(4), tab(5)]);

    await roundTrip(
      fake,
      proposal(
        proposed('example.com', 'Example', 'blue', 1, [1, 4]),
        proposed('other.org', 'Other', 'green', 1, [2, 5]),
      ),
    );
  });

  it('puts the order back after the window was sorted by group', async () => {
    const fake = fakeStrip([
      tab(1, 1, { pinned: true }),
      tab(2),
      tab(3),
      tab(4),
      tab(5),
      tab(6, 2),
      tab(7, 2),
      tab(8, 2),
    ]);

    await roundTrip(
      fake,
      proposal(
        proposed('example.com', 'Example', 'blue', 1, [3, 5]),
        proposed('other.org', 'Other', 'green', 2, [6, 8]),
      ),
      { sortByGroup: true, collapse: true },
    );
  });

  it('pins again a tab that grouping it unpinned', async () => {
    const fake = fakeStrip([tab(1, 1, { pinned: true }), tab(2), tab(3)]);

    await roundTrip(fake, proposal(proposed('example.com', 'Example', 'blue', 1, [1, 2, 3])), {
      includePinned: true,
      sortByGroup: true,
    });
  });

  /* PLAN.md §4.4: the user's groups come back with their tabs, their title and their colour. */
  it("rebuilds a group of the user's that the ungroup emptied", async () => {
    const fake = fakeStrip([
      tab(1),
      tab(2, 1, { groupId: 500 }),
      tab(3, 1, { groupId: 500 }),
      tab(4),
    ]);
    fake.groups.set(500, {
      id: 500,
      windowId: 1,
      title: 'Reading',
      color: 'purple',
      collapsed: true,
    });

    await roundTrip(fake, proposal(proposed('example.com', 'Example', 'blue', 1, [1, 2, 3, 4])), {
      includeGrouped: true,
      sortByGroup: true,
    });
    expect(fake.membersOf('Reading')).toEqual([2, 3]);
  });

  it("leaves the user's groups alone when they were never touched", async () => {
    const fake = fakeStrip([tab(1), tab(2), tab(3, 1, { groupId: 500 })]);
    fake.groups.set(500, {
      id: 500,
      windowId: 1,
      title: 'Reading',
      color: 'purple',
      collapsed: false,
    });

    await roundTrip(fake, proposal(proposed('example.com', 'Example', 'blue', 1, [1, 2])), {
      sortByGroup: true,
    });
    // Its tabs are never grouped, ungrouped or renamed; restoring the order may move the
    // whole group back to the index it had, which is what leaves it looking untouched.
    expect(fake.membersOf('Reading')).toEqual([3]);
    expect(fake.calls.filter((call) => call.startsWith('ungroup'))).toEqual(['ungroup 1,2']);
    expect(fake.calls.filter((call) => call.startsWith('update-group 500'))).toEqual([]);
  });

  /* PLAN.md §5.5: on Firefox a group id does not survive, so the title is the handle. */
  it('puts a tab back into a group of the same title when the id is gone', async () => {
    const fake = fakeStrip([tab(1), tab(2, 1, { groupId: 500 }), tab(3)]);
    fake.groups.set(500, {
      id: 500,
      windowId: 1,
      title: 'Reading',
      color: 'purple',
      collapsed: false,
    });

    const result = await applyGroups(
      proposal(proposed('example.com', 'Example', 'blue', 1, [1, 2])),
      { api: fake.api, capabilities: WITH_GROUPS, includeGrouped: true },
    );
    // Group 500 was emptied and deleted; the user has a new "Reading" since.
    const reborn = await fake.api.tabs.group({ tabIds: [3], createProperties: { windowId: 1 } });
    await fake.api.tabGroups?.update(reborn, { title: 'Reading', color: 'purple' });

    await undoGroups(result, { api: fake.api, capabilities: WITH_GROUPS });

    expect(fake.titles()).toEqual(['Reading']);
    expect(fake.membersOf('Reading')).toEqual([2, 3]);
    expect(fake.brokenGroups()).toEqual([]);
  });

  /* PLAN.md §7.4: a tab closed in the meantime is not an error, here either. */
  it('restores the tabs that are left when one was closed after the apply', async () => {
    const fake = fakeStrip([tab(1), tab(2), tab(3), tab(4)]);

    const result = await applyGroups(
      proposal(proposed('example.com', 'Example', 'blue', 1, [2, 4])),
      { api: fake.api, capabilities: WITH_GROUPS, sortByGroup: true },
    );
    fake.close(2);
    await undoGroups(result, { api: fake.api, capabilities: WITH_GROUPS });

    expect(fake.describeStrips()).toEqual(['w1: 1 | 3 | 4']);
    expect(fake.titles()).toEqual([]);
  });

  it('does nothing when nothing was applied', async () => {
    const fake = fakeStrip([tab(1)]);

    await undoGroups(
      { snapshot: [], groups: [], skipped: 3 },
      { api: fake.api, capabilities: WITH_GROUPS },
    );

    expect(fake.calls).toEqual([]);
  });

  it('does nothing where there are no native groups', async () => {
    const fake = fakeStrip([tab(1)], { noTabGroups: true });

    await undoGroups(
      {
        snapshot: [{ tabId: 1, windowId: 1, index: 0, groupId: NO_GROUP_ID, pinned: false }],
        groups: [{ key: 'example.com', groupId: 7000, windowId: 1, title: 'Example', tabIds: [1] }],
        skipped: 0,
      },
      { api: fake.api, capabilities: WITHOUT_GROUPS },
    );

    expect(fake.calls).toEqual([]);
  });
});

interface MultiWindowTab extends FakeTab {
  active?: boolean;
}

/**
 * Multi-window extension of `fakeStrip` modelling cross-window `tabs.move({ windowId, index })`,
 * automatic closing of emptied windows, `windows.create({ tabId })`, and `tabs.update({ active })`.
 */
function fakeMultiWindowStrip(initial: readonly MultiWindowTab[], options: StripOptions = {}) {
  const strips = new Map<number, MultiWindowTab[]>();
  const groups = new Map<number, FakeGroup>();
  let nextGroupId = 7000;
  let nextWindowId = 100;

  function strip(windowId: number): MultiWindowTab[] {
    const found = strips.get(windowId);
    if (found !== undefined) return found;
    const created: MultiWindowTab[] = [];
    strips.set(windowId, created);
    return created;
  }

  for (const entry of initial) strip(entry.windowId).push({ ...entry });

  function find(tabId: number): MultiWindowTab | undefined {
    for (const list of strips.values()) {
      const found = list.find((entry) => entry.id === tabId);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  function forgetGroup(groupId: number): void {
    const group = groups.get(groupId);
    if (group === undefined) return;
    const members = (strips.get(group.windowId) ?? []).filter((entry) => entry.groupId === groupId);
    if (members.length === 0) groups.delete(groupId);
  }

  function removeFromWindow(entry: MultiWindowTab, keepWindowId?: number): void {
    const list = strips.get(entry.windowId);
    if (list === undefined) return;
    const at = list.indexOf(entry);
    if (at >= 0) list.splice(at, 1);
    if (list.length === 0 && entry.windowId !== keepWindowId) strips.delete(entry.windowId);
  }

  function place(block: readonly MultiWindowTab[], windowId: number, index: number): void {
    const list = strip(windowId);
    for (const entry of block) {
      const prevWin = entry.windowId;
      const prevGroup = entry.groupId;
      removeFromWindow(entry, windowId);
      entry.windowId = windowId;
      if (prevWin !== windowId && prevGroup !== NO_GROUP_ID) {
        entry.groupId = NO_GROUP_ID;
        forgetGroup(prevGroup);
      }
    }
    const pinned = list.filter((entry) => entry.pinned).length;
    const blockPinned = block.every((entry) => entry.pinned);
    const low = blockPinned ? 0 : pinned;
    const high = blockPinned ? pinned : list.length;
    const targetIndex = index < 0 ? high : Math.min(Math.max(index, low), high);
    list.splice(targetIndex, 0, ...block);
  }

  const api: PlanGroupsApi = {
    tabs: {
      query: () => {
        const found: BrowserTab[] = [];
        for (const [windowId, list] of strips) {
          list.forEach((entry, index) => {
            found.push({
              id: entry.id,
              windowId,
              index,
              url: `https://example.com/${String(entry.id)}`,
              title: `Tab ${String(entry.id)}`,
              pinned: entry.pinned,
              active: entry.active === true,
              groupId: entry.groupId,
            });
          });
        }
        return Promise.resolve(found);
      },

      group: (request) => {
        const members: MultiWindowTab[] = [];
        for (const tabId of request.tabIds) {
          const found = find(tabId);
          if (found === undefined) throw new Error(`No tab with id: ${String(tabId)}.`);
          members.push(found);
        }
        let groupId: number;
        let windowId: number;
        if (request.groupId === undefined) {
          windowId = request.createProperties?.windowId ?? -1;
          groupId = nextGroupId++;
          groups.set(groupId, {
            id: groupId,
            windowId,
            title: '',
            color: 'grey',
            collapsed: false,
          });
        } else {
          const target = groups.get(request.groupId);
          if (target === undefined)
            throw new Error(`No group with id: ${String(request.groupId)}.`);
          groupId = target.id;
          windowId = target.windowId;
        }
        if (members.some((entry) => entry.windowId !== windowId)) {
          throw new Error('Tabs can only be grouped in the same window.');
        }
        const list = strip(windowId);
        const existing = list.filter(
          (entry) => entry.groupId === groupId && !members.includes(entry),
        );
        const anchorIndex =
          existing.length > 0
            ? Math.max(...existing.map((entry) => list.indexOf(entry))) +
              1 -
              members.filter(
                (m) => list.indexOf(m) <= Math.max(...existing.map((e) => list.indexOf(e))),
              ).length
            : Math.min(...members.map((entry) => list.indexOf(entry)));
        const left = new Set(members.map((entry) => entry.groupId));
        for (const entry of members) {
          entry.groupId = groupId;
          entry.pinned = false;
        }
        place(members, windowId, anchorIndex);
        for (const previous of left) if (previous !== NO_GROUP_ID) forgetGroup(previous);
        return Promise.resolve(groupId);
      },

      ungroup: (tabIds) => {
        const members: MultiWindowTab[] = [];
        for (const tabId of tabIds) {
          const found = find(tabId);
          if (found === undefined) throw new Error(`No tab with id: ${String(tabId)}.`);
          members.push(found);
        }
        const left = new Set(members.map((entry) => entry.groupId));
        for (const entry of members) entry.groupId = NO_GROUP_ID;
        for (const previous of left) if (previous !== NO_GROUP_ID) forgetGroup(previous);
        return Promise.resolve(undefined);
      },

      move: (tabId, properties) => {
        const found = find(tabId);
        if (found === undefined) throw new Error(`No tab with id: ${String(tabId)}.`);
        const targetWindow = properties.windowId ?? found.windowId;
        if (!strips.has(targetWindow)) {
          throw new Error(`No window with id: ${String(targetWindow)}.`);
        }
        place([found], targetWindow, properties.index);
        return Promise.resolve(undefined);
      },

      update: (tabId, properties) => {
        const found = find(tabId);
        if (found === undefined) throw new Error(`No tab with id: ${String(tabId)}.`);
        if (properties.pinned !== undefined) {
          found.pinned = properties.pinned;
          if (properties.pinned) {
            const prev = found.groupId;
            found.groupId = NO_GROUP_ID;
            place([found], found.windowId, 0);
            if (prev !== NO_GROUP_ID) forgetGroup(prev);
          }
        }
        if (properties.active === true) {
          for (const entry of strip(found.windowId)) entry.active = entry.id === found.id;
        }
        return Promise.resolve(undefined);
      },
    },

    ...(options.noTabGroups === true
      ? {}
      : {
          tabGroups: {
            query: () => Promise.resolve([...groups.values()].map((group) => ({ ...group }))),
            update: (groupId, properties) => {
              const group = groups.get(groupId);
              if (group === undefined) throw new Error(`No group with id: ${String(groupId)}.`);
              groups.set(groupId, {
                ...group,
                title: properties.title ?? group.title,
                color: properties.color ?? group.color,
                collapsed: properties.collapsed ?? group.collapsed,
              });
              return Promise.resolve(undefined);
            },
            move: (groupId, properties) => {
              const group = groups.get(groupId);
              if (group === undefined) throw new Error(`No group with id: ${String(groupId)}.`);
              const members = strip(group.windowId).filter((entry) => entry.groupId === groupId);
              place(members, group.windowId, properties.index);
              return Promise.resolve(undefined);
            },
          },
        }),

    windows: {
      create: (properties) => {
        const windowId = nextWindowId++;
        const list = strip(windowId);
        if (properties.tabId !== undefined) {
          const found = find(properties.tabId);
          if (found !== undefined) {
            removeFromWindow(found);
            found.windowId = windowId;
            found.groupId = NO_GROUP_ID;
            found.active = true;
            list.push(found);
          }
        }
        return Promise.resolve({ id: windowId });
      },
    },
  };

  function describeWindows(): readonly string[] {
    return [...strips.values()]
      .map((list) =>
        list
          .map((entry) => {
            const group = groups.get(entry.groupId);
            const g = group === undefined ? '' : `[${group.title}/${group.color}]`;
            const a = entry.active === true ? '*' : '';
            return `${String(entry.id)}${a}${g}`;
          })
          .join(' | '),
      )
      .sort();
  }

  return { api, groups, strips, describeWindows };
}

describe('savePlanAsTabGroups and undoSavedPlanGroups', () => {
  it('saves a single-window cluster as a native tab group and restores exact order on undo', async () => {
    const fake = fakeMultiWindowStrip([
      { ...tab(1, 1), active: true },
      tab(2, 1),
      tab(3, 1),
      tab(4, 1),
    ]);
    const before = fake.describeWindows();

    const result = await savePlanAsTabGroups(
      [{ key: 'math', title: 'Mathematics', color: 'cyan', tabIds: [1, 3] }],
      { api: fake.api, capabilities: WITH_GROUPS, focusedWindowId: 1 },
    );

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ title: 'Mathematics', windowId: 1, tabIds: [1, 3] });
    expect(result.skipped).toBe(0);
    expect([...fake.groups.values()]).toMatchObject([
      { title: 'Mathematics', color: 'cyan', collapsed: false },
    ]);

    await undoSavedPlanGroups(result, { api: fake.api, capabilities: WITH_GROUPS });
    expect(fake.groups.size).toBe(0);
    expect(fake.describeWindows()).toEqual(before);
  });

  it('moves cross-window cluster tabs into the majority window, groups them, and recreates emptied windows on undo', async () => {
    const fake = fakeMultiWindowStrip([
      { ...tab(1, 1), active: true },
      tab(2, 1),
      { ...tab(3, 2), active: true },
    ]);
    const before = fake.describeWindows();

    const result = await savePlanAsTabGroups(
      [{ key: 'math', title: 'Mathematics', color: 'blue', tabIds: [1, 2, 3] }],
      { api: fake.api, capabilities: WITH_GROUPS, focusedWindowId: 1 },
    );

    // Tab 3 left window 2 (emptying it) and joined tabs 1 & 2 in window 1 under "Mathematics".
    expect(fake.strips.size).toBe(1);
    expect(result.groups[0]).toMatchObject({
      title: 'Mathematics',
      windowId: 1,
      tabIds: [1, 2, 3],
    });
    expect([...fake.groups.values()]).toMatchObject([{ title: 'Mathematics', color: 'blue' }]);

    await undoSavedPlanGroups(result, { api: fake.api, capabilities: WITH_GROUPS });

    // Window 2 was recreated with tab 3 active, and window 1 has tabs 1 & 2 ungrouped.
    expect(fake.groups.size).toBe(0);
    expect(fake.strips.size).toBe(2);
    expect(fake.describeWindows()).toEqual(before);
  });

  it('reuses an already-saved native group when a new tab joins the cluster, and undo removes only the new tab', async () => {
    const fake = fakeMultiWindowStrip([
      { ...tab(1, 1, { groupId: 500 }), active: true },
      tab(2, 1, { groupId: 500 }),
      { ...tab(3, 2), active: true },
    ]);
    fake.groups.set(500, {
      id: 500,
      windowId: 1,
      title: 'My Custom Math',
      color: 'cyan',
      collapsed: false,
    });
    const before = fake.describeWindows();

    const result = await savePlanAsTabGroups(
      [{ key: 'math', title: 'Mathematics', color: 'blue', tabIds: [1, 2, 3] }],
      { api: fake.api, capabilities: WITH_GROUPS, focusedWindowId: 1 },
    );

    // Reused group 500, preserved its custom title, and only added tab 3.
    expect(result.changedTabIds).toEqual([3]);
    expect(result.groups[0]).toMatchObject({ groupId: 500, title: 'My Custom Math', tabIds: [3] });
    expect(fake.groups.get(500)?.title).toBe('My Custom Math');

    await undoSavedPlanGroups(result, { api: fake.api, capabilities: WITH_GROUPS });

    // Group 500 remains intact with tabs 1 & 2, and tab 3 returns to its own recreated window.
    expect(fake.describeWindows()).toEqual(before);
  });

  it('saves all unsaved clusters in one batch, skips already-saved ones, and respects missing capabilities', async () => {
    const fake = fakeMultiWindowStrip([
      tab(1, 1, { groupId: 500 }),
      tab(2, 1, { groupId: 500 }),
      tab(3, 1),
      tab(4, 1),
      tab(5, 2),
      tab(6, 2),
    ]);
    fake.groups.set(500, {
      id: 500,
      windowId: 1,
      title: 'Saved',
      color: 'green',
      collapsed: false,
    });

    const noCap = await savePlanAsTabGroups(
      [{ key: 'a', title: 'A', color: 'red', tabIds: [3, 4] }],
      { api: fake.api, capabilities: WITHOUT_GROUPS },
    );
    expect(noCap.groups).toEqual([]);
    expect(noCap.skipped).toBe(2);

    const all = await savePlanAsTabGroups(
      [
        { key: 'saved', title: 'Saved', color: 'green', tabIds: [1, 2] },
        { key: 'alpha', title: 'Alpha', color: 'blue', tabIds: [3, 4] },
        { key: 'beta', title: 'Beta', color: 'purple', tabIds: [5, 6] },
      ],
      { api: fake.api, capabilities: WITH_GROUPS, focusedWindowId: 1 },
    );

    expect(all.groups.map((g) => g.title)).toEqual(['Alpha', 'Beta']);
    expect([...fake.groups.values()].map((g) => g.title).sort()).toEqual([
      'Alpha',
      'Beta',
      'Saved',
    ]);

    await undoSavedPlanGroups(all, { api: fake.api, capabilities: WITH_GROUPS });
    // Pre-existing "Saved" group stays intact; Alpha and Beta are removed.
    expect([...fake.groups.values()].map((g) => g.title)).toEqual(['Saved']);
  });
});
