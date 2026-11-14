/**
 * `src/entrypoints/sidepanel/organize.ts`: the editable preview of PLAN.md §4.4.3.
 *
 * These are the edits TASKS.md M4.3 asks to cover as pure functions — rename, colour,
 * deselect, "Sposta in…", merge — plus what the preview promises about them: an edit
 * changes one group and nothing else, a blank name falls back to the suggested one, a move
 * or a merge never crosses a window, and the draft handed in is never modified.
 */

import { describe, expect, it } from 'vitest';

import type { GroupProposal } from '../../src/core/cluster';
import type { TabInfo } from '../../src/core/types';
import { NO_GROUP_ID } from '../../src/core/types';
import type { Draft } from '../../src/entrypoints/sidepanel/organize';
import {
  applyOptionsOf,
  clusterOptionsOf,
  DEFAULT_ORGANIZE_OPTIONS,
  draftOf,
  mergeGroups,
  mergeTargets,
  moveTab,
  moveTargets,
  plannedCount,
  proposalOf,
  recolorGroup,
  renameGroup,
  tabsInScope,
  toggleGroup,
  windowOrder,
} from '../../src/entrypoints/sidepanel/organize';

/** A proposal of two site groups in one window, plus one tab in "Altro". */
function proposal(): GroupProposal {
  return {
    mode: 'site',
    groups: [
      { key: 'github.com', title: 'GitHub', color: 'blue', windowId: 1, tabIds: [1, 2, 3] },
      { key: 'figma.com', title: 'Figma', color: 'pink', windowId: 1, tabIds: [4, 5, 6] },
    ],
    ungrouped: [7],
  };
}

/** The same, with the second group in another window: what a cross-window edit must refuse. */
function acrossWindows(): GroupProposal {
  return {
    mode: 'site',
    groups: [
      { key: 'github.com', title: 'GitHub', color: 'blue', windowId: 1, tabIds: [1, 2, 3] },
      { key: 'figma.com', title: 'Figma', color: 'pink', windowId: 2, tabIds: [4, 5, 6] },
    ],
    ungrouped: [7],
  };
}

/** Group key → its tabs, which is what the assertions about membership read. */
function membership(draft: Draft): Record<string, readonly number[]> {
  return Object.fromEntries(draft.groups.map((group) => [group.key, group.tabIds]));
}

function tab(id: number, windowId: number): TabInfo {
  return {
    id,
    windowId,
    index: id,
    url: `https://example.com/${String(id)}`,
    title: `Tab ${String(id)}`,
    pinned: false,
    audible: false,
    active: false,
    discarded: false,
    hidden: false,
    groupId: NO_GROUP_ID,
    incognito: false,
  };
}

describe('draftOf', () => {
  it('shows every proposed group, selected, named as proposed', () => {
    const draft = draftOf(proposal());

    expect(draft.mode).toBe('site');
    expect(draft.groups.map((group) => group.key)).toEqual(['github.com', 'figma.com']);
    expect(draft.groups.every((group) => group.selected)).toBe(true);
    expect(draft.groups.map((group) => group.title)).toEqual(['GitHub', 'Figma']);
    // `suggested` is the same until the user types, and is what a cleared box falls back to.
    expect(draft.groups.map((group) => group.suggested)).toEqual(['GitHub', 'Figma']);
    expect(draft.ungrouped).toEqual([7]);
  });
});

describe('renameGroup', () => {
  it('renames one group and leaves the other alone', () => {
    const draft = renameGroup(draftOf(proposal()), 'github.com', 'Codice');

    expect(draft.groups.map((group) => group.title)).toEqual(['Codice', 'Figma']);
  });

  it('does not recolour: the colour follows the key, not the name', () => {
    const draft = renameGroup(draftOf(proposal()), 'github.com', 'Codice');

    expect(draft.groups.map((group) => group.color)).toEqual(['blue', 'pink']);
  });

  it('keeps what was typed, so backspacing to nothing works', () => {
    const draft = renameGroup(draftOf(proposal()), 'github.com', '');

    expect(draft.groups[0]?.title).toBe('');
  });

  it('applies the suggested name when the box was left blank', () => {
    const blank = renameGroup(draftOf(proposal()), 'github.com', '   ');

    expect(proposalOf(blank).groups[0]?.title).toBe('GitHub');
  });

  it('trims what is applied, so a stray space is not a name', () => {
    const typed = renameGroup(draftOf(proposal()), 'github.com', '  Codice  ');

    expect(proposalOf(typed).groups[0]?.title).toBe('Codice');
  });

  it('ignores a key no group has', () => {
    const draft = draftOf(proposal());

    expect(renameGroup(draft, 'nowhere.example', 'X')).toBe(draft);
  });
});

describe('recolorGroup', () => {
  it('changes the colour of one group', () => {
    const draft = recolorGroup(draftOf(proposal()), 'figma.com', 'green');

    expect(draft.groups.map((group) => group.color)).toEqual(['blue', 'green']);
    expect(proposalOf(draft).groups[1]?.color).toBe('green');
  });
});

describe('toggleGroup', () => {
  it('deselects a group, which stays in the preview but is not applied', () => {
    const draft = toggleGroup(draftOf(proposal()), 'github.com');

    expect(draft.groups).toHaveLength(2);
    expect(draft.groups[0]?.selected).toBe(false);
    expect(proposalOf(draft).groups.map((group) => group.key)).toEqual(['figma.com']);
  });

  it('selects it again', () => {
    const draft = toggleGroup(toggleGroup(draftOf(proposal()), 'github.com'), 'github.com');

    expect(proposalOf(draft).groups).toHaveLength(2);
  });
});

describe('moveTargets and mergeTargets', () => {
  it('offer the other groups of the same window', () => {
    const draft = draftOf(proposal());

    expect(moveTargets(draft, 1).map((group) => group.key)).toEqual(['figma.com']);
    expect(mergeTargets(draft, 'github.com').map((group) => group.key)).toEqual(['figma.com']);
  });

  it('offer nothing across windows: a native group holds tabs of one window', () => {
    const draft = draftOf(acrossWindows());

    expect(moveTargets(draft, 1)).toEqual([]);
    expect(mergeTargets(draft, 'github.com')).toEqual([]);
  });

  it('offer nothing for a tab in "Altro", which is a destination and not a source', () => {
    expect(moveTargets(draftOf(proposal()), 7)).toEqual([]);
  });

  it('offer nothing for a key no group has', () => {
    expect(mergeTargets(draftOf(proposal()), 'nowhere.example')).toEqual([]);
  });
});

describe('moveTab', () => {
  it('moves a tab between groups, keeping the source order and appending to the target', () => {
    const draft = moveTab(draftOf(proposal()), 1, 'figma.com');

    expect(membership(draft)).toEqual({ 'github.com': [2, 3], 'figma.com': [4, 5, 6, 1] });
    expect(draft.ungrouped).toEqual([7]);
  });

  it('takes a tab out of every group with `null`, which is "Altro"', () => {
    const draft = moveTab(draftOf(proposal()), 2, null);

    expect(membership(draft)).toEqual({ 'github.com': [1, 3], 'figma.com': [4, 5, 6] });
    expect(draft.ungrouped).toEqual([7, 2]);
  });

  it('drops a group its last tab has left', () => {
    const one = draftOf({
      mode: 'site',
      groups: [
        { key: 'a.example', title: 'A', color: 'blue', windowId: 1, tabIds: [1] },
        { key: 'b.example', title: 'B', color: 'red', windowId: 1, tabIds: [2, 3] },
      ],
      ungrouped: [],
    });

    const moved = moveTab(one, 1, 'b.example');

    expect(moved.groups.map((group) => group.key)).toEqual(['b.example']);
    expect(membership(moved)).toEqual({ 'b.example': [2, 3, 1] });
  });

  it('refuses a target in another window', () => {
    const draft = draftOf(acrossWindows());

    expect(moveTab(draft, 1, 'figma.com')).toBe(draft);
  });

  it('refuses an unknown target, the group the tab is already in, and an ungrouped tab', () => {
    const draft = draftOf(proposal());

    expect(moveTab(draft, 1, 'nowhere.example')).toBe(draft);
    expect(moveTab(draft, 1, 'github.com')).toBe(draft);
    expect(moveTab(draft, 7, 'github.com')).toBe(draft);
    expect(moveTab(draft, 99, 'github.com')).toBe(draft);
  });
});

describe('mergeGroups', () => {
  it('empties one group into the other, which keeps its key, name and colour', () => {
    const named = renameGroup(draftOf(proposal()), 'figma.com', 'Design');
    const draft = mergeGroups(named, 'github.com', 'figma.com');

    expect(draft.groups).toHaveLength(1);
    expect(draft.groups[0]?.key).toBe('figma.com');
    expect(draft.groups[0]?.title).toBe('Design');
    expect(draft.groups[0]?.color).toBe('pink');
    expect(draft.groups[0]?.tabIds).toEqual([4, 5, 6, 1, 2, 3]);
  });

  it('refuses the same group, an unknown one and another window', () => {
    const draft = draftOf(proposal());
    const split = draftOf(acrossWindows());

    expect(mergeGroups(draft, 'github.com', 'github.com')).toBe(draft);
    expect(mergeGroups(draft, 'github.com', 'nowhere.example')).toBe(draft);
    expect(mergeGroups(draft, 'nowhere.example', 'github.com')).toBe(draft);
    expect(mergeGroups(split, 'github.com', 'figma.com')).toBe(split);
  });
});

describe('proposalOf', () => {
  it('keeps the mode and "Altro", and drops what is deselected', () => {
    const draft = toggleGroup(draftOf(proposal()), 'figma.com');
    const applied = proposalOf(draft);

    expect(applied.mode).toBe('site');
    expect(applied.ungrouped).toEqual([7]);
    expect(applied.groups.map((group) => group.key)).toEqual(['github.com']);
  });
});

describe('plannedCount and windowOrder', () => {
  it('counts the tabs of the selected groups only', () => {
    const draft = draftOf(proposal());

    expect(plannedCount(draft)).toBe(6);
    expect(plannedCount(toggleGroup(draft, 'github.com'))).toBe(3);
  });

  it('names the windows once each, in the order the groups do', () => {
    expect(windowOrder(draftOf(proposal()))).toEqual([1]);
    expect(windowOrder(draftOf(acrossWindows()))).toEqual([1, 2]);
  });
});

describe('tabsInScope', () => {
  const tabs = [tab(1, 1), tab(2, 1), tab(3, 2)];

  it('takes the focused window for "Finestra corrente"', () => {
    expect(tabsInScope(tabs, 'window', null, 1).map((found) => found.id)).toEqual([1, 2]);
  });

  it('takes everything when the browser does not say which window is focused', () => {
    expect(tabsInScope(tabs, 'window', null, undefined)).toHaveLength(3);
  });

  it('takes everything for "Tutte le finestre"', () => {
    expect(tabsInScope(tabs, 'all', null, 1)).toHaveLength(3);
  });

  it('takes exactly the ids "Raggruppa" brought, ignoring ones no longer open', () => {
    expect(tabsInScope(tabs, 'selection', [3, 1, 99], 1).map((found) => found.id)).toEqual([1, 3]);
  });

  it('takes nothing when "Raggruppa" never ran', () => {
    expect(tabsInScope(tabs, 'selection', null, 1)).toEqual([]);
  });
});

describe('the options of §4.4.4', () => {
  it('turn "leave pinned out" into cluster.ts\'s "include pinned"', () => {
    expect(clusterOptionsOf(DEFAULT_ORGANIZE_OPTIONS)).toEqual({
      includePinned: false,
      includeGrouped: false,
    });
    expect(
      clusterOptionsOf({ ...DEFAULT_ORGANIZE_OPTIONS, leavePinnedOut: false }).includePinned,
    ).toBe(true);
  });

  it('pass the two exclusions on to the apply as well as to the proposal', () => {
    expect(
      applyOptionsOf({ ...DEFAULT_ORGANIZE_OPTIONS, sortByGroup: true, collapse: true }),
    ).toEqual({ sortByGroup: true, collapse: true, includePinned: false, includeGrouped: false });
  });

  it('leaves pinned tabs out by default, as §4.4.4 has it', () => {
    expect(DEFAULT_ORGANIZE_OPTIONS.leavePinnedOut).toBe(true);
  });
});

describe('every edit', () => {
  it('leaves the draft it was given untouched', () => {
    const draft = draftOf(proposal());
    const before = JSON.stringify(draft);

    renameGroup(draft, 'github.com', 'Codice');
    recolorGroup(draft, 'github.com', 'green');
    toggleGroup(draft, 'github.com');
    moveTab(draft, 1, 'figma.com');
    moveTab(draft, 1, null);
    mergeGroups(draft, 'github.com', 'figma.com');

    expect(JSON.stringify(draft)).toBe(before);
  });
});
