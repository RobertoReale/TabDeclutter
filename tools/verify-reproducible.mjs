// AMO's rule for a bundled add-on (PLAN.md §12.3): the sources zip must rebuild the add-on zip
// exactly, and must hold no minified or generated code. This script proves both:
//
//   1. `pnpm zip:firefox` makes the two zips from the current tree (skip with `--no-zip` to check
//      the zips already in `.output/`);
//   2. the sources zip is inspected: no build output, dependencies or runtime state, no minified
//      file, and (in a git checkout) nothing that git does not track;
//   3. it is unpacked into a fresh temporary folder, where the documented commands run:
//      `pnpm install --frozen-lockfile` and `pnpm build:firefox`;
//   4. every file of the rebuilt `.output/firefox-mv3/` is compared, byte for byte, with the
//      add-on zip. The zips themselves are not compared: they carry timestamps.
//
// Exit 0 when the rebuild is identical. On a failure the temporary folder is kept for a look.
// `--keep` keeps it on success too.

import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const addonZip = join(root, '.output', `${pkg.name}-${pkg.version}-firefox.zip`);
const sourcesZip = join(root, '.output', `${pkg.name}-${pkg.version}-sources.zip`);

/** What a reviewer needs to rebuild; without any of these the check is meaningless. */
const REQUIRED = [
  'package.json',
  'pnpm-lock.yaml',
  '.nvmrc',
  'wxt.config.ts',
  'docs/AMO_REVIEW.md',
];
/** Build output, dependencies, tool state and tests: never in the sources zip. */
const FORBIDDEN =
  /(^|\/)(node_modules|\.output|\.wxt|\.phasekit|\.analysis|\.git|coverage|tests)\//;
/** No minifier writes a source line this long; a hand-written file never has one. */
const MAX_LINE = 1000;
const CODE = /\.(c|m)?(j|t)sx?$|\.css$|\.html$/;

/** `command` is one of the fixed literals below: through the shell, so `pnpm.cmd` is found on Windows. */
function run(command, cwd) {
  console.log(`\n> ${command}   (in ${cwd})`);
  const env = { ...process.env };
  // tools/size.mjs builds with this set; the rebuild must be the plain one.
  delete env.TD_SIZE_WITHOUT_TLDTS;
  const result = spawnSync(command, { cwd, env, stdio: 'inherit', shell: true });
  if (result.status !== 0) fail(`\`${command}\` exited ${result.status}`);
}

function fail(message, keep) {
  console.error(`\nNOT REPRODUCIBLE: ${message}`);
  if (keep) console.error(`The rebuild is kept in ${keep}`);
  process.exit(1);
}

/** The files of a zip, as `path → bytes`. Stored and deflated entries, no zip64: what WXT writes. */
function readZip(path) {
  const zip = readFileSync(path);
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error(`${path}: not a zip file`);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`${path}: bad central directory`);
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);
    if (method === 0) files.set(name, Buffer.from(raw));
    else if (method === 8) files.set(name, inflateRawSync(raw));
    else throw new Error(`${path}: ${name} uses compression method ${method}`);
  }
  return files;
}

function listFiles(dir, base = dir, out = new Map()) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else out.set(relative(base, full).split(sep).join('/'), readFileSync(full));
  }
  return out;
}

function trackedByGit() {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? new Set(result.stdout.split('\0').filter(Boolean)) : undefined;
}

// 1. The two zips, from the current tree.
if (!args.has('--no-zip')) run('pnpm zip:firefox', root);

// 2. What the sources zip holds.
const sources = readZip(sourcesZip);
const problems = [];
for (const name of REQUIRED) if (!sources.has(name)) problems.push(`${name} is missing`);
const tracked = trackedByGit();
for (const [name, bytes] of sources) {
  if (FORBIDDEN.test(name)) problems.push(`${name} is build output, dependencies or tests`);
  else if (tracked && !tracked.has(name)) problems.push(`${name} is not tracked by git`);
  if (/\.min\.\w+$/.test(name)) problems.push(`${name} is a minified file`);
  else if (
    CODE.test(name) &&
    bytes
      .toString('utf8')
      .split('\n')
      .some((l) => l.length > MAX_LINE)
  )
    problems.push(`${name} has a line over ${MAX_LINE} characters (minified or generated?)`);
}
if (problems.length > 0) fail(`the sources zip is not clean:\n  ${problems.join('\n  ')}`);
console.log(`\nSources zip: ${sources.size} files, none minified, generated or untracked.`);

// 3. The rebuild, with the commands of docs/AMO_REVIEW.md, in a folder of its own.
const work = mkdtempSync(join(tmpdir(), 'tabdeclutter-reproducible-'));
for (const [name, bytes] of sources) {
  const target = join(work, ...name.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}
run('pnpm install --frozen-lockfile', work);
run('pnpm build:firefox', work);

// 4. File by file.
const expected = readZip(addonZip);
const rebuilt = listFiles(join(work, '.output', 'firefox-mv3'));
const differences = [];
for (const [name, bytes] of expected) {
  const other = rebuilt.get(name);
  if (!other) differences.push(`${name}: in the add-on zip, not in the rebuild`);
  else if (!other.equals(bytes))
    differences.push(`${name}: differs (${bytes.length} B in the zip, ${other.length} B rebuilt)`);
}
for (const name of rebuilt.keys())
  if (!expected.has(name)) differences.push(`${name}: in the rebuild, not in the add-on zip`);
if (differences.length > 0)
  fail(`the rebuild differs from the add-on zip:\n  ${differences.join('\n  ')}`, work);

if (args.has('--keep')) console.log(`\nThe rebuild is kept in ${work}`);
else rmSync(work, { recursive: true, force: true });
console.log(
  `\nREPRODUCIBLE: the ${expected.size} files rebuilt from ${relative(root, sourcesZip)} ` +
    `are identical to ${relative(root, addonZip)}.`,
);
