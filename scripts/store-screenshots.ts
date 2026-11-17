/**
 * Generates the store screenshots (TASKS.md M7.4, PLAN.md §12.2 and §12.3).
 *
 *   pnpm screenshots
 *
 * Five 1280×800 images in `docs/store/screenshots/chrome/`: Declutter, Organize, Duplicate
 * protection, Archive and Declutter in the dark theme. Chromium is driven with Playwright, against
 * the build `pnpm screenshots` has just made. The same bundle UI ships in Firefox, and Firefox
 * cannot be photographed (its panel is a privileged document that WebDriver BiDi refuses to
 * resize or capture), so these images serve both listings (docs/DECISIONS.md, M7.4).
 *
 * **The method.** The panel is a narrow column (a side panel or a sidebar), so a bare
 * screenshot of it would be a thin strip, which neither store accepts at 1280×800. Each view is
 * therefore captured at the panel's real width (`PANEL_WIDTH` × `PANEL_HEIGHT`, one device
 * pixel per CSS pixel, the real extension document with real tabs) and then composed, by a
 * plain Chromium page, into a 1280×800 frame: a caption on the left and the panel on the
 * right. Nothing is mocked-up: every pixel inside the panel is the extension's own.
 *
 * **The data is seeded and the same on every run.** The tabs are real pages, served by this
 * script from 127.0.0.1 under the host names of `SITES` (the browser is told to resolve them
 * there, so nothing reaches the network, invariant 1). Their history (how old they are and how
 * often they were read) and the archive are written to `storage.local` as the background would
 * have written them, relative to the moment of the run, so the ages on screen are the same
 * ones every time.
 *
 * Run under `node --experimental-strip-types`, which does not resolve extensionless imports:
 * every import from `src/` here is a type.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';
import type { Browser as PlaywrightBrowser, Page as PlaywrightPage } from '@playwright/test';

import type { ArchivedTab } from '../src/core/types.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME_DIR = join(ROOT, '.output', 'chrome-mv3');
const LOCALES = join(ROOT, 'src', 'public', '_locales', 'en', 'messages.json');
const OUT = join(ROOT, 'docs', 'store', 'screenshots');

/** The size both stores ask for (PLAN.md §12.2). */
export const FRAME = { width: 1280, height: 800 } as const;

/** What the panel is captured at: a side panel's real width and a tall browser window. */
const PANEL_WIDTH = 460;
const PANEL_HEIGHT = 720;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** One open page: where it is, what it is called, and what the history says about it. */
interface Site {
  readonly host: string;
  readonly path: string;
  readonly title: string;
  /** How long ago it was opened and last looked at. */
  readonly ageDays: number;
  /** How many times it was brought to the front. 0 is a tab opened and never read. */
  readonly reads: number;
}

/** What the person has open: a day of work, with the tabs that pile up around it. */
/*
 * Hosts that are not on Chromium's HSTS preload list: it upgrades a preloaded host (github.com,
 * youtube.com, python.org, wikipedia.org …) to https before the host-resolver rule applies, and the
 * page would never load from this plain-http server.
 */
const SITES: readonly Site[] = [
  {
    host: 'gitlab.com',
    path: '/tabdeclutter/-/merge_requests/482',
    title: 'Add archive filters by age (!482) · Merge requests · tabdeclutter',
    ageDays: 1,
    reads: 9,
  },
  {
    host: 'gitlab.com',
    path: '/tabdeclutter/-/issues',
    title: 'Issues · tabdeclutter',
    ageDays: 3,
    reads: 4,
  },
  {
    host: 'gitlab.com',
    path: '/tabdeclutter/-/pipelines',
    title: 'Pipelines · tabdeclutter',
    ageDays: 2,
    reads: 3,
  },
  {
    host: 'developer.mozilla.org',
    path: '/docs/Web/API/Fetch_API',
    title: 'Fetch API - Web APIs | MDN',
    ageDays: 26,
    reads: 0,
  },
  {
    host: 'developer.mozilla.org',
    path: '/docs/Web/CSS/grid',
    title: 'grid - CSS: Cascading Style Sheets | MDN',
    ageDays: 31,
    reads: 0,
  },
  {
    host: 'developer.mozilla.org',
    path: '/docs/Web/JavaScript/Reference/Global_Objects/Promise',
    title: 'Promise - JavaScript | MDN',
    ageDays: 22,
    reads: 0,
  },
  {
    host: 'stackoverflow.com',
    path: '/questions/11227809',
    title: 'Why is processing a sorted array faster than an unsorted array?',
    ageDays: 14,
    reads: 0,
  },
  {
    host: 'stackoverflow.com',
    path: '/questions/231767',
    title: 'What does the "yield" keyword do in Python?',
    ageDays: 19,
    reads: 0,
  },
  {
    host: 'stackoverflow.com',
    path: '/questions/927358',
    title: 'How do I undo the most recent local commits in Git?',
    ageDays: 40,
    reads: 0,
  },
  {
    host: 'lwn.net',
    path: '/Articles/965321/',
    title: 'A tour of the new kernel scheduler [LWN.net]',
    ageDays: 9,
    reads: 0,
  },
  {
    host: 'lwn.net',
    path: '/Articles/961140/',
    title: 'Memory safety without a garbage collector [LWN.net]',
    ageDays: 12,
    reads: 0,
  },
  {
    host: 'news.ycombinator.com',
    path: '/item/38201',
    title: 'Show HN: A tab manager that never leaves your device',
    ageDays: 7,
    reads: 1,
  },
  {
    host: 'kayak.com',
    path: '/flights/lisbon',
    title: 'Cheap flights to Lisbon - KAYAK',
    ageDays: 8,
    reads: 0,
  },
  {
    host: 'kayak.com',
    path: '/flights/lisbon',
    title: 'Cheap flights to Lisbon - KAYAK',
    ageDays: 5,
    reads: 0,
  },
  {
    host: 'metoffice.gov.uk',
    path: '/weather/forecast/gcpvj0v07',
    title: 'London weather forecast - Met Office',
    ageDays: 11,
    reads: 0,
  },
  {
    host: 'metoffice.gov.uk',
    path: '/weather/forecast/gcpvj0v07',
    title: 'London weather forecast - Met Office',
    ageDays: 4,
    reads: 0,
  },
];

/** How far the Chromium panel's clock runs ahead: past the oldest tab of `SITES`. */
const CLOCK_SHIFT_MS = 45 * DAY;

/** One archived tab: how long ago and why it was closed. */
interface Closed {
  readonly host: string;
  readonly path: string;
  readonly title: string;
  readonly agoMs: number;
  readonly reason: ArchivedTab['reason'];
}

/** Newest first, as the archive stores them. */
const CLOSED: readonly Closed[] = [
  {
    host: 'amazon.com',
    path: '/dp/B0CKRT8Z4M',
    title: 'Mechanical keyboard, 75% – Amazon.com',
    agoMs: 25 * MINUTE,
    reason: 'manual',
  },
  {
    host: 'kayak.com',
    path: '/flights/lisbon',
    title: 'Cheap flights to Lisbon - KAYAK',
    agoMs: 2 * HOUR,
    reason: 'duplicate-auto',
  },
  {
    host: 'medium.com',
    path: '/@dev/designing-for-calm-3f2a',
    title: 'Designing for calm: why fewer tabs help you think',
    agoMs: 5 * HOUR,
    reason: 'manual',
  },
  {
    host: 'wikipedia.org',
    path: '/wiki/Tab_(interface)',
    title: 'Tab (interface) – Wikipedia',
    agoMs: 26 * HOUR,
    reason: 'manual',
  },
  {
    host: 'npmjs.com',
    path: '/package/preact',
    title: 'preact – npm',
    agoMs: 3 * DAY,
    reason: 'manual',
  },
  {
    host: 'nytimes.com',
    path: '/2026/11/10/technology/browser-tabs.html',
    title: 'The Tab Hoarders of the Internet – The New York Times',
    agoMs: 6 * DAY,
    reason: 'window',
  },
  {
    host: 'figma.com',
    path: '/file/landing-page',
    title: 'Landing page – Figma',
    agoMs: 12 * DAY,
    reason: 'manual',
  },
];

/** The five views, in the order the store lists them (PLAN.md §12.2). */
interface View {
  readonly file: string;
  readonly caption: string;
  readonly detail: string;
  readonly dark: boolean;
}

const VIEWS: Readonly<Record<'declutter' | 'organize' | 'guard' | 'archive' | 'dark', View>> = {
  declutter: {
    file: '1-declutter.png',
    caption: 'Know which tabs to close',
    detail: 'Every suggestion says why, and nothing closes until you decide.',
    dark: false,
  },
  organize: {
    file: '2-organize.png',
    caption: 'Group the rest, in one click',
    detail: 'Native tab groups by site, previewed first and undone in one tap.',
    dark: false,
  },
  guard: {
    file: '3-duplicate-protection.png',
    caption: 'Duplicates stop at the door',
    detail: 'A second copy of a page is closed the moment it opens, unless you whitelist it.',
    dark: false,
  },
  archive: {
    file: '4-archive.png',
    caption: 'Nothing is ever lost',
    detail: 'Every closed tab goes to a searchable archive. Restore it whenever you like.',
    dark: false,
  },
  dark: {
    file: '5-dark-theme.png',
    caption: 'Light and dark, by your system',
    detail: 'Follows the theme of your browser. Everything stays on your device.',
    dark: true,
  },
};

type ViewName = keyof typeof VIEWS;

/** The en catalogue: the labels the script clicks are read from the files the build ships. */
const CATALOGUE = JSON.parse(readFileSync(LOCALES, 'utf8')) as Record<string, { message: string }>;

function label(key: string): string {
  const entry = CATALOGUE[key];
  if (entry === undefined) throw new Error(`No "${key}" in en/messages.json`);
  return entry.message;
}

/** The pages, served from this machine whatever host they are asked under. */
function startServer(): Promise<{ server: Server; port: number }> {
  const titles = new Map<string, string>();
  for (const page of [...SITES, ...CLOSED]) titles.set(page.path, page.title);

  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const title = titles.get(path);
    if (title === undefined) {
      response.writeHead(path === '/favicon.ico' ? 204 : 404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><p>${title}</p></body></html>`,
    );
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the page server did not get a port'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

/** What the script needs of a panel page, whichever driver sits behind it. */
interface Panel {
  evaluate<Result, Arg>(fn: (arg: Arg) => Result | Promise<Result>, arg: Arg): Promise<Result>;
  /** How many rows the Declutter list is expected to have: what this browser's panel can show. */
  readonly suggestions: number;
  /** How far ahead of the real clock the panel's own clock runs. */
  readonly clockShiftMs: number;
  /** A PNG of the panel at `PANEL_WIDTH` × `PANEL_HEIGHT`. */
  capture(): Promise<Buffer>;
  close(): Promise<void>;
}

/** The slice of the extension API the panel page is asked for, inside the browser. */
interface ExtensionApi {
  tabs: {
    query(
      query: Record<string, unknown>,
    ): Promise<{ id?: number; url?: string; windowId?: number }[]>;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
}

/**
 * `browser` on Firefox, `chrome` on Chromium: both are promise-based in MV3. Written out inside
 * each function run in the page, because such a function is sent to the browser as source and
 * cannot call anything declared here.
 */
type ExtensionScope = { browser?: ExtensionApi; chrome?: ExtensionApi };

/** Waits for `fn` to answer true in the page, polling; throws with `what` on a timeout. */
async function waitFor<Arg>(
  panel: Panel,
  what: string,
  fn: (arg: Arg) => boolean | Promise<boolean>,
  arg: Arg,
): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await panel.evaluate(fn, arg)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const seen = await panel.evaluate(() => document.body.innerText.slice(0, 400), null);
  throw new Error(`timed out waiting for ${what}; the panel shows: ${seen}`);
}

/** Clicks the first `selector` element whose accessible text is `text` (any, if `text` is empty). */
async function click(panel: Panel, selector: string, text: string): Promise<void> {
  await waitFor(
    panel,
    `"${text}" (${selector})`,
    (arg: { selector: string; text: string }) => {
      const found = [...document.querySelectorAll<HTMLElement>(arg.selector)].find(
        (element) =>
          arg.text === '' ||
          (element.getAttribute('aria-label') ?? element.textContent ?? '').trim() === arg.text,
      );
      found?.click();
      return found !== undefined;
    },
    { selector, text },
  );
}

/** A short pause for the panel's own transitions to finish before a capture. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1_200));
}

/**
 * Waits until the background has stopped writing `local:activity`, which it holds in memory and
 * writes whole a second after the last tab event: a seed written earlier would be overwritten.
 */
async function trackerQuiet(panel: Panel): Promise<void> {
  let previous = '';
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = await panel.evaluate(async () => {
      const stored = await ((globalThis as unknown as ExtensionScope).browser ??
        (globalThis as unknown as ExtensionScope).chrome)!.storage.local.get('activity');
      return JSON.stringify(stored['activity'] ?? {});
    }, null);
    if (current !== '{}' && current === previous) return;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error('the background never stopped writing local:activity');
}

/** The seeded history and archive, written from the panel and then waited for on screen. */
async function seed(panel: Panel, base: (host: string, path: string) => string): Promise<void> {
  await trackerQuiet(panel);
  const now = Date.now() + panel.clockShiftMs;
  const closed = CLOSED.map((entry, at) => ({
    id: `closed-${String(at)}`,
    url: base(entry.host, entry.path),
    title: entry.title,
    closedAt: now - entry.agoMs,
    reason: entry.reason,
    index: at + 1,
  }));

  await panel.evaluate(
    async (arg: {
      now: number;
      closed: Omit<ArchivedTab, 'windowId'>[];
      sites: readonly Site[];
    }) => {
      const scope = globalThis as unknown as ExtensionScope;
      const extension = (scope.browser ?? scope.chrome) as ExtensionApi;
      const tabs = await extension.tabs.query({});
      const [active] = await extension.tabs.query({ active: true, currentWindow: true });
      const windowId = active?.windowId ?? -1;

      const minute = 60_000;
      const day = 24 * 60 * minute;
      const activity: Record<number, unknown> = {};
      const taken = new Map<string, number>();
      for (const tab of tabs) {
        const url = tab.url ?? '';
        const sites = arg.sites.filter((candidate) => url.endsWith(candidate.path));
        const seen = taken.get(url) ?? 0;
        taken.set(url, seen + 1);
        const site = sites[Math.min(seen, sites.length - 1)];
        const at = arg.now - (site === undefined ? 5 * minute : site.ageDays * day);
        activity[tab.id ?? -1] = {
          tabId: tab.id ?? -1,
          url,
          createdAt: at,
          lastActiveAt: at,
          activations: site?.reads ?? 0,
          foregroundMs: (site?.reads ?? 0) * minute,
        };
      }
      await extension.storage.local.set({
        activity,
        archive: arg.closed.map((entry) => ({ ...entry, windowId })),
      });
    },
    { now, closed, sites: SITES },
  );
}

/** Opens the Chromium session: every page open, the panel in front, the history seeded. */
async function chromiumSession(dark: boolean, port: number, profile: string): Promise<Panel> {
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    locale: 'en',
    colorScheme: dark ? 'dark' : 'light',
    viewport: { width: PANEL_WIDTH, height: PANEL_HEIGHT },
    args: [
      `--disable-extensions-except=${CHROME_DIR}`,
      `--load-extension=${CHROME_DIR}`,
      // Every host name of SITES is this machine, so nothing reaches the network.
      '--host-resolver-rules=MAP * 127.0.0.1',
    ],
  });

  const [existing] = context.serviceWorkers();
  const worker = existing ?? (await context.waitForEvent('serviceworker'));
  await worker.evaluate(() =>
    (
      globalThis as unknown as {
        chrome: { storage: { local: { set(items: Record<string, unknown>): Promise<void> } } };
      }
    ).chrome.storage.local.set({ onboarded: true }),
  );
  const extensionId = new URL(worker.url()).host;

  for (const [at, site] of SITES.entries()) {
    const tab = at === 0 ? context.pages()[0] : await context.newPage();
    await tab?.goto(`http://${site.host}:${String(port)}${site.path}`);
  }

  const page: PlaywrightPage = await context.newPage();
  // Before the document exists: the panel reads its clock once, when it starts. A browser keeps
  // each tab's own `lastAccessed` (now, for tabs just opened) and the score counts it, so the
  // history can only look old to a panel whose clock runs ahead of it. Firefox's panel cannot be
  // given a clock (`evaluateOnNewDocument` does not run on a `moz-extension://` document), which
  // is why its Declutter list shows only the duplicates.
  await page.addInitScript((shift: number) => {
    const real = Date.now;
    Date.now = () => real() + shift;
  }, CLOCK_SHIFT_MS);
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const panel = playwrightPanel(page, () => context.close());
  await seed(panel, (host, path) => `http://${host}:${String(port)}${path}`);
  return panel;
}

function playwrightPanel(page: PlaywrightPage, close: () => Promise<void>): Panel {
  return {
    // The page receives the function as source, so its argument is whatever the caller passed.
    evaluate: <Result, Arg>(fn: (arg: Arg) => Result | Promise<Result>, arg: Arg) =>
      page.evaluate(fn as (arg: unknown) => Result | Promise<Result>, arg as unknown),
    suggestions: 4,
    clockShiftMs: CLOCK_SHIFT_MS,
    capture: () => page.screenshot({ type: 'png' }),
    close,
  };
}

/** Declutter: the list, once the seeded history has reached it. */
async function showDeclutter(panel: Panel): Promise<void> {
  await waitFor(
    panel,
    'the Declutter list',
    (rows: number) => document.querySelectorAll('.td-row').length >= rows,
    panel.suggestions,
  );
  await settle();
}

async function showOrganize(panel: Panel): Promise<void> {
  await click(panel, '.td-nav-item', label('navOrganize'));
  await waitFor(
    panel,
    'the proposed groups',
    () => document.querySelectorAll('.td-group').length >= 3,
    null,
  );
  await settle();
}

async function showArchive(panel: Panel): Promise<void> {
  await click(panel, '.td-nav-item', label('navArchive'));
  await waitFor(panel, 'the archive', () => document.querySelectorAll('.td-row').length >= 5, null);
  await settle();
}

/** The duplicate-protection settings, with a whitelist already typed in and saved. */
async function showGuard(panel: Panel): Promise<void> {
  await click(panel, '.td-guard-chip', '');
  await click(panel, '[role="menuitem"]', label('guardMenuSettings'));
  await waitFor(
    panel,
    'the whitelist editor',
    () => document.querySelector('#td-whitelist') !== null,
    null,
  );
  await panel.evaluate((text: string) => {
    const editor = document.querySelector<HTMLTextAreaElement>('#td-whitelist');
    if (editor === null) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(editor, text);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }, 'https://mail.example.com/*\nhttps://docs.example.com/*');
  await click(panel, 'button', label('whitelistSave'));
  await waitFor(
    panel,
    'the whitelist to be saved',
    () => document.querySelectorAll('.td-pattern-line').length >= 2,
    null,
  );
  // The mode the caption promises, and the whitelist brought into view.
  await panel.evaluate((auto: string) => {
    const select = [...document.querySelectorAll('select')].find((candidate) =>
      [...candidate.options].some((option) => option.text === auto),
    );
    const option =
      select === undefined ? undefined : [...select.options].find((o) => o.text === auto);
    if (select !== undefined && option !== undefined) {
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    document.querySelector('#td-whitelist')?.scrollIntoView({ block: 'center' });
  }, label('guardModeAuto'));
  await waitFor(
    panel,
    'the mode to be on',
    (chip: string) => (document.querySelector('.td-guard-chip')?.textContent ?? '').includes(chip),
    label('guardStateAuto'),
  );
  await settle();
}

/** Escapes what goes into the frame's HTML. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The frame: the caption on the left, the captured panel on the right. */
function frameHtml(view: View, panelPng: Buffer): string {
  const background = view.dark
    ? 'linear-gradient(135deg, #111827, #1f2a44)'
    : 'linear-gradient(135deg, #e8f0fe, #f6f9ff)';
  const ink = view.dark ? '#e8eaed' : '#1f2937';
  const muted = view.dark ? '#aab4c5' : '#4b5563';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; width: ${String(FRAME.width)}px; height: ${String(FRAME.height)}px; }
    body { display: flex; align-items: center; justify-content: center; gap: 96px;
      background: ${background}; color: ${ink};
      font-family: 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif; }
    .text { width: 500px; }
    h1 { font-size: 52px; line-height: 1.1; margin: 0 0 20px; font-weight: 700; }
    p { font-size: 24px; line-height: 1.4; margin: 0; color: ${muted}; }
    .panel { width: ${String(PANEL_WIDTH)}px; height: ${String(PANEL_HEIGHT)}px; border-radius: 14px;
      overflow: hidden; box-shadow: 0 24px 60px rgba(15, 23, 42, 0.35), 0 0 0 1px rgba(15, 23, 42, 0.12); }
    .panel img { display: block; }
  </style></head><body>
    <div class="text"><h1>${escapeHtml(view.caption)}</h1><p>${escapeHtml(view.detail)}</p></div>
    <div class="panel"><img alt="" src="data:image/png;base64,${panelPng.toString('base64')}"></div>
  </body></html>`;
}

/** Composes the frame in a plain Chromium and checks that the file really is 1280×800. */
async function compose(
  composer: PlaywrightBrowser,
  view: View,
  panelPng: Buffer,
  file: string,
): Promise<void> {
  const page = await composer.newPage({ viewport: { ...FRAME }, deviceScaleFactor: 1 });
  await page.setContent(frameHtml(view, panelPng));
  const png = await page.screenshot({ type: 'png' });
  await page.close();

  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== FRAME.width || height !== FRAME.height) {
    throw new Error(`${file} is ${String(width)}×${String(height)}, not 1280×800`);
  }
  writeFileSync(file, png);
}

/** One browser: the light session for four views, the dark one for the fifth. */
async function shoot(
  name: 'chrome',
  open: (dark: boolean) => Promise<Panel>,
  composer: PlaywrightBrowser,
): Promise<void> {
  const directory = join(OUT, name);
  mkdirSync(directory, { recursive: true });

  const steps: readonly [ViewName, (panel: Panel) => Promise<void>][] = [
    ['declutter', showDeclutter],
    ['organize', showOrganize],
    ['archive', showArchive],
    ['guard', showGuard],
  ];

  const light = await open(false);
  try {
    for (const [view, show] of steps) {
      await show(light);
      await compose(
        composer,
        VIEWS[view],
        await light.capture(),
        join(directory, VIEWS[view].file),
      );
      console.log(`${name}: ${VIEWS[view].file}`);
    }
  } finally {
    await light.close();
  }

  const dark = await open(true);
  try {
    await showDeclutter(dark);
    await compose(composer, VIEWS.dark, await dark.capture(), join(directory, VIEWS.dark.file));
    console.log(`${name}: ${VIEWS.dark.file}`);
  } finally {
    await dark.close();
  }
}

async function main(): Promise<void> {
  const { server, port } = await startServer();
  const profiles = mkdtempSync(join(tmpdir(), 'tabdeclutter-shots-'));
  const composer = await chromium.launch({ headless: true });
  try {
    let profileCount = 0;
    await shoot(
      'chrome',
      (dark) => chromiumSession(dark, port, join(profiles, `chrome-${String(profileCount++)}`)),
      composer,
    );
  } finally {
    await composer.close();
    server.close();
    try {
      rmSync(profiles, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      // A profile Windows still holds open is in the temp folder and harmless.
    }
  }
}

main().then(
  () => {
    process.exit(0);
  },
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
