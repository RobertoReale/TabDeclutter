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

import type { Llm, groupByAi as GroupByAi } from '@/core/ai-grouping';
import {
  proposeGroups,
  type ClusterMode,
  type GroupColor,
  type GroupProposal,
} from '@/core/cluster';
import { NO_GROUP_ID, type AutoWindowMode, type TabInfo } from '@/core/types';
import { applyGroups, applyMessage, undoGroups, type ApplyResult } from '@/platform/groups';
import { aiProposalItem } from '@/platform/storage';
import { NO_WINDOW } from '@/platform/tabs';
import { isMovableTab, organizeWindows, type OrganizeWindowsResult } from '@/platform/windows';
import { aiActive, aiModel, availability, checkAi, type AiAvailability } from './ai';
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

/** Clears the AI fallback warning (e.g. when the user disables AI or switches away from topic). */
export function clearAiFallbackNotice(): void {
  aiFallbackNotice.value = false;
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
  aiFallbackNotice.value = false;
  let drafted: Draft | null = null;
  try {
    const groupBy = deps.groupBy ?? (await import('@/core/ai-grouping')).groupByAi;
    const model = deps.model ?? (await aiModel());
    const result = await groupBy(tabs, model, { ...chosen, signal: controller.signal });
    // A newer run, or a changed question, owns the answer now: this one is stale.
    if (running !== controller) return;
    if (result.source === 'ai') {
      drafted = draftOf(result.proposal);
      aiFallbackNotice.value = false;
    } else if (result.fallbackReason !== 'empty' && result.fallbackReason !== 'aborted') {
      aiFallbackNotice.value = true;
    }
  } catch (error: unknown) {
    // A model that cannot even be reached is not fatal: §7.2 has already answered,
    // and we surface a warning without changing the user's AI setting.
    console.error('TabDeclutter: group by topic with the model', error);
    if (running === controller && !controller.signal.aborted) {
      aiFallbackNotice.value = true;
    }
  } finally {
    if (running === controller) {
      running = null;
      aiWorking.value = false;
      // Recorded either way: a question that fell back is answered, and asking the model
      // the same thing again would only take the same twenty seconds.
      answer.value = { question: asked, draft: drafted };
    }
  }
}

export interface OrganizeWindowsWithAiOptions {
  readonly windowMode: AutoWindowMode;
  readonly clusterMode: ClusterMode;
  readonly useTabGroups: boolean;
  readonly useAi: boolean;
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
  aiFallbackNotice.value = false;

  if (request.useTabGroups || request.clusterMode !== 'topic' || !request.useAi) {
    return organize({
      windowMode: request.windowMode,
      clusterMode: request.clusterMode,
      useTabGroups: request.useTabGroups,
      focusedWindowId: request.focusedWindowId,
    });
  }

  const currentAvailability = availability.value ?? (await (request.deps?.check ?? checkAi)());
  if (currentAvailability !== 'available') {
    return organize({
      windowMode: request.windowMode,
      clusterMode: request.clusterMode,
      useTabGroups: request.useTabGroups,
      focusedWindowId: request.focusedWindowId,
    });
  }

  const movable = (panelData.value?.tabs ?? []).filter(
    (tab) => !tab.incognito && tab.windowId !== NO_WINDOW && isMovableTab(tab),
  );
  if (movable.length < 2) {
    return organize({
      windowMode: request.windowMode,
      clusterMode: request.clusterMode,
      useTabGroups: request.useTabGroups,
      focusedWindowId: request.focusedWindowId,
    });
  }

  // Group across every open window together by placing movable tabs in one virtual window.
  const unified: TabInfo[] = movable.map((tab, index) => ({
    ...tab,
    windowId: 1,
    index,
    groupId: NO_GROUP_ID,
  }));

  // Supersede any previous in-flight AI grouping run so rapid clicks always win cleanly.
  running?.abort();
  const controller = new AbortController();
  running = controller;
  aiWorking.value = true;
  let proposal: GroupProposal | undefined;

  try {
    const groupBy = request.deps?.groupBy ?? (await import('@/core/ai-grouping')).groupByAi;
    const model = request.deps?.model ?? (await aiModel());
    const result = await groupBy(unified, model, {
      minSiteTabs: 2,
      minClusterTabs: 2,
      includePinned: false,
      includeGrouped: true,
      signal: controller.signal,
    });
    if (
      running !== controller ||
      controller.signal.aborted ||
      result.fallbackReason === 'aborted'
    ) {
      return { movedTabs: 0, ungroupedTabs: 0, windowsCount: 0 };
    }
    if (result.source === 'ai') {
      proposal = result.proposal;
      aiFallbackNotice.value = false;
      void aiProposalItem.setValue(result.proposal).catch(() => undefined);
    } else if (result.fallbackReason !== 'empty') {
      aiFallbackNotice.value = true;
    }
  } catch (error: unknown) {
    if (running !== controller || controller.signal.aborted) {
      return { movedTabs: 0, ungroupedTabs: 0, windowsCount: 0 };
    }
    console.error('TabDeclutter: organize windows with the model', error);
    aiFallbackNotice.value = true;
  } finally {
    if (running === controller) {
      running = null;
      aiWorking.value = false;
    }
  }

  return organize({
    windowMode: request.windowMode,
    clusterMode: request.clusterMode,
    useTabGroups: request.useTabGroups,
    focusedWindowId: request.focusedWindowId,
    proposal,
  });
}

/** "Annulla" in the spinner (§7.3): the run stops and §7.2's proposal stays on screen. */
export function cancelAiGrouping(): void {
  running?.abort();
}

/** Drops the model's answer, so the next question is asked again. Used by the tests. */
export function resetAiGrouping(): void {
  running = null;
  aiWorking.value = false;
  aiFallbackNotice.value = false;
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
