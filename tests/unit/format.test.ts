import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { countsText, formatCount, reviewText } from '../../src/entrypoints/sidepanel/format';
import type { MessageKey, Translate } from '../../src/platform/i18n';
import { LOCALES, translator } from '../../src/platform/i18n';

/**
 * The header's counted nouns, checked against the real catalogues: these
 * functions are the only reason "1 scheda" is not "1 schede", and the shipped
 * Italian is what has to come out of them.
 *
 * This is the `unit` project, so there is no `browser` at all; `t` is built over
 * the catalogue files, exactly as `tests/unit/i18n.test.ts` does.
 */

interface Message {
  message: string;
  placeholders?: Record<string, { content: string }>;
}

function catalogue(locale: string): Record<string, Message> {
  const path = new URL(`../../src/public/_locales/${locale}/messages.json`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, Message>;
}

/** `i18n.getMessage`'s substitution, over one locale's real messages. */
function localeTranslator(locale: string): Translate {
  const messages = catalogue(locale);
  return translator({
    getMessage(key: string, subs: string[] = []): string {
      const entry = messages[key];
      if (entry === undefined) return '';
      let text = entry.message;
      for (const [name, { content }] of Object.entries(entry.placeholders ?? {})) {
        const index = /^\$([1-9])$/.exec(content)?.[1];
        const value = index === undefined ? content : (subs[Number(index) - 1] ?? '');
        text = text.replaceAll(`$${name.toUpperCase()}$`, value);
      }
      return text.replace(/\$([1-9])/g, (_, at: string) => subs[Number(at) - 1] ?? '');
    },
  });
}

// Not `en`/`it`: `it` is vitest's own.
const english = localeTranslator('en');
const italian = localeTranslator('it');

describe('formatCount', () => {
  it("writes a number the way the panel's language does", () => {
    expect(formatCount(7, 'en')).toBe('7');
    expect(formatCount(12345, 'en')).toBe('12,345');
    expect(formatCount(12345, 'it')).toBe('12.345');
  });

  it("leaves a four-digit number ungrouped where the language does, as Italian's CLDR does", () => {
    expect(formatCount(1234, 'en')).toBe('1,234');
    expect(formatCount(1234, 'it')).toBe('1234');
  });

  it('accepts a full tag, not just a language', () => {
    expect(formatCount(12345, 'en-US')).toBe('12,345');
    expect(formatCount(12345, 'it-IT')).toBe('12.345');
  });
});

describe('countsText', () => {
  it('counts in the singular when there is one of something', () => {
    expect(countsText(1, 1, english, 'en')).toBe('1 tab · 1 window');
    expect(countsText(1, 1, italian, 'it')).toBe('1 scheda · 1 finestra');
  });

  it('counts in the plural otherwise', () => {
    expect(countsText(87, 4, english, 'en')).toBe('87 tabs · 4 windows');
    expect(countsText(87, 4, italian, 'it')).toBe('87 schede · 4 finestre');
  });

  it('uses the plural form for zero, as both languages do', () => {
    expect(countsText(0, 0, english, 'en')).toBe('0 tabs · 0 windows');
    expect(countsText(0, 0, italian, 'it')).toBe('0 schede · 0 finestre');
  });

  it('groups the thousands, so 12000 tabs is readable', () => {
    expect(countsText(12000, 2, english, 'en')).toBe('12,000 tabs · 2 windows');
    expect(countsText(12000, 2, italian, 'it')).toBe('12.000 schede · 2 finestre');
  });

  it.each(LOCALES)('%s: leaves no placeholder behind', (locale) => {
    const text = countsText(3, 2, localeTranslator(locale), locale);
    expect(text).not.toMatch(/\$/);
    expect(text).toContain('3');
    expect(text).toContain('2');
  });
});

describe('reviewText', () => {
  it('says how many tabs the score suggests looking at', () => {
    expect(reviewText(23, english, 'en')).toBe('23 to review');
    expect(reviewText(23, italian, 'it')).toBe('23 da rivedere');
  });
});

describe('every message these helpers reach', () => {
  const keys: MessageKey[] = [
    'panelCounts',
    'countTabsOne',
    'countTabsOther',
    'countWindowsOne',
    'countWindowsOther',
    'healthReview',
  ];

  it.each(LOCALES)('%s: exists, so no call can come back empty', (locale) => {
    const messages = catalogue(locale);
    for (const key of keys) expect(messages[key]?.message, key).toBeTruthy();
  });
});
