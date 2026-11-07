import { describe, expect, it } from 'vitest';

import {
  closeSelectionText,
  closedText,
  confirmCloseText,
  countsText,
  durationText,
  formatCount,
  relativeAge,
  reviewText,
  tabsText,
} from '../../src/entrypoints/sidepanel/format';
import type { MessageKey } from '../../src/platform/i18n';
import { LOCALES } from '../../src/platform/i18n';
import { catalogue, localeTranslator } from './support/catalogue';

/**
 * The panel's counted nouns and ages, checked against the real catalogues: these
 * functions are the only reason "1 scheda" is not "1 schede", and the shipped
 * Italian is what has to come out of them.
 *
 * This is the `unit` project, so there is no `browser` at all; `t` is built over
 * the catalogue files, exactly as `tests/unit/i18n.test.ts` does.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

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

describe('tabsText', () => {
  it('counts tabs for a sentence, in the right number', () => {
    expect(tabsText(1, english, 'en')).toBe('1 tab');
    expect(tabsText(12, english, 'en')).toBe('12 tabs');
    expect(tabsText(1, italian, 'it')).toBe('1 scheda');
    expect(tabsText(12, italian, 'it')).toBe('12 schede');
  });
});

/*
 * The selection bar's close button (§4.3, §9). The whole reason this is a helper and not
 * a message is the second half: §9 asks the button itself to say that a window goes with
 * the tabs, and the two halves have to agree in number independently.
 */
describe('closeSelectionText', () => {
  it('is the bare count when no window empties, which is almost always', () => {
    expect(closeSelectionText(17, 0, english, 'en')).toBe('Close 17');
    expect(closeSelectionText(17, 0, italian, 'it')).toBe('Chiudi 17');
  });

  it("says the window goes too, in §9's words", () => {
    expect(closeSelectionText(3, 1, italian, 'it')).toBe('Chiudi 3 schede e la finestra');
    expect(closeSelectionText(3, 1, english, 'en')).toBe('Close 3 tabs and the window');
  });

  it('agrees in both halves at once, which one message could not', () => {
    expect(closeSelectionText(1, 1, italian, 'it')).toBe('Chiudi 1 scheda e la finestra');
    expect(closeSelectionText(8, 2, italian, 'it')).toBe('Chiudi 8 schede e le finestre');
    expect(closeSelectionText(8, 2, english, 'en')).toBe('Close 8 tabs and the windows');
  });

  it.each(LOCALES)('%s: leaves no placeholder behind', (locale) => {
    expect(closeSelectionText(5, 0, localeTranslator(locale), locale)).not.toMatch(/\$/);
    expect(closeSelectionText(5, 1, localeTranslator(locale), locale)).not.toMatch(/\$/);
    expect(closeSelectionText(5, 3, localeTranslator(locale), locale)).not.toMatch(/\$/);
  });
});

describe('confirmCloseText', () => {
  it("asks §9's question with the count in it", () => {
    expect(confirmCloseText(42, italian, 'it')).toBe('Chiudi 42 schede?');
    expect(confirmCloseText(42, english, 'en')).toBe('Close 42 tabs?');
  });

  /*
   * The question only appears above `BULK_CONFIRM_LIMIT`, so a singular is unreachable
   * from the bar — but the string is built the same way either way, and a helper that
   * says "1 schede" would be a wording bug waiting for a second caller.
   */
  it('counts in the singular all the same', () => {
    expect(confirmCloseText(1, italian, 'it')).toBe('Chiudi 1 scheda?');
  });
});

describe('closedText', () => {
  it("is the toast's own half of §4.3", () => {
    expect(closedText(17, italian, 'it')).toBe('17 schede chiuse');
    expect(closedText(17, english, 'en')).toBe('17 tabs closed');
  });

  it('agrees with one closed tab, which is the commonest close of all', () => {
    expect(closedText(1, italian, 'it')).toBe('1 scheda chiusa');
    expect(closedText(1, english, 'en')).toBe('1 tab closed');
  });

  it('groups the thousands, like every other count the panel shows', () => {
    expect(closedText(1200, italian, 'it')).toBe('1200 schede chiuse');
    expect(closedText(12000, italian, 'it')).toBe('12.000 schede chiuse');
  });
});

/*
 * The ages. The expected strings are CLDR's, written out: that is the point of using
 * `Intl` rather than translating them, and a wrong unit or a wrong sign would otherwise
 * look plausible.
 */
describe('relativeAge', () => {
  it('picks the unit the spec words that age in', () => {
    expect(relativeAge(12 * DAY, 'en')).toBe('12d ago');
    expect(relativeAge(12 * DAY, 'it')).toBe('12 gg fa');
    expect(relativeAge(3 * 7 * DAY, 'it')).toBe('3 sett. fa');
    expect(relativeAge(5 * HOUR, 'it')).toBe('5 h fa');
    expect(relativeAge(2 * 30 * DAY, 'it')).toBe('2 mesi fa');
  });

  /*
   * PLAN.md says both "Non la apri da 12 giorni" (§6.4) and "non toccata da 3 settimane"
   * (§4.3), so days hold for a fortnight and weeks take over after it.
   */
  it('counts days up to a fortnight, then weeks', () => {
    expect(relativeAge(13 * DAY, 'it')).toBe('13 gg fa');
    expect(relativeAge(14 * DAY, 'it')).toBe('2 sett. fa');
    expect(relativeAge(29 * DAY, 'it')).toBe('4 sett. fa');
    expect(relativeAge(30 * DAY, 'it')).toBe('mese scorso');
  });

  it("uses the language's own word for a single step, which is why numeric is auto", () => {
    expect(relativeAge(DAY, 'en')).toBe('yesterday');
    expect(relativeAge(DAY, 'it')).toBe('ieri');
  });

  it('rounds down, so 90 minutes is an hour and not two', () => {
    expect(relativeAge(90 * MINUTE, 'it')).toBe('1 h fa');
    expect(relativeAge(47 * HOUR, 'it')).toBe('ieri');
  });

  it('never says zero: a tab seen seconds ago is a minute ago', () => {
    expect(relativeAge(0, 'it')).toBe('1 min fa');
    expect(relativeAge(500, 'it')).toBe('1 min fa');
  });

  it('treats a clock that went backwards as just now, not as the future', () => {
    expect(relativeAge(-5 * DAY, 'it')).toBe('1 min fa');
  });
});

describe('durationText', () => {
  it('says the same duration as a quantity, for inside a sentence', () => {
    expect(durationText(12 * DAY, 'en')).toBe('12 days');
    expect(durationText(12 * DAY, 'it')).toBe('12 giorni');
  });

  it('agrees with the counted noun in the singular, which a translation would not', () => {
    expect(durationText(DAY, 'en')).toBe('1 day');
    expect(durationText(DAY, 'it')).toBe('1 giorno');
    expect(durationText(HOUR, 'it')).toBe('1 ora');
  });

  it('names the same unit the chip does', () => {
    expect(durationText(3 * 7 * DAY, 'it')).toBe('3 settimane');
    expect(durationText(400 * DAY, 'it')).toBe('1 anno');
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
    'barClose',
    'barCloseWithWindows',
    'barWindowOne',
    'barWindowOther',
    'confirmClose',
    'toastClosedOne',
    'toastClosedOther',
  ];

  it.each(LOCALES)('%s: exists, so no call can come back empty', (locale) => {
    const messages = catalogue(locale);
    for (const key of keys) expect(messages[key]?.message, key).toBeTruthy();
  });
});
