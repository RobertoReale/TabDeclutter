/**
 * The settings page's state (PLAN.md §4.6): that a change is read-change-written, that the
 * bookmarks permission is asked for inside the gesture and stored only when granted, and that
 * the language setting really changes the strings `t` gives back.
 *
 * What each setting then does to the core is `tests/unit/settings.test.ts`'s; what is here is
 * the wiring that only exists in an extension context (TASKS.md M6.1).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import type { LanguageSetting } from '../../src/core/types';
import { DEFAULT_SETTINGS } from '../../src/core/types';
import {
  applyLanguage,
  bookmarksDenied,
  bookmarksGranted,
  language,
  saveProtectedSites,
  setSetting,
  setUseBookmarks,
  startLanguage,
} from '../../src/entrypoints/sidepanel/state/settings';
import { panelData, type PanelData } from '../../src/entrypoints/sidepanel/state/tabs';
import { resetBookmarks } from '../../src/platform/bookmarks';
import { activeLocale, resetLocale, t } from '../../src/platform/i18n';
import { protectedDomainsItem, readSettings, saveSettings } from '../../src/platform/storage';

/** Just enough of an `it` catalogue to tell the two languages apart. */
const IT = {
  extName: { message: 'TabDeclutter' },
  navSettings: { message: 'Impostazioni' },
};

/** The `_locales/<locale>/messages.json` the panel asks for, served from the package. */
function serveCatalogues(): { readonly urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    urls.push(url);
    return Promise.resolve({ ok: true, json: () => Promise.resolve(IT) } as unknown as Response);
  });
  return { urls };
}

/** One panel read, which is where the settings page takes its values from. */
function snapshot(languageSetting: LanguageSetting): PanelData {
  return {
    tabs: [],
    activity: {},
    settings: { ...DEFAULT_SETTINGS, language: languageSetting },
    keeps: {},
    protectedSites: [],
    whitelist: [],
    bookmarks: new Set<string>(),
    focusedWindowId: 1,
    ownOrigin: 'chrome-extension://test',
    at: Date.UTC(2026, 0, 15, 12, 0, 0),
  };
}

beforeEach(() => {
  fakeBrowser.reset();
  panelData.value = null;
  resetBookmarks();
  resetLocale();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  bookmarksGranted.value = false;
  bookmarksDenied.value = false;
  language.value = 'en';
});

describe('changing a setting', () => {
  it('reads, changes and writes back, leaving the others alone', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, staleDays: 14 });

    setSetting('archiveRetentionDays', 90);
    await vi.waitFor(async () => {
      expect((await readSettings()).archiveRetentionDays).toBe(90);
    });

    expect((await readSettings()).staleDays).toBe(14);
  });

  it('writes "Siti protetti" as the list the core reads', async () => {
    await saveProtectedSites(['mail.google.com', '*.atlassian.net']);

    expect(await protectedDomainsItem.getValue()).toEqual(['mail.google.com', '*.atlassian.net']);
  });
});

describe('the bookmarks toggle (§5.4)', () => {
  it('asks for the permission before anything is awaited, so the gesture is still ours', () => {
    const request = vi.spyOn(fakeBrowser.permissions, 'request').mockResolvedValue(true as never);

    setUseBookmarks(true);

    // Synchronously, in the same turn as the click.
    expect(request).toHaveBeenCalledWith({ permissions: ['bookmarks'] });
  });

  it('stores the setting once the permission is granted', async () => {
    vi.spyOn(fakeBrowser.permissions, 'request').mockResolvedValue(true as never);

    setUseBookmarks(true);

    await vi.waitFor(async () => {
      expect((await readSettings()).useBookmarks).toBe(true);
    });
    expect(bookmarksGranted.value).toBe(true);
    expect(bookmarksDenied.value).toBe(false);
  });

  it('stores nothing when the user refuses, and says so', async () => {
    vi.spyOn(fakeBrowser.permissions, 'request').mockResolvedValue(false as never);

    setUseBookmarks(true);

    await vi.waitFor(() => {
      expect(bookmarksDenied.value).toBe(true);
    });
    expect((await readSettings()).useBookmarks).toBe(false);
    expect(bookmarksGranted.value).toBe(false);
  });

  it('gives the permission back when it is turned off (§12.1)', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, useBookmarks: true });
    const remove = vi.spyOn(fakeBrowser.permissions, 'remove').mockResolvedValue(true as never);

    setUseBookmarks(false);

    await vi.waitFor(() => {
      expect(remove).toHaveBeenCalledWith({ permissions: ['bookmarks'] });
    });
    expect((await readSettings()).useBookmarks).toBe(false);
    expect(bookmarksGranted.value).toBe(false);
  });
});

describe('the language setting (§4.6)', () => {
  it('leaves the strings to the browser for "automatica"', async () => {
    serveCatalogues();

    await applyLanguage('auto');

    expect(activeLocale()).toBeNull();
    expect(language.value).toBe('en');
  });

  it('loads the chosen catalogue out of our own package and answers from it', async () => {
    const served = serveCatalogues();

    await applyLanguage('it');

    expect(activeLocale()).toBe('it');
    expect(language.value).toBe('it');
    expect(t('navSettings')).toBe('Impostazioni');
    expect(served.urls).toHaveLength(1);
    expect(served.urls[0]).toContain('/_locales/it/messages.json');
  });

  it('follows the setting of the snapshot, and goes back for "automatica"', async () => {
    serveCatalogues();
    const stop = startLanguage();

    // What the panel's own read does: §4.6 lets the language change while the panel is open.
    panelData.value = snapshot('it');
    await vi.waitFor(() => {
      expect(language.value).toBe('it');
    });
    expect(t('navSettings')).toBe('Impostazioni');

    panelData.value = snapshot('auto');
    await vi.waitFor(() => {
      expect(activeLocale()).toBeNull();
    });
    expect(language.value).toBe('en');

    stop();
  });
});
