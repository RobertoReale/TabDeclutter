import { describe, expect, it } from 'vitest';

import {
  editorText,
  patternErrors,
  reviewPatterns,
  splitLines,
  storedPatterns,
} from '../../src/entrypoints/sidepanel/pattern-lines';

/**
 * The whitelist editor of PLAN.md §8.3: a valid line, an invalid one and the
 * "matches N open tabs" preview. The preview is counted with `core/patterns`'
 * own `compile`, so these tests also pin that it cannot drift from the matching
 * the guard does (invariant 9).
 */

const OPEN: readonly string[] = [
  'https://example.com/a',
  'https://example.com/b',
  'https://other.test/a',
  'about:blank',
];

describe('splitLines', () => {
  it('trims every line and keeps the blank ones, so the numbering is the user’s', () => {
    expect(splitLines('  a  \n\n b')).toEqual(['a', '', 'b']);
  });

  it('leaves no \\r behind on a list pasted from a Windows editor', () => {
    expect(splitLines('a\r\nb')).toEqual(['a', 'b']);
  });
});

describe('storedPatterns', () => {
  it('stores the patterns and not the blank lines', () => {
    expect(storedPatterns('a\n\n  \nb\n')).toEqual(['a', 'b']);
  });
});

describe('editorText', () => {
  it('is the inverse of storedPatterns for a stored list', () => {
    const stored = ['about:blank', 'https://example.com/*'];
    expect(storedPatterns(editorText(stored))).toEqual(stored);
  });
});

describe('reviewPatterns on a valid line', () => {
  it('counts the open tabs the wildcard pattern matches', () => {
    const [line] = reviewPatterns('https://example.com/*', OPEN);
    expect(line).toEqual({
      number: 1,
      text: 'https://example.com/*',
      blank: false,
      matches: 2,
    });
  });

  it('counts a regular expression line, which is not anchored', () => {
    const [line] = reviewPatterns('/example\\.com/', OPEN);
    expect(line?.error).toBeUndefined();
    expect(line?.matches).toBe(2);
  });

  it('reports zero rather than an error for a pattern nothing matches yet', () => {
    const [line] = reviewPatterns('https://nothing.test/*', OPEN);
    expect(line?.error).toBeUndefined();
    expect(line?.matches).toBe(0);
  });

  it('counts each line on its own, so one pattern never borrows another’s matches', () => {
    const lines = reviewPatterns('https://example.com/*\nabout:blank', OPEN);
    expect(lines.map((line) => line.matches)).toEqual([2, 1]);
  });
});

describe('reviewPatterns on an invalid line', () => {
  it('gives the reason and no matches for a regular expression that does not compile', () => {
    const [line] = reviewPatterns('/[unclosed/', OPEN);
    expect(line?.error?.code).toBe('invalid-regex');
    expect(line?.matches).toBe(0);
  });

  it('gives the reason for a line over 500 characters', () => {
    const [line] = reviewPatterns(`https://example.com/${'a'.repeat(500)}`, OPEN);
    expect(line?.error?.code).toBe('too-long');
  });

  it('gives the reason for a line with more than five wildcards', () => {
    const [line] = reviewPatterns('*a*b*c*d*e*', OPEN);
    expect(line?.error?.code).toBe('too-many-wildcards');
  });

  it('numbers the error by the line the user sees, blank lines counted', () => {
    const lines = reviewPatterns('about:blank\n\n/[unclosed/', OPEN);
    expect(lines[2]?.error).toMatchObject({ line: 3, code: 'invalid-regex' });
  });

  it('leaves the lines around it working: one bad pattern is never fatal', () => {
    const lines = reviewPatterns('/[unclosed/\nhttps://example.com/*', OPEN);
    expect(lines[0]?.error).toBeDefined();
    expect(lines[1]?.error).toBeUndefined();
    expect(lines[1]?.matches).toBe(2);
  });
});

describe('reviewPatterns on a blank line', () => {
  it('is neither an error nor a match', () => {
    const lines = reviewPatterns('about:blank\n\n', OPEN);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toEqual({ number: 2, text: '', blank: true, matches: 0 });
    expect(lines[2]?.blank).toBe(true);
  });
});

describe('patternErrors', () => {
  it('keeps only the flagged lines, in the order they appear', () => {
    const lines = reviewPatterns('/[unclosed/\nabout:blank\n*a*b*c*d*e*', OPEN);
    expect(patternErrors(lines).map((line) => line.number)).toEqual([1, 3]);
  });

  it('is empty when the whole list compiles', () => {
    expect(patternErrors(reviewPatterns('about:blank\nhttps://example.com/*', OPEN))).toEqual([]);
  });
});
