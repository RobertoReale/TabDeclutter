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
 */

import { computed, signal } from '@preact/signals';

import { proposeGroups, type GroupColor } from '@/core/cluster';
import { applyGroups, applyMessage, undoGroups, type ApplyResult } from '@/platform/groups';
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

/** The proposal for what is in scope right now, before any edit. */
const proposed = computed<Draft>(() => {
  const data = panelData.value;
  const scoped = tabsInScope(data?.tabs ?? [], scope.value, brought.value, data?.focusedWindowId);
  return draftOf(proposeGroups(scoped, mode.value, clusterOptionsOf(options.value)));
});

/** What the preview draws: the proposal, or the proposal as the user has left it. */
export const draft = computed<Draft>(() => edited.value ?? proposed.value);

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
