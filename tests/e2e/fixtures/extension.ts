import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, expect, test as base } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

import type { Locale, MessageKey } from '../../../src/platform/i18n';
import { createRecorder } from './recorder';
import type { ExtensionRecorder } from './recorder';

/** The Chrome build `pnpm e2e` has just produced. */
const EXTENSION_DIR = fileURLToPath(new URL('../../../.output/chrome-mv3', import.meta.url));

const LOCALES_DIR = new URL('../../../src/public/_locales/', import.meta.url);

/**
 * What `_locales/<locale>/messages.json` says, read from the same files the
 * build ships, so a renamed or retranslated string cannot pass unnoticed.
 */
export function message(locale: Locale, key: MessageKey): string {
  const file = fileURLToPath(new URL(`${locale}/messages.json`, LOCALES_DIR));
  const catalogue = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { message: string }>;
  const entry = catalogue[key];
  if (entry === undefined) throw new Error(`No "${key}" in ${locale}/messages.json`);
  return entry.message;
}

export interface ExtensionOptions {
  /**
   * The browser's UI language, which is what Chrome resolves `_locales/`
   * against and what `i18n.getUILanguage()` returns. Set it per describe block
   * with `test.use({ uiLanguage: 'it' })`.
   */
  uiLanguage: Locale;
}

/**
 * Picks the language Chrome resolves `_locales/` against, the way a person does
 * it from Chrome's language settings: `intl.app_locale` in the profile's
 * `Local State`, written before the browser starts.
 *
 * This is only half of a UI language. It decides which catalogue
 * `i18n.getMessage()` reads, but not what `i18n.getUILanguage()` answers: that
 * follows the renderer's locale, which Playwright's test runner pins to `en-US`
 * unless the context is given a `locale`. The `context` fixture sets both, so
 * catalogue, `getUILanguage()` and `navigator.language` agree — the state a
 * real browser is in.
 */
function seedProfile(userDataDir: string, locale: Locale): void {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'Local State'),
    JSON.stringify({ intl: { app_locale: locale } }),
    'utf8',
  );
}

export interface ExtensionFixtures {
  /** The extension's id, read off its service worker. */
  extensionId: string;
  /**
   * `sidepanel.html` open in an ordinary tab. The real side panel needs a user
   * gesture that a test cannot produce, and the document is the same one.
   */
  panel: Page;
  recorder: ExtensionRecorder;
  /** Automatic, nothing to use: see the fixture below. */
  health: void;
}

export const test = base.extend<ExtensionOptions & ExtensionFixtures>({
  uiLanguage: ['en', { option: true }],

  // Created before the context, so that it can start recording the moment the
  // browser is up and catch what the service worker logs while it boots.
  // Playwright reads a fixture's dependencies off its destructuring pattern and
  // rejects any other signature, so a fixture without dependencies has to
  // destructure nothing.
  // eslint-disable-next-line no-empty-pattern
  recorder: async ({}, use) => {
    await use(createRecorder());
  },

  // The profile lives in the test's own output directory, so Playwright creates
  // it, keeps it when the test fails and removes it when it passes.
  context: async ({ recorder, uiLanguage, headless, colorScheme }, use, testInfo) => {
    const userDataDir = testInfo.outputPath('profile');
    seedProfile(userDataDir, uiLanguage);

    const context: BrowserContext = await chromium.launchPersistentContext(userDataDir, {
      // `channel: 'chromium'` is the full Chromium browser. Playwright's
      // default headless binary is the headless shell, which has no extension
      // support, and branded Chrome ignores `--load-extension`.
      channel: 'chromium',
      headless,
      // What `i18n.getUILanguage()` and `navigator.language` report. Without it
      // the runner's default (`en-US`) would win and the panel would be in
      // Italian while calling itself English.
      locale: uiLanguage,
      // `prefers-color-scheme`, the only way the panel picks its theme (PLAN.md
      // §4.7). Passed on so `test.use({ colorScheme: 'dark' })` reaches a
      // persistent context, which does not get the runner's options for free.
      colorScheme,
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    });
    recorder.attach(context);
    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    const [existing] = context.serviceWorkers();
    const worker = existing ?? (await context.waitForEvent('serviceworker'));
    await use(new URL(worker.url()).host);
  },

  panel: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await use(page);
  },

  /**
   * Invariant 1 and "no console errors", checked after every test whether the
   * test thought about them or not. It depends on `extensionId`, so it is torn
   * down before the context closes.
   */
  health: [
    async ({ recorder, extensionId }, use) => {
      await use();
      expect(recorder.takeConsoleErrors(), 'the extension logged errors').toEqual([]);
      expect(
        recorder.takeForeignRequests(extensionId),
        'invariant 1: an extension context made a request outside its own origin',
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
