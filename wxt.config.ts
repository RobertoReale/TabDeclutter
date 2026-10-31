import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';

import { buildManifest } from './build/manifest';

export default defineConfig({
  srcDir: 'src',
  // WXT resolves `publicDir` against the project root, not `srcDir`, so the
  // `src/public/` of PLAN.md §5.3 has to be named: `_locales/` and, later, the
  // icons are copied from here to the output root.
  publicDir: 'src/public',
  // Firefox defaults to MV2 in WXT; PLAN.md §5.4 targets MV3 on both browsers.
  manifestVersion: 3,
  vite: () => ({
    plugins: [preact()],
  }),
  // The content is in build/manifest.ts, where a unit test can check it
  // against PLAN.md §5.4.
  manifest: ({ browser }) => buildManifest(browser),
});
