import { existsSync, globSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * That `docs/TEST-COVERAGE.md` still describes this repository (PLAN.md §14, M7.1).
 *
 * The correspondence between §14's lists and the tests is only worth having if it cannot
 * quietly go stale, and prose cannot be type-checked. Three things are therefore asserted
 * here: every file the document names exists, every manual check it cites is really in
 * `docs/MANUAL-CHECKS.md`, and every E2E spec of either suite is named in it — so a new
 * spec, which is a new §14 flow or a deliberate extra, fails this gate until the list says
 * where it belongs.
 *
 * What a test cannot check is that a row's test really proves its item. That is the
 * reviewer's job, and the reason each row quotes the test's own title.
 */

const root = new URL('../../', import.meta.url);

const DOC = 'docs/TEST-COVERAGE.md';
const doc = readFileSync(new URL(DOC, root), 'utf8') as string;

/** Every `path/like/this` in backticks, which is how the document names a file. */
function citedPaths(): string[] {
  const paths = new Set<string>();
  for (const match of doc.matchAll(/`((?:tests|docs|src|build|scripts|tools)\/[\w./-]+)`/g)) {
    if (match[1] !== undefined) paths.add(match[1]);
  }
  return [...paths].sort();
}

/** The `(M2.2)`-style tag of every `docs/MANUAL-CHECKS.md` entry the document cites. */
function citedManualChecks(): string[] {
  const tags = new Set<string>();
  for (const match of doc.matchAll(/MANUAL-CHECKS\.md`?\s+\(([^)]+)\)/g)) {
    if (match[1] !== undefined) tags.add(match[1]);
  }
  return [...tags].sort();
}

function specs(suite: string): string[] {
  return globSync(`${suite}/*.spec.ts`, { cwd: root }).map((path) => path.replaceAll('\\', '/'));
}

describe('the §14 correspondence list', () => {
  it('names files that exist', () => {
    const cited = citedPaths();
    // A document that cites nothing would pass everything below.
    expect(cited.length).toBeGreaterThan(20);
    expect(cited.filter((path) => !existsSync(new URL(path, root)))).toEqual([]);
  });

  it('cites manual checks that are in MANUAL-CHECKS.md', () => {
    const manual = readFileSync(new URL('docs/MANUAL-CHECKS.md', root), 'utf8') as string;
    const cited = citedManualChecks();
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.filter((tag) => !manual.includes(`(${tag})`))).toEqual([]);
  });

  it.each(['tests/e2e', 'tests/e2e-firefox'])('accounts for every spec of %s', (suite) => {
    const found = specs(suite);
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((path) => !doc.includes(path))).toEqual([]);
  });
});
