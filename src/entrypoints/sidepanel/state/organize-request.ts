/**
 * The question Organize is asked (PLAN.md §4.4.1-§4.4.4): which tabs, grouped how, with
 * which options — and the user's edits to the answer.
 *
 * This is a separate module from `state/organize.ts` for one reason: §4.3's "Raggruppa"
 * button lives in the selection bar, which is in the panel's first chunk, and it must be
 * able to set the scope without dragging the clustering in with it. Everything here is
 * signals and type-only imports, so the chunk that holds `core/cluster.ts` and
 * `platform/groups.ts` is still only reached through the `import()` of `App.tsx` (§11).
 *
 * `edited` lives here too, because every setter has to clear it: changing the scope, the
 * mode or an option asks a new question, and the edits made to the previous answer are not
 * an answer to it.
 */

import { signal } from '@preact/signals';

import type { ClusterMode } from '@/core/cluster';
import {
  DEFAULT_ORGANIZE_OPTIONS,
  type Draft,
  type OrganizeOptions,
  type OrganizeScope,
} from '../organize';
import { selectedIds } from './selection';
import { showView } from './view';

export const scope = signal<OrganizeScope>('window');
export const mode = signal<ClusterMode>('site');
export const options = signal<OrganizeOptions>(DEFAULT_ORGANIZE_OPTIONS);

/** The ids §4.3's "Raggruppa" brought over, or `null` when it never ran. */
export const brought = signal<readonly number[] | null>(null);

/** The user's edits, or `null` while the preview is still the proposal itself. */
export const edited = signal<Draft | null>(null);

/** A new question: the proposal answers it, not the edits made to the previous one. */
export function resetEdits(): void {
  edited.value = null;
}

export function setScope(next: OrganizeScope): void {
  scope.value = next;
  resetEdits();
}

export function setMode(next: ClusterMode): void {
  mode.value = next;
  resetEdits();
}

export function setOptions(change: Partial<OrganizeOptions>): void {
  options.value = { ...options.value, ...change };
  resetEdits();
}

/**
 * §4.3's "Raggruppa": the selection becomes the preview's scope and the panel goes to the
 * Organize view. The selection itself is left alone — going back to Declutter should find
 * the list as it was left.
 */
export function organizeSelection(tabIds: readonly number[] = selectedIds.value): void {
  brought.value = [...tabIds];
  scope.value = 'selection';
  resetEdits();
  showView('organize');
}
