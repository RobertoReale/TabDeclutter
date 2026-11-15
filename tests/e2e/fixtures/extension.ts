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
  /**
   * Whether the profile has already answered the first run of PLAN.md §17. True by default:
   * `onboarding.spec.ts` turns it off with `test.use({ onboarded: false })` and is then looking
   * at a real fresh install.
   */
  onboarded: boolean;
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

export interface LaunchOptions {
  /** The browser's UI language, Chrome's and the renderer's both. */
  readonly uiLanguage: Locale;
  readonly headless: boolean;
  /** `prefers-color-scheme`, or `null` for the browser's own default. */
  readonly colorScheme?: 'light' | 'dark' | 'no-preference' | null;
  /** `prefers-reduced-motion`, or `null` for the browser's own default. */
  readonly reducedMotion?: 'reduce' | 'no-preference' | null;
  /**
   * Whether the profile is past the first run of PLAN.md §17. True by default, because a fresh
   * profile is a fresh install and the onboarding screen would be the only thing in the panel:
   * `onboarding.spec.ts` is the one that wants it, with `test.use({ onboarded: false })`.
   */
  readonly onboarded?: boolean;
}

/** The part of the extension API the flag is written with, in the service worker. */
interface StorageApi {
  readonly chrome: {
    readonly storage: { readonly local: { set(items: Record<string, unknown>): Promise<void> } };
  };
}

/**
 * Marks the profile as past the first run.
 *
 * Through the service worker and before any panel document exists, so no panel ever reads the
 * flag as `false` and then sees it change underneath it.
 */
async function markOnboarded(context: BrowserContext): Promise<void> {
  const [existing] = context.serviceWorkers();
  const worker = existing ?? (await context.waitForEvent('serviceworker'));
  await worker.evaluate(() =>
    (globalThis as unknown as StorageApi).chrome.storage.local.set({ onboarded: true }),
  );
}

/**
 * A Chromium with the built extension loaded, on the profile at `userDataDir`.
 *
 * Exported because a test that restarts the browser (`restart.spec.ts`) has to launch it
 * itself: the `context` fixture is one context per test, and a restart is two on one
 * profile. An existing profile is reused as it is, which is what makes the second launch
 * a restart rather than a fresh install.
 */
export async function launchExtension(
  userDataDir: string,
  options: LaunchOptions,
): Promise<BrowserContext> {
  seedProfile(userDataDir, options.uiLanguage);
  const context = await chromium.launchPersistentContext(userDataDir, {
    // `channel: 'chromium'` is the full Chromium browser. Playwright's default
    // headless binary is the headless shell, which has no extension support, and
    // branded Chrome ignores `--load-extension`.
    channel: 'chromium',
    headless: options.headless,
    // What `i18n.getUILanguage()` and `navigator.language` report. Without it the
    // runner's default (`en-US`) would win and the panel would be in Italian while
    // calling itself English.
    locale: options.uiLanguage,
    // `prefers-color-scheme`, the only way the panel picks its theme (PLAN.md §4.7).
    // Passed on so `test.use({ colorScheme: 'dark' })` reaches a persistent context,
    // which does not get the runner's options for free.
    colorScheme: options.colorScheme ?? undefined,
    // `prefers-reduced-motion` (PLAN.md §4.7). Passed on for the same reason as
    // `colorScheme`: a persistent context does not pick up the runner's option on its own.
    reducedMotion: options.reducedMotion ?? undefined,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  // Before the test opens anything: every spec but `onboarding.spec.ts` is about a profile
  // whose first run is over (§17).
  if (options.onboarded !== false) await markOnboarded(context);
  return context;
}

/**
 * The extension's id, read off its service worker — which is also the wait for the
 * background to be running at all.
 *
 * An unpacked extension's id comes from the directory it was loaded from, so it is the
 * same id across a restart of the same build.
 */
export async function extensionIdOf(context: BrowserContext): Promise<string> {
  const [existing] = context.serviceWorkers();
  const worker = existing ?? (await context.waitForEvent('serviceworker'));
  return new URL(worker.url()).host;
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
  onboarded: [true, { option: true }],

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
  context: async (
    { recorder, uiLanguage, headless, colorScheme, reducedMotion, onboarded },
    use,
    testInfo,
  ) => {
    const context: BrowserContext = await launchExtension(testInfo.outputPath('profile'), {
      uiLanguage,
      headless,
      colorScheme,
      reducedMotion,
      onboarded,
    });
    recorder.attach(context);
    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    await use(await extensionIdOf(context));
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
