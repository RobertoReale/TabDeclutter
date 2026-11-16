import { globSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildManifest } from '../../build/manifest';
import { LOCALES } from '../../src/platform/i18n';

/**
 * The other half of invariant 11 (TASKS.md §2), the half the type checker cannot see:
 * `MessageKey` already makes a key that is *not* in `en` a compile error, so what is
 * left to check is the reverse direction — a key the catalogues still ship and nothing
 * asks for any more. A dead key is not harmless: it is a line a translator pays for,
 * and the next reader of `messages.json` cannot tell it from a live one.
 *
 * The scan is over the sources as text rather than over a parsed program, because the
 * keys do not all reach `t` as literals: the section names, the reasons and the chips
 * live in `Record<…, MessageKey>` tables that are indexed at run time, and the settings
 * fields pass theirs as a JSX attribute. A literal that happens to equal a key but
 * means something else only makes the "unused" direction more forgiving, never
 * stricter, so neither test can fail for a coincidence.
 */

const root = new URL('../../', import.meta.url);

/** Everything the extension ships. */
const sources = globSync('src/**/*.{ts,tsx}', { cwd: root }).map((path) =>
  path.replaceAll('\\', '/'),
);

const text = new Map(
  sources.map((path) => [path, readFileSync(new URL(path, root), 'utf8') as string]),
);

function catalogue(locale: string): Record<string, unknown> {
  const path = new URL(`src/public/_locales/${locale}/messages.json`, root);
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

const catalogues = new Map(LOCALES.map((locale) => [locale, Object.keys(catalogue(locale))]));
const en = catalogue('en');

/** Every key passed to `t` as a literal, against the file that passes it. */
function translatedKeys(): Map<string, string> {
  const found = new Map<string, string>();
  for (const [path, source] of text) {
    for (const match of source.matchAll(/\bt\(\s*'([^']+)'/g)) {
      if (match[1] !== undefined) found.set(match[1], path);
    }
  }
  return found;
}

/** Every key a source mentions, however it reaches `t`. */
function mentionedKeys(): Set<string> {
  const keys = new Set(Object.keys(en));
  const found = new Set<string>();
  for (const source of text.values()) {
    // Either quote: a key reaches a `MessageKey`-typed prop as a JSX attribute
    // (`label="settingsFieldStale"`), which Prettier writes with double quotes.
    for (const match of source.matchAll(/['"]([A-Za-z][A-Za-z0-9]*)['"]/g)) {
      const key = match[1];
      if (key !== undefined && keys.has(key)) found.add(key);
    }
  }
  // The manifest's own strings are `__MSG_*__` and never pass through `t`.
  for (const browser of ['chrome', 'firefox'] as const) {
    for (const match of JSON.stringify(buildManifest(browser)).matchAll(/__MSG_(\w+)__/g)) {
      if (match[1] !== undefined) found.add(match[1]);
    }
  }
  return found;
}

describe('the keys the code and the catalogues agree on', () => {
  it('passes t only keys that every locale ships', () => {
    const used = translatedKeys();
    expect(used.size).toBeGreaterThan(0);
    for (const [key, path] of used) {
      for (const [locale, shipped] of catalogues) {
        expect(shipped, `${key} (${path}), in ${locale}`).toContain(key);
      }
    }
  });

  it('ships no key the code has stopped asking for', () => {
    const mentioned = mentionedKeys();
    expect(Object.keys(en).filter((key) => !mentioned.has(key))).toEqual([]);
  });
});
