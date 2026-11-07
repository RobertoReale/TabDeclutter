/**
 * What the user has picked in the Declutter list (PLAN.md §4.3, §4.8).
 *
 * A set of tab ids and nothing else: which tabs those ids stand for, whether they are
 * still open and what closing them would mean are `src/core/actions.ts`'s answer
 * (`safeguardsFor`), computed from the same snapshot the rows are drawn from. That is why
 * nothing here prunes: an id whose tab has gone is dropped by every reader, because a
 * reader always starts from the open tabs, and a selection that outlived its tabs is at
 * worst a number the user cannot see.
 *
 * It is a module and not a component's state because three places read it — the rows, the
 * section headers and the sticky bar — and §4.8's `Ctrl+A` writes it from a fourth.
 */

// Relative, not `@/`: the `unit` vitest project runs without WXT's plugin and so without
// WXT's alias, and this module is tested there.
import { computed, signal, type ReadonlySignal } from '@preact/signals';

const picked = signal<ReadonlySet<number>>(new Set<number>());

/** The picked ids, in the order they were picked. */
export const selectedIds = computed<readonly number[]>(() => [...picked.value]);

/** Whether anything at all is picked, which is what makes the sticky bar appear (§4.3). */
export const hasSelection = computed(() => picked.value.size > 0);

export function isSelected(tabId: number): boolean {
  return picked.value.has(tabId);
}

const flags = new Map<number, ReadonlySignal<boolean>>();

/**
 * Whether that tab is picked, as a signal of its own — which is how picking one row
 * re-renders one row instead of the list (PLAN.md §11).
 *
 * A component that read the set itself would subscribe to every change of it, and with 200
 * rows on screen that is 200 renders per `Space`. One computed per tab id turns it into 200
 * `Set.has` and one render: they all recompute, only the one whose answer changed notifies
 * anything. The map is never pruned — one entry per tab id the panel has drawn, which is
 * bounded by the session's tabs and smaller than a row.
 */
export function selectedSignal(tabId: number): ReadonlySignal<boolean> {
  const existing = flags.get(tabId);
  if (existing !== undefined) return existing;
  const made = computed(() => isSelected(tabId));
  flags.set(tabId, made);
  return made;
}

/**
 * Whether every one of those tabs is picked. Empty is `false`: the section header asks
 * this to decide whether its button says "Seleziona tutti" or "Deseleziona tutti", and a
 * section with no rows has nothing to deselect.
 */
export function allSelected(tabIds: readonly number[]): boolean {
  return tabIds.length > 0 && tabIds.every((tabId) => picked.value.has(tabId));
}

/** §4.8's `Space` on a row. */
export function toggleSelected(tabId: number): void {
  const next = new Set(picked.value);
  if (!next.delete(tabId)) next.add(tabId);
  picked.value = next;
}

export function selectTabs(tabIds: readonly number[]): void {
  if (tabIds.length === 0) return;
  const next = new Set(picked.value);
  for (const tabId of tabIds) next.add(tabId);
  picked.value = next;
}

export function deselectTabs(tabIds: readonly number[]): void {
  if (tabIds.length === 0) return;
  const next = new Set(picked.value);
  for (const tabId of tabIds) next.delete(tabId);
  picked.value = next;
}

export function clearSelection(): void {
  if (picked.value.size === 0) return;
  picked.value = new Set<number>();
}
