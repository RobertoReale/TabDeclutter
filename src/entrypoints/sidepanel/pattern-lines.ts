/**
 * What the whitelist editor of PLAN.md §8.3 shows next to each line: whether the line compiles
 * and how many open tabs it currently matches.
 *
 * Relative imports, not `@/`: the `unit` vitest project runs without WXT's plugin and so without
 * WXT's alias, and this module is tested there.
 */
import type { PatternError } from '../../core/patterns';
import { compile } from '../../core/patterns';

export interface PatternLine {
  /** 1-based, counting blank lines, so it matches what the user sees in the textarea. */
  readonly number: number;
  /** The line as typed, trimmed. */
  readonly text: string;
  /** A blank line is not a pattern: it is neither an error nor a match. */
  readonly blank: boolean;
  /** Why the line was ignored, when it was. */
  readonly error?: PatternError;
  /** How many of the given URLs this line alone matches. */
  readonly matches: number;
}

/** The lines of the editor, as typed: blanks kept, so the numbering is the user's. */
export function splitLines(text: string): readonly string[] {
  return text.split('\n').map((line) => line.trim());
}

/** What gets stored: the lines that are patterns, in order, blanks dropped. */
export function storedPatterns(text: string): readonly string[] {
  return splitLines(text).filter((line) => line.length > 0);
}

/** The editor's text for a stored list. */
export function editorText(patterns: readonly string[]): string {
  return patterns.join('\n');
}

/**
 * Reviews the editor's text line by line. Each line is compiled on its own, which is both how its
 * error is found and how its "matches N open tabs" preview is counted.
 */
export function reviewPatterns(text: string, urls: readonly string[]): readonly PatternLine[] {
  return splitLines(text).map((line, index) => {
    const number = index + 1;
    if (line.length === 0) return { number, text: line, blank: true, matches: 0 };
    const compiled = compile([line]);
    // `compile` reports the line within what it was given, which here is always line 1.
    const error = compiled.errors[0];
    if (error !== undefined) {
      return { number, text: line, blank: false, error: { ...error, line: number }, matches: 0 };
    }
    return {
      number,
      text: line,
      blank: false,
      matches: urls.filter((url) => compiled.match(url)).length,
    };
  });
}

/** The lines the editor must flag, in the order they appear. */
export function patternErrors(lines: readonly PatternLine[]): readonly PatternLine[] {
  return lines.filter((line) => line.error !== undefined);
}
