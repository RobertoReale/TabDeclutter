/**
 * Which view the panel is showing.
 *
 * Module-level signals rather than state inside `App`, because the navigation is no longer the
 * only thing that moves: the chip's counter of PLAN.md §4.2 offers "· Vedi", which has to open
 * the archive from the header, and the chip's menu has to open the settings (§8.3). A signal
 * here means neither needs a callback threaded down through the shell.
 */

import { signal } from '@preact/signals';

export type ViewId = 'declutter' | 'organize' | 'archive';

export const view = signal<ViewId>('declutter');

/** Whether the settings are open on top of the current view (§8.3, the gear of §4.2). */
export const settingsOpen = signal(false);

/** Shows a view, which always means leaving the settings. */
export function showView(id: ViewId): void {
  view.value = id;
  settingsOpen.value = false;
}

export function showSettings(): void {
  settingsOpen.value = true;
}

export function toggleSettings(): void {
  settingsOpen.value = !settingsOpen.value;
}
