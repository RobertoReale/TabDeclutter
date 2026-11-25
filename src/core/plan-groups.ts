/**
 * Pure planning helpers for converting organized "Windows and topics" clusters into
 * native browser tab groups (and checking which clusters are already saved as one).
 *
 * Lives in `src/core/` with zero browser globals so every branch (single-window,
 * cross-window majority selection, tie-breaking, incremental reuse of an existing
 * native group, pinned/incognito/closed exclusions) is unit-tested exhaustively.
 */

import type { GroupColor } from './cluster';
import { NO_GROUP_ID, type TabInfo } from './types';

/** One organized cluster shown in "Windows and topics". */
export interface PlanCluster {
  readonly key: string;
  readonly title: string;
  readonly color: GroupColor;
  readonly tabIds: readonly number[];
}

/** What the platform layer needs to turn one cluster into a native browser tab group. */
export interface NativeGroupPlanItem {
  readonly key: string;
  readonly title: string;
  readonly color: GroupColor;
  /** Target browser window where all eligible tabs of this cluster will be grouped together. */
  readonly targetWindowId: number;
  /** Existing native `groupId` to reuse when expanding an already-saved group, or `null` to create a new one. */
  readonly reuseGroupId: number | null;
  /** Eligible tabs of this cluster currently in other windows that must move into `targetWindowId` first. */
  readonly moveTabIds: readonly number[];
  /** Eligible tabs of this cluster that need to be added into the native group. */
  readonly groupTabIds: readonly number[];
  /** Every live eligible tab belonging to this cluster, in cluster order. */
  readonly allTabIds: readonly number[];
}

export interface NativeGroupPlan {
  readonly items: readonly NativeGroupPlanItem[];
  /** Tabs named by input clusters that were closed or incognito. */
  readonly skipped: number;
}

/**
 * Returns `true` when every live eligible (non-pinned, non-incognito) tab of `tabIds`
 * already lives in the same single native browser tab group inside one window.
 */
export function isClusterSavedAsTabGroup(
  tabIds: readonly number[],
  byId: ReadonlyMap<number, TabInfo>,
): boolean {
  let firstGroupId: number | undefined;
  let firstWindowId: number | undefined;

  for (const id of tabIds) {
    const tab = byId.get(id);
    if (tab === undefined || tab.pinned || tab.incognito) continue;
    if (tab.groupId === NO_GROUP_ID) return false;
    if (firstGroupId === undefined) {
      firstGroupId = tab.groupId;
      firstWindowId = tab.windowId;
    } else if (tab.groupId !== firstGroupId || tab.windowId !== firstWindowId) {
      return false;
    }
  }

  return firstGroupId !== undefined;
}

function pickMajorityWindow(tabs: readonly TabInfo[], focusedWindowId: number | undefined): number {
  const counts = new Map<number, number>();
  for (const tab of tabs) {
    counts.set(tab.windowId, (counts.get(tab.windowId) ?? 0) + 1);
  }

  let bestWindowId = tabs[0]!.windowId;
  let bestCount = -1;
  for (const [windowId, count] of counts) {
    if (
      count > bestCount ||
      (count === bestCount &&
        (windowId === focusedWindowId ||
          (bestWindowId !== focusedWindowId && windowId < bestWindowId)))
    ) {
      bestCount = count;
      bestWindowId = windowId;
    }
  }
  return bestWindowId;
}

function pickReusableGroupId(
  tabs: readonly TabInfo[],
  nativeGroupSize: ReadonlyMap<number, number>,
): number | null {
  const counts = new Map<number, number>();
  for (const tab of tabs) {
    if (tab.groupId === NO_GROUP_ID) continue;
    counts.set(tab.groupId, (counts.get(tab.groupId) ?? 0) + 1);
  }

  let bestGroupId: number | null = null;
  let bestCount = 0;
  for (const [groupId, count] of counts) {
    // Only reuse an existing native group when EVERY member of that group belongs to this
    // cluster, so an unrelated manual group holding tabs from other topics is never hijacked.
    if (count !== nativeGroupSize.get(groupId)) continue;
    if (
      count > bestCount ||
      (count === bestCount && bestGroupId !== null && groupId < bestGroupId)
    ) {
      bestCount = count;
      bestGroupId = groupId;
    }
  }
  return bestGroupId;
}

/**
 * Plans how to turn one or more organized `clusters` into native browser tab groups:
 *
 * - Skips clusters that are already saved as a single native tab group.
 * - Excludes pinned tabs silently (consistent with `applyGroups`) and counts missing/incognito
 *   tabs as `skipped`.
 * - Reuses an existing native tab group when every member of that group already belongs to the
 *   cluster (e.g. a new tab joined an already-saved topic), moving and grouping only the new tabs.
 * - Otherwise picks the window that already holds the most tabs of the cluster (breaking ties in
 *   favour of `focusedWindowId`, then lowest window id) and moves only tabs from other windows.
 */
export function planNativeTabGroups(
  clusters: readonly PlanCluster[],
  liveTabs: readonly TabInfo[],
  focusedWindowId?: number,
): NativeGroupPlan {
  const byId = new Map<number, TabInfo>();
  const nativeGroupSize = new Map<number, number>();
  const nativeGroupWindow = new Map<number, number>();

  for (const tab of liveTabs) {
    if (tab.incognito) continue;
    byId.set(tab.id, tab);
    if (tab.groupId !== NO_GROUP_ID) {
      nativeGroupSize.set(tab.groupId, (nativeGroupSize.get(tab.groupId) ?? 0) + 1);
      if (!nativeGroupWindow.has(tab.groupId)) nativeGroupWindow.set(tab.groupId, tab.windowId);
    }
  }

  const claimed = new Set<number>();
  const items: NativeGroupPlanItem[] = [];
  let skipped = 0;

  for (const cluster of clusters) {
    const live: TabInfo[] = [];
    for (const id of cluster.tabIds) {
      if (claimed.has(id)) continue;
      const tab = byId.get(id);
      if (tab === undefined) {
        skipped += 1;
        continue;
      }
      if (tab.pinned) continue;
      claimed.add(id);
      live.push(tab);
    }

    if (live.length === 0) continue;

    const first = live[0]!;
    const alreadySaved =
      first.groupId !== NO_GROUP_ID &&
      live.every((tab) => tab.groupId === first.groupId && tab.windowId === first.windowId);
    if (alreadySaved) continue;

    const reuseGroupId = pickReusableGroupId(live, nativeGroupSize);
    const targetWindowId =
      reuseGroupId !== null
        ? nativeGroupWindow.get(reuseGroupId)!
        : pickMajorityWindow(live, focusedWindowId);

    const allTabIds = live.map((tab) => tab.id);
    const moveTabIds = live.filter((tab) => tab.windowId !== targetWindowId).map((tab) => tab.id);
    const groupTabIds =
      reuseGroupId !== null
        ? live.filter((tab) => tab.groupId !== reuseGroupId).map((tab) => tab.id)
        : allTabIds;

    items.push({
      key: cluster.key,
      title: cluster.title,
      color: cluster.color,
      targetWindowId,
      reuseGroupId,
      moveTabIds,
      groupTabIds,
      allTabIds,
    });
  }

  return { items, skipped };
}
