import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';

import { buildManifest } from './build/manifest';

export default defineConfig({
  srcDir: 'src',
  // Firefox defaults to MV2 in WXT; PLAN.md §5.4 targets MV3 on both browsers.
  manifestVersion: 3,
  vite: () => ({
    plugins: [preact()],
  }),
  // The content is in build/manifest.ts, where a unit test can check it
  // against PLAN.md §5.4.
  manifest: ({ browser }) => buildManifest(browser),
});
