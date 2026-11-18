/**
 * Window organization without Chrome tab groups (`platform/windows.ts`).
 *
 * Two clear modes the user can switch between:
 *
 * 1. `'merge-windows'` ("Unica finestra ordinata"):
 *    - Dissolves any existing coloured tab groups so the tab strip stays clean.
 *    - Moves tabs from scattered background windows into the primary window, leaving
 *      pinned and audible tabs where they are.
 *    - Sorts the tabs in the window by site or by topic so related pages sit side by side.
 *
 * 2. `'split-windows'` ("Una finestra per argomento / sito"):
 *    - Dissolves any existing coloured tab groups.
 *    - Clusters all open tabs across windows by site or by topic (`proposeGroups`), and
 *      places each cluster into its own dedicated browser window so every window has a
 *      single coherent theme, consolidating stray single-tab windows.
 */

import { isAuthUrl, isBlankUrl } from '../core/classify';
import { proposeGroups, siteKey, type ClusterMode, type GroupProposal } from '../core/cluster';
import { tabUrl } from '../core/duplicates';
import { NO_GROUP_ID, type AutoWindowMode, type TabInfo } from '../core/types';
import { asTabInfos, attempt, NO_WINDOW, type BrowserTab } from './tabs';

/**
 * A tab that may be safely moved between windows or reordered:
 * - never pinned tabs
 * - never tabs that are still loading (`url === ''`)
 * - never blank / New Tab pages (`chrome://newtab`, `about:blank`) while the user may be typing in the address bar
 * - never OAuth / sign-in pages (`isAuthUrl`) which often open in dedicated popup windows
 */
export function isMovableTab(tab: TabInfo): boolean {
  if (tab.pinned) return false;
  const url = tabUrl(tab);
  if (url === '' || isBlankUrl(url) || isAuthUrl(url)) return false;
  return true;
}

export interface WindowsOrganizeApi {
  tabs: {
    query(query: Record<string, unknown>): Promise<BrowserTab[]>;
    move(tabId: number, properties: { windowId?: number; index: number }): Promise<unknown>;
    update?(tabId: number, properties: { active?: boolean }): Promise<unknown>;
    ungroup?(tabIds: readonly number[]): Promise<unknown>;
  };
  windows: {
    create(properties: { tabId?: number; focused?: boolean }): Promise<{ id?: number } | undefined>;
    getLastFocused?(): Promise<{ id?: number }>;
  };
}

function defaultApi(): WindowsOrganizeApi {
  return browser as unknown as WindowsOrganizeApi;
}

export interface OrganizeWindowsOptions {
  readonly windowMode: AutoWindowMode;
  readonly clusterMode: ClusterMode;
  readonly useTabGroups?: boolean;
  readonly focusedWindowId?: number;
  /** Optional precomputed proposal (e.g. from Chrome's on-device AI in the side panel). */
  readonly proposal?: GroupProposal;
  readonly api?: WindowsOrganizeApi;
}

export interface OrganizeWindowsResult {
  readonly movedTabs: number;
  readonly ungroupedTabs: number;
  readonly windowsCount: number;
}

/**
 * Ungroups every tab that is currently inside a native tab group, so the tab strip has
 * no coloured group pills when `useTabGroups` is off.
 */
export async function ungroupAllOpenTabs(api: WindowsOrganizeApi = defaultApi()): Promise<number> {
  if (typeof api.tabs.ungroup !== 'function') return 0;
  const queried = await attempt(() => api.tabs.query({}));
  if (!queried.ok) return 0;
  const tabs = asTabInfos(queried.value);
  const groupedIds = tabs.filter((tab) => tab.groupId !== NO_GROUP_ID).map((tab) => tab.id);
  if (groupedIds.length === 0) return 0;

  const batch = await attempt(() => api.tabs.ungroup!(groupedIds));
  if (!batch.ok) {
    for (const id of groupedIds) {
      await attempt(() => api.tabs.ungroup!([id]));
    }
  }
  return groupedIds.length;
}

/**
 * Organizes browser windows and tabs according to `options.windowMode`:
 * either consolidating scattered windows into one sorted window (`'merge-windows'`)
 * or separating each topic/site cluster into its own clean window (`'split-windows'`).
 */
export async function organizeWindows(
  options: OrganizeWindowsOptions,
): Promise<OrganizeWindowsResult> {
  const api = options.api ?? defaultApi();
  let ungroupedTabs = 0;

  if (!options.useTabGroups) {
    ungroupedTabs = await ungroupAllOpenTabs(api);
  }

  const queried = await attempt(() => api.tabs.query({}));
  if (!queried.ok) return { movedTabs: 0, ungroupedTabs, windowsCount: 0 };
  const allTabs = asTabInfos(queried.value).filter(
    (tab) => !tab.incognito && tab.windowId !== NO_WINDOW,
  );
  if (allTabs.length === 0) return { movedTabs: 0, ungroupedTabs, windowsCount: 0 };

  if (options.windowMode === 'merge-windows') {
    const moved = await mergeAndSortIntoOneWindow(
      allTabs,
      options.clusterMode,
      options.focusedWindowId,
      options.proposal,
      api,
    );
    return { movedTabs: moved, ungroupedTabs, windowsCount: 1 };
  }

  const result = await splitIntoThematicWindows(
    allTabs,
    options.clusterMode,
    options.focusedWindowId,
    options.proposal,
    api,
  );
  return { movedTabs: result.movedTabs, ungroupedTabs, windowsCount: result.windowsCount };
}

/**
 * Mode 1: Consolidates movable tabs from secondary windows into the primary window and
 * sorts them by site or topic so tabs of the same site/topic sit next to each other.
 */
async function mergeAndSortIntoOneWindow(
  allTabs: readonly TabInfo[],
  clusterMode: ClusterMode,
  focusedWindowId: number | undefined,
  precomputed: GroupProposal | undefined,
  api: WindowsOrganizeApi,
): Promise<number> {
  const windowCounts = new Map<number, number>();
  for (const tab of allTabs) {
    windowCounts.set(tab.windowId, (windowCounts.get(tab.windowId) ?? 0) + 1);
  }

  // Always merge into the primary window (the one with the most tabs, breaking ties in
  // favour of `focusedWindowId`), so opening a small 1-tab window never pulls 20 tabs out
  // of the main window into the small one.
  const targetWindowId = [...windowCounts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    if (a[0] === focusedWindowId) return -1;
    if (b[0] === focusedWindowId) return 1;
    return a[0] - b[0];
  })[0]?.[0];
  if (targetWindowId === undefined) return 0;

  const movable = allTabs.filter(isMovableTab);
  if (movable.length === 0) return 0;
  const unmovableInTarget = allTabs.filter(
    (tab) => tab.windowId === targetWindowId && !isMovableTab(tab),
  ).length;

  const sortedIds = orderedTabIds(movable, clusterMode, targetWindowId, precomputed);

  // Check if everything is already in targetWindowId in this exact order.
  const currentInTarget = allTabs
    .filter((tab) => tab.windowId === targetWindowId && isMovableTab(tab))
    .sort((a, b) => a.index - b.index)
    .map((tab) => tab.id);

  if (
    currentInTarget.length === sortedIds.length &&
    currentInTarget.every((id, i) => id === sortedIds[i])
  ) {
    return 0;
  }

  let moved = 0;
  let nextIndex = unmovableInTarget;
  for (const tabId of sortedIds) {
    const ok = await attempt(() =>
      api.tabs.move(tabId, { windowId: targetWindowId, index: nextIndex }),
    );
    if (ok.ok) {
      moved += 1;
      nextIndex += 1;
    }
  }

  // If the user was looking at an active tab in a secondary window that just got merged into
  // `targetWindowId`, keep that tab active in `targetWindowId` so their current page stays on screen.
  const focusedActiveTab =
    focusedWindowId !== undefined && focusedWindowId !== targetWindowId
      ? movable.find((tab) => tab.windowId === focusedWindowId && tab.active)
      : undefined;
  if (focusedActiveTab !== undefined && typeof api.tabs.update === 'function') {
    await attempt(() => api.tabs.update!(focusedActiveTab.id, { active: true }));
  }

  return moved;
}

/**
 * Mode 2: Places each topic/site cluster (with ≥ 2 tabs) into its own dedicated window,
 * and puts remaining unclustered tabs together in the primary window, ordered cleanly.
 */
async function splitIntoThematicWindows(
  allTabs: readonly TabInfo[],
  clusterMode: ClusterMode,
  focusedWindowId: number | undefined,
  precomputed: GroupProposal | undefined,
  api: WindowsOrganizeApi,
): Promise<{ readonly movedTabs: number; readonly windowsCount: number }> {
  const movable = allTabs.filter(isMovableTab);
  if (movable.length === 0) return { movedTabs: 0, windowsCount: 1 };

  const proposal = resolveWindowProposal(movable, clusterMode, 1, precomputed);

  const byId = new Map(movable.map((tab) => [tab.id, tab]));

  // Build desired window buckets: one per proposed group, plus one bucket for ungrouped tabs (sorted by site).
  const buckets: number[][] = proposal.groups.map((group) => [...group.tabIds]);
  if (proposal.ungrouped.length > 0) {
    const sortedUngrouped = [...proposal.ungrouped].sort((leftId, rightId) => {
      const leftSite = siteKey(byId.get(leftId)?.url ?? '');
      const rightSite = siteKey(byId.get(rightId)?.url ?? '');
      if (leftSite !== rightSite) return leftSite.localeCompare(rightSite);
      return leftId - rightId;
    });
    buckets.push(sortedUngrouped);
  }
  if (buckets.length === 0) return { movedTabs: 0, windowsCount: 1 };

  const existingWindows = [...new Set(allTabs.map((tab) => tab.windowId))];
  const usedWindows = new Set<number>();

  // Reserve `focusedWindowId` first for whichever bucket holds the active tab of the focused window,
  // so the topic/site cluster the user is currently working on stays in their active window.
  const focusedBucketIndex =
    focusedWindowId === undefined
      ? -1
      : buckets.findIndex((tabIds) =>
          tabIds.some((id) => {
            const tab = byId.get(id);
            return tab !== undefined && tab.active && tab.windowId === focusedWindowId;
          }),
        );
  if (focusedBucketIndex >= 0 && focusedWindowId !== undefined) {
    usedWindows.add(focusedWindowId);
  }

  // Assign each remaining bucket to the existing window that already holds most of its tabs,
  // so tabs move as little as possible and windows stay stable.
  const assignments: { tabIds: readonly number[]; windowId: number | null }[] = buckets.map(
    (tabIds, index) => {
      if (index === focusedBucketIndex && focusedWindowId !== undefined) {
        return { tabIds, windowId: focusedWindowId };
      }
      const counts = new Map<number, number>();
      for (const id of tabIds) {
        const w = byId.get(id)?.windowId;
        if (w !== undefined) counts.set(w, (counts.get(w) ?? 0) + 1);
      }
      const best = [...counts.entries()]
        .filter(([w]) => !usedWindows.has(w))
        .sort((a, b) => b[1] - a[1])[0]?.[0];
      if (best !== undefined) {
        usedWindows.add(best);
        return { tabIds, windowId: best };
      }
      return { tabIds, windowId: null };
    },
  );

  // Give any unassigned bucket a remaining unused existing window before creating new ones.
  for (const slot of assignments) {
    if (slot.windowId !== null) continue;
    const free = existingWindows.find((w) => !usedWindows.has(w));
    if (free !== undefined) {
      usedWindows.add(free);
      slot.windowId = free;
    }
  }

  let movedTabs = 0;
  for (const slot of assignments) {
    // Filter out the currently active tab of the focused window if this slot would move it
    // into a different unfocused window, so we never yank a tab out from under the user.
    const safeTabIds = slot.tabIds.filter((tabId) => {
      const tab = byId.get(tabId);
      if (tab === undefined) return false;
      if (
        tab.active &&
        focusedWindowId !== undefined &&
        tab.windowId === focusedWindowId &&
        slot.windowId !== focusedWindowId
      ) {
        return false;
      }
      return true;
    });
    const [firstId, ...restIds] = safeTabIds;
    if (firstId === undefined) continue;

    let targetWindowId = slot.windowId;
    if (targetWindowId === null) {
      const created = await attempt(() => api.windows.create({ tabId: firstId, focused: false }));
      targetWindowId = created.ok ? (created.value?.id ?? null) : null;
      if (targetWindowId === null) continue;
      const newWindowId = targetWindowId;
      movedTabs += 1;
      let idx = 1;
      for (const tabId of restIds) {
        const moved = await attempt(() =>
          api.tabs.move(tabId, { windowId: newWindowId, index: idx }),
        );
        if (moved.ok) {
          movedTabs += 1;
          idx += 1;
        }
      }
      continue;
    }

    const existingWindowId = targetWindowId;

    // Check if the bucket's tabs are already in `existingWindowId` in order.
    const currentInWindow = allTabs
      .filter((tab) => tab.windowId === existingWindowId && isMovableTab(tab))
      .sort((a, b) => a.index - b.index)
      .map((tab) => tab.id);
    if (
      currentInWindow.length === safeTabIds.length &&
      currentInWindow.every((id, i) => id === safeTabIds[i])
    ) {
      continue;
    }

    const unmovableCount = allTabs.filter(
      (tab) => tab.windowId === existingWindowId && !isMovableTab(tab),
    ).length;
    let idx = unmovableCount;
    for (const tabId of safeTabIds) {
      const moved = await attempt(() =>
        api.tabs.move(tabId, { windowId: existingWindowId, index: idx }),
      );
      if (moved.ok) {
        movedTabs += 1;
        idx += 1;
      }
    }
  }

  return { movedTabs, windowsCount: assignments.length };
}

/**
 * Resolves the cluster proposal for `movable` tabs: uses a precomputed AI proposal when
 * supplied (strictly filtered to `movable` tabs so protected tabs are never touched), or
 * falls back to the deterministic local heuristic (`proposeGroups`).
 */
function resolveWindowProposal(
  movable: readonly TabInfo[],
  clusterMode: ClusterMode,
  virtualWindowId: number,
  precomputed: GroupProposal | undefined,
): GroupProposal {
  if (precomputed !== undefined) {
    const movableIds = new Set(movable.map((tab) => tab.id));
    const placed = new Set<number>();
    const groups = precomputed.groups
      .map((group) => {
        const tabIds = group.tabIds.filter((id) => {
          if (!movableIds.has(id) || placed.has(id)) return false;
          placed.add(id);
          return true;
        });
        return { ...group, tabIds };
      })
      .filter((group) => group.tabIds.length > 0);
    const ungrouped = movable.filter((tab) => !placed.has(tab.id)).map((tab) => tab.id);
    if (groups.length > 0) {
      return { mode: precomputed.mode, groups, ungrouped };
    }
  }

  const unified = movable.map((tab, index) => ({
    ...tab,
    windowId: virtualWindowId,
    index,
    groupId: NO_GROUP_ID,
  }));
  return proposeGroups(unified, clusterMode, {
    minSiteTabs: 2,
    minClusterTabs: 2,
    includePinned: false,
    includeGrouped: true,
  });
}

/**
 * Computes a clean, deterministic ordering of `tabs` by site or by topic:
 * clusters with the most tabs come first, followed by remaining tabs sorted by domain.
 */
function orderedTabIds(
  tabs: readonly TabInfo[],
  clusterMode: ClusterMode,
  virtualWindowId: number,
  precomputed: GroupProposal | undefined,
): readonly number[] {
  const proposal = resolveWindowProposal(tabs, clusterMode, virtualWindowId, precomputed);

  const grouped = proposal.groups.flatMap((group) => [...group.tabIds]);
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const ungrouped = [...proposal.ungrouped].sort((leftId, rightId) => {
    const leftSite = siteKey(byId.get(leftId)?.url ?? '');
    const rightSite = siteKey(byId.get(rightId)?.url ?? '');
    if (leftSite !== rightSite) return leftSite.localeCompare(rightSite);
    return leftId - rightId;
  });

  return [...grouped, ...ungrouped];
}
