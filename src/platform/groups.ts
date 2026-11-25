/**
 * The proposal becomes native tab groups, and "Annulla" puts the window back exactly as it
 * was (PLAN.md §7.4, §4.4 points 4-5).
 *
 * `core/cluster.ts` decides what the groups should be and nothing more; this is the only
 * part that calls `tabs.group`, `tabs.ungroup`, `tabs.move` and `tabGroups.*`, with the
 * same code for both browsers (PLAN.md §5.5, "Tab groups"). Three rules shape everything
 * below.
 *
 * - **The snapshot is read from the browser, not from the proposal** (PLAN.md §7.4): the
 *   indexes undo has to put back are the ones the tabs have the instant before they move,
 *   and a preview may have been on screen for minutes. It covers every tab of every window
 *   a group lands in, because sorting by group moves tabs that are in no group at all.
 * - **A call that fails because the thing is already gone is not an error** (PLAN.md §7.4,
 *   "a tab closed in the meantime"): what can be grouped is grouped, and the tabs that
 *   stayed out are counted and reported once, through `applyMessage`.
 * - **A tab is never moved between windows, and a grouped tab is never moved on its own.**
 *   A group lives in one window (PLAN.md §7.4), and a group is moved with `tabGroups.move`,
 *   which carries all of its tabs: moving one of them to an index outside its group is how
 *   a group comes apart, so restoring an order never does it.
 *
 * Nothing here decides *whether* to group: the two exclusions of PLAN.md §4.4 ("Lascia
 * fuori le schede fissate", the user's own groups) are options of the proposal too, and
 * they are checked again here against the browser's current state, which is the only state
 * that can still be wrong at the moment of the call.
 */

import type { GroupColor, GroupProposal } from '../core/cluster';
import { GROUP_COLORS } from '../core/cluster';
import { planNativeTabGroups, type PlanCluster } from '../core/plan-groups';
import type { TabInfo } from '../core/types';
import { NO_GROUP_ID } from '../core/types';
import type { Capabilities } from './capabilities';
import { caps } from './capabilities';
import type { MessageKey } from './i18n';
import { asTabInfos, attempt, NO_WINDOW } from './tabs';
import type { Attempt, BrowserTab, BrowserTabGroup } from './tabs';

/** What `tabGroups.update` accepts, which is exactly what PLAN.md §7.4 sets. */
export interface GroupProperties {
  readonly title?: string;
  readonly color?: GroupColor;
  readonly collapsed?: boolean;
}

/**
 * A group as the browser reports it. `BrowserTabGroup` plus the two properties only this
 * module reads: nothing else needs a group's colour or whether it is collapsed.
 */
interface RawTabGroup extends BrowserTabGroup {
  color?: string;
  collapsed?: boolean;
}

/** A group as this module keeps it: what undo needs to build the same group again. */
export interface TabGroupInfo {
  readonly id: number;
  readonly windowId: number;
  readonly title: string;
  readonly color: GroupColor;
  readonly collapsed: boolean;
}

/** The slice of the extension API this module uses. Injected, as everywhere here. */
export interface GroupsApi {
  tabs: {
    query(query: Record<string, unknown>): Promise<BrowserTab[]>;
    /** Resolves with the group's id, whether it was created or joined. */
    group(options: {
      tabIds: readonly number[];
      groupId?: number;
      createProperties?: { windowId: number };
    }): Promise<number>;
    ungroup(tabIds: readonly number[]): Promise<unknown>;
    move(tabId: number, properties: { index: number }): Promise<unknown>;
    /** Only ever used to pin a tab again that grouping it unpinned. */
    update(tabId: number, properties: { pinned: boolean }): Promise<unknown>;
  };
  /** Absent where there are no native tab groups (`capabilities.tabGroups`). */
  tabGroups?: {
    query(query: Record<string, unknown>): Promise<RawTabGroup[]>;
    update(groupId: number, properties: GroupProperties): Promise<unknown>;
    /** Moves the group with all of its tabs. No `create`: neither browser has one. */
    move(groupId: number, properties: { index: number }): Promise<unknown>;
  };
}

function groupsApi(): GroupsApi {
  return browser as unknown as GroupsApi;
}

/**
 * Where one tab was before the groups were applied (PLAN.md §7.4), plus the group it was
 * in, so that undo can build that group again when its id no longer answers (PLAN.md §5.5:
 * on Firefox a group id does not survive a restart and `sessions` never reports one).
 */
export interface TabSnapshot {
  readonly tabId: number;
  readonly windowId: number;
  readonly index: number;
  readonly groupId: number;
  /**
   * Whether the tab was pinned. Grouping a pinned tab unpins it — neither browser keeps a
   * pinned tab in a group — so without this, "Lascia fuori le schede fissate" turned off
   * would make undo leave the tab unpinned.
   */
  readonly pinned: boolean;
  /** Absent for a tab that was in no group, and for a group the browser would not report. */
  readonly group?: TabGroupInfo;
}

/** One group that now exists in the browser, as `undoGroups` has to unmake it. */
export interface AppliedGroup {
  /** The proposal's key, so the view can tell which of its groups this was. */
  readonly key: string;
  readonly groupId: number;
  readonly windowId: number;
  readonly title: string;
  /** The tabs that really went in, which can be fewer than the proposal asked for. */
  readonly tabIds: readonly number[];
}

export interface ApplyResult {
  /** Every tab of every window a group landed in, as it was. Undo's only input. */
  readonly snapshot: readonly TabSnapshot[];
  readonly groups: readonly AppliedGroup[];
  /**
   * How many tabs the proposal named and the browser could not group: closed, moved to
   * another window, or refused. Tabs left out on purpose — pinned, or in one of the user's
   * groups — are not failures and are not counted here (PLAN.md §4.4).
   */
  readonly skipped: number;
}

export interface ApplyOptions {
  readonly api?: GroupsApi;
  readonly capabilities?: Capabilities;
  /** PLAN.md §4.4.4 "Ordina le schede nella finestra per gruppo". */
  readonly sortByGroup?: boolean;
  /** PLAN.md §4.4.4 "Comprimi i gruppi". */
  readonly collapse?: boolean;
  /** PLAN.md §4.4.4 "Lascia fuori le schede fissate": off, so pinned tabs stay out. */
  readonly includePinned?: boolean;
  /** PLAN.md §4.4: a tab already in one of the user's groups is left alone by default. */
  readonly includeGrouped?: boolean;
}

export type UndoOptions = Pick<ApplyOptions, 'api' | 'capabilities'>;

/** A proposal that grouped nothing: no snapshot to keep and nothing to undo. */
const NOTHING_APPLIED: ApplyResult = { snapshot: [], groups: [], skipped: 0 };

/**
 * The groups of the proposal, created in the browser (PLAN.md §7.4).
 *
 * One `tabs.group` per group and per window — a group holds tabs of one window, and the
 * proposal is already per window (PLAN.md §7.4) — then one `tabGroups.update` with the
 * title, the colour and the collapsed state §7.4 names. The groups are created in the
 * proposal's own order, which is the order the preview showed and the order "Ordina le
 * schede nella finestra per gruppo" then lays out in the tab strip.
 *
 * What comes back is what undo needs and what the toast needs: the snapshot, the groups
 * that exist now, and how many tabs did not make it.
 */
export async function applyGroups(
  proposal: GroupProposal,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const proposed = proposal.groups.reduce((total, group) => total + group.tabIds.length, 0);
  if (proposed === 0) return NOTHING_APPLIED;

  // A browser with no native groups does not offer Organize at all (PLAN.md §5.5); a
  // proposal that arrives here anyway groups nothing, and says so.
  const capabilities = options.capabilities ?? caps;
  if (!capabilities.tabGroups) return { ...NOTHING_APPLIED, skipped: proposed };

  const api = options.api ?? groupsApi();
  const live = await liveTabs(api);
  if (live === null) return { ...NOTHING_APPLIED, skipped: proposed };

  const byId = new Map(live.map((tab) => [tab.id, tab]));
  const windows = new Set(proposal.groups.map((group) => group.windowId));
  const existing = await liveGroups(api);
  const snapshot = live
    .filter((tab) => windows.has(tab.windowId))
    .map((tab) => snapshotOf(tab, existing));

  const applied: AppliedGroup[] = [];
  let skipped = 0;
  for (const group of proposal.groups) {
    const chosen: number[] = [];
    for (const tabId of group.tabIds) {
      const tab = byId.get(tabId);
      // Closed, or in another window by now: §7.4 moves no tab between windows.
      if (tab === undefined || tab.windowId !== group.windowId) {
        skipped += 1;
        continue;
      }
      if (tab.pinned && options.includePinned !== true) continue;
      if (tab.groupId !== NO_GROUP_ID && options.includeGrouped !== true) continue;
      chosen.push(tabId);
    }
    if (chosen.length === 0) continue;

    const created = await createGroup(api, chosen, group.windowId);
    skipped += chosen.length - created.tabIds.length;
    const groupId = created.groupId;
    if (groupId === null) continue;

    await attempt(async () =>
      api.tabGroups?.update(groupId, {
        title: group.title,
        color: group.color,
        collapsed: options.collapse === true,
      }),
    );
    applied.push({
      key: group.key,
      groupId,
      windowId: group.windowId,
      title: group.title,
      tabIds: created.tabIds,
    });
  }

  if (options.sortByGroup === true) await sortByGroup(api, applied, live);
  return { snapshot, groups: applied, skipped };
}

/**
 * One group, with as many of its tabs as the browser still accepts.
 *
 * The batch is tried first, because that is one call and one animation. A single id the
 * user closed a moment ago makes the whole call fail on Chrome, exactly as `tabs.remove`
 * does (PLAN.md §8.6), so the ids are then tried one by one: the first one that works
 * creates the group and the rest join it, and a group of four survives a fifth tab that
 * went.
 */
async function createGroup(
  api: GroupsApi,
  tabIds: readonly number[],
  windowId: number,
): Promise<{ readonly groupId: number | null; readonly tabIds: readonly number[] }> {
  const batch = await attempt(() => api.tabs.group({ tabIds, createProperties: { windowId } }));
  if (batch.ok) return { groupId: batch.value, tabIds };

  let groupId: number | null = null;
  const grouped: number[] = [];
  for (const tabId of tabIds) {
    const target: number | null = groupId;
    const one: Attempt<number> = await attempt(() =>
      target === null
        ? api.tabs.group({ tabIds: [tabId], createProperties: { windowId } })
        : api.tabs.group({ tabIds: [tabId], groupId: target }),
    );
    if (!one.ok) continue;
    groupId ??= one.value;
    grouped.push(tabId);
  }
  return { groupId, tabIds: grouped };
}

/**
 * "Ordina le schede nella finestra per gruppo" (PLAN.md §4.4.4): the groups we just made
 * lead the window, in the order the preview listed them.
 *
 * `tabGroups.move` and not a tab at a time: it takes the group with every tab in it, so
 * the strip cannot end up with a group broken in half. The first position is the one after
 * the pinned tabs — they always lead the strip, and no group can be placed before them.
 * Everything else in the window keeps its relative order and only slides, which is also
 * what leaves the user's own groups untouched (PLAN.md §4.4).
 */
async function sortByGroup(
  api: GroupsApi,
  applied: readonly AppliedGroup[],
  live: readonly TabInfo[],
): Promise<void> {
  // A tab we grouped is not pinned any more, so it does not hold a place at the head.
  const grouped = new Set(applied.flatMap((group) => [...group.tabIds]));
  for (const windowId of [...new Set(applied.map((entry) => entry.windowId))]) {
    let index = live.filter(
      (tab) => tab.windowId === windowId && tab.pinned && !grouped.has(tab.id),
    ).length;
    for (const group of applied.filter((entry) => entry.windowId === windowId)) {
      await attempt(async () => api.tabGroups?.move(group.groupId, { index }));
      index += group.tabIds.length;
    }
  }
}

/**
 * "Annulla" (PLAN.md §4.4.5): the groups we made are undone, and every tab is back in the
 * group and at the index the snapshot recorded.
 *
 * In four passes, in this order, because each one depends on the one before:
 *
 * 1. our groups go first — a tab cannot be put back anywhere while it is still in one, and
 *    a group both browsers see as empty disappears on its own, so no group is left behind;
 * 2. a tab that grouping unpinned is pinned again, which is also what puts it back at the
 *    head of the strip where the pinned tabs live;
 * 3. the groups the tabs were in come back, by id, by title, or built again from the
 *    snapshot (PLAN.md §5.5);
 * 4. the order is restored last, lowest index first, a whole group at a time.
 *
 * A tab that has been closed in the meantime is simply left out of all of them: the others
 * still end up in the order they were in, which is what undo promises.
 */
export async function undoGroups(result: ApplyResult, options: UndoOptions = {}): Promise<void> {
  if (result.groups.length === 0) return;
  const capabilities = options.capabilities ?? caps;
  if (!capabilities.tabGroups) return;
  const api = options.api ?? groupsApi();

  await ungroupAll(
    api,
    result.groups.flatMap((group) => [...group.tabIds]),
  );

  const live = await liveTabs(api);
  if (live === null) return;
  const byId = new Map(live.map((tab) => [tab.id, tab]));
  const here = result.snapshot.filter((entry) => byId.has(entry.tabId));

  await repin(api, here, byId);
  const groupIds = await restoreGroups(api, here, byId);
  await restoreOrder(api, here, groupIds);
}

/** Pinned again, for the tabs that were pinned and are not any more. */
async function repin(
  api: GroupsApi,
  entries: readonly TabSnapshot[],
  byId: ReadonlyMap<number, TabInfo>,
): Promise<void> {
  for (const entry of entries) {
    if (!entry.pinned || byId.get(entry.tabId)?.pinned === true) continue;
    await attempt(() => api.tabs.update(entry.tabId, { pinned: true }));
  }
}

/** Our tabs leave their groups; one call, then one call each if the batch is refused. */
async function ungroupAll(api: GroupsApi, tabIds: readonly number[]): Promise<void> {
  if (tabIds.length === 0) return;
  const ungrouped = await attempt(() => api.tabs.ungroup(tabIds));
  if (ungrouped.ok) return;
  for (const tabId of tabIds) await attempt(() => api.tabs.ungroup([tabId]));
}

/**
 * Every tab back in the group it was in, and the answer to "which group is that now":
 * snapshot group id → the id it has in the browser at this moment.
 *
 * Three routes, in order of how faithful they are. The id itself, when the group is still
 * there. Then a group of the same title, in the tab's own window first (PLAN.md §5.5): a
 * group id does not survive a restart and Firefox never reports one, so the title is the
 * only handle left — compared here, exactly, rather than through `tabGroups.query({ title })`,
 * which Chrome treats as a pattern. Failing both, the group is built again from the
 * snapshot, with the title, colour and collapsed state it had: neither browser has a
 * `tabGroups.create`, so a group is created by grouping its tabs and then naming it.
 *
 * A group whose tabs never left it is not touched at all — that is the usual case for the
 * user's own groups, which PLAN.md §4.4 keeps out of this entirely.
 */
async function restoreGroups(
  api: GroupsApi,
  entries: readonly TabSnapshot[],
  byId: ReadonlyMap<number, TabInfo>,
): Promise<ReadonlyMap<number, number>> {
  const restored = new Map<number, number>();
  const groups = await liveGroups(api);

  for (const [groupId, members] of membersByGroup(entries)) {
    if (members.tabIds.every((tabId) => byId.get(tabId)?.groupId === groupId)) {
      restored.set(groupId, groupId);
      continue;
    }

    const alive = aliveGroup(groupId, members, groups);
    if (alive !== null) {
      // In the snapshot's own order, which is the order they sat in the group.
      const joined = await attempt(() =>
        api.tabs.group({ tabIds: members.tabIds, groupId: alive }),
      );
      if (joined.ok) {
        restored.set(groupId, alive);
        continue;
      }
    }

    const built = await attempt(() =>
      api.tabs.group({
        tabIds: members.tabIds,
        createProperties: { windowId: members.windowId },
      }),
    );
    if (!built.ok) continue;
    const was = members.group;
    if (was !== undefined) {
      await attempt(async () =>
        api.tabGroups?.update(built.value, {
          title: was.title,
          color: was.color,
          collapsed: was.collapsed,
        }),
      );
    }
    restored.set(groupId, built.value);
  }
  return restored;
}

/** The tabs of one group as the snapshot saw them, with what they all share. */
interface GroupMembers {
  readonly windowId: number;
  readonly group: TabGroupInfo | undefined;
  readonly tabIds: number[];
}

function membersByGroup(entries: readonly TabSnapshot[]): ReadonlyMap<number, GroupMembers> {
  const members = new Map<number, GroupMembers>();
  for (const entry of entries) {
    if (entry.groupId === NO_GROUP_ID) continue;
    const found = members.get(entry.groupId);
    if (found === undefined) {
      members.set(entry.groupId, {
        windowId: entry.windowId,
        group: entry.group,
        tabIds: [entry.tabId],
      });
      continue;
    }
    found.tabIds.push(entry.tabId);
  }
  return members;
}

/** The group to put these tabs back in: the id, a group of the same name, or none. */
function aliveGroup(
  groupId: number,
  members: GroupMembers,
  groups: ReadonlyMap<number, TabGroupInfo>,
): number | null {
  if (groups.has(groupId)) return groupId;
  const title = members.group?.title;
  if (title === undefined || title === '') return null;
  const matching = [...groups.values()].filter((group) => group.title === title);
  const found = matching.find((group) => group.windowId === members.windowId) ?? matching[0];
  return found?.id ?? null;
}

/**
 * The snapshot's order, restored window by window, lowest index first.
 *
 * Each window is walked in index order and every tab is sent to the index it had. Where
 * consecutive tabs were in the same group the group is moved once instead, with all of its
 * tabs: that is the only way to place a grouped tab without risking that it leaves its
 * group. An index that no longer exists — tabs were closed since — puts the tab at the end
 * of the strip, and because the walk is in order the tabs that are left still come out in
 * the order they were in.
 */
async function restoreOrder(
  api: GroupsApi,
  entries: readonly TabSnapshot[],
  groupIds: ReadonlyMap<number, number>,
): Promise<void> {
  for (const windowId of [...new Set(entries.map((entry) => entry.windowId))]) {
    const ordered = entries
      .filter((entry) => entry.windowId === windowId)
      .slice()
      .sort((left, right) => left.index - right.index);

    for (const run of runs(ordered)) {
      const groupId = run.groupId === NO_GROUP_ID ? undefined : groupIds.get(run.groupId);
      if (groupId === undefined) {
        // One tab, unless a group could not be restored at all; then the tabs at least
        // keep their relative order, one index after the other.
        let index = run.index;
        for (const tabId of run.tabIds) {
          await attempt(() => api.tabs.move(tabId, { index }));
          index += 1;
        }
        continue;
      }
      await attempt(async () => api.tabGroups?.move(groupId, { index: run.index }));
    }
  }
}

/** A stretch of the snapshot that moves as one: a group's tabs, or a single tab. */
interface Run {
  readonly groupId: number;
  /** Where the stretch started, which is where it goes back. */
  readonly index: number;
  readonly tabIds: number[];
}

function runs(ordered: readonly TabSnapshot[]): readonly Run[] {
  const found: Run[] = [];
  let current: Run | null = null;
  for (const entry of ordered) {
    if (current !== null && current.groupId === entry.groupId && entry.groupId !== NO_GROUP_ID) {
      current.tabIds.push(entry.tabId);
      continue;
    }
    current = { groupId: entry.groupId, index: entry.index, tabIds: [entry.tabId] };
    found.push(current);
  }
  return found;
}

/** The one message a partial apply gets (PLAN.md §7.4), or nothing when all went in. */
export interface ApplyMessage {
  readonly one: MessageKey;
  readonly other: MessageKey;
  readonly count: number;
}

/**
 * Every tab that stayed out, summarised in one message (PLAN.md §7.4: "apply what can be
 * applied and report a short message").
 *
 * One message and not one per group: a window where a dozen tabs went while the preview
 * was open would otherwise raise a dozen toasts for a single gesture. The keys come back
 * unformatted, as a plural pair, because the count has to be formatted in the panel's
 * language (invariant 11, `sidepanel/format.ts`).
 */
export function applyMessage(result: ApplyResult): ApplyMessage | null {
  if (result.skipped === 0) return null;
  return { one: 'organizeSkippedOne', other: 'organizeSkippedOther', count: result.skipped };
}

/** The tabs as the core sees them, or `null` when even the query failed. */
async function liveTabs(api: GroupsApi): Promise<readonly TabInfo[] | null> {
  const found = await attempt(() => api.tabs.query({}));
  return found.ok ? asTabInfos(found.value) : null;
}

/** Every group that exists now, by id. Empty where the browser has no groups to report. */
async function liveGroups(api: GroupsApi): Promise<ReadonlyMap<number, TabGroupInfo>> {
  const groups = new Map<number, TabGroupInfo>();
  const found = await attempt(async () => (await api.tabGroups?.query({})) ?? []);
  if (!found.ok) return groups;
  for (const group of found.value) {
    if (group.id === undefined) continue;
    groups.set(group.id, {
      id: group.id,
      windowId: group.windowId ?? NO_WINDOW,
      title: group.title ?? '',
      color: asGroupColor(group.color),
      collapsed: group.collapsed === true,
    });
  }
  return groups;
}

function snapshotOf(tab: TabInfo, groups: ReadonlyMap<number, TabGroupInfo>): TabSnapshot {
  const group = groups.get(tab.groupId);
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    groupId: tab.groupId,
    pinned: tab.pinned,
    ...(group === undefined ? {} : { group }),
  };
}

/** A colour name we do not know reads as `grey`, which is the browsers' own default. */
function asGroupColor(color: string | undefined): GroupColor {
  return GROUP_COLORS.find((known) => known === color) ?? 'grey';
}

/**
 * Extended browser API slice for saving "Windows and topics" clusters as native tab groups,
 * which may move tabs into a common window before grouping and recreate emptied windows on Undo.
 */
export interface PlanGroupsApi {
  tabs: {
    query(query: Record<string, unknown>): Promise<BrowserTab[]>;
    group(options: {
      tabIds: readonly number[];
      groupId?: number;
      createProperties?: { windowId: number };
    }): Promise<number>;
    ungroup(tabIds: readonly number[]): Promise<unknown>;
    move(tabId: number, properties: { windowId?: number; index: number }): Promise<unknown>;
    update?(tabId: number, properties: { pinned?: boolean; active?: boolean }): Promise<unknown>;
  };
  tabGroups?: GroupsApi['tabGroups'];
  windows?: {
    create(properties: { tabId?: number; focused?: boolean }): Promise<{ id?: number } | undefined>;
  };
}

function planGroupsApi(): PlanGroupsApi {
  return browser as unknown as PlanGroupsApi;
}

export interface SavedTabSnapshot extends TabSnapshot {
  readonly active: boolean;
}

export interface SavePlanGroupsResult {
  readonly snapshot: readonly SavedTabSnapshot[];
  readonly groups: readonly AppliedGroup[];
  /** Exact tab IDs newly added to a native group, so Undo ungroups only what this action changed. */
  readonly changedTabIds: readonly number[];
  readonly skipped: number;
  readonly focusedWindowId?: number;
}

export interface SavePlanGroupsOptions {
  readonly focusedWindowId?: number;
  readonly api?: PlanGroupsApi;
  readonly capabilities?: Capabilities;
}

export type UndoPlanGroupsOptions = Pick<SavePlanGroupsOptions, 'api' | 'capabilities'>;

const NOTHING_SAVED: SavePlanGroupsResult = {
  snapshot: [],
  groups: [],
  changedTabIds: [],
  skipped: 0,
};

async function joinGroup(
  api: PlanGroupsApi,
  tabIds: readonly number[],
  groupId: number,
): Promise<readonly number[]> {
  const batch = await attempt(() => api.tabs.group({ tabIds, groupId }));
  if (batch.ok) return tabIds;

  const grouped: number[] = [];
  for (const tabId of tabIds) {
    const one = await attempt(() => api.tabs.group({ tabIds: [tabId], groupId }));
    if (one.ok) grouped.push(tabId);
  }
  return grouped;
}

/**
 * Converts one or more organized "Windows and topics" clusters into native browser tab groups
 * (title + colour), moving tabs from other windows into each cluster's primary window first so
 * `tabs.group` succeeds on both Chrome and Firefox. Reuses an existing native group when a saved
 * cluster gained new tabs, and captures a complete multi-window snapshot for 1-click Undo.
 */
export async function savePlanAsTabGroups(
  clusters: readonly PlanCluster[],
  options: SavePlanGroupsOptions = {},
): Promise<SavePlanGroupsResult> {
  const proposed = clusters.reduce((total, cluster) => total + cluster.tabIds.length, 0);
  if (proposed === 0) return NOTHING_SAVED;

  const capabilities = options.capabilities ?? caps;
  if (!capabilities.tabGroups) return { ...NOTHING_SAVED, skipped: proposed };

  const api = options.api ?? planGroupsApi();
  const groupsCompat = api as unknown as GroupsApi;
  const live = await liveTabs(groupsCompat);
  if (live === null) return { ...NOTHING_SAVED, skipped: proposed };

  const existing = await liveGroups(groupsCompat);
  const plan = planNativeTabGroups(clusters, live, options.focusedWindowId);
  if (plan.items.length === 0) return { ...NOTHING_SAVED, skipped: plan.skipped };

  const byId = new Map(live.map((tab) => [tab.id, tab]));
  const affectedWindows = new Set<number>();
  for (const item of plan.items) {
    affectedWindows.add(item.targetWindowId);
    for (const id of item.allTabIds) {
      const win = byId.get(id)?.windowId;
      if (win !== undefined) affectedWindows.add(win);
    }
  }
  const snapshot: SavedTabSnapshot[] = live
    .filter((tab) => affectedWindows.has(tab.windowId))
    .map((tab) => ({ ...snapshotOf(tab, existing), active: tab.active }));

  const applied: AppliedGroup[] = [];
  const changedTabIds: number[] = [];
  let skipped = plan.skipped;

  for (const item of plan.items) {
    const failedMoves = new Set<number>();
    for (const tabId of item.moveTabIds) {
      const moved = await attempt(() =>
        api.tabs.move(tabId, { windowId: item.targetWindowId, index: -1 }),
      );
      if (!moved.ok) failedMoves.add(tabId);
    }
    skipped += failedMoves.size;

    const toGroup = item.groupTabIds.filter((tabId) => !failedMoves.has(tabId));
    if (toGroup.length === 0) continue;

    if (item.reuseGroupId !== null) {
      const joined = await joinGroup(api, toGroup, item.reuseGroupId);
      skipped += toGroup.length - joined.length;
      if (joined.length === 0) continue;

      const prev = existing.get(item.reuseGroupId);
      if (prev === undefined || prev.title === '') {
        await attempt(async () =>
          api.tabGroups?.update(item.reuseGroupId!, {
            title: item.title,
            color: item.color,
          }),
        );
      }
      changedTabIds.push(...joined);
      applied.push({
        key: item.key,
        groupId: item.reuseGroupId,
        windowId: item.targetWindowId,
        title: prev !== undefined && prev.title !== '' ? prev.title : item.title,
        tabIds: joined,
      });
      continue;
    }

    const created = await createGroup(groupsCompat, toGroup, item.targetWindowId);
    skipped += toGroup.length - created.tabIds.length;
    if (created.groupId === null) continue;

    await attempt(async () =>
      api.tabGroups?.update(created.groupId!, {
        title: item.title,
        color: item.color,
        collapsed: false,
      }),
    );
    changedTabIds.push(...created.tabIds);
    applied.push({
      key: item.key,
      groupId: created.groupId,
      windowId: item.targetWindowId,
      title: item.title,
      tabIds: created.tabIds,
    });
  }

  return {
    snapshot,
    groups: applied,
    changedTabIds,
    skipped,
    ...(options.focusedWindowId === undefined ? {} : { focusedWindowId: options.focusedWindowId }),
  };
}

/**
 * Reverts `savePlanAsTabGroups`: ungroups only tabs newly added by that action, recreates any
 * emptied window that closed during cross-window moves, returns tabs to their original windows,
 * restores any prior native tab groups and exact tab indices, and restores active tabs.
 */
export async function undoSavedPlanGroups(
  result: SavePlanGroupsResult,
  options: UndoPlanGroupsOptions = {},
): Promise<void> {
  if (result.groups.length === 0) return;
  const capabilities = options.capabilities ?? caps;
  if (!capabilities.tabGroups) return;

  const api = options.api ?? planGroupsApi();
  const groupsCompat = api as unknown as GroupsApi;

  await ungroupAll(groupsCompat, result.changedTabIds);

  let live = await liveTabs(groupsCompat);
  if (live === null) return;
  let byId = new Map(live.map((tab) => [tab.id, tab]));
  const liveWindowIds = new Set(live.map((tab) => tab.windowId));
  const here = result.snapshot.filter((entry) => byId.has(entry.tabId));

  const byOrigWindow = new Map<number, SavedTabSnapshot[]>();
  for (const entry of here) {
    const list = byOrigWindow.get(entry.windowId);
    if (list === undefined) byOrigWindow.set(entry.windowId, [entry]);
    else list.push(entry);
  }

  const windowMap = new Map<number, number>();
  let movedCrossWindow = false;

  // Recreate emptied windows first so their tabs leave surviving windows before ordering.
  for (const [origWindowId, entries] of byOrigWindow) {
    if (liveWindowIds.has(origWindowId)) {
      windowMap.set(origWindowId, origWindowId);
      continue;
    }
    if (typeof api.windows?.create !== 'function') continue;
    const ordered = entries.slice().sort((left, right) => left.index - right.index);
    const [first, ...rest] = ordered;
    if (first === undefined) continue;
    const created = await attempt(() =>
      api.windows!.create({
        tabId: first.tabId,
        focused: origWindowId === result.focusedWindowId,
      }),
    );
    const newWindowId = created.ok ? created.value?.id : undefined;
    if (newWindowId === undefined) continue;
    windowMap.set(origWindowId, newWindowId);
    movedCrossWindow = true;
    for (const entry of rest) {
      await attempt(() => api.tabs.move(entry.tabId, { windowId: newWindowId, index: -1 }));
    }
  }

  // Return tabs that moved out of surviving windows.
  for (const [origWindowId, entries] of byOrigWindow) {
    if (!liveWindowIds.has(origWindowId)) continue;
    const ordered = entries.slice().sort((left, right) => left.index - right.index);
    for (const entry of ordered) {
      const current = byId.get(entry.tabId);
      if (current === undefined || current.windowId === origWindowId) continue;
      const moved = await attempt(() =>
        api.tabs.move(entry.tabId, { windowId: origWindowId, index: -1 }),
      );
      if (moved.ok) movedCrossWindow = true;
    }
  }

  if (movedCrossWindow) {
    const refreshed = await liveTabs(groupsCompat);
    if (refreshed !== null) {
      live = refreshed;
      byId = new Map(live.map((tab) => [tab.id, tab]));
    }
  }

  const remapped: SavedTabSnapshot[] = here.map((entry) => {
    const mappedWindow = windowMap.get(entry.windowId) ?? entry.windowId;
    return mappedWindow === entry.windowId
      ? entry
      : {
          ...entry,
          windowId: mappedWindow,
          ...(entry.group === undefined
            ? {}
            : { group: { ...entry.group, windowId: mappedWindow } }),
        };
  });

  if (typeof api.tabs.update === 'function') {
    await repin(groupsCompat, remapped, byId);
  }
  const groupIds = await restoreGroups(groupsCompat, remapped, byId);
  await restoreOrder(groupsCompat, remapped, groupIds);

  if (movedCrossWindow && typeof api.tabs.update === 'function') {
    for (const entry of remapped) {
      if (!entry.active) continue;
      await attempt(() => api.tabs.update!(entry.tabId, { active: true }));
    }
  }
}
