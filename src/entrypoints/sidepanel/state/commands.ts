/**
 * What the panel actually does to the tabs it suggests (PLAN.md §4.3, §9).
 *
 * The rows, the section headers, the sticky bar, the window card and §4.8's keys all ask
 * for the same four things — close, keep, suspend, undo — so they ask them here instead of
 * each wiring itself to `platform/tabs.ts`. That is what keeps one rule in one place: no
 * close happens without going through `gate`, which is PLAN.md §9's safeguards, and every
 * close that happens ends in `rememberClose`, which is the Annulla of §4.3.
 *
 * Nothing here decides *whether* a close is safe: `src/core/actions.ts`'s `safeguardsFor`
 * does, over the same snapshot the rows are drawn from (`state/tabs.ts`). This module only
 * turns its answer into either a question or a call.
 *
 * The question is a signal rather than a component's state because the close can be asked
 * for from four different places and the answer is always given in the same one, the bar.
 */

import { computed, signal } from '@preact/signals';

import type { Safeguards } from '@/core/actions';
import { safeguardsFor } from '@/core/actions';
import type { TabInfo } from '@/core/types';
import {
  activateTab,
  closeTabs,
  closeWindow,
  discardTab,
  keepTab,
  restoreTabs,
} from '@/platform/tabs';
import { deselectTabs, selectTabs, selectedIds } from './selection';
import { panelData, scoring } from './tabs';
import { rememberClose, takeClose } from './undo';

/** A close, with what §9 says about it. */
export interface PendingClose {
  readonly safeguards: Safeguards;
  /**
   * Set when the close is one whole window taken as one (§4.3's card), which is archived
   * as a window so §4.5 can offer it back as a window.
   */
  readonly windowId?: number;
}

/** The close waiting for an answer in the bar, or `null`. */
export const asking = signal<PendingClose | null>(null);

/** What §9 says about what is picked right now, which is what the bar draws. */
export const selectionSafeguards = computed(() => plan(selectedIds.value));

function plan(tabIds: readonly number[]): Safeguards {
  const data = panelData.value;
  const focusedWindowId = data?.focusedWindowId;
  return safeguardsFor({
    selectedIds: tabIds,
    tabs: data?.tabs ?? [],
    ...(focusedWindowId === undefined ? {} : { focusedWindowId }),
  });
}

function ids(tabs: readonly TabInfo[]): readonly number[] {
  return tabs.map((tab) => tab.id);
}

/** "Chiudi", from a row, a section header or the bar. */
export function requestClose(tabIds: readonly number[]): void {
  gate(plan(tabIds));
}

/** "Chiudi finestra", from §4.3's card above the list. */
export function requestCloseWindow(windowId: number): void {
  const open = panelData.value?.tabs ?? [];
  gate(plan(ids(open.filter((tab) => tab.windowId === windowId))), windowId);
}

/**
 * PLAN.md §9, the only door a close goes through: either it may happen now, or it becomes
 * the question the bar asks.
 *
 * A close that has to be asked about selects its tabs first. The question is in the bar and
 * the bar is about the selection, so this is what makes the two agree — and it leaves the
 * rows ticked behind the question, which is the clearest answer to "which 42?".
 */
function gate(safeguards: Safeguards, windowId?: number): void {
  // Nothing of it is still open: the list has moved on, and so has the question.
  if (safeguards.tabs.length === 0) {
    asking.value = null;
    return;
  }

  const pending: PendingClose = {
    safeguards,
    ...(windowId === undefined ? {} : { windowId }),
  };

  if (!safeguards.needsConfirmation) {
    asking.value = null;
    run(close(pending));
    return;
  }

  selectTabs(ids(safeguards.tabs));
  asking.value = pending;
}

/**
 * [Conferma]. The safeguards are computed again on the way through: between the question
 * and the answer the user may have closed tabs by hand, and what goes is what is open now.
 */
export function confirmClose(): void {
  const pending = asking.value;
  asking.value = null;
  if (pending === null) return;

  const now = plan(ids(pending.safeguards.tabs));
  if (now.tabs.length === 0) return;
  run(
    close({
      safeguards: now,
      ...(pending.windowId === undefined ? {} : { windowId: pending.windowId }),
    }),
  );
}

/** [Annulla] on the question: nothing closes, and the selection stays to be looked at. */
export function cancelClose(): void {
  asking.value = null;
}

async function close(pending: PendingClose): Promise<void> {
  const { safeguards, windowId } = pending;
  const at = Date.now();
  const openTabs = panelData.value?.tabs ?? [];
  const byId = new Map(openTabs.map((tab) => [tab.id, tab]));
  const closingIds = new Set(safeguards.tabs.map((tab) => tab.id));

  let keptToActivate: TabInfo | undefined;
  if (windowId === undefined) {
    for (const scored of scoring.value.tabs) {
      if (!closingIds.has(scored.tabId)) continue;
      for (const reason of scored.reasons) {
        if (reason.code === 'duplicate' && !closingIds.has(reason.keptTabId)) {
          const kept = byId.get(reason.keptTabId);
          if (kept !== undefined) keptToActivate = kept;
        }
      }
    }
  }

  const entries =
    windowId === undefined
      ? await closeTabs(safeguards.tabs, at)
      : await closeWindow(windowId, openTabs, at);

  if (keptToActivate !== undefined) {
    await activateTab(keptToActivate.id, keptToActivate.windowId).catch(() => undefined);
  }

  deselectTabs(ids(safeguards.tabs));
  // Even an empty close arms the toast, so a close that archived nothing still says so
  // rather than leaving the user wondering.
  rememberClose({ entries, windows: safeguards.wholeWindowIds.length });
}

/**
 * "Mantieni" (§9): seven days, which is `keepTab`'s default. Once per distinct URL,
 * because a keep is about the page and a selection may hold the same page twice.
 */
export function keepTabs(tabs: readonly TabInfo[]): void {
  run(keep(tabs));
}

async function keep(tabs: readonly TabInfo[]): Promise<void> {
  const at = Date.now();
  for (const url of new Set(tabs.map((tab) => tab.url))) await keepTab(url, at);
  deselectTabs(ids(tabs));
}

/** "Sospendi" (§9, §5.5): the ones that can be, which is `discardTab`'s answer. */
export function discardTabs(tabs: readonly TabInfo[]): void {
  run(discard(tabs));
}

async function discard(tabs: readonly TabInfo[]): Promise<void> {
  for (const tab of tabs) await discardTab(tab);
  deselectTabs(ids(tabs));
}

/**
 * "Annulla" on the toast, and §4.8's `Ctrl+Z`. The batch leaves the toast before the
 * restore starts (`takeClose`), so the two cannot undo the same close twice.
 */
export function undoClose(): void {
  const closed = takeClose();
  if (closed === null) return;
  run(restoreTabs(closed.entries, Date.now()));
}

/**
 * Every call out of here is fire-and-forget — the click has already been answered on
 * screen — so this is the one place a failure is reported instead of becoming an
 * unhandled rejection.
 */
function run(work: Promise<unknown>): void {
  void work.catch((error: unknown) => {
    console.error('TabDeclutter: panel action', error);
  });
}
