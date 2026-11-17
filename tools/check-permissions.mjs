// Compares the permission tables of docs/PERMISSIONS.md with the manifests that were really
// built (`.output/<browser>-mv3/manifest.json`), PLAN.md §12.1 and M7.3. It is a gate that
// runs after both builds: the unit tests run before them, so they can only compare the
// document with `build/manifest.ts`, never with what WXT finally wrote.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(join(root, 'docs', 'PERMISSIONS.md'), 'utf8');

/** The first column of every table row under a `## <heading>` section. */
function rows(heading) {
  const lines = doc.split('\n');
  const start = lines.findIndex((line) => line === `## ${heading}`);
  if (start < 0) throw new Error(`docs/PERMISSIONS.md has no "## ${heading}" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  const section = (end < 0 ? rest : rest.slice(0, end)).join('\n');
  return [...section.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]).sort();
}

let failed = false;
for (const [name, dir] of [
  ['Chrome', 'chrome-mv3'],
  ['Firefox', 'firefox-mv3'],
]) {
  const path = `.output/${dir}/manifest.json`;
  if (!existsSync(join(root, path))) {
    process.stderr.write(`FAIL ${name}: ${path} does not exist; build it first\n`);
    failed = true;
    continue;
  }
  const manifest = JSON.parse(readFileSync(join(root, path), 'utf8'));
  const checks = [
    [`${name} (required)`, [...(manifest.permissions ?? [])].sort()],
    [`${name} (optional)`, [...(manifest.optional_permissions ?? [])].sort()],
  ];
  for (const [heading, built] of checks) {
    const documented = rows(heading);
    const same = JSON.stringify(documented) === JSON.stringify(built);
    process.stdout.write(
      `${same ? 'ok  ' : 'FAIL'} ${heading}: documented [${documented}] built [${built}]\n`,
    );
    if (!same) failed = true;
  }
  for (const key of ['host_permissions', 'content_scripts']) {
    if (manifest[key] !== undefined) {
      process.stderr.write(`FAIL ${name}: the built manifest has ${key}\n`);
      failed = true;
    }
  }
}
process.exit(failed ? 1 : 0);
