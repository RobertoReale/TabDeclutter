/**
 * Mirrors built extension bundles from `.output/chrome-mv3` and `.output/firefox-mv3`
 * into `~/TabDeclutter-prova/chrome` and `~/TabDeclutter-prova/firefox` when that
 * local test directory exists, preventing stale unpacked builds in `chrome://extensions`.
 */

import { cpSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const provaDir = join(homedir(), 'TabDeclutter-prova');

if (existsSync(provaDir)) {
  const pairs = [
    [join(root, '.output', 'chrome-mv3'), join(provaDir, 'chrome')],
    [join(root, '.output', 'firefox-mv3'), join(provaDir, 'firefox')],
  ];
  for (const [src, dest] of pairs) {
    if (!existsSync(src)) continue;
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true });
  }
}
