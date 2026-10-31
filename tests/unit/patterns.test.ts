import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WHITELIST_CHROME,
  DEFAULT_WHITELIST_FIREFOX,
  MAX_PATTERN_LENGTH,
  MAX_WILDCARDS,
  compile,
} from '../../src/core/patterns';

/** `[pattern, URLs it whitelists, URLs it does not]`. */
type Case = readonly [string, readonly string[], readonly string[]];

function check(cases: readonly Case[]): void {
  for (const [pattern, matches, misses] of cases) {
    const compiled = compile(pattern);
    expect(compiled.errors, `${pattern} should compile`).toEqual([]);
    for (const url of matches) expect(compiled.match(url), `${pattern} ~ ${url}`).toBe(true);
    for (const url of misses) expect(compiled.match(url), `${pattern} !~ ${url}`).toBe(false);
  }
}

/**
 * Patterns a Duplicate Tabs Closer user would really have in their whitelist, with the
 * behaviour that extension gives them.
 *
 * These expectations are not read off PLAN.md: they were produced by running
 * `whiteListToPattern` + `isUrlWhiteListed` from Peuj/duplicate-tabs-closer (`options.js`,
 * `worker.js`) over the same pairs and comparing, which is the only way "compatible with
 * their syntax" (PLAN.md §8.3) can be claimed. The surprises are commented, because each
 * one is a thing a reader would otherwise call a bug.
 */
const REAL_PATTERNS: readonly Case[] = [
  // A whole site. Anchored at the front, so the scheme is part of the pattern.
  [
    'https://www.google.com/*',
    ['https://www.google.com/', 'https://www.google.com/search?q=x'],
    ['http://www.google.com/', 'https://mail.google.com/', 'https://WWW.GOOGLE.COM/search?q=x'],
  ],
  // `*` over the scheme is how a DTC user writes "either protocol".
  [
    '*://mail.google.com/*',
    ['https://mail.google.com/mail/u/0/#inbox', 'http://mail.google.com/mail'],
    ['https://mail.google.com', 'https://www.google.com/mail/'],
  ],
  // A dev server, with the port left open by the trailing `*`.
  [
    'http://localhost*',
    ['http://localhost', 'http://localhost/', 'http://localhost:3000/app'],
    ['https://localhost:3000/app'],
  ],
  // DTC's own syntax hint: a regex is used as written, so this one whitelists every URL
  // that does *not* contain `google.com` — it needs no anchor to work.
  [
    '/^(?!.*google\\.com)/',
    ['https://example.com/a', 'about:blank', 'https://WWW.GOOGLE.COM/search?q=x'],
    ['https://www.google.com/', 'https://mail.google.com/mail'],
  ],
  // A regex matches anywhere in the URL, and honours the flags the user wrote.
  [
    '/mail\\.google\\.com/i',
    ['https://mail.google.com/mail', 'https://MAIL.GOOGLE.COM/mail'],
    ['https://mailxgoogle.com/'],
  ],
  [
    '/^https:\\/\\/x\\.com\\/(home|notifications)$/',
    ['https://x.com/home', 'https://x.com/notifications'],
    ['https://x.com/messages', 'https://x.com/home?x=1'],
  ],
  // The trap of the syntax: a wildcard pattern is anchored at *both* ends, so a bare
  // host whitelists nothing at all. DTC behaves exactly like this.
  ['example.com', [], ['https://example.com/', 'example.com/a', 'https://sub.example.com/']],
];

describe('compile', () => {
  it('matches the patterns a Duplicate Tabs Closer user already has', () => {
    check(REAL_PATTERNS);
  });

  describe('wildcards', () => {
    it('anchors at both ends and takes everything but `*` literally', () => {
      check([
        [
          'https://example.com/a*',
          ['https://example.com/a', 'https://example.com/ab', 'https://example.com/a/b/c'],
          ['https://example.com/', 'xhttps://example.com/a', 'https://example.com/b'],
        ],
        // `.` is a character, not "any character".
        ['https://a.example.com/x', ['https://a.example.com/x'], ['https://aXexample.com/x']],
        // So are the rest of the regex metacharacters.
        [
          'https://example.com/?q=a+b(c)[d]{1}^e$f|g\\h',
          ['https://example.com/?q=a+b(c)[d]{1}^e$f|g\\h'],
          ['https://example.com/?q=aXbXcXdX1XeXfXgXh'],
        ],
      ]);
    });

    it('lets `*` stand for the empty string, and for anything else', () => {
      check([
        ['https://example.com/a*b', ['https://example.com/ab', 'https://example.com/aXYZb'], []],
        // A lone `*` whitelists everything, the empty URL included.
        ['*', ['', 'https://example.com/', 'about:blank'], []],
      ]);
    });

    it('is case-sensitive, like the extension it copies', () => {
      check([['https://example.com/A', ['https://example.com/A'], ['https://example.com/a']]]);
    });

    it('treats the trailing slash as optional on both sides', () => {
      check([
        ['https://example.com/', ['https://example.com', 'https://example.com/'], []],
        ['https://example.com', ['https://example.com', 'https://example.com/'], []],
        ['about:blank', ['about:blank', 'about:blank/'], ['about:blankish', 'xabout:blank']],
        // Only the one slash the pattern ends with.
        [
          'https://example.com/a/',
          ['https://example.com/a', 'https://example.com/a/'],
          ['https://example.com/a//'],
        ],
      ]);
    });
  });

  describe('regular expressions', () => {
    it('reads `/body/flags` and nothing else as a regex', () => {
      check([
        // `body` needs at least one character, so `//` is the literal pattern `//` —
        // which, after the trailing slash is made optional, is `/` or `//`.
        ['//', ['/', '//'], ['///', 'https://example.com/']],
        // An unrecognized flag letter makes the whole line a wildcard pattern.
        ['/google/d', ['/google/d'], ['https://www.google.com/']],
      ]);
    });

    it('drops `g` and `y`, so that `match` has no memory', () => {
      for (const pattern of ['/google/', '/google/g', '/google/gy']) {
        const compiled = compile(pattern);
        expect(compiled.errors).toEqual([]);
        // The same answer three times: with `g`, `test` would advance `lastIndex` and
        // the second call on the same URL would say false.
        expect([1, 2, 3].map(() => compiled.match('https://www.google.com/'))).toEqual([
          true,
          true,
          true,
        ]);
      }
    });

    it('keeps the other flags', () => {
      check([
        ['/EXAMPLE/i', ['https://example.com/'], []],
        ['/EXAMPLE/', [], ['https://example.com/']],
        // `s` makes `.` match a newline; a title or URL can contain one.
        ['/a.b/s', ['a\nb'], []],
        ['/a.b/', [], ['a\nb']],
      ]);
    });
  });

  describe('invalid lines', () => {
    it('reports an unparseable regex and ignores that line only', () => {
      const compiled = compile(['https://example.com/*', '/foo(/', '/[/', 'about:blank']);
      expect(compiled.errors.map((e) => ({ line: e.line, code: e.code }))).toEqual([
        { line: 2, code: 'invalid-regex' },
        { line: 3, code: 'invalid-regex' },
      ]);
      // The engine's own words, which is what PLAN.md §8.3 shows the user.
      expect(compiled.errors[0]?.message).toMatch(/regular expression/i);
      // The lines around it still work: an invalid pattern is never a dead list.
      expect(compiled.match('https://example.com/a')).toBe(true);
      expect(compiled.match('about:blank')).toBe(true);
      expect(compiled.match('https://other.example/')).toBe(false);
    });

    it('reports a bad flag combination as an invalid regex', () => {
      const compiled = compile('/x/uu');
      expect(compiled.errors).toHaveLength(1);
      expect(compiled.errors[0]?.code).toBe('invalid-regex');
      expect(compiled.match('x')).toBe(false);
    });

    it('never throws, whatever the line says', () => {
      const nasty = [
        '(((',
        '[[[',
        '\\',
        '$^',
        '{2,}',
        '*?+',
        '/*/',
        '/(/',
        '/\\/',
        '/(?<',
        '/x/Z',
        '/x/gimsuy',
      ];
      for (const pattern of nasty) {
        const compiled = compile(pattern);
        expect(() => compiled.match('https://example.com/')).not.toThrow();
      }
    });
  });

  describe('blank lines', () => {
    it('ignores them without reporting an error, and still counts them', () => {
      const compiled = compile(['', '   ', '\t', 'about:blank', '', '/foo(/']);
      expect(compiled.errors.map((e) => ({ line: e.line, code: e.code }))).toEqual([
        { line: 6, code: 'invalid-regex' },
      ]);
      expect(compiled.match('about:blank')).toBe(true);
      // An empty list matches nothing — it does not degenerate into "everything".
      expect(compile('').errors).toEqual([]);
      expect(compile('').match('https://example.com/')).toBe(false);
      expect(compile('\n\n   \n').match('')).toBe(false);
    });

    it('trims each line, so leading and trailing spaces are not part of the pattern', () => {
      check([
        ['  https://example.com/*  ', ['https://example.com/a'], ['  https://example.com/a']],
        ['\t/EXAMPLE/i\t', ['https://example.com/'], []],
      ]);
      // A list pasted from a Windows editor arrives with `\r` at the end of each line.
      const compiled = compile('about:blank\r\nabout:newtab\r\n');
      expect(compiled.errors).toEqual([]);
      expect(compiled.match('about:newtab')).toBe(true);
    });
  });

  describe('limits', () => {
    it(`allows ${MAX_PATTERN_LENGTH} characters and reports the next one`, () => {
      const url = `https://example.com/${'a'.repeat(MAX_PATTERN_LENGTH)}`;
      const atLimit = `https://example.com/${'a'.repeat(MAX_PATTERN_LENGTH - 21)}*`;
      expect(atLimit).toHaveLength(MAX_PATTERN_LENGTH);
      expect(compile(atLimit).errors).toEqual([]);
      expect(compile(atLimit).match(url)).toBe(true);

      const tooLong = `${atLimit}*`;
      const compiled = compile(tooLong);
      expect(compiled.errors).toEqual([
        {
          line: 1,
          code: 'too-long',
          message: `501 characters, the limit is ${MAX_PATTERN_LENGTH}`,
        },
      ]);
      expect(compiled.match(url)).toBe(false);
    });

    it('measures the length after trimming, not before', () => {
      const atLimit = 'a'.repeat(MAX_PATTERN_LENGTH);
      expect(compile(`   ${atLimit}   `).errors).toEqual([]);
      expect(compile(`   ${atLimit}   `).match(atLimit)).toBe(true);
    });

    it('applies the limit to a regex line as well', () => {
      const body = 'a'.repeat(MAX_PATTERN_LENGTH);
      expect(compile(`/${body}/`).errors.map((e) => e.code)).toEqual(['too-long']);
    });

    it(`allows ${MAX_WILDCARDS} wildcards and reports the next one`, () => {
      const ok = 'a*b*c*d*e*f';
      expect(compile(ok).errors).toEqual([]);
      expect(compile(ok).match('a-b-c-d-e-f')).toBe(true);

      const compiled = compile('a*b*c*d*e*f*g');
      expect(compiled.errors).toEqual([
        {
          line: 1,
          code: 'too-many-wildcards',
          message: `6 wildcards, the limit is ${MAX_WILDCARDS}`,
        },
      ]);
      expect(compiled.match('a-b-c-d-e-f-g')).toBe(false);
      // The cap is on wildcard patterns only: a regex says `.*` as often as it likes.
      expect(compile('/a.*b.*c.*d.*e.*f.*g/').errors).toEqual([]);
    });
  });

  describe('the per-browser defaults (PLAN.md §8.3)', () => {
    it('is the list PLAN.md §8.3 prints, in that order', () => {
      expect(DEFAULT_WHITELIST_CHROME).toEqual([
        'chrome://newtab',
        'about:blank',
        'chrome://extensions*',
        'chrome-extension://*',
      ]);
      expect(DEFAULT_WHITELIST_FIREFOX).toEqual([
        'about:newtab',
        'about:home',
        'about:blank',
        'about:addons',
        'moz-extension://*',
      ]);
    });

    it('whitelists the pages Chrome duplicates on purpose', () => {
      const chrome = compile(DEFAULT_WHITELIST_CHROME);
      expect(chrome.errors).toEqual([]);
      for (const url of [
        // Chrome reports the new tab with the trailing slash, the setting is written without.
        'chrome://newtab/',
        'chrome://newtab',
        'about:blank',
        'chrome://extensions/',
        'chrome://extensions/?id=abcdef',
        'chrome-extension://abcdefghijklmnop/sidepanel.html',
      ]) {
        expect(chrome.match(url), url).toBe(true);
      }
      for (const url of [
        'https://example.com/',
        'chrome://settings/',
        'chrome://history/',
        'about:newtab',
        'moz-extension://11111111-2222-3333-4444-555555555555/sidepanel.html',
      ]) {
        expect(chrome.match(url), url).toBe(false);
      }
    });

    it('whitelists the pages Firefox duplicates on purpose', () => {
      const firefox = compile(DEFAULT_WHITELIST_FIREFOX);
      expect(firefox.errors).toEqual([]);
      for (const url of [
        'about:newtab',
        'about:home',
        'about:blank',
        'about:addons',
        'moz-extension://11111111-2222-3333-4444-555555555555/sidepanel.html',
      ]) {
        expect(firefox.match(url), url).toBe(true);
      }
      for (const url of [
        'https://example.com/',
        'about:preferences',
        'about:config',
        'chrome://newtab/',
        'chrome-extension://abcdefghijklmnop/sidepanel.html',
      ]) {
        expect(firefox.match(url), url).toBe(false);
      }
    });
  });

  it('takes the list as one text block or as its lines, with the same result', () => {
    const lines = [...DEFAULT_WHITELIST_CHROME, '', '/foo(/'];
    const asText = compile(lines.join('\n'));
    const asLines = compile(lines);
    expect(asText.errors).toEqual(asLines.errors);
    for (const url of ['about:blank', 'chrome://extensions/', 'https://example.com/']) {
      expect(asText.match(url), url).toBe(asLines.match(url));
    }
  });
});
