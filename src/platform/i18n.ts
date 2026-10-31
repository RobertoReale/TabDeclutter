/**
 * Localized strings, PLAN.md §2.1 and §5.4.
 *
 * Invariant 11 (TASKS.md §2): every visible string goes through `t`, and its key
 * type is read off the `en` catalogue, so a key that is not in
 * `src/public/_locales/en/messages.json` is a compile error.
 * `tests/unit/i18n.test.ts` keeps `it` in step with `en`.
 *
 * The import is type-only: the catalogue is not bundled, because the browser
 * loads `_locales/` itself and resolves both `__MSG_*__` in the manifest and
 * `i18n.getMessage` at runtime.
 */
import type enMessages from '../public/_locales/en/messages.json';

/** Every key of `src/public/_locales/en/messages.json`. */
export type MessageKey = keyof typeof enMessages;

/** The locales in `src/public/_locales/`. The first one is `default_locale`. */
export const LOCALES = ['en', 'it'] as const;

export type Locale = (typeof LOCALES)[number];

/** What the browser falls back to for a language we do not ship. */
export const DEFAULT_LOCALE: Locale = LOCALES[0];

/** The part of `browser.i18n` this module uses, so a test can supply its own. */
export interface I18nApi {
  getMessage(key: string, substitutions?: string[]): string;
  getUILanguage(): string;
}

export type Translate = <K extends MessageKey>(key: K, ...subs: string[]) => string;

/**
 * `t` bound to a catalogue. Exported so the unit tests can exercise the real
 * `messages.json` files without an extension context.
 */
export function translator(api: Pick<I18nApi, 'getMessage'>): Translate {
  return (key, ...subs) => api.getMessage(key, subs);
}

/**
 * WXT auto-imports `browser`, which is Firefox's namespace and `chrome` on
 * Chrome. The `typeof` guard is for the unit tests, where no auto-import
 * exists; outside an extension context there are no localized strings to give.
 */
function extensionI18n(): I18nApi | undefined {
  return typeof browser === 'undefined' ? undefined : browser.i18n;
}

export const t: Translate = translator({
  getMessage: (key, subs) => extensionI18n()?.getMessage(key, subs) ?? '',
});

/**
 * The value for the document's `lang`, from the browser's UI language.
 *
 * There is no API for the locale the browser actually picked out of
 * `_locales/`, so it is derived the same way the browser does: the UI language
 * if we ship its primary subtag, `default_locale` otherwise. `lang` then names
 * the language the strings are really in, which is what a screen reader and
 * `:lang()` need (PLAN.md §4.8).
 *
 * @param uiLanguage `i18n.getUILanguage()` (`en-US`), or an `@@ui_locale`
 * (`en_US`), whose underscore is not valid in `lang`.
 */
export function documentLanguage(uiLanguage: string): string {
  const tag = uiLanguage.replace('_', '-');
  const primary = tag.split('-')[0]?.toLowerCase();
  return LOCALES.some((locale) => locale === primary) ? tag : DEFAULT_LOCALE;
}

/** `documentLanguage()` for the current context. */
export function panelLanguage(): string {
  const uiLanguage = extensionI18n()?.getUILanguage();
  return uiLanguage === undefined ? DEFAULT_LOCALE : documentLanguage(uiLanguage);
}
