import { describe, expect, it } from 'vitest';

import { DEFAULT_WHITELIST_CHROME, DEFAULT_WHITELIST_FIREFOX } from '../../src/core/patterns';
import { DEFAULT_GUARD_SETTINGS, DEFAULT_MATCH_OPTIONS } from '../../src/core/types';
import {
  closedTodayText,
  guardChipText,
  guardStateText,
  guardWarnings,
  GUARD_TOGGLES,
  matchesText,
  patternErrorText,
  visibleGuardToggles,
} from '../../src/entrypoints/sidepanel/guard-settings';
import type { Capabilities } from '../../src/platform/capabilities';
import { defaultWhitelist } from '../../src/platform/whitelist';
import { localeTranslator } from './support/catalogue';

/**
 * The duplicate UI's rules, without a DOM: which options the running browser has
 * (PLAN.md §5.5), the warnings §8.6 asks for, and what the chip of §4.2 says.
 *
 * The capabilities are a literal, never a browser name (invariant 5), and every
 * Chrome/Firefox difference has its own case here (invariant 10).
 */

const NOTHING: Capabilities = {
  sidePanel: false,
  sidebarAction: false,
  faviconApi: false,
  promptApi: false,
  tabGroups: false,
  containers: false,
  sessionTabValues: false,
  duplicateCommandDetection: false,
  tabContextMenu: false,
};

/** Chrome: "Duplicate tab" can be recognized, and there are no containers. */
const CHROME: Capabilities = {
  ...NOTHING,
  sidePanel: true,
  faviconApi: true,
  tabGroups: true,
  duplicateCommandDetection: true,
};

/** Firefox: containers, and no way to tell a deliberate duplicate from any other. */
const FIREFOX: Capabilities = {
  ...NOTHING,
  sidebarAction: true,
  containers: true,
  sessionTabValues: true,
  tabContextMenu: true,
};

const english = localeTranslator('en');
const italian = localeTranslator('it');

function ids(capabilities: Capabilities): readonly string[] {
  return visibleGuardToggles(capabilities).map((row) => row.id);
}

describe('visibleGuardToggles on Chrome', () => {
  it('offers "Duplicate tab", which the browser lets it recognize', () => {
    expect(ids(CHROME)).toContain('allowIntentionalDuplicates');
  });

  it('hides the containers option rather than showing a dead switch', () => {
    expect(ids(CHROME)).not.toContain('containersAreSeparate');
  });
});

describe('visibleGuardToggles on Firefox', () => {
  it('offers the containers option', () => {
    expect(ids(FIREFOX)).toContain('containersAreSeparate');
  });

  it('hides "Duplicate tab", which it cannot tell from any other duplicate', () => {
    expect(ids(FIREFOX)).not.toContain('allowIntentionalDuplicates');
  });
});

describe('visibleGuardToggles', () => {
  it('keeps the options no capability gates, in the spec’s order', () => {
    expect(ids(NOTHING)).toEqual([
      'preferHttps',
      'keepPinned',
      'keepActive',
      'preferActiveWindow',
      'ignoreEmptyTabs',
      'ignoreAuthPages',
    ]);
  });

  it('names a real capability for every option it gates, and a real setting for each', () => {
    for (const row of GUARD_TOGGLES) {
      expect(row.id in DEFAULT_GUARD_SETTINGS, row.id).toBe(true);
      if (row.needs !== undefined) expect(row.needs in NOTHING, row.id).toBe(true);
    }
  });
});

describe('defaultWhitelist', () => {
  it('pre-fills Chrome’s own pages on Chrome', () => {
    expect(defaultWhitelist(CHROME)).toEqual(DEFAULT_WHITELIST_CHROME);
  });

  it('pre-fills the about: pages and moz-extension on Firefox', () => {
    expect(defaultWhitelist(FIREFOX)).toEqual(DEFAULT_WHITELIST_FIREFOX);
  });
});

describe('guardWarnings', () => {
  const guard = DEFAULT_GUARD_SETTINGS;
  const match = DEFAULT_MATCH_OPTIONS;

  it('says nothing about the defaults: a permanent caution is read as decoration', () => {
    expect(guardWarnings({ guard, match })).toEqual([]);
  });

  it('warns that "The newest" can close a tab the user was working on', () => {
    expect(guardWarnings({ guard: { ...guard, keep: 'newest' }, match })).toEqual([
      'guardWarnNewest',
    ]);
  });

  it('warns that ignoring the path is aggressive', () => {
    expect(guardWarnings({ guard, match: { ...match, ignorePath: true } })).toEqual([
      'guardWarnIgnorePath',
    ]);
  });

  it('gives both when both are chosen', () => {
    expect(
      guardWarnings({ guard: { ...guard, keep: 'newest' }, match: { ...match, ignorePath: true } }),
    ).toEqual(['guardWarnNewest', 'guardWarnIgnorePath']);
  });
});

describe('guardStateText', () => {
  const now = new Date(2026, 0, 15, 15, 10).getTime();

  it('says what the three modes are', () => {
    expect(guardStateText({ mode: 'auto' }, now, english, 'en')).toBe('ON');
    expect(guardStateText({ mode: 'warn' }, now, english, 'en')).toBe('Warnings only');
    expect(guardStateText({ mode: 'off' }, now, english, 'en')).toBe('OFF');
  });

  it('says when a pause ends, in the panel’s language', () => {
    const until = new Date(2026, 0, 15, 15, 40).getTime();
    expect(guardStateText({ mode: 'auto', pausedUntil: until }, now, italian, 'it')).toBe(
      'In pausa fino alle 15:40',
    );
  });

  it('calls a pause further out than a day "until restart", not a date', () => {
    const until = now + 365 * 24 * 60 * 60 * 1000;
    expect(guardStateText({ mode: 'auto', pausedUntil: until }, now, english, 'en')).toBe(
      'Paused until restart',
    );
  });

  it('reads a pause that has already run out as the mode itself', () => {
    expect(guardStateText({ mode: 'auto', pausedUntil: now - 1 }, now, english, 'en')).toBe('ON');
    expect(guardStateText({ mode: 'auto', pausedUntil: now }, now, english, 'en')).toBe('ON');
  });
});

describe('guardChipText', () => {
  it('is the state with the chip’s own label around it', () => {
    const now = Date.now();
    expect(guardChipText({ mode: 'auto' }, now, english, 'en')).toBe('Duplicates: ON');
    expect(guardChipText({ mode: 'off' }, now, italian, 'it')).toBe('Duplicati: OFF');
  });
});

describe('closedTodayText', () => {
  it('agrees with its number in both languages', () => {
    expect(closedTodayText(1, english, 'en')).toBe('1 duplicate closed today');
    expect(closedTodayText(4, english, 'en')).toBe('4 duplicates closed today');
    expect(closedTodayText(1, italian, 'it')).toBe('1 duplicato chiuso oggi');
    expect(closedTodayText(4, italian, 'it')).toBe('4 duplicati chiusi oggi');
  });
});

describe('matchesText', () => {
  it('says that a pattern matches nothing without using a zero', () => {
    expect(matchesText(0, english, 'en')).toBe('matches no open tab');
    expect(matchesText(0, italian, 'it')).toBe('non corrisponde a nessuna scheda aperta');
  });

  it('agrees with its number: §8.3’s "matches 3 open tabs"', () => {
    expect(matchesText(1, english, 'en')).toBe('matches 1 open tab');
    expect(matchesText(3, english, 'en')).toBe('matches 3 open tabs');
    expect(matchesText(1, italian, 'it')).toBe('corrisponde a 1 scheda aperta');
    expect(matchesText(3, italian, 'it')).toBe('corrisponde a 3 schede aperte');
  });
});

describe('patternErrorText', () => {
  it('turns each reason into a localized line, never a bare code', () => {
    expect(patternErrorText('too-long', english)).toBe('too long: 500 characters at most');
    expect(patternErrorText('too-many-wildcards', english)).toBe('too many *: five at most');
    expect(patternErrorText('invalid-regex', italian)).toBe("non è un'espressione regolare valida");
  });
});
