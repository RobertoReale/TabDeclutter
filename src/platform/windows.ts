/**
 * Window organization without Chrome tab groups (`platform/windows.ts`).
 *
 * Two clear modes the user can switch between:
 *
 * 1. `'merge-windows'` ("Unica finestra ordinata"):
 *    - Leaves existing native tab groups intact so user-created and one-click saved groups
 *      are never dissolved by Autopilot.
 *    - Moves ungrouped tabs from scattered background windows into the primary window, leaving
 *      pinned, grouped, and protected tabs where they are.
 *    - Sorts ungrouped tabs in the window by site or by topic so related pages sit side by side.
 *
 * 2. `'split-windows'` ("Una finestra per argomento / sito"):
 *    - Leaves existing native tab groups and their windows intact.
 *    - Clusters remaining ungrouped tabs across windows by site or by topic (`proposeGroups`),
 *      and places each cluster into its own dedicated browser window so every window has a
 *      single coherent theme, consolidating stray single-tab windows.
 */

import { isAuthUrl, isBlankUrl } from '../core/classify';
import {
  clusterTabIds,
  siteKey,
  type ClusterMode,
  type GroupProposal,
  type ProposedGroup,
} from '../core/cluster';
import { tabUrl } from '../core/duplicates';
import { INTERNAL_SCHEMES } from '../core/rules';
import {
  NO_GROUP_ID,
  type AutoWindowMode,
  type TabInfo,
  type YouTubeDurationOrder,
} from '../core/types';
import { planAnchorMoves, planYouTubeSlotMoves, sortYouTubeTabIds } from '../core/youtube';
import { asTabInfos, attempt, NO_WINDOW, retryBatch, type BrowserTab } from './tabs';

/** Shared clustering options used by background window/AI batching and window organization. */
export const ORGANIZE_CLUSTER_OPTIONS = {
  minSiteTabs: 2,
  minClusterTabs: 2,
  includePinned: false,
  includeGrouped: true,
} as const;

/**
 * A tab that may be safely moved between windows or reordered:
 * - never pinned tabs
 * - never tabs that are still loading (`url === ''`)
 * - never blank / New Tab pages (`chrome://newtab`, `about:blank`) while the user may be typing in the address bar
 * - never browser-internal or extension pages (`chrome://extensions`, `chrome://settings`, non-suspender `chrome-extension://`)
 * - never OAuth / sign-in pages (`isAuthUrl`) which often open in dedicated popup windows
 */
export function isMovableTab(tab: TabInfo): boolean {
  if (tab.pinned) return false;
  const url = tabUrl(tab);
  if (url === '' || isBlankUrl(url) || isAuthUrl(url)) return false;
  const lower = url.toLowerCase();
  return !INTERNAL_SCHEMES.some((prefix) => lower.startsWith(prefix));
}

/** Minimum new/navigated tabs before an automatic AI refresh wakes the model when ≥ 80% already match. */
const AUTO_AI_MIN_DRIFT_TABS = 4;
const AUTO_AI_MAX_DRIFT_RATIO = 0.2;

function tabSignatureEntry(tab: TabInfo): string {
  const title = tab.title
    .replace(/^\(\d+\+?\)\s+|[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 60);
  return `${tab.id}\t${siteKey(tab.url)}\t${title}`;
}

/** Content-aware per-tab signature covering tab IDs, site keys, and normalized titles. */
export function movableTabsSignature(movable: readonly TabInfo[]): string {
  if (movable.length < 2) return '';
  return [...movable]
    .sort((a, b) => a.id - b.id)
    .map(tabSignatureEntry)
    .join('\n');
}

function validSignatureIds(
  movable: readonly TabInfo[],
  savedSignature: string,
): Set<number> | null {
  const savedLines = new Set(savedSignature.split('\n').filter((line) => line.includes('\t')));
  if (savedLines.size === 0) return null;
  const validIds = new Set<number>();
  for (const tab of movable) {
    if (savedLines.has(tabSignatureEntry(tab))) validIds.add(tab.id);
  }
  return validIds.size === 0 ? null : validIds;
}

/**
 * Strips any tab IDs from a persisted AI `proposal` whose live site or title no longer matches
 * `savedSignature`. Prevents reused tab IDs after a browser restart from matching unrelated
 * pages, and lets navigated tabs fall through to incremental placement immediately.
 */
export function filterProposalBySignature(
  proposal: GroupProposal | null,
  movable: readonly TabInfo[],
  savedSignature = '',
): GroupProposal | null {
  if (proposal === null || savedSignature === '') return proposal;
  const validIds = validSignatureIds(movable, savedSignature);
  if (validIds === null) return null;

  return {
    ...proposal,
    groups: proposal.groups.map((group) => ({
      ...group,
      tabIds: group.tabIds.filter((id) => validIds.has(id)),
    })),
    ungrouped: proposal.ungrouped.filter((id) => validIds.has(id)),
  };
}

/** Extracts the surviving live groups (`>= 2` tabs) and newly arrived tabs from a cached AI proposal. */
export function extractLiveProposal(
  movable: readonly TabInfo[],
  proposal: GroupProposal | null | undefined,
  savedSignature = '',
): {
  readonly groups: (ProposedGroup & { tabIds: number[] })[];
  readonly placed: Set<number>;
  readonly newTabs: TabInfo[];
} | null {
  if (proposal === null || proposal === undefined || movable.length < 2) return null;
  const allowedIds =
    savedSignature === ''
      ? new Set(movable.map((tab) => tab.id))
      : validSignatureIds(movable, savedSignature);
  if (allowedIds === null) return null;

  const knownIds = new Set<number>(proposal.ungrouped.filter((id) => allowedIds.has(id)));
  const placed = new Set<number>();
  const groups: (ProposedGroup & { tabIds: number[] })[] = [];
  for (const group of proposal.groups) {
    const valid = group.tabIds.filter((id) => allowedIds.has(id));
    for (const id of valid) knownIds.add(id);
    const live = valid.filter((id) => !placed.has(id));
    if (live.length < 2) continue;
    for (const id of live) placed.add(id);
    groups.push({ ...group, tabIds: live });
  }
  if (groups.length === 0) return null;
  return { groups, placed, newTabs: movable.filter((tab) => !knownIds.has(tab.id)) };
}

/** Returns drifted (new/navigated) tab count, or `-1` if `proposal` has no valid live group. */
function proposalDriftCount(
  proposal: GroupProposal | null,
  movable: readonly TabInfo[],
  savedSignature: string,
): number {
  return extractLiveProposal(movable, proposal, savedSignature)?.newTabs.length ?? -1;
}

/** Whether `proposal` exactly covers every live movable tab with at least one valid group. */
export function aiProposalCoversMovable(
  proposal: GroupProposal | null,
  movable: readonly TabInfo[],
  savedSignature = '',
): boolean {
  return proposalDriftCount(proposal, movable, savedSignature) === 0;
}

/**
 * Whether a cached AI proposal is fresh enough for automatic mount/background sweeps: tolerates
 * closed tabs and (unless `exact` is true) 1–3 newly opened/navigated tabs while ≥ 80% of open
 * tabs still match, avoiding cold `LanguageModel.create()` stalls on minor browsing changes.
 * Explicit clicks always bypass.
 */
export function aiProposalFreshForAutoRefresh(
  proposal: GroupProposal | null,
  movable: readonly TabInfo[],
  savedSignature = '',
  exact = false,
): boolean {
  const drifted = proposalDriftCount(proposal, movable, savedSignature);
  return (
    drifted === 0 ||
    (!exact &&
      drifted > 0 &&
      drifted < AUTO_AI_MIN_DRIFT_TABS &&
      drifted / movable.length <= AUTO_AI_MAX_DRIFT_RATIO)
  );
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

export interface YouTubeSortOptions {
  readonly durations: ReadonlyMap<string, number | null>;
  readonly order: YouTubeDurationOrder;
}

export interface OrganizeWindowsOptions {
  readonly windowMode: AutoWindowMode;
  readonly clusterMode: ClusterMode;
  readonly useTabGroups?: boolean;
  readonly focusedWindowId?: number;
  /** Optional precomputed proposal (e.g. from Chrome's on-device AI in the side panel). */
  readonly proposal?: GroupProposal;
  /** Optional signature captured alongside `proposal`, used to reject stale/reused tab IDs. */
  readonly proposalSignature?: string;
  /** Optional YouTube video duration sorting applied within each cluster / window bucket. */
  readonly youTubeSort?: YouTubeSortOptions;
  readonly api?: WindowsOrganizeApi;
}

export interface WindowTabSnapshot {
  readonly tabId: number;
  readonly windowId: number;
  readonly index: number;
  readonly active: boolean;
}

export interface OrganizeWindowsSnapshot {
  readonly tabs: readonly WindowTabSnapshot[];
  readonly focusedWindowId?: number;
  /** Exact in-place single-window restore plan so undoing YouTube sort never moves non-YT tabs. */
  readonly inPlaceRestore?: {
    readonly windowId: number;
    readonly order: readonly number[];
    readonly movingIds: readonly number[];
  };
}

export interface OrganizeWindowsResult {
  readonly movedTabs: number;
  readonly ungroupedTabs: number;
  readonly windowsCount: number;
  /** Snapshot captured before moving tabs so the user can undo the window organization in one click. */
  readonly undo?: OrganizeWindowsSnapshot;
}

async function ungroupIds(api: WindowsOrganizeApi, groupedIds: readonly number[]): Promise<number> {
  if (typeof api.tabs.ungroup !== 'function' || groupedIds.length === 0) return 0;
  await retryBatch(groupedIds, (batch) => api.tabs.ungroup!(batch));
  return groupedIds.length;
}

function countPinned(allTabs: readonly TabInfo[], windowId: number): number {
  return allTabs.filter((tab) => tab.windowId === windowId && tab.pinned).length;
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
  return ungroupIds(api, groupedIds);
}

/** Whether `tab` is eligible for window-level moves: movable and not inside a native tab group. */
function isUngroupedMovable(tab: TabInfo): boolean {
  return tab.groupId === NO_GROUP_ID && isMovableTab(tab);
}

/**
 * Organizes browser windows and tabs according to `options.windowMode`:
 * either consolidating scattered windows into one sorted window (`'merge-windows'`)
 * or separating each topic/site cluster into its own clean window (`'split-windows'`).
 *
 * Existing native browser tab groups are always preserved intact; explicit ungrouping only
 * happens through `ungroupAllOpenTabs()`.
 */
export async function organizeWindows(
  options: OrganizeWindowsOptions,
): Promise<OrganizeWindowsResult> {
  const api = options.api ?? defaultApi();
  const empty = { movedTabs: 0, ungroupedTabs: 0, windowsCount: 0 };

  const queried = await attempt(() => api.tabs.query({}));
  if (!queried.ok) return empty;

  const allTabs = asTabInfos(queried.value).filter(
    (tab) => !tab.incognito && tab.windowId !== NO_WINDOW,
  );
  const movable = allTabs.filter(isUngroupedMovable);
  if (movable.length === 0) return empty;
  const snapshot: OrganizeWindowsSnapshot = {
    tabs: [...movable]
      .sort((a, b) => a.windowId - b.windowId || a.index - b.index)
      .map(({ id: tabId, windowId, index, active }) => ({ tabId, windowId, index, active })),
    ...(options.focusedWindowId === undefined ? {} : { focusedWindowId: options.focusedWindowId }),
  };

  const result =
    options.windowMode === 'merge-windows'
      ? {
          movedTabs: await mergeAndSortIntoOneWindow(
            allTabs,
            options.clusterMode,
            options.focusedWindowId,
            options.proposal,
            options.proposalSignature,
            options.youTubeSort,
            api,
          ),
          windowsCount: 1,
        }
      : await splitIntoThematicWindows(
          allTabs,
          options.clusterMode,
          options.focusedWindowId,
          options.proposal,
          options.proposalSignature,
          options.youTubeSort,
          api,
        );
  return { ...result, ungroupedTabs: 0, ...(result.movedTabs > 0 ? { undo: snapshot } : {}) };
}

export interface SortWindowYouTubeOptions {
  readonly windowId?: number;
  readonly order: YouTubeDurationOrder;
  readonly durations: ReadonlyMap<string, number | null>;
  readonly api?: WindowsOrganizeApi;
}

export interface SortWindowYouTubeResult {
  readonly movedTabs: number;
  readonly videoCount: number;
  readonly knownCount: number;
  readonly undo?: OrganizeWindowsSnapshot;
}

/**
 * Sorts only the movable YouTube video tabs of one window by duration, swapping them in place
 * across their own slots so non-YouTube tabs, pinned tabs, internal pages, and native tab group
 * boundaries remain untouched. Returns an Undo snapshot whenever at least one tab moved.
 */
export async function sortWindowYouTubeTabs(
  options: SortWindowYouTubeOptions,
): Promise<SortWindowYouTubeResult> {
  const api = options.api ?? defaultApi();
  const queried = await attempt(() => api.tabs.query({}));
  if (!queried.ok) return { movedTabs: 0, videoCount: 0, knownCount: 0 };

  const allTabs = asTabInfos(queried.value).filter(
    (tab) => !tab.incognito && tab.windowId !== NO_WINDOW,
  );
  if (allTabs.length === 0) return { movedTabs: 0, videoCount: 0, knownCount: 0 };

  let targetWindowId = options.windowId;
  if (targetWindowId === undefined && typeof api.windows.getLastFocused === 'function') {
    const focused = await attempt(() => api.windows.getLastFocused!());
    if (focused.ok && focused.value?.id !== undefined) targetWindowId = focused.value.id;
  }
  if (targetWindowId === undefined || !allTabs.some((tab) => tab.windowId === targetWindowId)) {
    targetWindowId = (allTabs.find((tab) => tab.active) ?? allTabs[0])!.windowId;
  }

  const windowTabs = allTabs
    .filter((tab) => tab.windowId === targetWindowId)
    .sort((a, b) => a.index - b.index);
  const movable = windowTabs.filter(isMovableTab);
  const movableIds = new Set(movable.map((tab) => tab.id));
  const plan = planYouTubeSlotMoves(windowTabs, movableIds, options.durations, options.order);
  if (plan.moves.length === 0) {
    return { movedTabs: 0, videoCount: plan.videoCount, knownCount: plan.knownCount };
  }

  const nonPinnedOrder = windowTabs.filter((tab) => !tab.pinned).map((tab) => tab.id);
  const movingIds = [...new Set(plan.moves.map((move) => move.tabId))];
  const snapshot: OrganizeWindowsSnapshot = {
    tabs: movable.map((tab) => ({
      tabId: tab.id,
      windowId: tab.windowId,
      index: tab.index,
      active: tab.active,
    })),
    focusedWindowId: targetWindowId,
    inPlaceRestore: { windowId: targetWindowId, order: nonPinnedOrder, movingIds },
  };

  let movedTabs = 0;
  for (const move of plan.moves) {
    const ok = await attempt(() =>
      api.tabs.move(move.tabId, { windowId: targetWindowId, index: move.index }),
    );
    if (ok.ok) movedTabs += 1;
  }

  return movedTabs > 0
    ? { movedTabs, videoCount: plan.videoCount, knownCount: plan.knownCount, undo: snapshot }
    : { movedTabs: 0, videoCount: plan.videoCount, knownCount: plan.knownCount };
}

/**
 * Restores tabs back to the windows and positions captured before `organizeWindows` ran.
 *
 * Emptied windows that the browser closed during merge/split are recreated first so their tabs
 * leave existing windows before existing windows are reordered back to their original indices.
 */
export async function undoOrganizeWindows(
  snapshot: OrganizeWindowsSnapshot,
  api: WindowsOrganizeApi = defaultApi(),
): Promise<number> {
  const queried = await attempt(() => api.tabs.query({}));
  if (!queried.ok) return 0;

  const liveTabs = asTabInfos(queried.value).filter(
    (tab) => !tab.incognito && tab.windowId !== NO_WINDOW,
  );
  const liveById = new Map(liveTabs.map((tab) => [tab.id, tab]));
  const liveWindowIds = new Set(liveTabs.map((tab) => tab.windowId));

  // Fast exact in-place restore for single-window YouTube sorting: only moves the YouTube tabs
  // back to their original slots without touching non-YouTube or unmovable tabs.
  const inPlace = snapshot.inPlaceRestore;
  if (inPlace !== undefined && liveWindowIds.has(inPlace.windowId)) {
    const winTabs = liveTabs
      .filter((tab) => tab.windowId === inPlace.windowId)
      .sort((a, b) => a.index - b.index);
    const pinnedCount = winTabs.filter((tab) => tab.pinned).length;
    const liveIds = winTabs.filter((tab) => !tab.pinned).map((tab) => tab.id);
    const liveSet = new Set(liveIds);
    const savedSet = new Set(inPlace.order);
    const desiredIds = [
      ...inPlace.order.filter((id) => liveSet.has(id)),
      ...liveIds.filter((id) => !savedSet.has(id)),
    ];
    const movingSet = new Set(inPlace.movingIds.filter((id) => liveSet.has(id)));
    const restoreMoves = planAnchorMoves(liveIds, desiredIds, movingSet, pinnedCount);
    let restored = 0;
    for (const move of restoreMoves) {
      const ok = await attempt(() =>
        api.tabs.move(move.tabId, { windowId: inPlace.windowId, index: move.index }),
      );
      if (ok.ok) restored += 1;
    }
    return restored;
  }

  const byOrigWindow = new Map<number, WindowTabSnapshot[]>();
  for (const entry of snapshot.tabs) {
    const live = liveById.get(entry.tabId);
    if (live === undefined || live.pinned) continue;
    const list = byOrigWindow.get(entry.windowId);
    if (list === undefined) byOrigWindow.set(entry.windowId, [entry]);
    else list.push(entry);
  }

  // Sort each window's entries by original index, and restore closed windows first so tabs
  // leave surviving windows before surviving windows restore their original order.
  const entries = [...byOrigWindow.entries()].sort(([leftId], [rightId]) => {
    const leftAlive = liveWindowIds.has(leftId) ? 1 : 0;
    const rightAlive = liveWindowIds.has(rightId) ? 1 : 0;
    if (leftAlive !== rightAlive) return leftAlive - rightAlive;
    return leftId - rightId;
  });

  let restored = 0;
  for (const [origWindowId, tabs] of entries) {
    tabs.sort((a, b) => a.index - b.index);
    const [first, ...rest] = tabs;
    if (first === undefined) continue;

    if (!liveWindowIds.has(origWindowId)) {
      const created = await attempt(() =>
        api.windows.create({
          tabId: first.tabId,
          focused: origWindowId === snapshot.focusedWindowId,
        }),
      );
      const newWindowId = created.ok ? created.value?.id : undefined;
      if (newWindowId === undefined) continue;
      restored += 1;
      let idx = 1;
      for (const tab of rest) {
        const moved = await attempt(() =>
          api.tabs.move(tab.tabId, { windowId: newWindowId, index: idx }),
        );
        if (moved.ok) {
          restored += 1;
          idx += 1;
        }
      }
      continue;
    }

    for (const tab of tabs) {
      const moved = await attempt(() =>
        api.tabs.move(tab.tabId, { windowId: origWindowId, index: tab.index }),
      );
      if (moved.ok) restored += 1;
    }
  }

  if (typeof api.tabs.update === 'function') {
    for (const entry of snapshot.tabs) {
      if (!entry.active || !liveById.has(entry.tabId)) continue;
      await attempt(() => api.tabs.update!(entry.tabId, { active: true }));
    }
  }

  return restored;
}

function isWindowOrdered(
  allTabs: readonly TabInfo[],
  windowId: number,
  desired: readonly number[],
): boolean {
  const current = allTabs
    .filter((tab) => tab.windowId === windowId && isUngroupedMovable(tab))
    .sort((a, b) => a.index - b.index)
    .map((tab) => tab.id);
  return current.length === desired.length && current.every((id, i) => id === desired[i]);
}

/**
 * Mode 1: Consolidates ungrouped movable tabs from secondary windows into the primary window and
 * sorts them by site or topic so tabs of the same site/topic sit next to each other, leaving
 * native tab groups untouched.
 */
async function mergeAndSortIntoOneWindow(
  allTabs: readonly TabInfo[],
  clusterMode: ClusterMode,
  focusedWindowId: number | undefined,
  precomputed: GroupProposal | undefined,
  proposalSignature: string | undefined,
  youTubeSort: YouTubeSortOptions | undefined,
  api: WindowsOrganizeApi,
): Promise<number> {
  const movable = allTabs.filter(isUngroupedMovable);
  if (movable.length === 0) return 0;

  const windowCounts = new Map<number, number>();
  for (const tab of allTabs) {
    if (tab.groupId !== NO_GROUP_ID) continue;
    windowCounts.set(tab.windowId, (windowCounts.get(tab.windowId) ?? 0) + 1);
  }

  // Always merge into the primary window (the one with the most ungrouped tabs, breaking ties in
  // favour of `focusedWindowId`), so opening a small 1-tab window never pulls 20 tabs out of the
  // main window and dedicated grouped-tab windows are not hijacked.
  let targetWindowId: number | undefined;
  let bestCount = -1;
  for (const [id, count] of windowCounts) {
    if (
      count > bestCount ||
      (count === bestCount &&
        targetWindowId !== undefined &&
        (id === focusedWindowId || (targetWindowId !== focusedWindowId && id < targetWindowId)))
    ) {
      bestCount = count;
      targetWindowId = id;
    }
  }
  if (targetWindowId === undefined) return 0;

  const pinnedInTarget = countPinned(allTabs, targetWindowId);
  const targetHasGroups = allTabs.some(
    (tab) => tab.windowId === targetWindowId && tab.groupId !== NO_GROUP_ID,
  );

  const sortedIds = orderedTabIds(
    movable,
    clusterMode,
    targetWindowId,
    precomputed,
    proposalSignature,
    youTubeSort,
  );

  if (isWindowOrdered(allTabs, targetWindowId, sortedIds)) {
    return 0;
  }

  const byId = new Map(movable.map((tab) => [tab.id, tab]));
  // When `targetWindowId` contains native tab groups, append sorted ungrouped tabs to the end
  // (`index: -1`) in order so no ungrouped tab ever crosses a native group boundary on Chrome or Firefox.
  let moved = 0;
  if (targetHasGroups) {
    for (const tabId of sortedIds) {
      const ok = await attempt(() => api.tabs.move(tabId, { windowId: targetWindowId, index: -1 }));
      if (ok.ok) moved += 1;
    }
  } else {
    moved = await moveSequence(api, sortedIds, targetWindowId, pinnedInTarget, byId);
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

/** Maximum total thematic + fallback-site windows created in `split-windows` mode. */
const MAX_SPLIT_WINDOWS = 10;

export interface SiteFallbackBucket {
  readonly siteKey: string;
  readonly tabIds: readonly number[];
}

/**
 * Splits remaining `ungrouped` tabs by site when a site has ≥ 2 ungrouped tabs (up to the
 * window cap), so miscellaneous tabs on a busy site (e.g. 10 YouTube videos or 2 Gemini chats)
 * get their own clean window instead of being mixed into one catch-all window alongside
 * unrelated single-tab sites (e.g. GitHub).
 */
export function partitionUngroupedBySite(
  ungrouped: readonly number[],
  byId: ReadonlyMap<number, TabInfo>,
  existingGroupCount: number,
  maxTotalWindows = MAX_SPLIT_WINDOWS,
): { readonly siteBuckets: readonly SiteFallbackBucket[]; readonly remaining: readonly number[] } {
  const bySite = new Map<string, number[]>();
  const remaining: number[] = [];
  for (const id of ungrouped) {
    const key = siteKey(byId.get(id)?.url ?? '');
    if (key === '') {
      remaining.push(id);
      continue;
    }
    const list = bySite.get(key);
    if (list === undefined) bySite.set(key, [id]);
    else list.push(id);
  }

  const budget = Math.max(0, maxTotalWindows - existingGroupCount);
  const siteBuckets: SiteFallbackBucket[] = [];
  for (const [key, ids] of [...bySite.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  )) {
    if (ids.length >= 2 && siteBuckets.length < budget) {
      siteBuckets.push({ siteKey: key, tabIds: ids });
    } else {
      remaining.push(...ids);
    }
  }

  return { siteBuckets, remaining: sortBySite(remaining, byId) };
}

/**
 * Mode 2: Places each topic/site cluster (with ≥ 2 tabs) into its own dedicated window,
 * separates multi-tab ungrouped sites into clean fallback windows in topic mode, and puts
 * remaining singletons together in a small catch-all window.
 */
async function splitIntoThematicWindows(
  allTabs: readonly TabInfo[],
  clusterMode: ClusterMode,
  focusedWindowId: number | undefined,
  precomputed: GroupProposal | undefined,
  proposalSignature: string | undefined,
  youTubeSort: YouTubeSortOptions | undefined,
  api: WindowsOrganizeApi,
): Promise<{ readonly movedTabs: number; readonly windowsCount: number }> {
  const movable = allTabs.filter(isUngroupedMovable);
  if (movable.length === 0) return { movedTabs: 0, windowsCount: 1 };

  const proposal = resolveWindowProposal(movable, clusterMode, 1, precomputed, proposalSignature);

  const byId = new Map(movable.map((tab) => [tab.id, tab]));

  // Build desired window buckets: one per proposed group, then fallback site windows for any
  // ungrouped site with ≥ 2 tabs (in topic mode), plus one catch-all for remaining singletons.
  const rawBuckets: (readonly number[])[] = [...proposal.groups];
  if (proposal.ungrouped.length > 0) {
    if (clusterMode === 'topic') {
      const { siteBuckets, remaining } = partitionUngroupedBySite(
        proposal.ungrouped,
        byId,
        rawBuckets.length,
      );
      for (const bucket of siteBuckets) rawBuckets.push(bucket.tabIds);
      if (remaining.length > 0) rawBuckets.push(remaining);
    } else {
      rawBuckets.push(sortBySite(proposal.ungrouped, byId));
    }
  }
  const buckets: (readonly number[])[] =
    youTubeSort === undefined
      ? rawBuckets
      : rawBuckets.map((ids) =>
          sortYouTubeTabIds(ids, byId, youTubeSort.durations, youTubeSort.order),
        );
  if (buckets.length === 0) return { movedTabs: 0, windowsCount: 1 };

  // Never hijack windows holding native tab groups, browser-internal pages, or OAuth popups.
  const groupedWindows = new Set(
    allTabs.filter((tab) => tab.groupId !== NO_GROUP_ID).map((tab) => tab.windowId),
  );
  const existingWindows = [...new Set(movable.map((tab) => tab.windowId))].filter(
    (windowId) => !groupedWindows.has(windowId),
  );
  const usedWindows = new Set<number>(groupedWindows);

  const focusedActiveId =
    focusedWindowId === undefined
      ? undefined
      : movable.find((tab) => tab.active && tab.windowId === focusedWindowId)?.id;

  // Reserve `focusedWindowId` first for whichever bucket holds the active tab of the focused
  // window (when that window is not reserved by a native tab group), so the user's current
  // cluster stays in their active window.
  const focusedBucketIndex =
    focusedActiveId === undefined ||
    (focusedWindowId !== undefined && groupedWindows.has(focusedWindowId))
      ? -1
      : buckets.findIndex((tabIds) => tabIds.includes(focusedActiveId));
  if (focusedBucketIndex >= 0 && focusedWindowId !== undefined) {
    usedWindows.add(focusedWindowId);
  }

  const assignments: { tabIds: readonly number[]; windowId: number | null }[] = buckets.map(
    (tabIds, index) => {
      if (index === focusedBucketIndex && focusedWindowId !== undefined) {
        return { tabIds, windowId: focusedWindowId };
      }
      const counts = new Map<number, number>();
      let best: number | null = null;
      let bestCount = 0;
      for (const id of tabIds) {
        const w = byId.get(id)?.windowId;
        if (w === undefined || usedWindows.has(w)) continue;
        const c = (counts.get(w) ?? 0) + 1;
        counts.set(w, c);
        if (c > bestCount) {
          bestCount = c;
          best = w;
        }
      }
      if (best !== null) usedWindows.add(best);
      return { tabIds, windowId: best };
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

  const createBucketWindow = async (
    firstId: number,
    restIds: readonly number[],
  ): Promise<number> => {
    const created = await attempt(() => api.windows.create({ tabId: firstId, focused: false }));
    const newWinId = created.ok ? (created.value?.id ?? null) : null;
    return newWinId === null ? 0 : 1 + (await moveSequence(api, restIds, newWinId, 1));
  };

  let movedTabs = 0;
  for (const slot of assignments) {
    // Filter out the currently active tab of the focused window if this slot would move it
    // into a different unfocused window, so we never yank a tab out from under the user.
    const safeTabIds = slot.tabIds.filter(
      (tabId) =>
        byId.has(tabId) && !(slot.windowId !== focusedWindowId && tabId === focusedActiveId),
    );
    const [firstId, ...restIds] = safeTabIds;
    if (firstId === undefined) continue;

    if (slot.windowId === null) {
      movedTabs += await createBucketWindow(firstId, restIds);
      continue;
    }

    const existingWindowId = slot.windowId;
    if (isWindowOrdered(allTabs, existingWindowId, safeTabIds)) continue;

    const pinnedCount = countPinned(allTabs, existingWindowId);
    const moved = await moveSequence(api, safeTabIds, existingWindowId, pinnedCount, byId);
    // If an earlier slot drained every tab out of `existingWindowId`, Chrome auto-closed that
    // window so all moves into it failed; create a dedicated window instead of stranding tabs.
    movedTabs +=
      moved === 0 && safeTabIds.some((id) => byId.get(id)?.windowId !== existingWindowId)
        ? await createBucketWindow(firstId, restIds)
        : moved;
  }

  return { movedTabs, windowsCount: assignments.length };
}

async function moveSequence(
  api: WindowsOrganizeApi,
  tabIds: readonly number[],
  windowId: number,
  startIndex: number,
  currentById?: ReadonlyMap<number, TabInfo>,
): Promise<number> {
  // Skip any leading prefix of tabs that are already sitting at their exact target indices in
  // `windowId`, so placing 1 new tab into an already-sorted 20-tab window costs 1 move, not 21.
  let offset = 0;
  if (currentById !== undefined) {
    while (offset < tabIds.length) {
      const existing = currentById.get(tabIds[offset] as number);
      if (
        existing === undefined ||
        existing.windowId !== windowId ||
        existing.index !== startIndex + offset
      ) {
        break;
      }
      offset += 1;
    }
  }
  let moved = 0;
  let idx = startIndex + offset;
  for (let i = offset; i < tabIds.length; i += 1) {
    const tabId = tabIds[i] as number;
    const ok = await attempt(() => api.tabs.move(tabId, { windowId, index: idx }));
    if (ok.ok) {
      moved += 1;
      idx += 1;
    }
  }
  return moved;
}

function sortBySite(ids: readonly number[], byId: ReadonlyMap<number, TabInfo>): number[] {
  return [...ids].sort((leftId, rightId) => {
    const leftSite = siteKey(byId.get(leftId)?.url ?? '');
    const rightSite = siteKey(byId.get(rightId)?.url ?? '');
    if (leftSite !== rightSite) return leftSite.localeCompare(rightSite);
    return leftId - rightId;
  });
}

/**
 * Reconciles a cached AI `proposal` against the live `movable` tabs: drops groups under 2 live
 * tabs, rejects plans covering < 50% of tabs, places newly opened tabs into matching AI groups or
 * new extra local clusters in `< 5 ms`, and preserves group metadata when `clusterExtras` provides it.
 */
export function reconcileAiProposal(
  movable: readonly TabInfo[],
  precomputed: GroupProposal | null | undefined,
  proposalSignature: string | undefined,
  clusterExtras: (subset: readonly TabInfo[]) => readonly ProposedGroup[],
): { readonly groups: readonly ProposedGroup[]; readonly ungrouped: readonly number[] } | null {
  const extracted = extractLiveProposal(movable, precomputed, proposalSignature);
  if (extracted === null || (movable.length - extracted.newTabs.length) * 2 < movable.length) {
    return null;
  }
  const { groups, placed, newTabs } = extracted;
  if (newTabs.length >= 1) {
    const fullLocal = clusterExtras(movable);
    const remainingNew: TabInfo[] = [];
    for (const newTab of newTabs) {
      const localCluster = fullLocal.find((g) => g.tabIds.includes(newTab.id));
      let bestGroup: (ProposedGroup & { tabIds: number[] }) | undefined;
      let bestOverlap = 0;
      if (localCluster !== undefined) {
        for (const group of groups) {
          const overlap = group.tabIds.filter((id) => localCluster.tabIds.includes(id)).length;
          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestGroup = group;
          }
        }
      }
      if (bestGroup !== undefined) {
        bestGroup.tabIds.push(newTab.id);
        placed.add(newTab.id);
      } else {
        remainingNew.push(newTab);
      }
    }
    if (remainingNew.length >= 2) {
      for (const extraGroup of clusterExtras(remainingNew)) {
        if (groups.length >= MAX_SPLIT_WINDOWS) break;
        groups.push({
          ...extraGroup,
          key: `new:${extraGroup.key}`,
          tabIds: [...extraGroup.tabIds],
        });
        for (const id of extraGroup.tabIds) placed.add(id);
      }
    }
  }
  const ungrouped = movable.filter((tab) => !placed.has(tab.id)).map((tab) => tab.id);
  return { groups, ungrouped };
}

/**
 * Resolves the cluster buckets for `movable` tabs: uses a precomputed AI proposal when
 * supplied (strictly filtered to `movable` tabs so protected tabs are never touched), or
 * falls back to the deterministic local clustering (`clusterTabIds`).
 */
function resolveWindowProposal(
  movable: readonly TabInfo[],
  clusterMode: ClusterMode,
  virtualWindowId: number,
  precomputed: GroupProposal | undefined,
  proposalSignature?: string,
): { readonly groups: readonly (readonly number[])[]; readonly ungrouped: readonly number[] } {
  const clusterLocal = (subset: readonly TabInfo[]) =>
    clusterTabIds(
      subset.map((tab, index) => ({
        ...tab,
        windowId: virtualWindowId,
        index,
        groupId: NO_GROUP_ID,
      })),
      clusterMode,
      ORGANIZE_CLUSTER_OPTIONS,
    );

  const reconciled = reconcileAiProposal(movable, precomputed, proposalSignature, (subset) =>
    clusterLocal(subset).groups.map((tabIds) => ({ tabIds }) as unknown as ProposedGroup),
  );
  if (reconciled !== null) {
    return {
      groups: reconciled.groups.map((g) => g.tabIds),
      ungrouped: reconciled.ungrouped,
    };
  }

  return clusterLocal(movable);
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
  proposalSignature?: string,
  youTubeSort?: YouTubeSortOptions,
): readonly number[] {
  const proposal = resolveWindowProposal(
    tabs,
    clusterMode,
    virtualWindowId,
    precomputed,
    proposalSignature,
  );
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const ungrouped = sortBySite(proposal.ungrouped, byId);
  if (youTubeSort === undefined) return [...proposal.groups.flat(), ...ungrouped];
  const orderGroup = (ids: readonly number[]) =>
    sortYouTubeTabIds(ids, byId, youTubeSort.durations, youTubeSort.order);
  return [...proposal.groups.flatMap(orderGroup), ...orderGroup(ungrouped)];
}
