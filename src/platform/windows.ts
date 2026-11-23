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
import { clusterTabIds, siteKey, type ClusterMode, type GroupProposal } from '../core/cluster';
import { tabUrl } from '../core/duplicates';
import { INTERNAL_SCHEMES } from '../core/rules';
import { NO_GROUP_ID, type AutoWindowMode, type TabInfo } from '../core/types';
import { asTabInfos, attempt, NO_WINDOW, type BrowserTab } from './tabs';

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
  const savedLines = new Set(savedSignature.split('\n').filter((line) => line.includes('\t')));
  if (savedLines.size === 0) return null;

  const validIds = new Set<number>();
  for (const tab of movable) {
    if (savedLines.has(tabSignatureEntry(tab))) validIds.add(tab.id);
  }
  if (validIds.size === 0) return null;

  return {
    ...proposal,
    groups: proposal.groups.map((group) => ({
      ...group,
      tabIds: group.tabIds.filter((id) => validIds.has(id)),
    })),
    ungrouped: proposal.ungrouped.filter((id) => validIds.has(id)),
  };
}

/** Returns drifted (new/navigated) tab count, or `-1` if `proposal` has no valid live group. */
function proposalDriftCount(
  proposal: GroupProposal | null,
  movable: readonly TabInfo[],
  savedSignature: string,
): number {
  const verified =
    movable.length < 2 ? null : filterProposalBySignature(proposal, movable, savedSignature);
  if (verified === null) return -1;

  const ids = new Set(movable.map((tab) => tab.id));
  const known = new Set<number>(verified.ungrouped);
  let live = false;
  for (const group of verified.groups) {
    let n = 0;
    for (const id of group.tabIds) {
      known.add(id);
      if (ids.has(id)) n += 1;
    }
    if (n >= 2) live = true;
  }
  return live ? movable.filter((tab) => !known.has(tab.id)).length : -1;
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
 * closed tabs and 1–3 newly opened/navigated tabs while ≥ 80% of open tabs still match, avoiding
 * cold `LanguageModel.create()` stalls on minor browsing changes. Explicit clicks always bypass.
 */
export function aiProposalFreshForAutoRefresh(
  proposal: GroupProposal | null,
  movable: readonly TabInfo[],
  savedSignature = '',
): boolean {
  const drifted = proposalDriftCount(proposal, movable, savedSignature);
  return (
    drifted === 0 ||
    (drifted > 0 &&
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

export interface OrganizeWindowsOptions {
  readonly windowMode: AutoWindowMode;
  readonly clusterMode: ClusterMode;
  readonly useTabGroups?: boolean;
  readonly focusedWindowId?: number;
  /** Optional precomputed proposal (e.g. from Chrome's on-device AI in the side panel). */
  readonly proposal?: GroupProposal;
  /** Optional signature captured alongside `proposal`, used to reject stale/reused tab IDs. */
  readonly proposalSignature?: string;
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
  const batch = await attempt(() => api.tabs.ungroup!(groupedIds));
  if (!batch.ok) {
    for (const id of groupedIds) {
      await attempt(() => api.tabs.ungroup!([id]));
    }
  }
  return groupedIds.length;
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
  const query = async (): Promise<readonly TabInfo[] | null> => {
    const q = await attempt(() => api.tabs.query({}));
    return q.ok ? asTabInfos(q.value) : null;
  };

  let rawTabs = await query();
  if (rawTabs === null) return { movedTabs: 0, ungroupedTabs, windowsCount: 0 };

  if (!options.useTabGroups && typeof api.tabs.ungroup === 'function') {
    const groupedIds = rawTabs.filter((tab) => tab.groupId !== NO_GROUP_ID).map((tab) => tab.id);
    if (groupedIds.length > 0) {
      ungroupedTabs = await ungroupIds(api, groupedIds);
      rawTabs = await query();
      if (rawTabs === null) return { movedTabs: 0, ungroupedTabs, windowsCount: 0 };
    }
  }

  const allTabs = rawTabs.filter((tab) => !tab.incognito && tab.windowId !== NO_WINDOW);
  if (allTabs.length === 0) return { movedTabs: 0, ungroupedTabs, windowsCount: 0 };

  const snapshot: OrganizeWindowsSnapshot = {
    tabs: allTabs
      .filter(isMovableTab)
      .sort((a, b) => (a.windowId !== b.windowId ? a.windowId - b.windowId : a.index - b.index))
      .map((tab) => ({
        tabId: tab.id,
        windowId: tab.windowId,
        index: tab.index,
        active: tab.active,
      })),
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
          api,
        );
  return {
    ...result,
    ungroupedTabs,
    ...(result.movedTabs > 0 ? { undo: snapshot } : {}),
  };
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
    .filter((tab) => tab.windowId === windowId && isMovableTab(tab))
    .sort((a, b) => a.index - b.index)
    .map((tab) => tab.id);
  return current.length === desired.length && current.every((id, i) => id === desired[i]);
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
  proposalSignature: string | undefined,
  api: WindowsOrganizeApi,
): Promise<number> {
  const windowCounts = new Map<number, number>();
  for (const tab of allTabs) {
    windowCounts.set(tab.windowId, (windowCounts.get(tab.windowId) ?? 0) + 1);
  }

  // Always merge into the primary window (the one with the most tabs, breaking ties in
  // favour of `focusedWindowId`), so opening a small 1-tab window never pulls 20 tabs out
  // of the main window into the small one.
  const targetWindowId = [...windowCounts.entries()].sort(
    (a, b) =>
      b[1] - a[1] || (a[0] === focusedWindowId ? -1 : b[0] === focusedWindowId ? 1 : a[0] - b[0]),
  )[0]?.[0];
  if (targetWindowId === undefined) return 0;

  const movable = allTabs.filter(isMovableTab);
  if (movable.length === 0) return 0;
  const pinnedInTarget = allTabs.filter(
    (tab) => tab.windowId === targetWindowId && tab.pinned,
  ).length;

  const byId = new Map(movable.map((tab) => [tab.id, tab]));
  const proposal = resolveWindowProposal(
    movable,
    clusterMode,
    targetWindowId,
    precomputed,
    proposalSignature,
  );
  const sortedIds = [...proposal.groups.flat(), ...sortBySite(proposal.ungrouped, byId)];

  if (isWindowOrdered(allTabs, targetWindowId, sortedIds)) {
    return 0;
  }

  const moved = await moveSequence(api, sortedIds, targetWindowId, pinnedInTarget, byId);

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

  const multiSite = [...bySite.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .sort((a, b) =>
      b[1].length !== a[1].length ? b[1].length - a[1].length : a[0].localeCompare(b[0]),
    );

  const budget = Math.max(0, maxTotalWindows - existingGroupCount);
  const siteBuckets: SiteFallbackBucket[] = [];
  for (const [key, ids] of multiSite) {
    if (siteBuckets.length < budget) {
      siteBuckets.push({ siteKey: key, tabIds: ids });
    } else {
      remaining.push(...ids);
    }
  }
  for (const [, ids] of bySite) {
    if (ids.length === 1) remaining.push(...ids);
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
  api: WindowsOrganizeApi,
): Promise<{ readonly movedTabs: number; readonly windowsCount: number }> {
  const movable = allTabs.filter(isMovableTab);
  if (movable.length === 0) return { movedTabs: 0, windowsCount: 1 };

  const proposal = resolveWindowProposal(movable, clusterMode, 1, precomputed, proposalSignature);

  const byId = new Map(movable.map((tab) => [tab.id, tab]));

  // Build desired window buckets: one per proposed group, then fallback site windows for any
  // ungrouped site with ≥ 2 tabs (in topic mode), plus one catch-all for remaining singletons.
  const buckets: number[][] = proposal.groups.map((group) => [...group]);
  if (proposal.ungrouped.length > 0) {
    if (clusterMode === 'topic') {
      const { siteBuckets, remaining } = partitionUngroupedBySite(
        proposal.ungrouped,
        byId,
        buckets.length,
      );
      for (const bucket of siteBuckets) buckets.push([...bucket.tabIds]);
      if (remaining.length > 0) buckets.push([...remaining]);
    } else {
      buckets.push(sortBySite(proposal.ungrouped, byId));
    }
  }
  if (buckets.length === 0) return { movedTabs: 0, windowsCount: 1 };

  // Only reuse existing windows that already hold movable tabs, so browser-internal or OAuth
  // popup windows (`chrome://extensions`, `chrome://newtab`, sign-in windows) are never hijacked.
  const existingWindows = [...new Set(movable.map((tab) => tab.windowId))];
  const usedWindows = new Set<number>();

  // Reserve `focusedWindowId` first for whichever bucket holds the active tab of the focused window,
  // so the topic/site cluster the user is currently working on stays in their active window.
  const focusedBucketIndex = buckets.findIndex((tabIds) =>
    tabIds.some((id) => {
      const tab = byId.get(id);
      return tab?.active === true && tab.windowId === focusedWindowId;
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
      return (
        tab !== undefined &&
        !(tab.active && tab.windowId === focusedWindowId && slot.windowId !== focusedWindowId)
      );
    });
    const [firstId, ...restIds] = safeTabIds;
    if (firstId === undefined) continue;

    let targetWindowId = slot.windowId;
    if (targetWindowId === null) {
      const created = await attempt(() => api.windows.create({ tabId: firstId, focused: false }));
      targetWindowId = created.ok ? (created.value?.id ?? null) : null;
      if (targetWindowId === null) continue;
      movedTabs += 1 + (await moveSequence(api, restIds, targetWindowId, 1));
      continue;
    }

    const existingWindowId = targetWindowId;

    if (isWindowOrdered(allTabs, existingWindowId, safeTabIds)) {
      continue;
    }

    const pinnedCount = allTabs.filter(
      (tab) => tab.windowId === existingWindowId && tab.pinned,
    ).length;
    movedTabs += await moveSequence(api, safeTabIds, existingWindowId, pinnedCount, byId);
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
      { minSiteTabs: 2, minClusterTabs: 2, includePinned: false, includeGrouped: true },
    );

  const verified =
    precomputed === undefined
      ? null
      : filterProposalBySignature(precomputed, movable, proposalSignature ?? '');
  if (verified !== null) {
    const movableIds = new Set(movable.map((tab) => tab.id));
    const knownIds = new Set<number>(verified.ungrouped);
    const placed = new Set<number>();
    const groups: number[][] = [];
    for (const group of verified.groups) {
      for (const id of group.tabIds) knownIds.add(id);
      const live = group.tabIds.filter((id) => movableIds.has(id) && !placed.has(id));
      if (live.length < 2) continue;
      for (const id of live) placed.add(id);
      groups.push(live);
    }
    const newTabs = movable.filter((tab) => !knownIds.has(tab.id));
    // Reuse a cached AI proposal only while it still has real (>=2-tab) groups and covers at
    // least half of the current movable tabs; otherwise re-cluster everything fresh so new
    // browsing sessions never pile into the ungrouped catch-all window.
    if (groups.length > 0 && (movable.length - newTabs.length) * 2 >= movable.length) {
      if (newTabs.length >= 1) {
        // 1. First try matching each newly opened tab against existing AI groups using fast
        //    full-window local clustering, so opening even a single new tab on an active topic
        //    lands in its thematic window immediately (< 5 ms) before the LLM re-runs.
        const fullLocal = clusterLocal(movable);
        const remainingNew: TabInfo[] = [];
        for (const newTab of newTabs) {
          const localCluster = fullLocal.groups.find((g) => g.includes(newTab.id));
          let bestGroupIdx = -1;
          let bestOverlap = 0;
          if (localCluster !== undefined) {
            for (const [idx, group] of groups.entries()) {
              const overlap = group.filter((id) => localCluster.includes(id)).length;
              if (overlap > bestOverlap) {
                bestOverlap = overlap;
                bestGroupIdx = idx;
              }
            }
          }
          if (bestGroupIdx >= 0) {
            groups[bestGroupIdx]!.push(newTab.id);
            placed.add(newTab.id);
          } else {
            remainingNew.push(newTab);
          }
        }
        // 2. Any remaining new tabs that form a brand-new topic pair get their own new window.
        if (remainingNew.length >= 2) {
          const extra = clusterLocal(remainingNew);
          for (const extraGroup of extra.groups) {
            if (groups.length >= 8) break;
            groups.push([...extraGroup]);
            for (const id of extraGroup) placed.add(id);
          }
        }
      }
      const ungrouped = movable.filter((tab) => !placed.has(tab.id)).map((tab) => tab.id);
      return { groups, ungrouped };
    }
  }

  return clusterLocal(movable);
}
