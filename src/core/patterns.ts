/**
 * The duplicate whitelist: the patterns whose URLs may always have duplicates
 * (PLAN.md §8.3, "Duplicate whitelist").
 *
 * The syntax is **Duplicate Tabs Closer's**, so that the user can paste the whitelist
 * they already use. It was read off that extension's source rather than guessed, because
 * "compatible" is only worth something if the edge cases agree too (`options.js`,
 * `whiteListToPattern`, and `worker.js`, `isUrlWhiteListed`; see docs/DECISIONS.md):
 *
 * - lines are split, trimmed and the empty ones dropped;
 * - a line of the form `/body/flags` is a **regular expression**, used as written and
 *   therefore *not* anchored, with the flags the user gave minus `g` and `y`;
 * - any other line is a **wildcard** pattern: `*` is any sequence of characters,
 *   everything else is literal, and the whole thing is anchored at both ends with a
 *   trailing slash left optional. So it is case-sensitive, and `about:blank` whitelists
 *   `about:blank` and nothing containing it;
 * - a line that does not compile is ignored instead of breaking the whole list.
 *
 * The URL to pass to `match` is the tab's **raw** URL, not the normalized key: that is
 * what the reference extension tests, and what the user typed the pattern against.
 *
 * Compiled once per list and kept, not per tab: the guard runs on every navigation
 * (PLAN.md §8.2) and `compile` is the only place a `RegExp` is built. The per-line
 * preview of §8.3 ("matches 3 open tabs") is a `compile` of that single line.
 */

/** PLAN.md §8.3: "Maximum length 500 characters per pattern". */
export const MAX_PATTERN_LENGTH = 500;

/**
 * Duplicate Tabs Closer's own cap on a wildcard pattern. Kept, both for compatibility
 * and because `*` becomes `.*`: a handful of them in one anchored pattern is already
 * enough backtracking to notice on a long URL.
 */
export const MAX_WILDCARDS = 5;

/** Why a line was ignored. The UI turns this into a localized message (§2.11). */
export type PatternErrorCode = 'too-long' | 'too-many-wildcards' | 'invalid-regex';

export interface PatternError {
  /** 1-based, counted over every line of the input, the blank ones included. */
  readonly line: number;
  readonly code: PatternErrorCode;
  /**
   * The detail behind the code, in English: the two numbers, or what the regular
   * expression engine said (`SyntaxError: Invalid regular expression: …`). Shown next to
   * the localized message, never instead of it.
   */
  readonly message: string;
}

export interface CompiledPatterns {
  /** Whether `url` is whitelisted by any line that compiled. */
  match(url: string): boolean;
  /** One entry per ignored line, in line order. Empty when the whole list compiled. */
  readonly errors: readonly PatternError[];
}

/** The six flags the reference extension recognizes. `/x/d` is not a regex line there. */
const REGEX_FLAGS = /^[gimsuy]*$/;

/** `g` and `y` move `lastIndex`, which would make `match` depend on its history. */
const STATEFUL_FLAGS = /[gy]/g;

/** Everything a regular expression reads as syntax. `*` is handled on its own. */
const METACHARACTER = /[.+?^${}()|[\]\\]/;

function toLines(patterns: string | readonly string[]): readonly string[] {
  // Split on `\n` alone: a `\r` then goes with the surrounding spaces when the line is
  // trimmed, so a list pasted from a Windows editor behaves like any other.
  return typeof patterns === 'string' ? patterns.split('\n') : patterns;
}

/**
 * The literal-with-`*` form, as an anchored regular expression.
 *
 * Cannot throw: every character that is not `*` is either escaped or has no meaning in
 * a pattern. That matters more than it looks — a whitelist is a place where the user
 * types, and PLAN.md §8.3 asks for "never a crash".
 */
function wildcardToRegExp(pattern: string): RegExp {
  // One trailing slash off and an optional one back on, so that a pattern written
  // `https://example.com/` also covers the URL without the slash, and the other way
  // round. The browser is not consistent about it either (`chrome://newtab/`).
  const trimmedSlash = pattern.replace(/\/$/, '');
  let source = '^';
  for (const character of trimmedSlash) {
    if (character === '*') source += '.*';
    else if (METACHARACTER.test(character)) source += `\\${character}`;
    else source += character;
  }
  return new RegExp(`${source}\\/?$`);
}

/**
 * The `/body/flags` form, or `null` when the line is a wildcard pattern.
 *
 * The reference extension reads it with `/^\/(.+)\/([gimsuy]*)$/`. Written out by hand
 * instead, because the capture groups of a match are typed as possibly absent and
 * re-checking them would add two branches no input can reach. Equivalent: `(.+)` is
 * greedy, so the closing slash is the last one in the line — any earlier candidate would
 * leave a `/` among the flags, which they do not allow.
 */
function regexLine(pattern: string): { body: string; flags: string } | null {
  if (!pattern.startsWith('/')) return null;
  const close = pattern.lastIndexOf('/');
  // `(.+)`: at least one character between the two slashes, so `/` and `//` are literals.
  if (close < 2) return null;
  const flags = pattern.slice(close + 1);
  if (!REGEX_FLAGS.test(flags)) return null;
  return { body: pattern.slice(1, close), flags };
}

function countWildcards(pattern: string): number {
  return (pattern.match(/\*/g) ?? []).length;
}

/**
 * Compiles a whitelist, as one text block or as its lines.
 *
 * Total: any input gives a usable matcher. A line that cannot be compiled is reported
 * in `errors` and left out of `match`, which is what the line editor highlights.
 */
export function compile(patterns: string | readonly string[]): CompiledPatterns {
  const matchers: RegExp[] = [];
  const errors: PatternError[] = [];

  toLines(patterns).forEach((rawLine, index) => {
    const line = index + 1;
    const pattern = rawLine.trim();
    if (pattern === '') return;

    if (pattern.length > MAX_PATTERN_LENGTH) {
      errors.push({
        line,
        code: 'too-long',
        message: `${pattern.length} characters, the limit is ${MAX_PATTERN_LENGTH}`,
      });
      return;
    }

    const asRegex = regexLine(pattern);
    if (asRegex !== null) {
      try {
        matchers.push(new RegExp(asRegex.body, asRegex.flags.replace(STATEFUL_FLAGS, '')));
      } catch (error) {
        // `String`, not `error.message`: anything is throwable, and a branch on the type
        // of what was thrown could never be reached by a test — `new RegExp` throws a
        // `SyntaxError` or nothing. The type is part of the detail the user sees.
        errors.push({ line, code: 'invalid-regex', message: String(error) });
      }
      return;
    }

    const wildcards = countWildcards(pattern);
    if (wildcards > MAX_WILDCARDS) {
      errors.push({
        line,
        code: 'too-many-wildcards',
        message: `${wildcards} wildcards, the limit is ${MAX_WILDCARDS}`,
      });
      return;
    }

    matchers.push(wildcardToRegExp(pattern));
  });

  return {
    match: (url) => matchers.some((matcher) => matcher.test(url)),
    errors,
  };
}

/**
 * The pre-filled whitelist on Chrome (PLAN.md §8.3).
 *
 * The browser's own pages and every extension page: they are duplicated all the time on
 * purpose, and closing one of them is never what the user meant. Which of the two lists
 * to install is a build-time fact, so `src/platform/` picks it — the core may not ask
 * what browser it is running on (TASKS.md §2.4, §2.5).
 */
export const DEFAULT_WHITELIST_CHROME: readonly string[] = [
  'chrome://newtab',
  'about:blank',
  'chrome://extensions*',
  'chrome-extension://*',
];

/** The pre-filled whitelist on Firefox (PLAN.md §8.3). */
export const DEFAULT_WHITELIST_FIREFOX: readonly string[] = [
  'about:newtab',
  'about:home',
  'about:blank',
  'about:addons',
  'moz-extension://*',
];
