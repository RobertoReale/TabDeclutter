/**
 * The settings of PLAN.md §4.6, as the panel reads and changes them.
 *
 * The values themselves come from the one snapshot of `state/tabs.ts`, so what the settings page
 * shows and what the scores were computed from are the same read. Every change is read, changed
 * and written back (never a snapshot taken earlier), and the background hears about it through
 * `storage.onChanged` — the panel still sends it no messages (§5.2).
 *
 * Two of them need more than a write:
 *
 * - **The bookmarks** need the optional permission of §5.4, which both browsers only grant from
 *   a user gesture. `setUseBookmarks` therefore calls `permissions.request` **synchronously**,
 *   and the setting is stored only once the answer is yes.
 * - **The language** cannot be changed through `browser.i18n`, so `platform/i18n.ts` loads the
 *   requested catalogue and `language` here is what every view re-renders from
 *   (docs/DECISIONS.md M6.1).
 */

import { computed, effect, signal } from '@preact/signals';

import { DEFAULT_SETTINGS, type LanguageSetting, type Settings } from '@/core/types';
import {
  hasBookmarksPermission,
  removeBookmarksPermission,
  requestBookmarksPermission,
} from '@/platform/bookmarks';
import { panelLanguage, requestedLocale, t, useLocale } from '@/platform/i18n';
import { protectedDomainsItem, updateSettings } from '@/platform/storage';
import { clearModeOverrideIf } from './organize-request';
import { applyLocalSettings, panelData } from './tabs';

/** The stored settings, or the defaults until the first read comes back. */
export const settings = computed<Settings>(() => panelData.value?.settings ?? DEFAULT_SETTINGS);

/** "Siti protetti" (§4.6), the list the editor shows. */
export const protectedSites = computed<readonly string[]>(
  () => panelData.value?.protectedSites ?? [],
);

/** Whether the browser has given us the bookmarks, as it last answered. */
export const bookmarksGranted = signal(false);

/** Whether the last request was refused, which is what the page has to explain. */
export const bookmarksDenied = signal(false);

/**
 * The language the panel is actually speaking, as a `lang` tag.
 *
 * A signal and not `panelLanguage()` on every render: §4.6 lets the user change it while the
 * panel is open, and this is what the views read, so a change re-renders all of them.
 */
export const language = signal<string>(panelLanguage());

/** Changes one setting (§4.6). */
export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
  run(
    update((current) => ({ ...current, [key]: value })).then(() => {
      if (key === 'autoOrganizeMode') clearModeOverrideIf(value as Settings['autoOrganizeMode']);
    }),
  );
}

/** Replaces "Siti protetti" with what the editor holds. */
export function saveProtectedSites(domains: readonly string[]): Promise<void> {
  return protectedDomainsItem.setValue([...domains]);
}

/**
 * The bookmarks toggle (§4.6, §5.4).
 *
 * **Not `async`, and nothing is awaited before the request**: the user gesture is spent by the
 * first `await`, and a request made after it is refused without ever being shown. Turning it off
 * gives the permission back, so the extension holds no access it is not using (§12.1).
 */
export function setUseBookmarks(next: boolean): void {
  if (!next) {
    bookmarksDenied.value = false;
    bookmarksGranted.value = false;
    run(
      update((current) => ({ ...current, useBookmarks: false })).then(() =>
        removeBookmarksPermission(),
      ),
    );
    return;
  }

  const answer = requestBookmarksPermission();
  run(
    answer.then(async (granted) => {
      bookmarksGranted.value = granted;
      bookmarksDenied.value = !granted;
      // Only a granted permission becomes a stored setting: a "yes" we cannot honour would
      // promise a signal the score would never get.
      if (granted) await update((current) => ({ ...current, useBookmarks: true }));
    }),
  );
}

/** Asks the browser whether the permission is already there, when the settings page opens. */
export function checkBookmarksPermission(): void {
  run(
    hasBookmarksPermission().then((granted) => {
      bookmarksGranted.value = granted;
    }),
  );
}

/**
 * Applies the language setting: loads the asked-for catalogue, then tells the document and the
 * views what they are now speaking.
 */
export async function applyLanguage(setting: LanguageSetting): Promise<void> {
  const tag = await useLocale(requestedLocale(setting));
  language.value = tag;
  if (typeof document !== 'undefined') {
    // `__MSG_*__` is resolved in the manifest and in CSS, never in HTML, so the document's own
    // language and title are set from here (as `main.tsx` does on the first paint).
    document.documentElement.lang = tag;
    document.title = t('extName');
  }
}

/**
 * Follows the language setting for as long as the panel lives.
 *
 * Returns `effect`'s disposer, which only a test uses: the panel's own subscription lasts as
 * long as its document.
 */
export function startLanguage(): () => void {
  return effect(() => {
    const setting = settings.value.language;
    run(applyLanguage(setting));
  });
}

/** Serialized read-change-write: the panel never writes a settings snapshot it took earlier. */
async function update(change: (current: Settings) => Settings): Promise<void> {
  const next = await updateSettings(change);
  applyLocalSettings(next);
}

function run(work: Promise<unknown>): void {
  void work.catch(failed);
}

function failed(error: unknown): void {
  console.error('TabDeclutter: settings', error);
}
