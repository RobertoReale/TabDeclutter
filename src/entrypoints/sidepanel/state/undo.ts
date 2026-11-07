/**
 * The last close, for as long as it can still be undone (PLAN.md §4.3, §9).
 *
 * PLAN.md §3: "everything reversible with an immediate Annulla". A close writes its
 * archive entries here, the toast shows them for `UNDO_MS`, and `takeClose` hands them to
 * whoever restores them — `platform/tabs.ts`'s `restoreTabs`, which is the panel's and not
 * this module's, so the state machine stays a function of its own calls and is tested
 * without a browser.
 *
 * The clock is the only thing here with a will of its own, and it has one rule: §4.3 says
 * the toast "does not disappear while hovered", so a hold stops it and letting go starts
 * it again from the top. A second close replaces the first rather than queueing: the toast
 * offers one Annulla, and it is always the last thing the user did (§4.8's `Ctrl+Z`).
 *
 * The entries stay in the archive when the toast expires. Nothing is lost by forgetting
 * them here — §4.5's Archive view restores them for weeks afterwards.
 */

// Relative, not `@/`: the `unit` vitest project runs without WXT's plugin and so without
// WXT's alias, and this module is tested there.
import { signal } from '@preact/signals';

import type { ArchivedTab } from '../../../core/types';

/** How long the undo toast stays, PLAN.md §4.3: "8 s". */
export const UNDO_MS = 8_000;

/** One close, as the toast and `Ctrl+Z` see it. */
export interface ClosedBatch {
  /** What went to the archive, which is what a restore brings back. */
  readonly entries: readonly ArchivedTab[];
  /** How many windows went with those tabs, so the toast can say the same as the button. */
  readonly windows: number;
}

/** The close still open to an Annulla, or `null`. */
export const lastClose = signal<ClosedBatch | null>(null);

let timer: ReturnType<typeof setTimeout> | undefined;
/** Whether the pointer or the focus is on the toast. */
let held = false;
/** The span of the close currently showing. */
let span = UNDO_MS;

function disarm(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
}

function arm(): void {
  disarm();
  if (held || lastClose.value === null) return;
  timer = setTimeout(() => {
    timer = undefined;
    lastClose.value = null;
  }, span);
}

/**
 * Remembers a close and starts the toast's clock. `ms` is injected only so the tests can
 * be exact about the 8 s.
 */
export function rememberClose(closed: ClosedBatch, ms: number = UNDO_MS): void {
  span = ms;
  held = false;
  lastClose.value = closed;
  arm();
}

/** The pointer or the focus arrived: §4.3's "does not disappear while hovered". */
export function holdUndo(): void {
  held = true;
  disarm();
}

/** It left: the 8 s start again, so what was read stays readable. */
export function releaseUndo(): void {
  held = false;
  arm();
}

/** Drops the close without undoing it. */
export function forgetClose(): void {
  disarm();
  held = false;
  lastClose.value = null;
}

/**
 * Takes the close to undo it: it leaves the toast at once, so a second Annulla — a click
 * and a `Ctrl+Z` on top of each other — cannot restore the same tabs twice.
 */
export function takeClose(): ClosedBatch | null {
  const closed = lastClose.value;
  forgetClose();
  return closed;
}
