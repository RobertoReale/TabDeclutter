/**
 * The editable preview of PLAN.md §4.4.3, as pure functions over a draft.
 *
 * `src/core/cluster.ts` proposes the groups; this is what the user then does to the
 * proposal before it reaches the browser — rename, recolour, deselect, "Sposta in…",
 * merge — and `proposalOf` turns what is left into the `GroupProposal`
 * `platform/groups.ts` applies. Every function takes a draft and returns a new one, so
 * the view is a function of one signal and the edits are tested without a browser or a
 * renderer (TASKS.md M4.3's "unit tests on the preview edits").
 *
 * Two rules the spec fixes and this module keeps:
 *
 * - A group's `key` is its identity, not its name: the colour is the hash of the key
 *   (`colorFor`), so renaming never recolours, and a merge keeps the key of the group
 *   merged *into*. `suggested` is what the proposal called it, which is what a name box
 *   emptied to nothing falls back to — a group with no name at all would reach Chrome as
 *   a coloured dot nobody can read.
 * - "Altro" is not a group (§7.2.4): it is `ungrouped`, a destination for a tab taken out
 *   of a group and never a source, because §4.4.3 moves a tab *between groups* and a tab
 *   in "Altro" has no window of its own in the proposal.
 *
 * A move or a merge only ever happens inside one window: a native group holds tabs of one
 * window (§7.4), so `moveTargets` and `mergeTargets` are what the menus offer and the
 * edits refuse anything else rather than silently producing a group no browser can make.
 */

// Relative, not `@/`: the `unit` vitest project runs without WXT's plugin and so without
// WXT's alias, and this module is tested there.
import type { ClusterMode, ClusterOptions, GroupColor, GroupProposal } from '../../core/cluster';
import type { TabInfo } from '../../core/types';

/** Which tabs the preview is about (PLAN.md §4.4.1, plus §4.3's "Raggruppa"). */
export type OrganizeScope = 'window' | 'all' | 'selection';

/** One proposed group, with what the preview lets the user change about it. */
export interface DraftGroup {
  /** The proposal's own key: the identity the colour hashes off (`cluster.ts`). */
  readonly key: string;
  /** What the proposal called it, and what a cleared name box falls back to. */
  readonly suggested: string;
  /** What the name box holds, exactly as typed. */
  readonly title: string;
  readonly color: GroupColor;
  readonly windowId: number;
  readonly tabIds: readonly number[];
  /** A deselected group stays in the preview and is not applied (§4.4.3). */
  readonly selected: boolean;
}

/** The proposal as the preview holds it. */
export interface Draft {
  readonly mode: ClusterMode;
  readonly groups: readonly DraftGroup[];
  /** "Altro" (§7.2.4): never applied, and what a tab taken out of a group joins. */
  readonly ungrouped: readonly number[];
}

/** The four options of PLAN.md §4.4.4, in its wording. */
export interface OrganizeOptions {
  /** "Ordina le schede nella finestra per gruppo". */
  readonly sortByGroup: boolean;
  /** "Comprimi i gruppi". */
  readonly collapse: boolean;
  /** "Lascia fuori le schede fissate", which §4.4.4 has on. */
  readonly leavePinnedOut: boolean;
  /** §4.4's last bullet: a tab already in one of the user's groups is left alone. */
  readonly includeGrouped: boolean;
}

export const DEFAULT_ORGANIZE_OPTIONS: OrganizeOptions = {
  sortByGroup: false,
  collapse: false,
  leavePinnedOut: true,
  includeGrouped: false,
};

/** The two of §4.4.4's options that change what is *proposed* (`cluster.ts`). */
export function clusterOptionsOf(options: OrganizeOptions): ClusterOptions {
  return { includePinned: !options.leavePinnedOut, includeGrouped: options.includeGrouped };
}

/** What a group must be named for the browser: never the empty string. */
function nameOf(group: DraftGroup): string {
  const typed = group.title.trim();
  return typed === '' ? group.suggested : typed;
}

/**
 * The four options as `platform/groups.ts`'s `applyGroups` takes them. The two exclusions
 * are passed on as well as used for the proposal: between the preview and [Applica] a tab
 * can have been pinned or grouped by hand, and the option is about the tab, not the moment.
 */
export function applyOptionsOf(options: OrganizeOptions): {
  readonly sortByGroup: boolean;
  readonly collapse: boolean;
  readonly includePinned: boolean;
  readonly includeGrouped: boolean;
} {
  return {
    sortByGroup: options.sortByGroup,
    collapse: options.collapse,
    includePinned: !options.leavePinnedOut,
    includeGrouped: options.includeGrouped,
  };
}

/**
 * The tabs the chosen scope is about (§4.4.1).
 *
 * "Finestra corrente" is the window the panel is in (`state/tabs.ts`'s `focusedWindowId`);
 * a browser that does not say which that is leaves every tab in scope, which is the answer
 * "Tutte le finestre" gives anyway. "Selezione" is §4.3's "Raggruppa": exactly the ids it
 * brought, and nothing when it brought none.
 */
export function tabsInScope(
  tabs: readonly TabInfo[],
  scope: OrganizeScope,
  brought: readonly number[] | null,
  focusedWindowId?: number,
): readonly TabInfo[] {
  if (scope === 'selection') {
    if (brought === null) return [];
    const wanted = new Set(brought);
    return tabs.filter((tab) => wanted.has(tab.id));
  }
  if (scope === 'window' && focusedWindowId !== undefined) {
    return tabs.filter((tab) => tab.windowId === focusedWindowId);
  }
  return tabs;
}

/** A proposal as the preview first shows it: everything in, nothing renamed. */
export function draftOf(proposal: GroupProposal): Draft {
  return {
    mode: proposal.mode,
    groups: proposal.groups.map((group) => ({
      key: group.key,
      suggested: group.title,
      title: group.title,
      color: group.color,
      windowId: group.windowId,
      tabIds: group.tabIds,
      selected: true,
    })),
    ungrouped: proposal.ungrouped,
  };
}

/** The draft with one group changed, or the draft itself when there is no such group. */
function withGroup(draft: Draft, key: string, change: (group: DraftGroup) => DraftGroup): Draft {
  if (!draft.groups.some((group) => group.key === key)) return draft;
  return {
    ...draft,
    groups: draft.groups.map((group) => (group.key === key ? change(group) : group)),
  };
}

/**
 * §4.4.3's inline rename. What the user typed is kept as typed, so backspacing to nothing
 * works; `proposalOf` is where a blank name becomes the suggested one again.
 */
export function renameGroup(draft: Draft, key: string, title: string): Draft {
  return withGroup(draft, key, (group) => ({ ...group, title }));
}

/** §4.4.3's colour, out of Chrome's own palette (`GROUP_COLORS`). */
export function recolorGroup(draft: Draft, key: string, color: GroupColor): Draft {
  return withGroup(draft, key, (group) => ({ ...group, color }));
}

/** §4.4.3's "a group can be deselected", and selected again. */
export function toggleGroup(draft: Draft, key: string): Draft {
  return withGroup(draft, key, (group) => ({ ...group, selected: !group.selected }));
}

/** The group a tab is in, or `undefined` when it is in "Altro". */
function holderOf(draft: Draft, tabId: number): DraftGroup | undefined {
  return draft.groups.find((group) => group.tabIds.includes(tabId));
}

/** Where §4.4.3's "Sposta in…" can take that tab: the other groups of its own window. */
export function moveTargets(draft: Draft, tabId: number): readonly DraftGroup[] {
  const holder = holderOf(draft, tabId);
  if (holder === undefined) return [];
  return draft.groups.filter(
    (group) => group.key !== holder.key && group.windowId === holder.windowId,
  );
}

/** Which groups that one can be merged into: the other groups of its window. */
export function mergeTargets(draft: Draft, key: string): readonly DraftGroup[] {
  const group = draft.groups.find((candidate) => candidate.key === key);
  if (group === undefined) return [];
  return draft.groups.filter(
    (candidate) => candidate.key !== key && candidate.windowId === group.windowId,
  );
}

/**
 * §4.4.3's "Sposta in…": a tab from one group to another of the same window, or out of
 * every group with `to === null`, which puts it in "Altro".
 *
 * A group the move empties leaves the preview: a group with no tabs is not something the
 * user can apply, deselect or read, and keeping it would only be a row that does nothing.
 */
export function moveTab(draft: Draft, tabId: number, to: string | null): Draft {
  const holder = holderOf(draft, tabId);
  if (holder === undefined) return draft;

  if (to !== null) {
    const target = draft.groups.find((group) => group.key === to);
    if (target === undefined || target.key === holder.key) return draft;
    if (target.windowId !== holder.windowId) return draft;
  }

  const groups = draft.groups
    .map((group) => {
      if (group.key === holder.key) {
        return { ...group, tabIds: group.tabIds.filter((id) => id !== tabId) };
      }
      if (group.key === to) return { ...group, tabIds: [...group.tabIds, tabId] };
      return group;
    })
    .filter((group) => group.tabIds.length > 0);

  return {
    ...draft,
    groups,
    ungrouped: to === null ? [...draft.ungrouped, tabId] : draft.ungrouped,
  };
}

/**
 * §4.4.3's "two groups can be merged": `from` is emptied into `into`, which keeps its own
 * key, name and colour — the key is the identity the colour hashes off, so the merged
 * group stays the colour the user was looking at.
 */
export function mergeGroups(draft: Draft, fromKey: string, intoKey: string): Draft {
  if (fromKey === intoKey) return draft;
  const from = draft.groups.find((group) => group.key === fromKey);
  const into = draft.groups.find((group) => group.key === intoKey);
  if (from === undefined || into === undefined) return draft;
  if (from.windowId !== into.windowId) return draft;

  return {
    ...draft,
    groups: draft.groups
      .filter((group) => group.key !== fromKey)
      .map((group) =>
        group.key === intoKey ? { ...group, tabIds: [...group.tabIds, ...from.tabIds] } : group,
      ),
  };
}

/** The windows the draft spans, in the order its groups first name them. */
export function windowOrder(draft: Draft): readonly number[] {
  return [...new Set(draft.groups.map((group) => group.windowId))];
}

/** How many tabs [Applica] would group, which is what makes the button worth pressing. */
export function plannedCount(draft: Draft): number {
  return draft.groups.reduce(
    (total, group) => (group.selected ? total + group.tabIds.length : total),
    0,
  );
}

/**
 * What [Applica] sends to `platform/groups.ts`: the groups still selected, named as the
 * preview names them. "Altro" is carried along unchanged and is never applied (§7.2.4).
 */
export function proposalOf(draft: Draft): GroupProposal {
  return {
    mode: draft.mode,
    groups: draft.groups
      .filter((group) => group.selected && group.tabIds.length > 0)
      .map((group) => ({
        key: group.key,
        title: nameOf(group),
        color: group.color,
        windowId: group.windowId,
        tabIds: group.tabIds,
      })),
    ungrouped: draft.ungrouped,
  };
}
