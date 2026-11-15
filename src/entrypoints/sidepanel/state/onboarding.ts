/**
 * The first run of PLAN.md §17: whether the panel owes the user the onboarding screen, the two
 * choices while they are being made, and what "Inizia" writes.
 *
 * The screen is shown by the panel itself and nothing is ever opened for the user (§17: "never
 * pages opened automatically"), so this is read when the panel starts, exactly like the settings
 * and the guard's state.
 *
 * The choices are held here rather than in the view, because the whitelist link of §17.3 leaves
 * the screen for the settings: what the user had already answered must survive the move, and the
 * write that carries it happens here.
 */

import { signal } from '@preact/signals';

import { DEFAULT_SETTINGS, type GuardMode } from '@/core/types';
import { onboardedItem, readSettings, saveSettings } from '@/platform/storage';
import { ONBOARDING_DEFAULT_MODE } from '../settings-fields';
import { showSettings } from './view';

/**
 * Whether the onboarding is what the panel has to show. `null` until the stored flag has been
 * read, which is the one state in which the panel shows neither: a flash of Declutter followed by
 * the first-run screen would be worse than a frame of nothing.
 */
export const onboardingNeeded = signal<boolean | null>(null);

/** §17.2, the age threshold, until "Inizia" makes it a setting. */
export const draftStaleDays = signal<number>(DEFAULT_SETTINGS.staleDays);

/** §17.3, the duplicate protection, preselected on "Chiudila e torna a quella esistente". */
export const draftGuardMode = signal<GuardMode>(ONBOARDING_DEFAULT_MODE);

/**
 * Reads the flag, once, when the panel starts.
 *
 * A read that fails resolves to "already done": storage is local and this cannot normally fail,
 * and if it ever does, a panel that works is better than a panel stuck on its first screen.
 */
export function startOnboarding(): void {
  void onboardedItem.getValue().then(
    (done) => {
      onboardingNeeded.value = !done;
    },
    (error: unknown) => {
      failed(error);
      onboardingNeeded.value = false;
    },
  );
}

/**
 * "Inizia" (§17.5): the two answers become settings and the screen is done with.
 *
 * One read-change-write for both, through `readSettings`, so nothing else in the object is
 * touched (`state/settings.ts`). The flag is written after them, so a write that fails leaves the
 * user with the screen again rather than with choices they made and that were never stored.
 */
export async function finishOnboarding(): Promise<void> {
  const current = await readSettings();
  await saveSettings({
    ...current,
    staleDays: draftStaleDays.value,
    guard: { ...current.guard, mode: draftGuardMode.value },
  });
  await onboardedItem.setValue(true);
  onboardingNeeded.value = false;
}

/** "Inizia", as the button calls it. */
export function completeOnboarding(): void {
  run(finishOnboarding());
}

/**
 * "Hai una whitelist di Duplicate Tabs Closer? Incollala qui" (§17.3): the editor is the one in
 * the duplicates settings, so the first run is finished with what has been answered so far and
 * the panel opens on that sub-page. The user lands in the editor, and the screen does not come
 * back behind them.
 */
export function openWhitelistFromOnboarding(): void {
  run(
    finishOnboarding().then(() => {
      showSettings('duplicates');
    }),
  );
}

function run(work: Promise<unknown>): void {
  void work.catch(failed);
}

function failed(error: unknown): void {
  console.error('TabDeclutter: onboarding', error);
}
