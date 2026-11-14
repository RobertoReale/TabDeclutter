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

/** One entry of a `messages.json`, as both browsers define the format. */
export interface Message {
  readonly message: string;
  readonly placeholders?: Readonly<Record<string, { readonly content: string }>>;
}

/** A whole `messages.json`, as it is shipped and as `loadCatalogue` returns it. */
export type Catalogue = Readonly<Record<string, Message>>;

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

/**
 * `i18n.getMessage`'s documented substitution, over a catalogue we loaded ourselves: a
 * named placeholder takes the argument its `content` points at, and `$1`…`$9` left in the
 * message are replaced directly.
 *
 * [Chrome](https://developer.chrome.com/docs/extensions/reference/api/i18n#method-getMessage)
 * · [MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/i18n/getMessage)
 */
export function formatMessage(catalogue: Catalogue, key: string, subs: string[] = []): string {
  const entry = catalogue[key];
  if (entry === undefined) return '';
  let text = entry.message;
  for (const [name, { content }] of Object.entries(entry.placeholders ?? {})) {
    text = text.replaceAll(`$${name.toUpperCase()}$`, argument(content, subs));
  }
  return text.replace(/\$([1-9])/g, (_, index: string) => subs[Number(index) - 1] ?? '');
}

/** A placeholder's `content`: `$1`…`$9`, or a literal. */
function argument(content: string, subs: string[]): string {
  const direct = /^\$([1-9])$/.exec(content);
  return direct?.[1] === undefined ? content : (subs[Number(direct[1]) - 1] ?? '');
}

/**
 * The catalogue the user asked for, when it is not the one the browser picked.
 *
 * `browser.i18n` resolves `_locales/` once, from the browser's own UI language, and offers
 * nothing to change it at runtime — `getMessage` has no locale argument, and `getAcceptLanguages`
 * only reports what the user reads. So "Lingua: IT/EN" (PLAN.md §4.6) is served by loading the
 * requested `messages.json` out of our own package and answering from it instead
 * (docs/DECISIONS.md M6.1).
 */
let override: Catalogue | null = null;

/** Which locale `t` is answering in, or `null` while it is the browser's own choice. */
let overrideLocale: Locale | null = null;

export const t: Translate = translator({
  getMessage: (key, subs) =>
    override === null
      ? (extensionI18n()?.getMessage(key, subs) ?? '')
      : formatMessage(override, key, subs),
});

/** The locale `t` answers in now, or `null` when the browser's own choice is in force. */
export function activeLocale(): Locale | null {
  return overrideLocale;
}

/**
 * Which catalogue the setting of §4.6 asks for, or `null` for "leave it to the browser".
 *
 * A chosen language is applied even when the browser had resolved to the same one: what the
 * browser resolved is not observable, so acting on the setting alone keeps the result the same
 * on every profile.
 */
export function requestedLocale(setting: 'auto' | Locale): Locale | null {
  return setting === 'auto' ? null : setting;
}

/**
 * Reads a shipped `_locales/<locale>/messages.json`.
 *
 * `runtime.getURL` makes it a URL in the extension's own origin, so this is a read of our own
 * package and not a network request (invariant 1).
 */
export async function loadCatalogue(locale: Locale): Promise<Catalogue> {
  const url = browser.runtime.getURL(`/_locales/${locale}/messages.json`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`cannot load ${locale}: ${String(response.status)}`);
  return (await response.json()) as Catalogue;
}

/**
 * Makes `t` answer in `locale`, or in the browser's language again when it is `null`.
 *
 * Returns the language tag the document should carry, so the caller sets `lang` to the
 * language the strings are really in (PLAN.md §4.8).
 */
export async function useLocale(locale: Locale | null): Promise<string> {
  if (locale === null) {
    override = null;
    overrideLocale = null;
    return panelLanguage();
  }
  if (overrideLocale !== locale) {
    const catalogue = await loadCatalogue(locale);
    override = catalogue;
    overrideLocale = locale;
  }
  return locale;
}

/** Forgets the loaded catalogue, which is all a module singleton needs between tests. */
export function resetLocale(): void {
  override = null;
  overrideLocale = null;
}

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

/**
 * `documentLanguage()` for the current context.
 *
 * A context that cannot answer — no extension API, or a browser that does not implement
 * `getUILanguage` — gets `default_locale`, which is the locale its strings would come from
 * anyway.
 */
export function panelLanguage(): string {
  const uiLanguage = uiLanguageOrNothing();
  return uiLanguage === undefined ? DEFAULT_LOCALE : documentLanguage(uiLanguage);
}

function uiLanguageOrNothing(): string | undefined {
  try {
    return extensionI18n()?.getUILanguage();
  } catch {
    return undefined;
  }
}
