import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { buildManifest } from '../../build/manifest';
import type { MessageKey } from '../../src/platform/i18n';
import { DEFAULT_LOCALE, LOCALES, documentLanguage, translator } from '../../src/platform/i18n';

/**
 * Invariant 11 (TASKS.md §2): every visible string goes through i18n and the
 * `en`/`it` keys match. `en` is the source catalogue — the one `MessageKey` is
 * typed on and the one `default_locale` names — so the drift these tests look
 * for is always `it` falling behind it.
 */

/** One entry of a `messages.json`, as both browsers define the format. */
interface Message {
  message: string;
  description?: string;
  placeholders?: Record<string, { content: string; example?: string }>;
}

type Catalogue = Record<string, Message>;

function readCatalogue(locale: string): Catalogue {
  const path = new URL(`../../src/public/_locales/${locale}/messages.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')) as Catalogue;
}

const catalogues = new Map(LOCALES.map((locale) => [locale, readCatalogue(locale)]));

function catalogue(locale: (typeof LOCALES)[number]): Catalogue {
  const found = catalogues.get(locale);
  if (found === undefined) throw new Error(`no catalogue for ${locale}`);
  return found;
}

const en = catalogue('en');

/**
 * `i18n.getMessage`'s documented substitution, so that `t` can be exercised
 * over the real files: named placeholders take the argument their `content`
 * points at, and `$1`…`$9` in the message itself are replaced directly.
 *
 * [Chrome](https://developer.chrome.com/docs/extensions/reference/api/i18n#method-getMessage)
 * · [MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/i18n/getMessage)
 */
function fakeI18n(messages: Catalogue) {
  return {
    getMessage(key: string, subs: string[] = []): string {
      const entry = messages[key];
      if (entry === undefined) return '';
      let text = entry.message;
      for (const [name, { content }] of Object.entries(entry.placeholders ?? {})) {
        text = text.replaceAll(`$${name.toUpperCase()}$`, substitution(content, subs));
      }
      return text.replace(/\$([1-9])/g, (_, index: string) => subs[Number(index) - 1] ?? '');
    },
  };
}

/** A placeholder's `content`: `$1`…`$9`, or a literal. */
function substitution(content: string, subs: string[]): string {
  const direct = /^\$([1-9])$/.exec(content);
  return direct?.[1] === undefined ? content : (subs[Number(direct[1]) - 1] ?? '');
}

/** The arguments a message needs: the highest `$n` any of its placeholders uses. */
function argumentCount(entry: Message): number {
  const indices = [
    ...entry.message.matchAll(/\$([1-9])/g),
    ...Object.values(entry.placeholders ?? {}).flatMap((placeholder) => [
      ...placeholder.content.matchAll(/\$([1-9])/g),
    ]),
  ].map((match) => Number(match[1]));
  return indices.length === 0 ? 0 : Math.max(...indices);
}

describe('the message catalogues', () => {
  it('carries exactly the keys the shipped code asks for, in en', () => {
    expect(Object.keys(en).sort()).toEqual([
      'actionCancel',
      'actionClose',
      'actionConfirm',
      'actionDelete',
      'actionDiscard',
      'actionGo',
      'actionKeep',
      'actionRestore',
      'actionTitle',
      'actionUndo',
      'archiveConfirmEmpty',
      'archiveCopied',
      'archiveEmpty',
      'archiveEmptyAll',
      'archiveExport',
      'archiveList',
      'archiveNoMatch',
      'archiveOrigin',
      'archiveOriginAny',
      'archiveOriginDuplicates',
      'archiveOriginMine',
      'archiveReasonDuplicateAuto',
      'archiveReasonDuplicateManual',
      'archiveReasonManual',
      'archiveReasonWindow',
      'archiveSearch',
      'archiveTools',
      'archiveWhen',
      'archiveWhenAny',
      'archiveWhenOlder',
      'archiveWhenToday',
      'archiveWhenWeek',
      'barClose',
      'barCloseWithWindows',
      'barDelete',
      'barLabel',
      'barOrganize',
      'barRestore',
      'barWindowOne',
      'barWindowOther',
      'chipBookmarked',
      'chipDiscarded',
      'chipError',
      'chipNearDuplicate',
      'chipOpenedNever',
      'chipOpenedOne',
      'chipOpenedOther',
      'cmdCloseDuplicates',
      'cmdToggleGuard',
      'colorBlue',
      'colorCyan',
      'colorGreen',
      'colorGrey',
      'colorOrange',
      'colorPink',
      'colorPurple',
      'colorRed',
      'colorYellow',
      'confirmClose',
      'confirmCloseActive',
      'countTabsOne',
      'countTabsOther',
      'countWindowsOne',
      'countWindowsOther',
      'declutterEmpty',
      'declutterList',
      'extDescription',
      'extName',
      'guardAfterActivate',
      'guardAfterMoveActivate',
      'guardAfterNone',
      'guardAllowIntentional',
      'guardChip',
      'guardClosedTodayOne',
      'guardClosedTodayOther',
      'guardCoexistence',
      'guardContainersSeparate',
      'guardFieldAfter',
      'guardFieldKeep',
      'guardFieldMode',
      'guardFieldScope',
      'guardGroupBehaviour',
      'guardGroupMatch',
      'guardGroupMatchHint',
      'guardGroupPriority',
      'guardGroupPriorityHint',
      'guardGroupWhitelist',
      'guardGroupWhitelistHint',
      'guardIgnoreAuthPages',
      'guardIgnoreEmptyTabs',
      'guardKeepActive',
      'guardKeepNewest',
      'guardKeepOldest',
      'guardKeepOldestReloaded',
      'guardKeepPinned',
      'guardMenuCloseAll',
      'guardMenuLabel',
      'guardMenuResume',
      'guardMenuSettings',
      'guardModeAuto',
      'guardModeOff',
      'guardModeWarn',
      'guardNoticeSee',
      'guardPreferActiveWindow',
      'guardPreferHttps',
      'guardScopeAllWindows',
      'guardScopeWindow',
      'guardStateAuto',
      'guardStateOff',
      'guardStatePausedRestart',
      'guardStatePausedUntil',
      'guardStateWarn',
      'guardWarnIgnorePath',
      'guardWarnNewest',
      'healthReview',
      'matchIgnoreAllParams',
      'matchIgnoreCase',
      'matchIgnoreHash',
      'matchIgnorePath',
      'matchIgnoreTracking',
      'matchIgnoreWww',
      'menuAllowDuplicates',
      'menuKeepAlways',
      'menuPause15Min',
      'menuPause1Hour',
      'menuPauseGuard',
      'menuPauseRestart',
      'menuProtectSite',
      'menuReopenAllowSite',
      'menuReopenDuplicate',
      'navArchive',
      'navDeclutter',
      'navLabel',
      'navOrganize',
      'navSettings',
      'organizeAiBadge',
      'organizeAiCancel',
      'organizeAiDownloading',
      'organizeAiEnable',
      'organizeAiEnableHint',
      'organizeAiUse',
      'organizeAiWorking',
      'organizeAppliedOne',
      'organizeAppliedOther',
      'organizeApply',
      'organizeDismiss',
      'organizeEmpty',
      'organizeGroupColor',
      'organizeGroupInclude',
      'organizeGroupName',
      'organizeMerge',
      'organizeMode',
      'organizeModeSite',
      'organizeModeTopic',
      'organizeMoveTo',
      'organizeNoGroups',
      'organizeOptionCollapse',
      'organizeOptionIncludeGrouped',
      'organizeOptionLeavePinned',
      'organizeOptionSort',
      'organizeOptions',
      'organizeOther',
      'organizeOtherHint',
      'organizePreview',
      'organizeScope',
      'organizeScopeAll',
      'organizeScopeSelection',
      'organizeScopeWindow',
      'organizeSkippedOne',
      'organizeSkippedOther',
      'organizeWindow',
      'panelCounts',
      'reasonAuth',
      'reasonBlank',
      'reasonBrowserPage',
      'reasonDuplicate',
      'reasonSearch',
      'reasonStale',
      'reasonStaleUnread',
      'reasonTransient',
      'rowSelect',
      'sectionCloseAll',
      'sectionDeselectAll',
      'sectionDuplicates',
      'sectionHeading',
      'sectionReview',
      'sectionSelectAll',
      'sectionStale',
      'sectionStaleUnread',
      'sectionTransient',
      'settingsDuplicates',
      'toastClosedOne',
      'toastClosedOther',
      'whitelistDefaults',
      'whitelistErrorInvalidRegex',
      'whitelistErrorTooLong',
      'whitelistErrorTooManyWildcards',
      'whitelistHint',
      'whitelistIgnored',
      'whitelistImport',
      'whitelistImportHow',
      'whitelistLabel',
      'whitelistLine',
      'whitelistMatchesNone',
      'whitelistMatchesOne',
      'whitelistMatchesOther',
      'whitelistSave',
      'windowClose',
      'windowForgotten',
    ]);
  });

  it('ships a catalogue for every locale the code claims, default_locale first', () => {
    expect(LOCALES).toEqual(['en', 'it']);
    expect(DEFAULT_LOCALE).toBe('en');
    for (const locale of LOCALES) expect(Object.keys(catalogue(locale)).length).toBeGreaterThan(0);
  });

  it.each(LOCALES)('%s: has exactly the keys of en, in the same order', (locale) => {
    expect(Object.keys(catalogue(locale))).toEqual(Object.keys(en));
  });

  it.each(LOCALES)('%s: translates every message to a non-empty string', (locale) => {
    for (const [key, entry] of Object.entries(catalogue(locale))) {
      expect(entry.message, key).toBeTypeOf('string');
      expect(entry.message.trim(), key).not.toBe('');
    }
  });

  it('documents every en message, so a translator knows what it is for', () => {
    for (const [key, entry] of Object.entries(en)) {
      expect(entry.description?.trim() ?? '', key).not.toBe('');
    }
  });

  it.each(LOCALES)('%s: declares the same placeholders as en, with the same content', (locale) => {
    for (const [key, entry] of Object.entries(catalogue(locale))) {
      expect(entry.placeholders ?? {}, key).toEqual(en[key]?.placeholders ?? {});
    }
  });

  it.each(LOCALES)('%s: uses every argument the en message takes', (locale) => {
    for (const [key, entry] of Object.entries(catalogue(locale))) {
      const expected = en[key];
      if (expected === undefined) continue;
      expect(argumentCount(entry), key).toBe(argumentCount(expected));
    }
  });

  it('keeps the store description within the 132 characters Chrome allows', () => {
    for (const locale of LOCALES) {
      const description = catalogue(locale).extDescription?.message ?? '';
      expect(description.length, locale).toBeLessThanOrEqual(132);
    }
  });
});

describe('t', () => {
  it('returns the message of the locale it is bound to', () => {
    expect(translator(fakeI18n(en))('navDeclutter')).toBe('Declutter');
    expect(translator(fakeI18n(catalogue('it')))('navDeclutter')).toBe('Riordina');
  });

  it('passes the substitutions on, in the order they were given', () => {
    const api = { getMessage: vi.fn(() => 'whatever') };
    translator(api)('panelCounts', 'first', 'second');
    expect(api.getMessage).toHaveBeenCalledWith('panelCounts', ['first', 'second']);
  });

  it('substitutes a named placeholder with its argument', () => {
    const withPlaceholder: Catalogue = {
      panelCounts: {
        message: '$TABS$ and $WINDOWS$',
        placeholders: { tabs: { content: '$1' }, windows: { content: '$2' } },
      },
    };
    expect(translator(fakeI18n(withPlaceholder))('panelCounts', 'Ada', 'Grace')).toBe(
      'Ada and Grace',
    );
  });

  it('substitutes a bare $1 in the message', () => {
    const direct: Catalogue = { healthReview: { message: 'Hello $1' } };
    expect(translator(fakeI18n(direct))('healthReview', 'Ada')).toBe('Hello Ada');
  });

  it.each(LOCALES)('%s: leaves no placeholder unresolved in any message', (locale) => {
    const t = translator(fakeI18n(catalogue(locale)));
    for (const [key, entry] of Object.entries(catalogue(locale))) {
      const args = Array.from({ length: argumentCount(entry) }, (_, i) => `arg${String(i + 1)}`);
      const text = t(key as MessageKey, ...args);
      expect(text, key).not.toMatch(/\$[A-Z_]+\$/);
      expect(text, key).not.toMatch(/\$[1-9]/);
    }
  });

  it('gives an empty string outside an extension context, rather than throwing', async () => {
    // The real `t`, whose api is `browser.i18n`: there is no `browser` here.
    const { t } = await import('../../src/platform/i18n');
    expect(t('extName')).toBe('');
  });
});

describe('the manifest placeholders', () => {
  const browsers = ['chrome', 'firefox'] as const;

  it.each(browsers)('%s: every __MSG_*__ it uses is a key of en', (browser) => {
    const used = [...JSON.stringify(buildManifest(browser)).matchAll(/__MSG_(\w+)__/g)].map(
      (match) => match[1],
    );
    expect(used.length).toBeGreaterThan(0);
    for (const key of used) expect(Object.keys(en)).toContain(key);
  });

  it.each(browsers)('%s: declares default_locale, and we ship that locale', (browser) => {
    const locale = buildManifest(browser).default_locale;
    expect(locale).toBe(DEFAULT_LOCALE);
    expect(LOCALES).toContain(locale);
  });
});

describe('documentLanguage', () => {
  it('keeps a UI language whose primary subtag we ship', () => {
    expect(documentLanguage('en')).toBe('en');
    expect(documentLanguage('it')).toBe('it');
    expect(documentLanguage('en-US')).toBe('en-US');
    expect(documentLanguage('it-CH')).toBe('it-CH');
  });

  it("turns an @@ui_locale's underscore into the hyphen lang needs", () => {
    expect(documentLanguage('en_GB')).toBe('en-GB');
    expect(documentLanguage('it_IT')).toBe('it-IT');
  });

  it('falls back to default_locale for a language we do not ship, as the browser does', () => {
    expect(documentLanguage('de')).toBe('en');
    expect(documentLanguage('fr-CA')).toBe('en');
    expect(documentLanguage('')).toBe('en');
  });

  it('ignores the case the browser reports the tag in', () => {
    expect(documentLanguage('IT-it')).toBe('IT-it');
  });
});
