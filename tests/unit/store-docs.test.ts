import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildManifest } from '../../build/manifest';

/**
 * That the store documents (PLAN.md §12, M7.3) still describe the extension that is built.
 *
 * `docs/PERMISSIONS.md` is compared with the manifests, in both directions, so a permission
 * added to `build/manifest.ts` fails here until the document says why, and a row left behind
 * for a removed one fails too. The unit gate runs before the builds, so the
 * comparison with the manifests WXT really wrote is the `permissions docs` gate
 * (`tools/check-permissions.mjs`).
 */

const root = new URL('../../', import.meta.url);

function read(path: string): string {
  return readFileSync(new URL(path, root), 'utf8') as string;
}

/** The text between a heading line and the next heading of the same or a higher level. */
function section(doc: string, heading: string): string {
  const lines = doc.split('\n');
  const start = lines.findIndex((line) => line === heading);
  if (start < 0) throw new Error(`no heading "${heading}"`);
  const level = heading.match(/^#+/)?.[0].length ?? 1;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => {
    const m = line.match(/^(#+) /);
    return m !== null && (m[1]?.length ?? 0) <= level;
  });
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/** The first column of every table row of a section, with its backticks removed. */
function permissionRows(doc: string, heading: string): string[] {
  const rows: string[] = [];
  for (const match of section(doc, heading).matchAll(/^\|\s*`([^`]+)`\s*\|/gm)) {
    if (match[1] !== undefined) rows.push(match[1]);
  }
  return rows;
}

/** The content of the first fenced block under a heading. */
function block(doc: string, heading: string): string {
  const match = section(doc, heading).match(/```\n([\s\S]*?)\n```/);
  if (match?.[1] === undefined) throw new Error(`no block under "${heading}"`);
  return match[1];
}

const permissions = read('docs/PERMISSIONS.md');

describe('docs/PERMISSIONS.md', () => {
  const browsers = [
    { name: 'Chrome', target: 'chrome' },
    { name: 'Firefox', target: 'firefox' },
  ];

  for (const { name, target } of browsers) {
    const manifest = buildManifest(target);

    it(`lists exactly the ${name} permissions of the manifest`, () => {
      expect(permissionRows(permissions, `## ${name} (required)`).sort()).toEqual(
        [...(manifest.permissions ?? [])].sort(),
      );
    });

    it(`lists exactly the optional ${name} permissions of the manifest`, () => {
      expect(permissionRows(permissions, `## ${name} (optional)`).sort()).toEqual(
        [...(manifest.optional_permissions ?? [])].sort(),
      );
    });

    it(`gives every ${name} permission a warning and a justification`, () => {
      for (const heading of [`## ${name} (required)`, `## ${name} (optional)`]) {
        for (const line of section(permissions, heading).split('\n')) {
          if (!/^\|\s*`/.test(line)) continue;
          const cells = line.split('|').map((cell) => cell.trim());
          expect(cells[2], line).not.toBe('');
          expect((cells[3] ?? '').length, line).toBeGreaterThan(40);
        }
      }
    });
  }
});

describe('docs/STORE_LISTING.md', () => {
  const listing = read('docs/STORE_LISTING.md');
  const messages = (locale: string): { extDescription: { message: string } } =>
    JSON.parse(read(`src/public/_locales/${locale}/messages.json`));

  it('gives the Chrome short descriptions as the manifest does, within 132 characters', () => {
    for (const [locale, lang] of [
      ['en', 'EN'],
      ['it', 'IT'],
    ] as const) {
      const text = block(listing, `### Short description (${lang}, max 132 characters)`);
      expect(text).toBe(messages(locale).extDescription.message);
      expect(text.length).toBeLessThanOrEqual(132);
    }
  });

  it('keeps the AMO summaries within 250 characters', () => {
    for (const lang of ['EN', 'IT']) {
      const text = block(listing, `### Summary (${lang}, max 250 characters)`);
      expect(text.length).toBeLessThanOrEqual(250);
      expect(text.length).toBeGreaterThan(50);
    }
  });

  it('states the single purpose of PLAN.md §12.1 in both languages', () => {
    expect(block(listing, '### Single purpose (EN)')).toContain('reduce, deduplicate and organize');
    expect(block(listing, '### Single purpose (IT)')).toContain(
      'ridurre, deduplicare e organizzare',
    );
  });

  it('quotes only reasons the extension really shows', () => {
    for (const [locale, heading] of [
      ['en', '### Detailed description (EN)'],
      ['it', '### Detailed description (IT)'],
    ] as const) {
      const messages = JSON.parse(read(`src/public/_locales/${locale}/messages.json`)) as Record<
        string,
        { message: string }
      >;
      const stale = (messages['reasonStale']?.message ?? '').replace(
        '$1',
        '12 ' + (locale === 'en' ? 'days' : 'giorni'),
      );
      const duplicate = messages['reasonDuplicate']?.message ?? '';
      const text = block(listing, heading);
      expect(text).toContain(`"${stale}"`);
      expect(text).toContain(`"${duplicate}"`);
    }
  });

  it('has every long description, and tells the reader about Duplicate Tabs Closer', () => {
    for (const heading of [
      '### Detailed description (EN)',
      '### Detailed description (IT)',
      '### Description (EN)',
      '### Description (IT)',
    ]) {
      expect(block(listing, heading)).toContain('Duplicate Tabs Closer');
    }
  });
});

describe('docs/AMO_REVIEW.md', () => {
  const review = read('docs/AMO_REVIEW.md');

  it('names the Node version of .nvmrc and the pnpm version of package.json', () => {
    const node = read('.nvmrc').trim().replace(/^v/, '');
    const pkg = JSON.parse(read('package.json')) as { packageManager: string };
    const pnpm = pkg.packageManager.replace(/^pnpm@/, '');
    expect(review).toContain(`**${node}**`);
    expect(review).toContain(`**${pnpm}**`);
  });

  it('gives the build commands of PLAN.md §12.3', () => {
    expect(review).toContain('pnpm install --frozen-lockfile');
    expect(review).toContain('pnpm build:firefox');
  });

  it('lists every Firefox permission in its notes for reviewers', () => {
    const notes = block(review, '## Notes for reviewers');
    const manifest = buildManifest('firefox');
    for (const permission of [
      ...(manifest.permissions ?? []),
      ...(manifest.optional_permissions ?? []),
    ]) {
      expect(notes, permission).toContain(`- ${permission}`);
    }
  });
});

describe('CHANGELOG.md and the README', () => {
  it('has an entry for the version of package.json', () => {
    const pkg = JSON.parse(read('package.json')) as { version: string };
    expect(read('CHANGELOG.md')).toContain(`## [${pkg.version}]`);
  });

  it('names every store document', () => {
    const readme = read('README.md');
    for (const file of ['PRIVACY', 'PERMISSIONS', 'STORE_LISTING', 'AMO_REVIEW']) {
      expect(readme).toContain(`docs/${file}.md`);
      expect(existsSync(new URL(`docs/${file}.md`, root))).toBe(true);
    }
  });
});
