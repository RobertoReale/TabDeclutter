import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';

// The full per-browser manifest is M0.2. What is here is the minimum that makes
// `web-ext lint` report 0 errors on the Firefox build (PLAN.md §12.3).
export default defineConfig({
  srcDir: 'src',
  // Firefox defaults to MV2 in WXT; PLAN.md §5.4 targets MV3 on both browsers.
  manifestVersion: 3,
  vite: () => ({
    plugins: [preact()],
  }),
  manifest: ({ browser }) => ({
    name: 'TabDeclutter',
    description:
      'Suggests which tabs to close, organizes the rest into native tab groups and blocks duplicate tabs in real time.',
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              // Fixed forever: it identifies the add-on on AMO (docs/DECISIONS.md, "setup").
              id: 'tabdeclutter@robertoreale',
              strict_min_version: '140.0',
              data_collection_permissions: { required: ['none'] },
            },
          },
        }
      : {}),
  }),
});
