/**
 * The Organize view's state (PLAN.md §4.4): what is being proposed, what the user has
 * changed about it, and the last apply for as long as "Annulla" can still take it back.
 *
 * The question itself — the scope, the mode, the options and the pin on the edits — is
 * `state/organize-request.ts`, which the selection bar can touch without loading any of
 * this (§11). This module is the part that costs: the clustering of `core/cluster.ts` and
 * the grouping of `platform/groups.ts`.
 *
 * The proposal is a `computed` and not something a mount has to ask for: it is the scope,
 * the mode and the options applied to the snapshot `state/tabs.ts` already keeps, so the
 * preview is right the moment the data arrives and follows the browser while nothing has
 * been edited. The first edit pins it (`edited`) — from then on a tab opening elsewhere
 * must not move the rows under the hand that is renaming one. Being a computed also means
 * the clustering runs only while this view is on screen and someone reads it (§11).
 *
 * The toast is not `state/undo.ts`'s. A close that scrolls out of the toast is still in
 * the archive for weeks (§4.5), so eight seconds costs nothing; a grouping has no archive,
 * so letting the toast expire would make the apply the one thing in the panel that cannot
 * be undone (PLAN.md §3). It stays until it is dismissed, undone, or replaced by the next
 * apply — see docs/DECISIONS.md, M4.3.
 *
 * Grouping by topic may also be answered by the on-device model (§7.3). That answer is not
 * a computed: it costs seconds and a prompt, so it is asked for once per question and kept
 * (`answer`) until the question changes. Everything about the model is behind `state/ai.ts`
 * and an `import()`, so a panel that never asks never loads it (§11).
 */

import { computed, signal } from '@preact/signals';

import type { AiFallbackReason, Llm, groupByAi as GroupByAi } from '@/core/ai-grouping';
import {
  colorFor,
  proposeGroups,
  siteName,
  type ClusterMode,
  type GroupColor,
  type GroupProposal,
} from '@/core/cluster';
import { MINUTE } from '@/core/time';
import { NO_GROUP_ID, type AutoWindowMode, type TabInfo } from '@/core/types';
import { applyGroups, applyMessage, undoGroups, type ApplyResult } from '@/platform/groups';
import {
  aiBusyUntilItem,
  aiProposalItem,
  aiProposalSignatureItem,
  organizeSnoozeUntilItem,
  preemptBackgroundAi,
  readAiProposalState,
  saveAiProposalState,
  withAiLock,
} from '@/platform/storage';
import { NO_WINDOW } from '@/platform/tabs';
import {
  aiProposalCoversMovable,
  aiProposalFreshForAutoRefresh,
  filterProposalBySignature,
  isMovableTab,
  movableTabsSignature,
  organizeWindows,
  partitionUngroupedBySite,
  undoOrganizeWindows,
  type OrganizeWindowsResult,
  type OrganizeWindowsSnapshot,
} from '@/platform/windows';
import {
  aiActive,
  aiModel,
  availability,
  checkAi,
  PANEL_AI_TIMEOUT_MS,
  PANEL_AI_WARMUP_TIMEOUT_MS,
  useAi,
  type AiAvailability,
} from './ai';
import {
  applyOptionsOf,
  clusterOptionsOf,
  draftOf,
  mergeGroups,
  moveTab,
  plannedCount,
  proposalOf,
  recolorGroup,
  renameGroup,
  tabsInScope,
  toggleGroup,
  type Draft,
} from '../organize';
import { brought, edited, mode, options, resetEdits, scope } from './organize-request';
import { panelData } from './tabs';

// The view reads the question and the answer as one thing, and both are this module's
// subject; re-exporting is what keeps the split an implementation detail of the chunking.
export {
  brought,
  mode,
  options,
  organizeSelection,
  scope,
  setMode,
  setOptions,
  setScope,
} from './organize-request';

/** The tabs the question is about (§4.4.1): the scope, over the current snapshot. */
const scoped = computed<readonly TabInfo[]>(() => {
  const data = panelData.value;
  return tabsInScope(data?.tabs ?? [], scope.value, brought.value, data?.focusedWindowId);
});

/** The proposal for what is in scope right now, before any edit. */
const proposed = computed<Draft>(() =>
  draftOf(proposeGroups(scoped.value, mode.value, clusterOptionsOf(options.value))),
);

/**
 * The question the model would be asked, as one value to compare: an answer is only an
 * answer to the scope, the mode and the options it was given.
 */
export const aiQuestion = computed(() =>
  JSON.stringify([scope.value, mode.value, options.value, brought.value]),
);

/** The model's answer to `aiQuestion`, with `null` in it when §7.2 answered instead. */
const answer = signal<{ readonly question: string; readonly draft: Draft | null } | null>(null);

/** The model's proposal while it still answers the question being asked. */
const aiDraft = computed<Draft | null>(() => {
  const given = answer.value;
  return given !== null && given.question === aiQuestion.value ? given.draft : null;
});

/**
 * What the preview draws: the user's edits, else the model's answer, else §7.2's.
 *
 * In that order because each one supersedes the one behind it — an edited preview is the
 * user's (§4.4.3), and a model that answered has answered this very question.
 */
export const draft = computed<Draft>(() => edited.value ?? aiDraft.value ?? proposed.value);

/** The "AI on-device" badge of §4.4.2: what is on screen came from the model. */
export const aiBadge = computed(() => aiDraft.value !== null && edited.value === null);

/** Whether the model is being asked right now, which is what the spinner shows (§7.3). */
export const aiWorking = signal(false);

/**
 * Whether the last AI grouping run failed or timed out and fell back to local topic grouping.
 * Shown as an informational warning without ever mutating the user's AI or mode settings.
 */
export const aiFallbackNotice = signal(false);

/** Short diagnostic reason for the last AI fallback (e.g. `timeout`, `error (NotSupportedError)`). */
export const aiFallbackDetail = signal<string | null>(null);

/** Live diagnostic stage and elapsed timer shown while `aiWorking` is true. */
export const aiStageDetail = signal<string | null>(null);

/** Clears the AI fallback warning (e.g. when the user disables AI or switches away from topic). */
export function clearAiFallbackNotice(): void {
  aiFallbackNotice.value = false;
  aiFallbackDetail.value = null;
}

function formatSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

function startStageTicker(
  initialLabel: string,
  budgetMs: number,
  signal?: AbortSignal,
): { readonly stop: () => void; readonly setLabel: (next: string) => void } {
  const startedAt = Date.now();
  const budgetSec = Math.round(budgetMs / 1000);
  let label = initialLabel;
  const update = (): void => {
    const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
    aiStageDetail.value = `${label} · ${elapsedSec}s / ${budgetSec}s`;
  };
  update();
  const interval = setInterval(update, 1_000);
  (interval as unknown as { unref?: () => void }).unref?.();
  const stop = (): void => {
    clearInterval(interval);
  };
  signal?.addEventListener('abort', stop, { once: true });
  return {
    stop: () => {
      signal?.removeEventListener('abort', stop);
      stop();
    },
    setLabel: (next: string) => {
      label = next;
      update();
    },
  };
}

function recordAiFallback(reason: AiFallbackReason | undefined, detail?: string): void {
  aiFallbackNotice.value = true;
  const summary =
    detail !== undefined && detail !== ''
      ? reason !== undefined
        ? `${reason}: ${detail}`
        : detail
      : (reason ?? null);
  aiFallbackDetail.value = summary;
  // Use console.info rather than console.warn so expected graceful fallbacks (already shown in
  // the side panel UI) do not populate Chrome's chrome://extensions "Errors" dashboard.
  console.info('TabDeclutter: on-device AI fallback:', summary ?? 'unknown');
}

function isTimeoutError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'name' in error &&
    String((error as { name: unknown }).name) === 'TimeoutError'
  );
}

/**
 * Loads/warms the on-device model session under its own bounded deadline before `groupByAi`
 * starts its prompt clock, so cold-loading weights into VRAM never steals inference time.
 */
async function warmModel(model: Llm, outer: AbortSignal): Promise<void> {
  if (typeof model.open !== 'function') return;
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort(outer.reason);
  };
  outer.addEventListener('abort', onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((keep, reject) => {
      const give = (): void => {
        reject(controller.signal.reason as Error);
      };
      if (outer.aborted) controller.abort(outer.reason);
      if (controller.signal.aborted) {
        give();
        return;
      }
      controller.signal.addEventListener('abort', give, { once: true });
      timer = setTimeout(() => {
        controller.abort(
          new DOMException('the on-device model took too long to load', 'TimeoutError'),
        );
      }, PANEL_AI_WARMUP_TIMEOUT_MS);
      model.open!({ signal: controller.signal }).then(keep, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    outer.removeEventListener('abort', onAbort);
  }
}

/**
 * Remaps real Chrome tab IDs (often 9-10 digit integers) to compact 1..N integers before
 * sending them to the small on-device model so it never transposes digits, then restores the
 * real tab IDs in the returned proposal.
 */
function withCompactTabIds(tabs: readonly TabInfo[]): {
  readonly compact: TabInfo[];
  readonly restore: (proposal: GroupProposal) => GroupProposal;
} {
  const realByShort = new Map<number, number>();
  const compact = tabs.map((tab, index) => {
    const shortId = index + 1;
    realByShort.set(shortId, tab.id);
    return { ...tab, id: shortId };
  });
  return {
    compact,
    restore: (proposal) => ({
      mode: proposal.mode,
      groups: proposal.groups
        .map((group) => ({
          ...group,
          tabIds: group.tabIds
            .map((id) => realByShort.get(id))
            .filter((id): id is number => id !== undefined),
        }))
        .filter((group) => group.tabIds.length > 0),
      ungrouped: proposal.ungrouped
        .map((id) => realByShort.get(id))
        .filter((id): id is number => id !== undefined),
    }),
  };
}

/** The run in flight, which "Annulla" aborts. */
let running: AbortController | null = null;

export interface AiRunDeps {
  /** The session to ask. The panel's own by default (`state/ai.ts`). */
  readonly model?: Llm;
  /** `core/ai-grouping.ts`'s `groupByAi`, loaded with `import()` by default (§11). */
  readonly groupBy?: typeof GroupByAi;
}

/**
 * Asks the model to group by topic (PLAN.md §7.3). Called when Organize is opened and
 * whenever the question changes; it decides for itself whether there is anything to do.
 *
 * It never throws and never leaves the preview empty: `groupByAi` falls back to §7.2 on
 * its own, and anything it could still throw lands on `answer.draft = null`, which is the
 * heuristic again. The answer is kept so that coming back to the view does not spend a
 * second prompt on the same question.
 */
export async function startAiGrouping(deps: AiRunDeps = {}): Promise<void> {
  if (!aiActive.value || mode.value !== 'topic') return;
  if (aiWorking.value) return;
  const asked = aiQuestion.value;
  if (answer.value?.question === asked) return;

  const tabs = scoped.value;
  const chosen = clusterOptionsOf(options.value);
  const controller = new AbortController();
  running = controller;
  aiWorking.value = true;
  clearAiFallbackNotice();
  let drafted: Draft | null = null;
  let usedModel: Llm | undefined;
  let ticker: { readonly stop: () => void; readonly setLabel: (next: string) => void } | undefined;
  const lockStartedAt = Date.now();
  let warmupStartedAt = lockStartedAt;
  let lockMs = 0;
  let wasWarm = false;
  try {
    ticker = startStageTicker('lock (waiting for background AI)', PANEL_AI_WARMUP_TIMEOUT_MS);
    preemptBackgroundAi();
    await withAiLock(false, async () => {
      ticker?.stop();
      ticker = undefined;
      if (running !== controller || controller.signal.aborted) return;
      lockMs = Date.now() - lockStartedAt;
      warmupStartedAt = Date.now();
      const groupBy = deps.groupBy ?? (await import('@/core/ai-grouping')).groupByAi;
      const model = deps.model ?? (await aiModel());
      usedModel = model;
      wasWarm = (model as { isOpen?: boolean }).isOpen === true;
      ticker = startStageTicker(
        `warmup (LanguageModel.create, ${wasWarm ? 'warm' : 'cold'})`,
        PANEL_AI_WARMUP_TIMEOUT_MS,
      );
      await warmModel(model, controller.signal);
      ticker.stop();
      ticker = undefined;
      if (running !== controller || controller.signal.aborted) return;
      const warmupMs = Date.now() - warmupStartedAt;
      const mapped = withCompactTabIds(tabs);
      const promptStartedAt = Date.now();
      const promptTicker = startStageTicker(
        `prompt (${mapped.compact.length} tabs, warm=${formatSeconds(warmupMs)})`,
        PANEL_AI_TIMEOUT_MS,
      );
      ticker = promptTicker;
      const result = await groupBy(mapped.compact, model, {
        ...chosen,
        timeoutMs: PANEL_AI_TIMEOUT_MS,
        signal: controller.signal,
        onStage: (stage) => {
          promptTicker.setLabel(`${stage} (${mapped.compact.length} tabs)`);
        },
      });
      promptTicker.stop();
      ticker = undefined;
      const promptMs = Date.now() - promptStartedAt;
      // A newer run, or a changed question, owns the answer now: this one is stale.
      if (running !== controller) return;
      if (result.source === 'ai') {
        drafted = draftOf(mapped.restore(result.proposal));
        clearAiFallbackNotice();
      } else if (result.fallbackReason !== 'empty' && result.fallbackReason !== 'aborted') {
        const lockTag = lockMs >= 100 ? `lock=${formatSeconds(lockMs)} · ` : '';
        const timing = `${lockTag}warmup=${formatSeconds(warmupMs)} · prompt=${formatSeconds(promptMs)}/${Math.round(PANEL_AI_TIMEOUT_MS / 1000)}s · tabs=${mapped.compact.length}`;
        recordAiFallback(
          result.fallbackReason,
          result.fallbackDetail !== undefined ? `${result.fallbackDetail} (${timing})` : timing,
        );
      }
    });
  } catch (error: unknown) {
    // A model that cannot even be reached is not fatal: §7.2 has already answered,
    // and we surface a warning without changing the user's AI setting.
    if (running === controller && !controller.signal.aborted) {
      const elapsed = formatSeconds(Date.now() - warmupStartedAt);
      const budget = `${Math.round(PANEL_AI_WARMUP_TIMEOUT_MS / 1000)}s`;
      const lockTag = lockMs >= 100 ? `lock=${formatSeconds(lockMs)} · ` : '';
      const meta = `LanguageModel.create · ${lockTag}${elapsed}/${budget} · session=${wasWarm ? 'warm' : 'cold'} · tabs=${tabs.length}`;
      if (isTimeoutError(error)) {
        recordAiFallback('timeout', `model warmup (${meta})`);
        // If background warmup finishes after our timer gave up, automatically retry once warm.
        usedModel?.onWarm?.(() => {
          if (answer.value?.draft === null && !aiWorking.value) {
            answer.value = null;
            void startAiGrouping(deps);
          }
        });
      } else {
        const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        recordAiFallback('error', `${msg} (${meta})`);
      }
    }
  } finally {
    ticker?.stop();
    if (running === controller) {
      running = null;
      aiWorking.value = false;
      aiStageDetail.value = null;
      // Recorded either way: a question that fell back is answered, and asking the model
      // the same thing again would only take the same twenty seconds.
      answer.value = { question: asked, draft: drafted };
    }
  }
}

/** How long background `autoOrganize` snoozes after the user explicitly clicks Undo. */
const WINDOW_UNDO_SNOOZE_MS = 5 * MINUTE;

/** Cooldown before another automatic on-mount AI retry fires after a failed automatic run. */
const AI_AUTO_RETRY_COOLDOWN_MS = 2 * MINUTE;

let aiAutoCooldownUntil = 0;

/** Whether automatic on-mount AI window retries are currently cooling down after a failure. */
export function isAiAutoCoolingDown(now: number = Date.now()): boolean {
  return now < aiAutoCooldownUntil;
}

/** Clears any automatic AI retry cooldown (e.g. when the user explicitly clicks Organize or toggles AI). */
export function clearAiAutoCooldown(): void {
  aiAutoCooldownUntil = 0;
}

/** The last window organization that actually moved tabs, for as long as "Undo" can revert it. */
export const windowOrganized = signal<{
  readonly movedTabs: number;
  readonly windowsCount: number;
  readonly undo: OrganizeWindowsSnapshot;
} | null>(null);

/** Whether a window organization or window undo is currently running. */
export const windowWorking = signal(false);

/** Most recent on-device AI window proposal persisted in `storage.local`. */
export const savedAiProposal = signal<GroupProposal | null>(null);

/** Content signature that `savedAiProposal` was computed for. */
export const savedAiProposalSignature = signal<string>('');

/** Whether `savedAiProposal` has been hydrated from `storage.local` at least once. */
export const savedAiProposalLoaded = signal(false);

/** Movable-tab signature for which automatic AI window organization already ran this session. */
export const lastAutoWindowAiSignature = signal<string | null>(null);

/** Hydrates `savedAiProposal` from `storage.local` so the overview reflects persisted & background state. */
let watchingAiProposalStorage = false;
export async function loadSavedAiProposal(): Promise<void> {
  if (!watchingAiProposalStorage) {
    watchingAiProposalStorage = true;
    try {
      aiProposalItem.watch((next) => {
        savedAiProposal.value = next;
        savedAiProposalLoaded.value = true;
      });
      aiProposalSignatureItem.watch((next) => {
        savedAiProposalSignature.value = next;
      });
    } catch {
      // Fallback when storage watching is unavailable in lightweight test stubs.
    }
  }
  const state = await readAiProposalState().catch(() => ({ proposal: null, signature: '' }));
  savedAiProposal.value = state.proposal;
  savedAiProposalSignature.value = state.signature;
  savedAiProposalLoaded.value = true;
}

/** Clears any cached on-device AI window proposal (e.g. when disabling AI). */
export function clearSavedAiProposal(): void {
  savedAiProposal.value = null;
  savedAiProposalSignature.value = '';
  lastAutoWindowAiSignature.value = null;
  void saveAiProposalState(null, '').catch(() => undefined);
}

/** All currently open, non-incognito tabs eligible for window organization. */
export const movableTabs = computed<readonly TabInfo[]>(() =>
  (panelData.value?.tabs ?? []).filter(
    (tab) => !tab.incognito && tab.windowId !== NO_WINDOW && isMovableTab(tab),
  ),
);

/** Content-aware signature of the currently movable tabs (empty when fewer than 2 tabs exist). */
export const movableTabSignature = computed<string>(() => movableTabsSignature(movableTabs.value));

export { aiProposalCoversMovable, aiProposalFreshForAutoRefresh };

export interface WindowPlanGroup {
  readonly key: string;
  readonly title: string;
  readonly color: GroupColor;
  readonly tabIds: readonly number[];
}

export interface WindowPlan {
  readonly source: 'ai' | 'local';
  readonly groups: readonly WindowPlanGroup[];
  readonly ungrouped: readonly number[];
}

/**
 * Current window-organization overview for the `!useTabGroups` UI, mirroring `platform/windows.ts`
 * so the user can see each window's topic/site name, tabs, and whether AI or local grouping ran.
 */
export const windowPlan = computed<WindowPlan>(() => {
  const movable = movableTabs.value;
  if (movable.length === 0) return { source: 'local', groups: [], ungrouped: [] };
  const byId = new Map(movable.map((tab) => [tab.id, tab]));
  const splitSites =
    panelData.value?.settings.autoWindowMode === 'split-windows' && mode.value === 'topic';

  const finalize = (
    source: 'ai' | 'local',
    groups: WindowPlanGroup[],
    ungrouped: readonly number[],
  ): WindowPlan => {
    if (!splitSites || ungrouped.length === 0) return { source, groups, ungrouped };
    const { siteBuckets, remaining } = partitionUngroupedBySite(ungrouped, byId, groups.length);
    return {
      source,
      groups: [
        ...groups,
        ...siteBuckets.map((bucket) => ({
          key: `site:${bucket.siteKey}`,
          title: siteName(bucket.siteKey),
          color: colorFor(bucket.siteKey),
          tabIds: bucket.tabIds,
        })),
      ],
      ungrouped: remaining,
    };
  };

  const clusterLocal = (subset: readonly TabInfo[]) =>
    proposeGroups(
      subset.map((tab, index) => ({ ...tab, windowId: 1, index, groupId: NO_GROUP_ID })),
      mode.value,
      { minSiteTabs: 2, minClusterTabs: 2, includePinned: false, includeGrouped: true },
    );

  const cached =
    mode.value === 'topic' && useAi.value
      ? filterProposalBySignature(savedAiProposal.value, movable, savedAiProposalSignature.value)
      : null;
  if (cached !== null) {
    const movableIds = new Set(movable.map((tab) => tab.id));
    const knownIds = new Set<number>(cached.ungrouped);
    const placed = new Set<number>();
    const groups: WindowPlanGroup[] = [];
    for (const group of cached.groups) {
      for (const id of group.tabIds) knownIds.add(id);
      const live = group.tabIds.filter((id) => movableIds.has(id) && !placed.has(id));
      if (live.length < 2) continue;
      for (const id of live) placed.add(id);
      groups.push({ key: group.key, title: group.title, color: group.color, tabIds: live });
    }
    const knownMovable = movable.filter((tab) => knownIds.has(tab.id)).length;
    if (groups.length > 0 && knownMovable * 2 >= movable.length) {
      const newTabs = movable.filter((tab) => !knownIds.has(tab.id));
      if (newTabs.length >= 1) {
        const fullLocal = clusterLocal(movable);
        const remainingNew: TabInfo[] = [];
        for (const newTab of newTabs) {
          const localCluster = fullLocal.groups.find((g) => g.tabIds.includes(newTab.id));
          let bestGroupIdx = -1;
          let bestOverlap = 0;
          if (localCluster !== undefined) {
            for (const [idx, group] of groups.entries()) {
              const overlap = group.tabIds.filter((id) => localCluster.tabIds.includes(id)).length;
              if (overlap > bestOverlap) {
                bestOverlap = overlap;
                bestGroupIdx = idx;
              }
            }
          }
          if (bestGroupIdx >= 0) {
            const target = groups[bestGroupIdx]!;
            groups[bestGroupIdx] = { ...target, tabIds: [...target.tabIds, newTab.id] };
            placed.add(newTab.id);
          } else {
            remainingNew.push(newTab);
          }
        }
        if (remainingNew.length >= 2) {
          const extra = clusterLocal(remainingNew);
          for (const extraGroup of extra.groups) {
            if (groups.length >= 8) break;
            groups.push({
              key: `new:${extraGroup.key}`,
              title: extraGroup.title,
              color: extraGroup.color,
              tabIds: extraGroup.tabIds,
            });
            for (const id of extraGroup.tabIds) placed.add(id);
          }
        }
      }
      const ungrouped = movable.filter((tab) => !placed.has(tab.id)).map((tab) => tab.id);
      return finalize('ai', groups, ungrouped);
    }
  }

  const local = clusterLocal(movable);
  return finalize(
    'local',
    local.groups.map((group) => ({
      key: group.key,
      title: group.title,
      color: group.color,
      tabIds: group.tabIds,
    })),
    local.ungrouped,
  );
});

export interface OrganizeWindowsWithAiOptions {
  readonly windowMode: AutoWindowMode;
  readonly clusterMode: ClusterMode;
  readonly useTabGroups: boolean;
  readonly useAi: boolean;
  /** True when triggered automatically on Organize mount rather than by an explicit click. */
  readonly automatic?: boolean;
  readonly focusedWindowId?: number;
  readonly deps?: AiRunDeps & {
    readonly check?: () => Promise<AiAvailability>;
    readonly organize?: typeof organizeWindows;
  };
}

/**
 * Organizes browser windows, using Chrome's on-device AI across all movable open tabs when
 * `clusterMode === 'topic'`, `useAi === true`, and native tab groups are off.
 *
 * Never modifies `useOnDeviceAi` or `autoOrganizeMode`: if the model is unavailable, times
 * out, or fails, falls back cleanly to local topic grouping and raises `aiFallbackNotice`
 * so the user is informed while their settings stay intact.
 */
export async function organizeWindowsWithAi(
  request: OrganizeWindowsWithAiOptions,
): Promise<OrganizeWindowsResult> {
  const organize = request.deps?.organize ?? organizeWindows;
  if (request.automatic === true && isAiAutoCoolingDown()) {
    return { movedTabs: 0, ungroupedTabs: 0, windowsCount: 0 };
  }
  if (request.automatic !== true) {
    clearAiAutoCooldown();
  }
  clearAiFallbackNotice();
  // An explicit user organize clears any prior undo snooze.
  void organizeSnoozeUntilItem.setValue(0).catch(() => undefined);

  const finish = async (proposal?: GroupProposal): Promise<OrganizeWindowsResult> => {
    windowWorking.value = true;
    try {
      const outcome = await organize({
        windowMode: request.windowMode,
        clusterMode: request.clusterMode,
        useTabGroups: request.useTabGroups,
        focusedWindowId: request.focusedWindowId,
        proposal,
      });
      if (outcome.undo !== undefined) {
        windowOrganized.value = {
          movedTabs: outcome.movedTabs,
          windowsCount: outcome.windowsCount,
          undo: outcome.undo,
        };
      }
      return outcome;
    } finally {
      windowWorking.value = false;
    }
  };

  if (request.useTabGroups || request.clusterMode !== 'topic' || !request.useAi) {
    return finish();
  }

  const currentAvailability = availability.value ?? (await (request.deps?.check ?? checkAi)());
  if (currentAvailability !== 'available') {
    return finish();
  }

  const movable = (panelData.value?.tabs ?? []).filter(
    (tab) => !tab.incognito && tab.windowId !== NO_WINDOW && isMovableTab(tab),
  );
  if (movable.length < 2) {
    return finish();
  }
  const currentSignature = movableTabsSignature(movable);
  lastAutoWindowAiSignature.value = currentSignature;

  // Group across every open window together by placing movable tabs in one virtual window,
  // with compact 1..N IDs so the small local model never drops digits from Chrome's 10-digit IDs.
  const unified: TabInfo[] = movable.map((tab, index) => ({
    ...tab,
    windowId: 1,
    index,
    groupId: NO_GROUP_ID,
  }));
  const mapped = withCompactTabIds(unified);

  // Supersede any previous in-flight AI grouping run so rapid clicks always win cleanly.
  running?.abort();
  const controller = new AbortController();
  running = controller;
  aiWorking.value = true;
  void aiBusyUntilItem
    .setValue(Date.now() + PANEL_AI_WARMUP_TIMEOUT_MS + PANEL_AI_TIMEOUT_MS)
    .catch(() => undefined);
  clearAiFallbackNotice();
  let proposal: GroupProposal | undefined;
  let usedModel: Llm | undefined;
  let ticker: { readonly stop: () => void; readonly setLabel: (next: string) => void } | undefined;
  const lockStartedAt = Date.now();
  let warmupStartedAt = lockStartedAt;
  let lockMs = 0;
  let wasWarm = false;

  let cancelled = false;
  try {
    ticker = startStageTicker('lock (waiting for background AI)', PANEL_AI_WARMUP_TIMEOUT_MS);
    preemptBackgroundAi();
    await withAiLock(false, async () => {
      ticker?.stop();
      ticker = undefined;
      if (running !== controller || controller.signal.aborted) {
        cancelled = true;
        return;
      }
      lockMs = Date.now() - lockStartedAt;
      warmupStartedAt = Date.now();
      const groupBy = request.deps?.groupBy ?? (await import('@/core/ai-grouping')).groupByAi;
      const model = request.deps?.model ?? (await aiModel());
      usedModel = model;
      wasWarm = (model as { isOpen?: boolean }).isOpen === true;
      ticker = startStageTicker(
        `warmup (LanguageModel.create, ${wasWarm ? 'warm' : 'cold'})`,
        PANEL_AI_WARMUP_TIMEOUT_MS,
      );
      await warmModel(model, controller.signal);
      ticker.stop();
      ticker = undefined;
      if (running !== controller || controller.signal.aborted) {
        cancelled = true;
        return;
      }
      const warmupMs = Date.now() - warmupStartedAt;
      const promptStartedAt = Date.now();
      const promptTicker = startStageTicker(
        `prompt (${mapped.compact.length} tabs, warm=${formatSeconds(warmupMs)})`,
        PANEL_AI_TIMEOUT_MS,
      );
      ticker = promptTicker;
      const result = await groupBy(mapped.compact, model, {
        minSiteTabs: 2,
        minClusterTabs: 2,
        maxBatchTabs: 60,
        includePinned: false,
        includeGrouped: true,
        timeoutMs: PANEL_AI_TIMEOUT_MS,
        signal: controller.signal,
        onStage: (stage) => {
          promptTicker.setLabel(`${stage} (${mapped.compact.length} tabs)`);
        },
      });
      promptTicker.stop();
      ticker = undefined;
      const promptMs = Date.now() - promptStartedAt;
      if (
        running !== controller ||
        controller.signal.aborted ||
        result.fallbackReason === 'aborted'
      ) {
        cancelled = true;
        return;
      }
      const lockTag = lockMs >= 100 ? `lock=${formatSeconds(lockMs)} · ` : '';
      const timing = `${lockTag}warmup=${formatSeconds(warmupMs)} · prompt=${formatSeconds(promptMs)}/${Math.round(PANEL_AI_TIMEOUT_MS / 1000)}s · tabs=${mapped.compact.length}`;
      if (result.source === 'ai') {
        const restored = mapped.restore(result.proposal);
        if (restored.groups.length > 0) {
          proposal = restored;
          clearAiAutoCooldown();
          clearAiFallbackNotice();
          savedAiProposal.value = restored;
          savedAiProposalSignature.value = currentSignature;
          savedAiProposalLoaded.value = true;
          void saveAiProposalState(restored, currentSignature).catch(() => undefined);
        } else {
          if (request.automatic === true) {
            aiAutoCooldownUntil = Date.now() + AI_AUTO_RETRY_COOLDOWN_MS;
          }
          savedAiProposal.value = null;
          savedAiProposalSignature.value = '';
          void saveAiProposalState(null, '').catch(() => undefined);
          recordAiFallback('no-groups', timing);
        }
      } else if (result.fallbackReason !== 'empty') {
        if (request.automatic === true) {
          aiAutoCooldownUntil = Date.now() + AI_AUTO_RETRY_COOLDOWN_MS;
        }
        savedAiProposal.value = null;
        savedAiProposalSignature.value = '';
        void saveAiProposalState(null, '').catch(() => undefined);
        recordAiFallback(
          result.fallbackReason,
          result.fallbackDetail !== undefined ? `${result.fallbackDetail} (${timing})` : timing,
        );
      }
    });
    if (cancelled) return { movedTabs: 0, ungroupedTabs: 0, windowsCount: 0 };
  } catch (error: unknown) {
    if (running !== controller || controller.signal.aborted) {
      return { movedTabs: 0, ungroupedTabs: 0, windowsCount: 0 };
    }
    if (request.automatic === true) {
      aiAutoCooldownUntil = Date.now() + AI_AUTO_RETRY_COOLDOWN_MS;
    }
    savedAiProposal.value = null;
    savedAiProposalSignature.value = '';
    void saveAiProposalState(null, '').catch(() => undefined);
    const elapsed = formatSeconds(Date.now() - warmupStartedAt);
    const budget = `${Math.round(PANEL_AI_WARMUP_TIMEOUT_MS / 1000)}s`;
    const lockTag = lockMs >= 100 ? `lock=${formatSeconds(lockMs)} · ` : '';
    const meta = `LanguageModel.create · ${lockTag}${elapsed}/${budget} · session=${wasWarm ? 'warm' : 'cold'} · tabs=${mapped.compact.length}`;
    if (isTimeoutError(error)) {
      recordAiFallback('timeout', `model warmup (${meta})`);
      // When the in-flight background `LanguageModel.create()` finishes warming after the
      // deadline, lift the cooldown and automatically re-run with the warm session.
      usedModel?.onWarm?.(() => {
        clearAiAutoCooldown();
        lastAutoWindowAiSignature.value = null;
        if (!aiWorking.value && !windowWorking.value && useAi.value) {
          void organizeWindowsWithAi({ ...request, automatic: false }).catch(() => undefined);
        }
      });
    } else {
      const msg = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      recordAiFallback('error', `${msg} (${meta})`);
    }
  } finally {
    ticker?.stop();
    if (running === controller) {
      running = null;
      aiWorking.value = false;
      aiStageDetail.value = null;
      void aiBusyUntilItem.setValue(0).catch(() => undefined);
    }
  }

  return finish(proposal);
}

/** Reverts the last window organization and briefly snoozes background auto-organize so it stays undone. */
export async function undoWindowOrganize(
  undoFn: typeof undoOrganizeWindows = undoOrganizeWindows,
): Promise<void> {
  const last = windowOrganized.value;
  if (last === null || windowWorking.value) return;
  windowOrganized.value = null;
  windowWorking.value = true;
  try {
    await organizeSnoozeUntilItem
      .setValue(Date.now() + WINDOW_UNDO_SNOOZE_MS)
      .catch(() => undefined);
    savedAiProposal.value = null;
    savedAiProposalSignature.value = '';
    await saveAiProposalState(null, '').catch(() => undefined);
    await undoFn(last.undo);
  } catch (error: unknown) {
    console.error('TabDeclutter: undo window organize', error);
  } finally {
    windowWorking.value = false;
  }
}

/** Dismisses the window organization toast, keeping the new window layout. */
export function dismissWindowOrganized(): void {
  windowOrganized.value = null;
}

/** "Annulla" in the spinner (§7.3): the run stops and §7.2's proposal stays on screen. */
export function cancelAiGrouping(): void {
  running?.abort();
}

/** Drops the model's answer, so the next question is asked again. Used by the tests. */
export function resetAiGrouping(): void {
  running?.abort();
  running = null;
  aiWorking.value = false;
  aiStageDetail.value = null;
  windowWorking.value = false;
  windowOrganized.value = null;
  savedAiProposal.value = null;
  savedAiProposalSignature.value = '';
  savedAiProposalLoaded.value = false;
  lastAutoWindowAiSignature.value = null;
  aiAutoCooldownUntil = 0;
  clearAiFallbackNotice();
  answer.value = null;
}

/** How many tabs [Applica] would group (§4.4.5), which is when it is worth pressing. */
export const plannedTabs = computed(() => plannedCount(draft.value));

/** The last apply, for as long as "Annulla" can still take it back. */
export const applied = signal<ApplyResult | null>(null);

/** Whether an apply or an undo is in flight, so neither can be asked for twice. */
export const working = signal(false);

/** What the toast has to say: how many groups went in, and what stayed out (§7.4). */
export const appliedMessage = computed(() => {
  const result = applied.value;
  if (result === null) return null;
  return { groups: result.groups.length, skipped: applyMessage(result) };
});

/* The edits of §4.4.3. Each one pins the draft, because an edited preview is the user's. */

export function rename(key: string, title: string): void {
  edited.value = renameGroup(draft.value, key, title);
}

export function recolor(key: string, color: GroupColor): void {
  edited.value = recolorGroup(draft.value, key, color);
}

export function toggle(key: string): void {
  edited.value = toggleGroup(draft.value, key);
}

export function move(tabId: number, to: string | null): void {
  edited.value = moveTab(draft.value, tabId, to);
}

export function merge(fromKey: string, intoKey: string): void {
  edited.value = mergeGroups(draft.value, fromKey, intoKey);
}

/**
 * [Applica] (§4.4.5). The draft is pinned first, so what the toast is about stays on
 * screen: the tabs are grouped a moment later, and an unpinned proposal would empty
 * itself out from under the user who is deciding whether to undo.
 */
export function applyDraft(): void {
  if (working.value) return;
  const current = draft.value;
  const proposal = proposalOf(current);
  if (proposal.groups.length === 0) return;

  edited.value = current;
  working.value = true;
  void applyGroups(proposal, applyOptionsOf(options.value))
    .then((result) => {
      applied.value = result;
    })
    .catch((error: unknown) => {
      console.error('TabDeclutter: apply groups', error);
    })
    .finally(() => {
      working.value = false;
    });
}

/** "Annulla" on the toast: `ungroup` and the original indexes back (§4.4.5). */
export function undoApply(): void {
  const result = applied.value;
  if (result === null || working.value) return;
  applied.value = null;
  working.value = true;
  void undoGroups(result)
    .then(() => {
      // The groups are gone, so the proposal is the answer again.
      resetEdits();
    })
    .catch((error: unknown) => {
      console.error('TabDeclutter: undo groups', error);
    })
    .finally(() => {
      working.value = false;
    });
}

/** The toast dismissed: the apply stands, and the preview goes back to proposing. */
export function dismissApplied(): void {
  applied.value = null;
  resetEdits();
}
