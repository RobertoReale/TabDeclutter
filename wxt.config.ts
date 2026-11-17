import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';

import { buildManifest } from './build/manifest';

// `tools/size.mjs` measures the extension's own share of each bundle (the budgets of
// PLAN.md §11 exclude tldts) by building it again with the public suffix list replaced
// by a stub. Such a build never ships: it goes to its own `outDir`, away from `.output/`.
const withoutTldts = process.env.TD_SIZE_WITHOUT_TLDTS === '1';

export default defineConfig({
  srcDir: 'src',
  outDir: withoutTldts ? '.analysis/no-tldts' : '.output',
  // WXT resolves `publicDir` against the project root, not `srcDir`, so the
  // `src/public/` of PLAN.md §5.3 has to be named: `_locales/` and, later, the
  // icons are copied from here to the output root.
  publicDir: 'src/public',
  // Firefox defaults to MV2 in WXT; PLAN.md §5.4 targets MV3 on both browsers.
  manifestVersion: 3,
  vite: () => ({
    plugins: [preact()],
    resolve: withoutTldts
      ? {
          alias: {
            'tldts-experimental': fileURLToPath(new URL('build/tldts-stub.ts', import.meta.url)),
          },
        }
      : {},
  }),
  // `wxt build --analyze` writes the rollup-plugin-visualizer treemap of PLAN.md §13 M7
  // (WXT bundles its own fork of the plugin) to `.analysis/stats.html`; `tools/size.mjs`
  // runs it for each browser. The whole directory is build output, and ignored.
  analysis: {
    template: 'treemap',
    outputFile: '.analysis/stats.html',
  },
  // The content is in build/manifest.ts, where a unit test can check it
  // against PLAN.md §5.4.
  manifest: ({ browser }) => buildManifest(browser),
});
