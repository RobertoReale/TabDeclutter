/**
 * The first run's state (PLAN.md §17): that a fresh profile owes the screen, that "Inizia" writes
 * both answers into the settings and nothing else, that the screen does not come back, and that
 * the whitelist link saves what has been answered before it leaves for the editor.
 *
 * What the screen looks like in a real browser is `tests/e2e/onboarding.spec.ts`'s; what is here
 * is the wiring that only exists over an extension's storage (TASKS.md M6.2).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { DEFAULT_SETTINGS } from '../../src/core/types';
import {
  completeOnboarding,
  draftGuardMode,
  draftStaleDays,
  finishOnboarding,
  onboardingNeeded,
  startOnboarding,
} from '../../src/entrypoints/sidepanel/state/onboarding';
import { settingsOpen, settingsPage } from '../../src/entrypoints/sidepanel/state/view';
import { onboardedItem, readSettings, saveSettings } from '../../src/platform/storage';

beforeEach(() => {
  fakeBrowser.reset();
  onboardingNeeded.value = null;
  draftStaleDays.value = DEFAULT_SETTINGS.staleDays;
  draftGuardMode.value = 'auto';
  settingsOpen.value = false;
  settingsPage.value = 'main';
});

describe('whether the screen is owed', () => {
  it('is owed on a profile that has never answered it', async () => {
    startOnboarding();

    await vi.waitFor(() => {
      expect(onboardingNeeded.value).toBe(true);
    });
  });

  it('is not owed once the flag is stored', async () => {
    await onboardedItem.setValue(true);

    startOnboarding();

    await vi.waitFor(() => {
      expect(onboardingNeeded.value).toBe(false);
    });
  });
});

describe('"Inizia" (§17.5)', () => {
  it('writes both answers as settings and leaves the rest of them alone', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, showBadge: false, archiveRetentionDays: 90 });
    draftStaleDays.value = 14;
    draftGuardMode.value = 'off';

    await finishOnboarding();

    const stored = await readSettings();
    expect(stored.staleDays).toBe(14);
    expect(stored.guard.mode).toBe('off');
    expect(stored.showBadge).toBe(false);
    expect(stored.archiveRetentionDays).toBe(90);
    // The rest of the duplicate settings are the ones §8.3 defines, not re-decided here.
    expect(stored.guard.scope).toBe(DEFAULT_SETTINGS.guard.scope);
  });

  it('stores the preselected "chiudila e torna a quella esistente" when nothing is touched', async () => {
    completeOnboarding();

    await vi.waitFor(async () => {
      expect((await readSettings()).guard.mode).toBe('auto');
    });
    expect((await readSettings()).staleDays).toBe(DEFAULT_SETTINGS.staleDays);
  });

  it('does not come back: the flag is stored and the panel moves on', async () => {
    onboardingNeeded.value = true;

    await finishOnboarding();

    expect(await onboardedItem.getValue()).toBe(true);
    expect(onboardingNeeded.value).toBe(false);

    // What a later panel reads.
    onboardingNeeded.value = null;
    startOnboarding();
    await vi.waitFor(() => {
      expect(onboardingNeeded.value).toBe(false);
    });
  });

  it('enables autoDeclutter and autoOrganize only when automatic protection is chosen', async () => {
    draftGuardMode.value = 'warn';
    await finishOnboarding();
    expect(await readSettings()).toMatchObject({ autoDeclutter: false, autoOrganize: false });

    draftGuardMode.value = 'off';
    await finishOnboarding();
    expect(await readSettings()).toMatchObject({ autoDeclutter: false, autoOrganize: false });

    draftGuardMode.value = 'auto';
    await finishOnboarding();
    expect(await readSettings()).toMatchObject({ autoDeclutter: true, autoOrganize: true });
  });
});
