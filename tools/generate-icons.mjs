#!/usr/bin/env node
/**
 * Rasterises `src/public/icon/icon.svg` to the PNG sizes PLAN.md §4.7 asks
 * for — 16/32/48/128 — so the manifest never points at anything this script
 * did not just produce from that one source file (TASKS.md M6.3: "generated
 * reproducibly").
 *
 * `@resvg/resvg-js` (recorded in docs/DECISIONS.md) renders deterministically
 * from the SVG with no system install beyond its own prebuilt binary, which is
 * what "reproducibly" rules out a hand-exported PNG from doing.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const iconDir = join(here, '..', 'src', 'public', 'icon');
const svg = readFileSync(join(iconDir, 'icon.svg'), 'utf8');

/** PLAN.md §4.7: source SVG + PNG 16/32/48/128. */
const SIZES = [16, 32, 48, 128];

for (const size of SIZES) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  const png = resvg.render().asPng();
  writeFileSync(join(iconDir, `icon-${size}.png`), png);
}
