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

import { computed, signal } from '@preact/signals';

import type { ClusterMode } from '@/core/cluster';
import { DEFAULT_SETTINGS } from '@/core/types';
import {
  DEFAULT_ORGANIZE_OPTIONS,
  type Draft,
  type OrganizeOptions,
  type OrganizeScope,
} from '../organize';
import { selectedIds } from './selection';
import { panelData } from './tabs';
import { showView } from './view';

export const scope = signal<OrganizeScope>('window');

/**
 * In-memory override for `mode` during the current panel session (so `setMode` takes effect
 * synchronously before `storage.local` finishes its round trip). When `null` (such as every
 * time the side panel is opened), `mode` reads the persisted `settings.autoOrganizeMode`, so
 * "By topic" / "By website" never resets when reopening the panel.
 */
const modeOverride = signal<ClusterMode | null>(null);

export const mode = computed<ClusterMode>(
  () =>
    modeOverride.value ??
    panelData.value?.settings.autoOrganizeMode ??
    DEFAULT_SETTINGS.autoOrganizeMode,
);
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
  modeOverride.value = next;
  resetEdits();
}

/** Drops the local override so `mode` follows persisted `settings.autoOrganizeMode` again. */
export function clearModeOverride(): void {
  modeOverride.value = null;
}

/** Drops the local override only if it still matches `expected`, preventing races on rapid clicks. */
export function clearModeOverrideIf(expected: ClusterMode): void {
  if (modeOverride.value === expected) modeOverride.value = null;
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
