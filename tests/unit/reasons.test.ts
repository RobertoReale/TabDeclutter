import { describe, expect, it } from 'vitest';

import type { PageType } from '../../src/core/classify';
import type { PrimaryReason, Reason, ScoredTab } from '../../src/core/scoring';
import { DAY, MINUTE } from '../../src/core/time';
import { chipsOf, forgottenWindowText, reasonText } from '../../src/entrypoints/sidepanel/reasons';
import { localeTranslator } from './support/catalogue';

/**
 * What a row says about itself (PLAN.md §6.4), against the shipped catalogues: these are
 * the sentences the user actually reads, so the Italian is asserted and not mocked.
 *
 * Nothing here may invent a reason. Every sentence and every chip comes from something
 * the score put in `reasons` or in `primaryReason` — which is what "explained
 * suggestions" (PLAN.md §3) rests on.
 */

const english = localeTranslator('en');
const italian = localeTranslator('it');

function scored(overrides: Partial<ScoredTab> = {}): ScoredTab {
  return {
    tabId: 1,
    windowId: 1,
    score: 80,
    bucket: 'close',
    primaryReason: 'review',
    reasons: [],
    pageType: 'content',
    idleMs: 12 * DAY,
    multiplier: 1,
    ...overrides,
  };
}

function sentence(primaryReason: PrimaryReason, pageType: PageType = 'content'): string {
  return reasonText(scored({ primaryReason, pageType }), italian, 'it');
}

describe('reasonText', () => {
  it('names the fact, for a page another tab already shows', () => {
    expect(sentence('duplicate')).toBe("Duplicato di un'altra scheda aperta");
    expect(reasonText(scored({ primaryReason: 'duplicate' }), english, 'en')).toBe(
      'Duplicate of another open tab',
    );
  });

  it('says what kind of temporary page it is, so the user need not look', () => {
    expect(sentence('transient', 'search')).toBe('Risultati di ricerca già consultati');
    expect(sentence('transient', 'auth')).toBe('Pagina di accesso o reindirizzamento');
    expect(sentence('transient', 'browser-internal')).toBe('Pagina del browser');
    expect(sentence('blank')).toBe("Scheda vuota, aperta da un po'");
  });

  /* An error page gets points but never the headline (`primaryReasonOf`), so if one ever
     reaches this sentence it must not claim to know more than it does. */
  it.each<PageType>(['content', 'error', 'own'])(
    'falls back to the general line for %s',
    (type) => {
      expect(sentence('transient', type)).toBe('Pagina già consultata');
    },
  );

  it('puts the age in the sentence when the age is the reason', () => {
    expect(reasonText(scored({ primaryReason: 'stale' }), italian, 'it')).toBe(
      'Non la apri da 12 giorni',
    );
    expect(reasonText(scored({ primaryReason: 'stale', idleMs: DAY }), italian, 'it')).toBe(
      'Non la apri da 1 giorno',
    );
    expect(reasonText(scored({ primaryReason: 'stale-unread' }), italian, 'it')).toBe(
      "Non la apri da 12 giorni e non l'hai mai letta",
    );
    expect(reasonText(scored({ primaryReason: 'stale-unread' }), english, 'en')).toBe(
      'You have not opened it in 12 days and never read it',
    );
  });

  /*
   * "Da valutare" is a tab the score added small signals up for: the honest line is the
   * chips and the section it is in, not a sentence saying there is no strong reason.
   */
  it('says nothing when the score has no headline to give', () => {
    expect(sentence('review')).toBe('');
    expect(sentence('protected')).toBe('');
  });
});

describe('chipsOf', () => {
  const LOW: Reason = { code: 'low-engagement', points: 15, activations: 0, foregroundMs: 0 };

  it('leads with the age, in the words the browser itself would use', () => {
    expect(chipsOf(scored(), italian, 'it')[0]).toEqual({ id: 'age', text: '12 gg fa' });
    expect(chipsOf(scored({ idleMs: 30 * MINUTE }), italian, 'it')[0]?.text).toBe('30 min fa');
  });

  it('leaves the age chip off a row whose sentence already carries it', () => {
    for (const primaryReason of ['stale', 'stale-unread'] as const) {
      const chips = chipsOf(scored({ primaryReason, reasons: [LOW] }), italian, 'it');
      expect(chips.map((chip) => chip.id)).toEqual(['low-engagement']);
    }
  });

  it('counts how many times the tab was ever opened, in the right number', () => {
    const text = (activations: number): string | undefined =>
      chipsOf(
        scored({ primaryReason: 'stale', reasons: [{ ...LOW, activations }] }),
        italian,
        'it',
      )[0]?.text;

    expect(text(0)).toBe('mai aperta');
    expect(text(1)).toBe('aperta 1 volta');
    expect(text(5)).toBe('aperta 5 volte');
  });

  it('adds a chip for each secondary signal, in the order the rules found them', () => {
    const chips = chipsOf(
      scored({
        reasons: [
          { code: 'near-duplicate', points: 15, otherTabId: 2 },
          { code: 'bookmarked', points: 10 },
          { code: 'discarded', points: 5 },
          { code: 'error', points: 15 },
        ],
      }),
      italian,
      'it',
    );

    expect(chips.map((chip) => chip.text)).toEqual([
      '12 gg fa',
      'quasi duplicata',
      'nei preferiti',
      'sospesa',
      'errore',
    ]);
  });

  /*
   * These say nothing a row does not say already: `stale` is the age chip, the transient
   * codes are the sentence, and `forgotten-window` is the card above the list.
   */
  it('says nothing twice', () => {
    const reasons: readonly Reason[] = [
      { code: 'duplicate', points: 95, keptTabId: 2 },
      { code: 'blank', points: 90 },
      { code: 'stale', points: 55, idleMs: 12 * DAY },
      { code: 'search', points: 25 },
      { code: 'auth', points: 25 },
      { code: 'browser-internal', points: 25 },
      { code: 'forgotten-window', points: 10, tabCount: 12, idleMs: 21 * DAY },
    ];
    const chips = chipsOf(scored({ reasons }), italian, 'it');
    expect(chips.map((chip) => chip.id)).toEqual(['age']);
  });

  it('gives each chip the key of the signal it came from, so the list is stable', () => {
    const chips = chipsOf(
      scored({ reasons: [LOW, { code: 'bookmarked', points: 10 }] }),
      italian,
      'it',
    );
    expect(chips.map((chip) => chip.id)).toEqual(['age', 'low-engagement', 'bookmarked']);
    expect(new Set(chips.map((chip) => chip.id)).size).toBe(chips.length);
  });
});

describe('forgottenWindowText', () => {
  it("is §4.3's card, counted noun and duration in one sentence", () => {
    expect(forgottenWindowText(12, 21 * DAY, italian, 'it')).toBe(
      'Finestra con 12 schede non toccata da 3 settimane',
    );
    expect(forgottenWindowText(1, DAY, english, 'en')).toBe(
      'Window with 1 tab untouched for 1 day',
    );
  });
});

describe('every sentence these functions produce', () => {
  const primaries: readonly PrimaryReason[] = [
    'duplicate',
    'blank',
    'transient',
    'stale',
    'stale-unread',
  ];

  it.each(['en', 'it'] as const)('%s: leaves no placeholder behind', (locale) => {
    const t = localeTranslator(locale);
    for (const primaryReason of primaries) {
      const text = reasonText(scored({ primaryReason }), t, locale);
      expect(text, primaryReason).not.toBe('');
      expect(text, primaryReason).not.toMatch(/\$/);
    }
    for (const activations of [0, 1, 5]) {
      const chips = chipsOf(
        scored({ reasons: [{ code: 'low-engagement', points: 15, activations, foregroundMs: 0 }] }),
        t,
        locale,
      );
      for (const chip of chips) expect(chip.text, chip.id).not.toMatch(/\$/);
    }
    expect(forgottenWindowText(12, 21 * DAY, t, locale)).not.toMatch(/\$/);
  });
});
