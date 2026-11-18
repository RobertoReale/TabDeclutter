// The JS budgets of PLAN.md §11, as a gate: gzip of the side panel's initial JS ≤ 60 KB and
// of the background ≤ 18 KB, both without tldts, on the Chrome and on the Firefox build.
//
//   pnpm size
//
// §11 excludes tldts (the public suffix list, data rather than the extension's code) from both
// budgets, and gzip cannot be split into per-module shares, so each browser is built twice:
//   - the real build, into `.output/`, with WXT's rollup-plugin-visualizer treemap
//     (`.analysis/<target>.html`): what ships, printed for information;
//   - the same build with tldts replaced by `build/tldts-stub.ts`, into `.analysis/no-tldts/`:
//     the files both budgets are judged on.
// "Initial JS" is what a page loads before it runs: the scripts the side panel's HTML (or the
// manifest's background) names and everything they import statically. A dynamic `import()`
// (the Organize view, PLAN.md §11) is loaded later and is not counted.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 1 KB = 1000 B: the stricter reading of PLAN.md §11. */
const BUDGETS = { panel: 60_000, background: 25_000 };
const BROWSERS = ['chrome', 'firefox'];

function build(browser, { withoutTldts }) {
  const args = ['exec', 'wxt', 'build', '-b', browser, ...(withoutTldts ? [] : ['--analyze'])];
  const result = spawnSync('pnpm', args, {
    cwd: root,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, TD_SIZE_WITHOUT_TLDTS: withoutTldts ? '1' : '' },
  });
  if (result.status !== 0) {
    process.stdout.write(`${result.stdout ?? ''}${result.stderr ?? ''}`);
    throw new Error(`wxt build -b ${browser} failed (exit ${result.status})`);
  }
}

/** The relative modules a chunk imports or re-exports statically. `import(` is not one. */
const staticImport =
  /\b(?:import|export)\s*(?:[\w$\s{},*]*?\bfrom\s*)?(["'`])(\.{1,2}\/[^"'`]+)\1/g;

/** `entries` and every file they import statically, as paths relative to `dir`. */
function closure(dir, entries) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(join(dir, file), 'utf8');
    for (const match of source.matchAll(staticImport)) {
      visit(posix.normalize(posix.join(posix.dirname(file), match[2])));
    }
  };
  entries.forEach((entry) => visit(entry.replace(/^\//, '')));
  return [...seen].sort();
}

function panelEntries(dir) {
  const html = readFileSync(join(dir, 'sidepanel.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
  const preloads = [...html.matchAll(/<link\b[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)];
  return [...scripts, ...preloads.map((m) => m[1])];
}

function backgroundEntries(dir) {
  const { background } = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  return background.service_worker ? [background.service_worker] : background.scripts;
}

/** Each file gzipped on its own at level 9, as it sits in the package, and summed. */
function measure(dir, entries) {
  const files = closure(dir, entries);
  const bytes = files.reduce(
    (sum, file) => sum + gzipSync(readFileSync(join(dir, file)), { level: 9 }).length,
    0,
  );
  return { files, bytes };
}

const format = (n) => n.toLocaleString('en-US');
let passed = 0;
let failed = 0;

for (const browser of BROWSERS) {
  const target = `${browser}-mv3`;
  build(browser, { withoutTldts: false });
  const report = join(root, '.analysis', 'stats.html');
  if (existsSync(report)) renameSync(report, join(root, '.analysis', `${target}.html`));
  build(browser, { withoutTldts: true });

  const shipped = join(root, '.output', target);
  const stubbed = join(root, '.analysis', 'no-tldts', target);
  for (const [part, entries] of [
    ['panel', panelEntries],
    ['background', backgroundEntries],
  ]) {
    const own = measure(stubbed, entries(stubbed));
    const whole = measure(shipped, entries(shipped));
    const ok = own.bytes <= BUDGETS[part];
    if (ok) passed++;
    else failed++;
    process.stdout.write(
      `${ok ? 'ok  ' : 'OVER'} ${target} ${part}: ${format(own.bytes)} B gzip without tldts, ` +
        `budget ${format(BUDGETS[part])} B (${own.files.join(', ')}; ` +
        `${format(whole.bytes)} B as shipped, with tldts, for information)\n`,
    );
  }
}

process.stdout.write(
  `Treemaps: .analysis/${BROWSERS.map((b) => `${b}-mv3`).join('.html, .analysis/')}.html\n`,
);
process.stdout.write(`bundle size: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
