import { createServer } from 'node:http';
import type { Server } from 'node:http';

import type { BrowserContext, Page } from '@playwright/test';

import type { ActivityStore } from '../../src/core/types';
import type { MessageKey } from '../../src/platform/i18n';
import { expect, message, test } from './fixtures/extension';

/**
 * The Declutter list in the real browser (PLAN.md §4.2, §4.3, §5.5, §6.4): that the
 * sections appear in the order the spec gives them, that every row says why it is there,
 * that a section with nothing to close starts folded, and that "Vai" really activates the
 * tab it belongs to.
 *
 * The tabs are local pages this test serves itself, so nothing reaches the network
 * (invariant 1) and the titles are known. What makes them old is the panel's clock, not
 * the records: `src/core/scoring.ts` reads the *later* of the stored `lastActiveAt` and
 * Chrome's own `tab.lastAccessed`, and `lastAccessed` is a few seconds ago whatever is
 * written to storage. So the panel is opened twelve days in the future, and every tab is
 * twelve days idle. The seeded records carry what only storage knows: when the tab was
 * created, and how often it was read.
 *
 * The ages ("12 days", "12d ago") are written out rather than imported from `format.ts`:
 * what is checked here is what Chromium's own ICU renders, which is the half the unit
 * tests cannot see. Everything that is ours comes from the shipped catalogue.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How far the panel's clock runs ahead: past `staleDays` (7), past the two-hour grace
 * period and past the one-day bootstrap grace, and an hour clear of both 12 and 13 days
 * so the expected strings do not depend on how long the test takes to get there.
 */
const SHIFT_MS = 12 * DAY + HOUR;

/** What `Intl` makes of `SHIFT_MS` in English: inside a sentence, and on a chip. */
const AGE_SENTENCE = '12 days';
const AGE_CHIP = '12d ago';

/**
 * How long ago the seeded records say the tabs were created: enough to clear the two-hour
 * grace period on its own, so the tabs are scored even before the clock is moved.
 */
const HISTORY_MS = 20 * DAY;

interface LocalPage {
  readonly path: string;
  readonly title: string;
}

const ALPHA: LocalPage = { path: '/alpha', title: 'Alpha' };
/** `/login` is `auth` by its path alone (`src/core/rules.ts`), whatever its title. */
const LOGIN: LocalPage = { path: '/login', title: 'Sign in' };
const BETA: LocalPage = { path: '/beta', title: 'Beta' };
const GAMMA: LocalPage = { path: '/gamma', title: 'Gamma' };

const PAGES: readonly LocalPage[] = [ALPHA, LOGIN, BETA, GAMMA];

/** The tabs, in the order they are opened, which is the order of the tab strip. */
const STRIP: readonly (LocalPage | null)[] = [
  // Two tabs on one page: the duplicate of §4.3's first section.
  ALPHA,
  ALPHA,
  LOGIN,
  // An empty tab, left exactly as the browser opened it: §6.4's "empty and inactive".
  null,
  BETA,
  GAMMA,
];

let server: Server;
let base = '';

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const page = PAGES.find((candidate) => candidate.path === path);
    if (page !== undefined) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html(page.title));
      return;
    }
    // Chrome asks for this on its own. Answered with "nothing here" so the tab keeps no
    // `favIconUrl` and the row goes through Chrome's favicon cache (PLAN.md §5.5).
    response.writeHead(path === '/favicon.ico' ? 204 : 404).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server did not get a port');
  }
  base = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

function html(title: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><p>${title}</p></body></html>`;
}

/** The slice of the extension API the panel page is asked for, inside the browser. */
interface SeedApi {
  tabs: {
    query(query: Record<string, unknown>): Promise<{ id?: number; url?: string }[]>;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
}

/** A tab as the extension sees it. */
interface SeedTab {
  readonly id: number;
  readonly url: string;
}

/**
 * The open tabs, in the browser's order.
 *
 * Asked of the panel page rather than derived from `context.pages()`, because the ids the
 * records are keyed by are the browser's and `about:blank` is a tab like any other.
 */
async function openTabs(panel: Page): Promise<readonly SeedTab[]> {
  return panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
    const tabs = await api.tabs.query({});
    return tabs.map((tab) => ({ id: tab.id ?? -1, url: tab.url ?? '' }));
  });
}

async function storedActivity(panel: Page): Promise<ActivityStore> {
  return panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
    const stored = await api.storage.local.get('activity');
    return (stored.activity ?? {}) as ActivityStore;
  });
}

/**
 * Waits until the background has stopped writing.
 *
 * `src/entrypoints/background/tracker.ts` holds the store in memory, debounces its writes
 * by a second and writes the whole store at once, so a seed written while it is still
 * flushing would be thrown away. Two identical, non-empty reads a debounce apart mean the
 * last tab event has landed.
 */
async function trackerQuiet(panel: Page): Promise<void> {
  let previous = '';
  await expect
    .poll(
      async () => {
        const current = JSON.stringify(await storedActivity(panel));
        const quiet = current !== '{}' && current === previous;
        previous = current;
        return quiet;
      },
      { intervals: Array.from({ length: 8 }, () => 1_500), timeout: 15_000 },
    )
    .toBe(true);
}

/**
 * The history the score reads (PLAN.md §6.1), as the background would have recorded it.
 *
 * Every tab was created `HISTORY_MS` ago and none was ever in the foreground — except
 * `/gamma`, which was read five times: that is the one tab with no "low engagement"
 * points, so it is the only one the score is merely unsure about, and its section is the
 * one that starts folded.
 *
 * The first of the two `/alpha` tabs is made the older one, so the keep rules of §8.4.3
 * ("Più vecchia") always choose the same survivor and the duplicate is always the second.
 */
function historyFor(tabs: readonly SeedTab[]): ActivityStore {
  const now = Date.now();
  const activity: ActivityStore = {};
  let alphas = 0;

  for (const tab of tabs) {
    const read = tab.url.endsWith(GAMMA.path);
    const older = tab.url.endsWith(ALPHA.path) && alphas++ === 0;
    const at = now - HISTORY_MS - (older ? HOUR : 0);
    activity[tab.id] = {
      tabId: tab.id,
      url: tab.url,
      createdAt: at,
      lastActiveAt: at,
      activations: read ? 5 : 0,
      foregroundMs: read ? MINUTE : 0,
    };
  }
  return activity;
}

interface Seeded {
  /** `sidepanel.html`, open in a tab, with its clock `SHIFT_MS` ahead. */
  readonly panel: Page;
  readonly tabs: readonly SeedTab[];
}

/** The six tabs of `STRIP`, the panel, and the history that makes them old. */
async function seed(context: BrowserContext, extensionId: string): Promise<Seeded> {
  for (const [at, page] of STRIP.entries()) {
    // The window the persistent context opens with already holds the first tab.
    const existing = at === 0 ? context.pages()[0] : undefined;
    const tab = existing ?? (await context.newPage());
    if (page !== null) await tab.goto(`${base}${page.path}`);
  }

  const panel = await context.newPage();
  // Before the document exists: `startPanelState` captures `Date.now` when it is imported,
  // so a clock installed after the panel has loaded would never be read.
  await panel.addInitScript((shift: number) => {
    const real = Date.now;
    Date.now = () => real() + shift;
  }, SHIFT_MS);
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  await trackerQuiet(panel);

  const tabs = await openTabs(panel);
  await panel.evaluate(async (activity) => {
    const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
    await api.storage.local.set({ activity });
  }, historyFor(tabs));

  /*
   * Nothing is old until that write lands: the panel renders the tracker's own records
   * first, and the seeded history reaches it as a `storage.onChanged`. A test that read
   * the list straight away would read the one before the seed, and a test that walked it
   * with the keyboard would have the rows shift under the walk. §4.3's folded section is
   * what the seeded history produces and the records on their own never do, so its
   * appearance is the signal that the list on screen is the seeded one.
   */
  await expect(panel.locator('.td-section-toggle[aria-expanded="false"]')).toHaveCount(1);

  return { panel, tabs };
}

/** A section by its place in the list, which is the order §4.3 fixes. */
function sectionAt(panel: Page, at: number) {
  return panel.locator('.td-section').nth(at);
}

/** The `data-stop` of whatever has the focus, or `null` if it is not a stop of the list. */
async function focusedStop(panel: Page): Promise<string | null> {
  return panel.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement ? (active.dataset.stop ?? null) : null;
  });
}

/**
 * Tabs forward until the focus is inside the list, the way a keyboard user arrives: the
 * gear, the three views, and then the list — which is one tab stop, whatever it holds
 * (§4.8's roving tabindex).
 */
async function tabIntoList(panel: Page): Promise<string | null> {
  for (let press = 0; press < 12; press++) {
    await panel.keyboard.press('Tab');
    const stop = await focusedStop(panel);
    if (stop !== null) return stop;
  }
  throw new Error('Tab never reached the Declutter list');
}

/** Where ↓ lands, pressed `times` over. */
async function arrowDown(panel: Page, times: number): Promise<string | null> {
  for (let press = 0; press < times; press++) await panel.keyboard.press('ArrowDown');
  return focusedStop(panel);
}

/** Every stop of the list, in the order the document has them, which is the order ↓ walks. */
async function stopsInDocument(panel: Page): Promise<string[]> {
  return panel.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-stop]')].map(
      (stop) => stop.dataset.stop ?? '',
    ),
  );
}

/**
 * ↓ from the top of the list until `id` has the focus.
 *
 * The number of presses is read off the document rather than counted out here: how many
 * rows a section ends up with depends on the score, and a page that was slow to load
 * leaves a blank tab that adds one.
 */
async function arrowDownTo(panel: Page, id: string): Promise<string | null> {
  const at = (await stopsInDocument(panel)).indexOf(id);
  if (at < 0) throw new Error(`no stop ${id} in the list`);
  return arrowDown(panel, at);
}

/** Every stop currently holding `tabindex="0"`, which §4.8 says is exactly one. */
async function tabStops(panel: Page): Promise<string[]> {
  return panel.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-stop][tabindex="0"]')].map(
      (stop) => stop.dataset.stop ?? '',
    ),
  );
}

/** A heading as the panel builds it: "Duplicates (1)". */
function heading(name: MessageKey, count: number): string {
  return message('en', 'sectionHeading')
    .replace('$1', message('en', name))
    .replace('$2', String(count));
}

/** A counted noun as `format.ts` builds it, for the window card. */
function tabsText(count: number): string {
  const key: MessageKey = count === 1 ? 'countTabsOne' : 'countTabsOther';
  return message('en', key).replace('$1', String(count));
}

test.describe('in English', () => {
  test.use({ uiLanguage: 'en' });
  // Seven real tabs and a second of the tracker's debounce to wait out, twice.
  test.slow();

  test('the sections of §4.3 appear in order, each row saying why', async ({
    context,
    extensionId,
  }) => {
    const { panel, tabs } = await seed(context, extensionId);

    // Four of the five: nothing here scores between 40 and 70 without a stale reason, so
    // "Da valutare" has no rows and is not in the list at all.
    await expect(panel.locator('.td-section-name')).toHaveText([
      heading('sectionDuplicates', 1),
      heading('sectionTransient', 2),
      heading('sectionStaleUnread', 2),
      heading('sectionStale', 1),
    ]);

    // The duplicate: 95 points, and the only thing worth saying about it.
    const duplicates = sectionAt(panel, 0);
    await expect(duplicates.locator('.td-row-title')).toHaveText([ALPHA.title]);
    await expect(duplicates.locator('.td-row-host')).toHaveText(['127.0.0.1']);
    await expect(duplicates.locator('.td-row-reason')).toHaveText([
      message('en', 'reasonDuplicate'),
    ]);
    await expect(duplicates.locator('.td-chip')).toHaveText([AGE_CHIP]);
    // §5.5: a real page's icon comes from Chrome's own cache, never from the network.
    await expect(duplicates.locator('img.td-favicon')).toHaveAttribute(
      'src',
      new RegExp(`^chrome-extension://${extensionId}/_favicon/`),
    );

    // The transient pages, by score: the sign-in page (100) before the empty tab (90).
    const transient = sectionAt(panel, 1);
    await expect(transient.locator('.td-row-reason')).toHaveText([
      message('en', 'reasonAuth'),
      message('en', 'reasonBlank'),
    ]);
    await expect(transient.locator('.td-row').first().locator('.td-chip')).toHaveText([
      AGE_CHIP,
      message('en', 'chipOpenedNever'),
    ]);
    // The empty tab is named by Chrome, so the row is identified by its reason above and
    // only its icon is checked here: no host, no initial, §5.5's plain coloured square.
    await expect(transient.locator('.td-row').nth(1).locator('.td-favicon')).toHaveClass(
      /td-avatar/,
    );

    // Old and never read: 80 each, so the tab strip breaks the tie.
    const unread = sectionAt(panel, 2);
    const unreadReason = message('en', 'reasonStaleUnread').replace('$1', AGE_SENTENCE);
    await expect(unread.locator('.td-row-title')).toHaveText([ALPHA.title, BETA.title]);
    await expect(unread.locator('.td-row-reason')).toHaveText([unreadReason, unreadReason]);
    // The sentence already carries the age, so the row does not repeat it as a chip.
    await expect(unread.locator('.td-row').first().locator('.td-chip')).toHaveText([
      message('en', 'chipOpenedNever'),
    ]);

    // §4.3's folded section: the one tab the score is only inviting a look at (65).
    const inactive = sectionAt(panel, 3);
    await expect(inactive.locator('.td-section-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(inactive.locator('.td-row')).toHaveCount(0);

    await inactive.locator('.td-section-toggle').click();
    await expect(inactive.locator('.td-section-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(inactive.locator('.td-row-title')).toHaveText([GAMMA.title]);
    await expect(inactive.locator('.td-row-reason')).toHaveText([
      message('en', 'reasonStale').replace('$1', AGE_SENTENCE),
    ]);
    await expect(inactive.locator('.td-chip')).toHaveCount(0);

    // The health bar of §4.2: every tab but the panel's own, which step 1 protects.
    await expect(panel.locator('.td-health-text')).toHaveText(
      message('en', 'healthReview').replace('$1', String(tabs.length - 1)),
    );

    // Every tab of the window is older than `staleDays` and some of them are to close,
    // which is what §4.3 offers a whole window for.
    await expect(panel.locator('.td-window-card')).toHaveText(
      message('en', 'windowForgotten')
        .replace('$1', tabsText(tabs.length))
        .replace('$2', AGE_SENTENCE),
    );
  });

  test('the list is a grid the keyboard walks from end to end (§4.8)', async ({
    context,
    extensionId,
  }) => {
    const { panel } = await seed(context, extensionId);

    // The roles M2.3 chose, in the DOM (docs/DECISIONS.md): one grid, named by a string
    // only a screen reader hears, a rowgroup per section, and every row a single cell.
    const grid = panel.getByRole('grid', { name: message('en', 'declutterList') });
    await expect(grid).toHaveCount(1);

    // What the list holds is the previous test's subject; here the shape is read off the
    // document, so what is checked is the relation between the roles and the stops rather
    // than a composition this test would only be repeating.
    const sections = await panel.locator('.td-section').count();
    expect(sections).toBeGreaterThan(1);
    await expect(grid.locator('> [role="rowgroup"]')).toHaveCount(sections);
    // The fold is on the header row itself, which is why the header is a row and not a
    // button: it is one of the places ↑/↓ stop.
    await expect(panel.locator('[role="rowgroup"] > [role="row"][aria-expanded]')).toHaveCount(
      sections,
    );

    // Every row is a stop and carries exactly one cell: the section headers and the rows
    // of the open sections, and nothing else.
    const inDocument = await stopsInDocument(panel);
    expect(inDocument.length).toBeGreaterThan(sections);
    await expect(panel.getByRole('row')).toHaveCount(inDocument.length);
    await expect(panel.getByRole('gridcell')).toHaveCount(inDocument.length);

    // The counts are the polite live regions §4.8 asks for: the header's and the bar's.
    await expect(panel.locator('.td-counts')).toHaveAttribute('aria-live', 'polite');
    await expect(panel.locator('.td-health-text')).toHaveAttribute('aria-live', 'polite');

    // Whatever the list holds, it is one tab stop, before the keyboard has touched it.
    expect(await tabStops(panel)).toEqual([inDocument[0]]);

    // Tab arrives at the top of the list, and ↓ walks every stop in turn, crossing from a
    // section's last row into the next section's header without a second Tab.
    expect(await tabIntoList(panel)).toBe(inDocument[0]);
    const walked: (string | null)[] = [inDocument[0] ?? null];
    for (let step = 1; step < inDocument.length; step++) {
      walked.push(await arrowDown(panel, 1));
    }
    expect(walked).toEqual(inDocument);

    // The tab stop followed the focus, and the far end does not wrap round to the top.
    const last = inDocument[inDocument.length - 1];
    expect(await tabStops(panel)).toEqual([last]);
    expect(await arrowDown(panel, 1)).toBe(last);

    // §4.8's visible focus ring, as Chromium computes it for the focused row.
    const ring = await panel.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return null;
      const style = getComputedStyle(active);
      return { style: style.outlineStyle, width: style.outlineWidth };
    });
    expect(ring).toEqual({ style: 'solid', width: '2px' });

    // And Tab leaves the list rather than walking its rows one by one: the row's own
    // button is out of the tab order, because `Enter` on the row already activates it.
    await panel.keyboard.press('Tab');
    expect(await focusedStop(panel)).toBeNull();
  });

  /*
   * Last, and on its own: activating a tab is a `tabs.onActivated` the background answers
   * by rewriting `local:activity` from its own memory, which undoes the seed a second
   * later. Nothing else can be asserted after it.
   */
  test('"Vai" activates the tab of the row it belongs to', async ({ context, extensionId }) => {
    const { panel, tabs } = await seed(context, extensionId);

    const beta = tabs.find((tab) => tab.url.endsWith(BETA.path));
    if (beta === undefined) throw new Error(`no ${BETA.path} tab among the open tabs`);

    // By title: the two `/alpha` rows show the same page, `/beta` is one tab only.
    const row = panel.locator('.td-row').filter({ hasText: BETA.title });
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { name: message('en', 'actionGo') }).click();

    await expect
      .poll(async () =>
        panel.evaluate(async () => {
          const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
          const [active] = await api.tabs.query({ active: true, currentWindow: true });
          return active?.id;
        }),
      )
      .toBe(beta.id);
  });

  /* Last for the same reason: it ends by activating a tab. */
  test('the keyboard alone folds a section and goes to a tab with Enter (§4.8)', async ({
    context,
    extensionId,
  }) => {
    const { panel } = await seed(context, extensionId);

    // §4.3's folded section is the one place in the list the keyboard has something to
    // open. Which stop it is comes from the document: how many rows stand above it is the
    // first test's subject, and counting them out again here would only make this test
    // fail when that composition changes.
    const folded = String(
      await panel.locator('[role="row"][aria-expanded="false"]').getAttribute('data-stop'),
    );
    const inactive = panel.locator('.td-section').filter({
      // By its stop, which the fold does not change, so the section is still this one
      // once `Enter` has opened it.
      has: panel.locator(`[data-stop="${folded}"]`),
    });
    const toggle = inactive.locator('.td-section-toggle');

    const stops = await stopsInDocument(panel);
    expect(await tabIntoList(panel)).toBe(stops[0]);
    expect(await arrowDownTo(panel, folded)).toBe(folded);

    // `Enter` on a header opens it, and `Enter` again closes it, without the focus moving.
    await panel.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(inactive.locator('.td-row')).toHaveCount(1);
    expect(await focusedStop(panel)).toBe(folded);

    await panel.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(inactive.locator('.td-row')).toHaveCount(0);
    expect(await focusedStop(panel)).toBe(folded);

    // Open again, step onto the row it reveals, and go to the tab that row stands for:
    // which tab that is, the row itself says, in the id its stop is named by.
    await panel.keyboard.press('Enter');
    const row = inactive.locator('.td-row').first();
    await expect(row).toHaveText(new RegExp(GAMMA.title));
    const stop = await row.getAttribute('data-stop');
    // One step: the rows of a section follow its header immediately.
    expect(await arrowDown(panel, 1)).toBe(stop);

    await panel.keyboard.press('Enter');
    await expect
      .poll(async () =>
        panel.evaluate(async () => {
          const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
          const [active] = await api.tabs.query({ active: true, currentWindow: true });
          return `row:${String(active?.id)}`;
        }),
      )
      .toBe(stop);
  });
});
