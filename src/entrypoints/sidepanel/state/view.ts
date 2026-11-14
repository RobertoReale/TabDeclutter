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

/**
 * Which settings page is open: the one of §4.6, or the "Protezione duplicati" sub-page of §8.3.
 *
 * A signal here and not state inside the view, because the chip's menu opens the sub-page
 * directly while the gear opens the main page.
 */
export type SettingsPage = 'main' | 'duplicates';

export const settingsPage = signal<SettingsPage>('main');

/** Shows a view, which always means leaving the settings. */
export function showView(id: ViewId): void {
  view.value = id;
  settingsOpen.value = false;
}

export function showSettings(page: SettingsPage = 'main'): void {
  settingsPage.value = page;
  settingsOpen.value = true;
}

/** The gear of §4.2, which always opens the settings at their first page. */
export function toggleSettings(): void {
  settingsPage.value = 'main';
  settingsOpen.value = !settingsOpen.value;
}
