import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import puppeteer from 'puppeteer-core';
import type { Browser, Page } from 'puppeteer-core';

import type { Locale, MessageKey } from '../../../src/platform/i18n';

/** The Firefox build `pnpm e2e:firefox` has just produced. */
const EXTENSION_DIR = fileURLToPath(new URL('../../../.output/firefox-mv3', import.meta.url));

const LOCALES_DIR = new URL('../../../src/public/_locales/', import.meta.url);

/** `browser_specific_settings.gecko.id`, from `build/manifest.ts`. */
const ADDON_ID = 'tabdeclutter@robertoreale';

/**
 * Firefox gives every installed extension a random internal UUID and serves its
 * pages from `moz-extension://<uuid>/`. There is no API to read it back — the
 * background page is not a WebDriver target on Firefox, so the Chromium trick of
 * taking the id off the service worker's URL has no equivalent — so it is pinned
 * through `extensions.webextensions.uuids` before the browser starts and the
 * panel URL is known in advance. Any UUID will do; this one is arbitrary.
 */
const EXTENSION_UUID = '4f2bb1ea-5ac7-4c1e-9f4e-3f1bb0f2a001';

/** The document the sidebar renders. */
export const PANEL_URL = `moz-extension://${EXTENSION_UUID}/sidepanel.html`;

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

/**
 * Where Firefox is when `FIREFOX_PATH` does not say. Puppeteer does not download
 * Firefox for us (`puppeteer-core` never downloads anything), so CI sets
 * `FIREFOX_PATH` to the build it fetched and a developer machine falls back to
 * the installed browser.
 */
const WELL_KNOWN_FIREFOX: Record<string, readonly string[]> = {
  win32: [
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
  ],
  darwin: ['/Applications/Firefox.app/Contents/MacOS/firefox'],
  linux: ['/usr/bin/firefox', '/usr/local/bin/firefox', '/snap/bin/firefox'],
};

export function firefoxPath(): string {
  const configured = process.env['FIREFOX_PATH'];
  if (configured !== undefined && configured !== '') {
    if (!existsSync(configured)) {
      throw new Error(`FIREFOX_PATH points at nothing: ${configured}`);
    }
    return configured;
  }
  const candidates = WELL_KNOWN_FIREFOX[process.platform] ?? [];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      `No Firefox found. Set FIREFOX_PATH to the binary. Looked in: ${candidates.join(', ') || `(nothing known for ${process.platform})`}`,
    );
  }
  return found;
}

/**
 * Console errors and uncaught exceptions from the extension, oldest first.
 * Reading removes them, which is what lets `console.spec.ts` provoke a real
 * violation, take it, and still end clean.
 */
export interface ErrorCollector {
  take(): string[];
}

/** `console.error(…)` from a content context — which is what an extension page is. */
const CONSOLE_ERROR = /^console\.error\b/;

/** An uncaught exception, reported with the URL of the script that threw. */
const EXTENSION_EXCEPTION = new RegExp(`^JavaScript error: moz-extension://${EXTENSION_UUID}/`);

function isExtensionError(line: string): boolean {
  return CONSOLE_ERROR.test(line) || EXTENSION_EXCEPTION.test(line);
}

/**
 * "No console errors" (PLAN.md §14) for Firefox.
 *
 * WebDriver BiDi cannot see it: measured on Firefox 157, Gecko emits no
 * `log.entryAdded` for a `moz-extension://` document at all — not a
 * `console.error` from the page's own script at load, not an uncaught exception
 * — so `page.on('console')`, `page.on('pageerror')` and a raw unfiltered
 * subscription all stay empty, and `evaluateOnNewDocument` never runs there
 * either. What does work is Firefox's own mirror of the console to the browser
 * process's output, which the launch turns on for content contexts only
 * (`devtools.console.stdout.content`); `devtools.console.stdout.chrome` stays
 * off, which is what keeps Gecko's internal chatter out. Uncaught exceptions are
 * reported with the URL of the script that threw and so are matched by origin.
 *
 * `console.spec.ts` proves the collector fires, because a guard that silently
 * never fires is worse than no guard at all.
 */
function collectErrors(firefox: Browser): ErrorCollector {
  const errors: string[] = [];
  const child = firefox.process();
  const streams = [child?.stdout, child?.stderr];
  if (streams.some((stream) => stream === null || stream === undefined)) {
    throw new Error('The Firefox process has no piped output: nothing could watch its console.');
  }

  for (const stream of streams) {
    if (stream === null || stream === undefined) continue;
    stream.setEncoding('utf8');
    // Chunks split lines anywhere, so the tail waits for the rest.
    let tail = '';
    stream.on('data', (chunk: string) => {
      const lines = (tail + chunk).split(/\r?\n/);
      tail = lines.pop() ?? '';
      for (const line of lines) {
        if (isExtensionError(line)) errors.push(line);
      }
    });
  }

  return {
    take: () => errors.splice(0, errors.length),
  };
}

/**
 * Puppeteer 25.16.0's BiDi frame. `page.goto` never resolves against the panel:
 * it waits for navigation events Gecko does not emit for a privileged document
 * (verified by polling the document, which was loaded and complete while
 * `page.url()` still said `about:blank` and no `framenavigated` ever arrived).
 * The browsing context underneath is what actually navigates, and it is not part
 * of Puppeteer's public API — which is why the dependency is pinned exactly.
 */
interface BidiNavigable {
  browsingContext: { navigate(url: string, wait: 'complete'): Promise<unknown> };
}

async function navigate(page: Page, url: string): Promise<void> {
  const frame = page.mainFrame() as unknown as BidiNavigable;
  await frame.browsingContext.navigate(url, 'complete');
}

/** What the panel rendered, read from the live document. */
export interface PanelState {
  url: string;
  /** `<html lang>`, which the panel sets itself (PLAN.md §4.8). */
  lang: string;
  title: string;
  /** The panel's only visible text, or `null` if it has not rendered. */
  main: string | null;
  /** `i18n.getUILanguage()`, the language the catalogue was resolved against. */
  uiLanguage: string | null;
}

/**
 * The panel, once it has rendered. On a page that never renders this returns the
 * last state it saw rather than throwing, so the assertion that follows fails
 * with the real values instead of a timeout.
 */
export async function panelState(page: Page): Promise<PanelState> {
  let state: PanelState | undefined;
  for (let attempt = 0; attempt < 40; attempt++) {
    state = await page.evaluate(() => ({
      url: location.href,
      lang: document.documentElement.lang,
      title: document.title,
      main: document.querySelector('main')?.textContent ?? null,
      uiLanguage: typeof browser === 'undefined' ? null : browser.i18n.getUILanguage(),
    }));
    if (state.url === PANEL_URL && state.main !== null && state.main !== '') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (state === undefined) throw new Error('never read the panel');
  return state;
}

export interface PanelSession {
  /** `sidepanel.html` open in an ordinary tab: the sidebar renders this document. */
  page: Page;
  errors: ErrorCollector;
  close(): Promise<void>;
}

/**
 * A headless Firefox with the built extension installed and the panel open.
 *
 * `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS` is Gecko's documented switch for driving
 * privileged URLs: without it `browsingContext.navigate` refuses
 * `moz-extension://` with "Navigation to … is not allowed in this context", and
 * the alternative — adding `sidepanel.html` to `web_accessible_resources` — would
 * widen the shipped manifest for the tests' benefit.
 */
export async function openPanel(): Promise<PanelSession> {
  const firefox = await puppeteer.launch({
    browser: 'firefox',
    headless: true,
    executablePath: firefoxPath(),
    env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
    extraPrefsFirefox: {
      // A JSON string, which is how Firefox stores this pref.
      'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: EXTENSION_UUID }),
      // See collectErrors: the only way to observe the extension's console.
      'devtools.console.stdout.content': true,
      'devtools.console.stdout.chrome': false,
    },
  });

  const errors = collectErrors(firefox);

  const installed = await firefox.installExtension(EXTENSION_DIR);
  if (installed !== ADDON_ID) {
    await firefox.close();
    throw new Error(
      `Installed ${installed}, expected ${ADDON_ID}: the pinned UUID would not apply`,
    );
  }

  const page = await firefox.newPage();
  await navigate(page, PANEL_URL);

  return {
    page,
    errors,
    close: () => firefox.close(),
  };
}
