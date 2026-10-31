// Runs the gates of phasekit.json in one call and prints one line per gate, plus the lines
// that explain a failure. phasekit.json stays the only definition of "green": this reads
// the same array phasekit runs before every merge, so the two cannot drift apart.
//
//   pnpm gates                     every gate, in order, stopping at the first red one
//   pnpm gates lint "unit tests"   only the gates named, in phasekit.json order
//
// The full output of every gate goes to a log file whose path is printed, so a failure
// can be read further without running the gate again.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { stripVTControlCharacters } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(root, 'phasekit.json'), 'utf8'));
const logDir = join(tmpdir(), 'tabdeclutter-gates');
mkdirSync(logDir, { recursive: true });

const wanted = process.argv.slice(2).map((name) => name.toLowerCase());
const gates = config.gates.filter(
  (g) => wanted.length === 0 || wanted.includes(g.name.toLowerCase()),
);
const unknown = wanted.filter((name) => !config.gates.some((g) => g.name.toLowerCase() === name));
if (unknown.length > 0) {
  const names = config.gates.map((g) => g.name).join(', ');
  process.stdout.write(`Unknown gate: ${unknown.join(', ')}. The gates are: ${names}\n`);
  process.exit(2);
}

const marker = /\b(fail(ed|ure)?|errors?|expected|received|assert\w*|not ok|timed? ?out)\b|[✗×✘]/i;

// A test runner prints each failure where it happens and the counts at the very end, so
// the tail alone names nothing. Keep the lines around each failure marker and the tail.
function failureLines(output, { before = 1, after = 6, tail = 10, max = 60 } = {}) {
  const lines = stripVTControlCharacters(output).split(/\r?\n/);
  const keep = new Set();
  lines.forEach((line, i) => {
    if (!marker.test(line)) return;
    for (let j = Math.max(0, i - before); j <= Math.min(lines.length - 1, i + after); j++)
      keep.add(j);
  });
  for (let j = Math.max(0, lines.length - tail); j < lines.length; j++) keep.add(j);
  const picked = [...keep].sort((a, b) => a - b);
  const shown =
    picked.length > max ? [...picked.slice(0, max - tail), ...picked.slice(-tail)] : picked;
  const out = [];
  let previous = -1;
  for (const j of shown) {
    if (previous !== -1 && j !== previous + 1) out.push('    ...');
    if (lines[j].trim() !== '') out.push(`    ${lines[j]}`);
    previous = j;
  }
  return out.join('\n');
}

// The counts a green gate ends with (tests passed, coverage, warnings), which the report
// has to quote, without the hundreds of lines above them.
const summary =
  /\b\d+ (passed|failed|skipped|problems?|errors?|warnings?|notices?)\b|^\s*(All files|Statements|Lines)\b/i;

function summaryLines(output, max = 4) {
  const lines = stripVTControlCharacters(output).split(/\r?\n/);
  return lines
    .filter((line) => summary.test(line))
    .slice(-max)
    .map((line) => `    ${line.trim()}`)
    .join('\n');
}

let failed = null;
for (const gate of gates) {
  const cwd = join(root, gate.cwd ?? '.');
  const attempts = 1 + (gate.retries ?? 0);
  const log = join(logDir, `${gate.name.replace(/\W+/g, '-')}.log`);
  const started = Date.now();
  let result;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    result = spawnSync(gate.run, {
      cwd,
      shell: true,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    });
    if (result.status === 0) break;
    if (attempt < attempts) {
      process.stdout.write(
        `FLAKY ${gate.name}: exit ${result.status} on attempt ${attempt} of ${attempts}, running it again\n`,
      );
    }
  }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? String(result.error) : ''}`;
  writeFileSync(log, output);
  const seconds = Math.round((Date.now() - started) / 1000);
  if (result.status === 0) {
    const counts = summaryLines(output);
    process.stdout.write(`PASS  ${gate.name} (${seconds}s)\n${counts ? `${counts}\n` : ''}`);
    continue;
  }
  process.stdout.write(`FAIL  ${gate.name} (exit ${result.status}, ${seconds}s): ${gate.run}\n`);
  process.stdout.write(`${failureLines(output)}\n`);
  process.stdout.write(`Full output: ${log}\n`);
  failed = gate;
  break;
}

if (failed) {
  const rest = gates.slice(gates.indexOf(failed) + 1).map((g) => g.name);
  if (rest.length > 0) process.stdout.write(`Not run: ${rest.join(', ')}\n`);
  process.exit(1);
}
process.stdout.write(`All ${gates.length} gates green.\n`);
