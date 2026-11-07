import { createServer } from 'node:http';
import type { Server } from 'node:http';

import type { BrowserContext, Page } from '@playwright/test';

import type { MessageKey } from '../../src/platform/i18n';
import { expect, message, test } from './fixtures/extension';

/**
 * What the panel does to tabs, in the real browser (PLAN.md §4.3, §4.8, §9): picking rows,
 * the sticky bar, the 8 s toast and its Annulla, the two inline confirmations, and the keys
 * that do the same four things without the mouse.
 *
 * The tabs are local pages this test serves itself, so nothing reaches the network
 * (invariant 1). What makes them old is the panel's clock: `src/core/scoring.ts` reads the
 * *later* of the stored `lastActiveAt` and Chrome's own `tab.lastAccessed`, and
 * `lastAccessed` is seconds ago whatever is written to storage — so the panel is opened
 * twelve days in the future and every tab is twelve days idle, which clears the two-hour
 * grace, the one-day bootstrap grace and `staleDays` at once. Nothing is seeded into
 * storage: a tab with no record counts as never read, which is exactly the tab this spec
 * wants.
 *
 * The panel is the window's *first* tab, reused rather than opened: that keeps it the
 * active tab of its window, which is what makes §9's active-tab question reachable through
 * §4.3's window card, and it keeps the panel on screen so every click here is a real click
 * rather than a dispatched event.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How far ahead the panel's clock runs. Mirrors `declutter.spec.ts`. */
const SHIFT_MS = 12 * DAY + HOUR;

/** `DEFAULT_KEEP_MS`: how long "Mantieni" protects a page (PLAN.md §10). */
const KEEP_MS = 7 * DAY;

/** What `Intl` makes of `SHIFT_MS` in English, inside the window card's sentence. */
const AGE_SENTENCE = '12 days';

interface LocalPage {
  readonly path: string;
  readonly title: string;
}

const ALPHA: LocalPage = { path: '/alpha', title: 'Alpha' };
const BETA: LocalPage = { path: '/beta', title: 'Beta' };
const GAMMA: LocalPage = { path: '/gamma', title: 'Gamma' };

const PAGES: readonly LocalPage[] = [ALPHA, BETA, GAMMA];

/** The three pages, one tab each: §4.3's "Aperte e mai lette", three rows. */
const THREE: readonly LocalPage[] = [ALPHA, BETA, GAMMA];

/**
 * One page over and over, to get past §9's `BULK_CONFIRM_LIMIT` of 25.
 *
 * No duplicate guard is wired into the background yet (M3b.2), so all 27 stay open and the
 * duplicates section holds the 26 the keep rules did not choose — one more than the limit.
 */
const MANY = 27;

/**
 * How many tabs §14's undo closes in one go, per window: five here, five next door, and the
 * eleventh page is the second window's anchor.
 */
const SPLIT = 5;
const ANCHOR = 2 * SPLIT;

/**
 * The nth throwaway page. The server titles it after its number, so ten tabs are ten
 * different pages and "the same URL in the same window" is something a test can check.
 */
function numbered(n: number): string {
  return `${base}/n/${String(n)}`;
}

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
    // `/n/<number>`, the throwaway pages of `numbered()`.
    const nth = /^\/n\/(\d+)$/.exec(path);
    if (nth !== null) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html(`Page ${String(nth[1])}`));
      return;
    }
    // Chrome asks for this on its own; "nothing here" keeps the row off the network.
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
    query(
      query: Record<string, unknown>,
    ): Promise<{ id?: number; status?: string; url?: string; windowId?: number }[]>;
    create(properties: Record<string, unknown>): Promise<{ id?: number }>;
  };
  windows: {
    create(properties: Record<string, unknown>): Promise<{ tabs?: { id?: number }[] }>;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
}

/**
 * `sidepanel.html` in the window's first tab, with its clock `SHIFT_MS` ahead.
 *
 * The clock is installed before the document exists: `startPanelState` captures `Date.now`
 * when it is imported, so one installed after the panel has loaded would never be read.
 */
async function openPanel(context: BrowserContext, extensionId: string): Promise<Page> {
  // The window a persistent context opens with already holds one tab. Reusing it leaves
  // the window with no stray `about:blank` — which §6.4 would list as an empty tab — and
  // leaves the panel active.
  const panel = context.pages()[0] ?? (await context.newPage());
  await panel.addInitScript((shift: number) => {
    const real = Date.now;
    Date.now = () => real() + shift;
  }, SHIFT_MS);
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return panel;
}

/**
 * Opens tabs in the panel's own window and waits until every one of them has loaded.
 *
 * Through `chrome.tabs.create` rather than `context.newPage()`: `active: false` keeps the
 * panel in the foreground, which `newPage` would not, and twenty-seven of them cost one
 * round trip each.
 */
async function openTabs(panel: Page, urls: readonly string[]): Promise<void> {
  const ids: number[] = [];
  for (const url of urls) {
    ids.push(
      await panel.evaluate(async (target) => {
        const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
        const tab = await api.tabs.create({ url: target, active: false });
        return tab.id ?? -1;
      }, url),
    );
  }

  await waitLoaded(panel, ids);
}

/** Waits until every one of `ids` has finished loading, so no row is still "about:blank". */
async function waitLoaded(panel: Page, ids: readonly number[]): Promise<void> {
  await expect
    .poll(
      async () =>
        panel.evaluate(async (wanted) => {
          const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
          const tabs = await api.tabs.query({});
          return tabs.filter((tab) => wanted.includes(tab.id ?? -1) && tab.status !== 'complete')
            .length;
        }, ids),
      { timeout: 30_000 },
    )
    .toBe(0);
}

/**
 * A second window on `urls`, so that a close and its undo cross a window boundary.
 *
 * Its first tab is the window's active tab and so protected whatever its age (§8.4): it has
 * no row, it keeps §9's active-tab question out of the way, and it keeps the window from
 * emptying when everything else in it is closed.
 */
async function openWindow(panel: Page, urls: readonly string[]): Promise<void> {
  const ids = await panel.evaluate(async (targets) => {
    const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
    const created = await api.windows.create({ url: targets, focused: false });
    return (created.tabs ?? []).map((tab) => tab.id ?? -1);
  }, urls);

  await waitLoaded(panel, ids);
  // A new window can take the foreground whatever `focused: false` asks for. The panel has
  // to be back on screen, or the clicks below are not the real clicks this spec is for.
  await panel.bringToFront();
}

/** The three pages, and the rows the panel makes of them. */
async function seedThree(panel: Page): Promise<void> {
  await openTabs(
    panel,
    THREE.map((page) => `${base}${page.path}`),
  );
  // All three score the same way, so the tab strip orders them: the list on screen is the
  // seeded one from here on.
  await expect(panel.locator('.td-row-title')).toHaveText(THREE.map((page) => page.title));
}

/** How many tabs the browser has open, the panel's own included. */
async function tabsOpen(panel: Page): Promise<number> {
  return panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
    return (await api.tabs.query({})).length;
  });
}

/**
 * Every tab this spec's server is serving, as `"<url> <windowId>"`, sorted.
 *
 * The pair is the whole point: §14's undo has to put each tab back on its own page *and* in
 * the window it was closed from, and a count of open tabs cannot tell the difference.
 */
async function servedTabs(panel: Page): Promise<string[]> {
  const tabs = await panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
    return (await api.tabs.query({})).map(
      (tab) => `${tab.url ?? ''} ${String(tab.windowId ?? -1)}`,
    );
  });
  return tabs.filter((tab) => tab.startsWith(base)).sort();
}

/** `local:keeps` as it is stored: normalized URL → when the keep runs out, `null` forever. */
async function storedKeeps(panel: Page): Promise<Record<string, number | null>> {
  return panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
    const stored = await api.storage.local.get('keeps');
    return (stored.keeps as Record<string, number | null> | undefined) ?? {};
  });
}

/** The panel's own clock, `SHIFT_MS` ahead of this process's. */
async function panelNow(panel: Page): Promise<number> {
  return panel.evaluate(() => Date.now());
}

/** A row by the page it shows, which is unique wherever this spec uses it. */
function rowFor(panel: Page, title: string) {
  return panel.locator('.td-row').filter({ hasText: title });
}

/** The `data-stop` of whatever has the focus, or `null` if it is not a stop of the list. */
async function focusedStop(panel: Page): Promise<string | null> {
  return panel.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement ? (active.dataset.stop ?? null) : null;
  });
}

/** Tabs forward until the focus is inside the list, the way a keyboard user arrives. */
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

/** A counted noun as `format.ts` builds it. */
function tabsText(count: number): string {
  const key: MessageKey = count === 1 ? 'countTabsOne' : 'countTabsOther';
  return message('en', key).replace('$1', String(count));
}

/** The bar's close button when no window empties: "Close 26". */
function barClose(tabs: number): string {
  return message('en', 'barClose').replace('$1', String(tabs));
}

/** And when one does, which is §9's "Chiudi N schede e la finestra". */
function barCloseWithWindows(tabs: number, windows: number): string {
  const word: MessageKey = windows === 1 ? 'barWindowOne' : 'barWindowOther';
  return message('en', 'barCloseWithWindows')
    .replace('$1', tabsText(tabs))
    .replace('$2', message('en', word));
}

/** §9's question above the bulk limit. */
function confirmClose(tabs: number): string {
  return message('en', 'confirmClose').replace('$1', tabsText(tabs));
}

/** What the toast says it has just done. */
function closedText(tabs: number): string {
  const key: MessageKey = tabs === 1 ? 'toastClosedOne' : 'toastClosedOther';
  return message('en', key).replace('$1', String(tabs));
}

/**
 * Watches for a native dialog, which §9 forbids outright: every confirmation is inline.
 *
 * Playwright dismisses dialogs on its own, so a stray `confirm()` would not hang the test —
 * it would pass unnoticed. Hence the list, asserted empty at the end.
 */
function watchDialogs(panel: Page): string[] {
  const seen: string[] = [];
  panel.on('dialog', (dialog) => {
    seen.push(dialog.message());
    void dialog.dismiss();
  });
  return seen;
}

test.describe('in English', () => {
  test.use({ uiLanguage: 'en' });
  // Real tabs to open and load, twenty-eight of them in one test.
  test.slow();

  test('§4.3: a selection closes together, says so, and comes back with Annulla', async ({
    context,
    extensionId,
  }) => {
    const panel = await openPanel(context, extensionId);
    await seedThree(panel);

    const bar = panel.locator('.td-bar');
    // Nothing picked, no bar: §4.3's strip appears with the selection and goes with it.
    await expect(bar).toHaveCount(0);

    /*
     * The toast's slot, on the other hand, is in the document from the start and stays
     * there: it is the live region, and a region that appears together with its text is
     * announced inconsistently (§4.8).
     */
    const slot = panel.locator('.td-toast-slot');
    await expect(slot).toHaveAttribute('role', 'status');
    await expect(slot).toHaveAttribute('aria-live', 'polite');

    // A click anywhere on a row picks it, and the checkbox is that state made visible.
    const beta = rowFor(panel, BETA.title);
    await beta.click();
    await expect(beta).toHaveClass(/td-row-picked/);
    await expect(beta.locator('.td-row-check')).toBeChecked();

    await rowFor(panel, GAMMA.title).click();
    await expect(panel.locator('.td-row-picked')).toHaveCount(2);

    // Two tabs, neither of them the one in use and well under §9's bulk limit, so the
    // close happens on the click.
    await bar.getByRole('button', { name: barClose(2) }).click();
    await expect(panel.locator('.td-row-title')).toHaveText([ALPHA.title]);
    await expect(bar).toHaveCount(0);
    expect(await tabsOpen(panel)).toBe(2);

    /*
     * §4.3's toast. The pointer goes onto it first, which is what "non scompare mentre il
     * mouse è sopra" means: the 8 s stop running, so nothing asserted below is a race
     * against them.
     */
    const toast = panel.locator('.td-toast');
    await toast.hover();
    await expect(toast.locator('.td-toast-text')).toHaveText(closedText(2), { timeout: 15_000 });
    await expect(toast).toHaveAttribute('tabindex', '0');

    // Annulla takes the batch out of the toast before it restores anything, so the toast
    // goes at once and the same close cannot be undone twice.
    await toast.getByRole('button', { name: message('en', 'actionUndo') }).click();
    await expect(toast).toHaveCount(0);
    await expect.poll(async () => tabsOpen(panel), { timeout: 20_000 }).toBe(4);
  });

  test('§14: ten tabs across two windows go together, and Annulla puts every one back', async ({
    context,
    extensionId,
  }) => {
    const panel = await openPanel(context, extensionId);
    const dialogs = watchDialogs(panel);

    // Five in the panel's window, five in a second one, all on different pages.
    const here = Array.from({ length: SPLIT }, (_, at) => numbered(at));
    const there = Array.from({ length: SPLIT }, (_, at) => numbered(SPLIT + at));
    await openTabs(panel, here);
    await openWindow(panel, [numbered(ANCHOR), ...there]);

    // All ten are old and never read, which is one section: so one "Seleziona tutti" picks
    // exactly the ten under test, and the assertion below says there is nothing else.
    const section = panel.locator('.td-section');
    await expect(section).toHaveCount(1);
    await expect(section.locator('.td-row')).toHaveCount(2 * SPLIT, { timeout: 20_000 });

    const before = await servedTabs(panel);
    expect(before).toHaveLength(2 * SPLIT + 1);

    await section.getByRole('button', { name: message('en', 'sectionSelectAll') }).click();
    await expect(panel.locator('.td-row-picked')).toHaveCount(2 * SPLIT);

    /*
     * Ten is under §9's bulk limit of 25, no tab in use is picked, and neither window
     * empties — the panel holds one open, the anchor the other — so §9 has nothing to ask
     * and the click closes them. That the bar says "Close 10" rather than §9's "and the
     * window" is the assertion that none of the three safeguards is in the way.
     */
    const bar = panel.locator('.td-bar');
    await bar.getByRole('button', { name: barClose(2 * SPLIT) }).click();
    await expect(panel.locator('.td-row')).toHaveCount(0, { timeout: 20_000 });
    await expect.poll(async () => (await servedTabs(panel)).length, { timeout: 20_000 }).toBe(1);

    // The pointer holds the 8 s open, so Annulla below is not a race against them.
    const toast = panel.locator('.td-toast');
    await toast.hover();
    await expect(toast.locator('.td-toast-text')).toHaveText(closedText(2 * SPLIT), {
      timeout: 20_000,
    });

    await toast.getByRole('button', { name: message('en', 'actionUndo') }).click();
    await expect(toast).toHaveCount(0);

    /*
     * §14's undo: not ten tabs again, but the ten that were there — each on its own URL and
     * back in the window it was closed from. `restoreTabs` reaches for `sessions.restore`
     * first and falls back to `tabs.create` with the stored window and index; both windows
     * still exist here, so either path has to land in the right one.
     */
    await expect.poll(async () => servedTabs(panel), { timeout: 30_000 }).toEqual(before);

    expect(dialogs, '§9: every confirmation is inline').toEqual([]);
  });

  test('§14: "Mantieni" takes the row off the list, and the keep running out brings it back', async ({
    context,
    extensionId,
  }) => {
    const panel = await openPanel(context, extensionId);
    await seedThree(panel);

    const open = await tabsOpen(panel);
    const now = await panelNow(panel);

    // The row's own "Mantieni" (§4.3), which is what the `K` of §4.8 does with a key.
    await rowFor(panel, ALPHA.title)
      .getByRole('button', { name: message('en', 'actionKeep') })
      .click();

    // Off the suggestions, still open: a keep is a promise about a page, not an act on a tab.
    await expect(panel.locator('.td-row-title')).toHaveText([BETA.title, GAMMA.title]);
    expect(await tabsOpen(panel)).toBe(open);

    // And written down, so it outlives the panel: one entry, keyed by the normalized URL,
    // running out seven days from now — §10's default, which nothing asked for.
    const keeps = await storedKeeps(panel);
    const [key = '', ...others] = Object.keys(keeps);
    expect(others, 'one keep, for the one row that was kept').toEqual([]);
    expect(key).toContain(ALPHA.path);
    const until = keeps[key] ?? 0;
    expect(until).toBeGreaterThan(now + KEEP_MS - HOUR);
    expect(until).toBeLessThan(now + KEEP_MS + HOUR);

    /*
     * Seven days later. The panel's clock is fixed `SHIFT_MS` ahead and no test can wait a
     * week, so the expiry moves into the past instead — the same moment seen from the keep's
     * side. The panel watches `local:keeps`, which is what makes this a test of the
     * expiry and not of a reload.
     */
    await panel.evaluate(
      async (expired: Record<string, number>) => {
        const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
        await api.storage.local.set({ keeps: expired });
      },
      { [key]: now - HOUR },
    );

    // The suggestion comes back on its own, and the tab was never touched.
    await expect(panel.locator('.td-row-title')).toHaveText(THREE.map((page) => page.title));
    expect(await tabsOpen(panel)).toBe(open);
  });

  test('§9 asks before more than 25 tabs go, inline and never with confirm()', async ({
    context,
    extensionId,
  }) => {
    const panel = await openPanel(context, extensionId);
    const dialogs = watchDialogs(panel);

    await openTabs(
      panel,
      Array.from({ length: MANY }, () => `${base}${ALPHA.path}`),
    );

    // §4.3's first section: all but the one the keep rules of §8.4.3 chose to keep.
    const duplicates = panel.locator('.td-section').first();
    await expect(duplicates.locator('.td-row')).toHaveCount(MANY - 1, { timeout: 15_000 });

    await duplicates.getByRole('button', { name: message('en', 'sectionSelectAll') }).click();
    await expect(duplicates.locator('.td-row-picked')).toHaveCount(MANY - 1);

    const bar = panel.locator('.td-bar');
    await bar.getByRole('button', { name: barClose(MANY - 1) }).click();

    // Twenty-six is one past the limit, so the bar turns into the question itself.
    const question = panel.locator('.td-confirm-text');
    await expect(question).toHaveText(confirmClose(MANY - 1));

    /*
     * The question is read out through the button that answers it, which is also where the
     * focus goes: §9's confirmation can be answered with `Enter` without a hunt for it, and
     * no `aria-live` has to shout over the bar's own counts.
     */
    const confirm = bar.getByRole('button', { name: message('en', 'actionConfirm') });
    await expect(confirm).toBeFocused();
    const describedBy = await confirm.getAttribute('aria-describedby');
    await expect(panel.locator(`#${String(describedBy)}`)).toHaveText(confirmClose(MANY - 1));

    // [Annulla] backs out of the question and leaves the rows it ticked, which is the
    // clearest answer to "which twenty-six?".
    await bar.getByRole('button', { name: message('en', 'actionCancel') }).click();
    await expect(panel.locator('.td-confirm')).toHaveCount(0);
    await expect(bar.getByRole('button', { name: barClose(MANY - 1) })).toHaveCount(1);
    await expect(duplicates.locator('.td-row-picked')).toHaveCount(MANY - 1);
    expect(await tabsOpen(panel)).toBe(MANY + 1);

    // And answering it does close them, with the toast that offers them back.
    await bar.getByRole('button', { name: barClose(MANY - 1) }).click();
    await bar.getByRole('button', { name: message('en', 'actionConfirm') }).click();
    await expect(panel.locator('.td-toast-text')).toHaveText(closedText(MANY - 1), {
      timeout: 20_000,
    });
    await expect.poll(async () => tabsOpen(panel), { timeout: 20_000 }).toBe(2);

    expect(dialogs, '§9: every confirmation is inline').toEqual([]);
  });

  test('§9 asks before the tab in use goes, and says the window goes with it', async ({
    context,
    extensionId,
  }) => {
    const panel = await openPanel(context, extensionId);
    const dialogs = watchDialogs(panel);
    await seedThree(panel);

    /*
     * §4.3's whole-window suggestion. It counts every tab of the window, the panel's own
     * included, and its close is the one close in the panel that takes the tab the user is
     * looking at — which is why it is the path §9's active-tab question is on.
     */
    const card = panel.locator('.td-window-card');
    await expect(card.locator('.td-window-text')).toHaveText(
      message('en', 'windowForgotten')
        .replace('$1', tabsText(THREE.length + 1))
        .replace('$2', AGE_SENTENCE),
    );

    await card.getByRole('button', { name: message('en', 'windowClose') }).click();

    // The active tab's question, not the count's: four tabs is well under the bulk limit,
    // and this is the half of §9 that has to be asked anyway.
    await expect(panel.locator('.td-confirm-text')).toHaveText(message('en', 'confirmCloseActive'));

    const bar = panel.locator('.td-bar');
    await bar.getByRole('button', { name: message('en', 'actionCancel') }).click();

    /*
     * Nothing closed, and the window stayed picked: so the bar now says, in §9's own words,
     * what that selection would do — the tabs, and the window they empty with them. The
     * panel's own tab is part of it and has no row, so three rows are ticked, not four.
     */
    await expect(
      bar.getByRole('button', { name: barCloseWithWindows(THREE.length + 1, 1) }),
    ).toHaveCount(1);
    await expect(panel.locator('.td-row-picked')).toHaveCount(THREE.length);
    expect(await tabsOpen(panel)).toBe(THREE.length + 1);

    // §4.8's `Escape`: the question first, and with none left, the selection.
    await panel.keyboard.press('Escape');
    await expect(bar).toHaveCount(0);
    await expect(panel.locator('.td-row-picked')).toHaveCount(0);

    expect(dialogs, '§9: every confirmation is inline').toEqual([]);
  });

  test('§4.8: Ctrl+A and Space pick, Del closes, Ctrl+Z undoes', async ({
    context,
    extensionId,
  }) => {
    const panel = await openPanel(context, extensionId);
    await seedThree(panel);

    const bar = panel.locator('.td-bar');
    // Tab reaches the list at its first stop, which is the section header.
    const header = await tabIntoList(panel);
    expect(header).toBe('section:stale-unread');

    // `Ctrl+A` is the header's own "Seleziona tutti", and the section the keyboard is in
    // rather than the document the browser would have selected.
    await panel.keyboard.press('Control+a');
    await expect(panel.locator('.td-row-picked')).toHaveCount(THREE.length);
    await expect(bar.getByRole('button', { name: barClose(THREE.length) })).toHaveCount(1);

    // `Escape` with no question to answer drops the selection.
    await panel.keyboard.press('Escape');
    await expect(bar).toHaveCount(0);
    await expect(panel.locator('.td-row-picked')).toHaveCount(0);

    // One ↓ onto the first row, where `Space` picks exactly that row.
    const row = await arrowDown(panel, 1);
    expect(row).not.toBeNull();
    await panel.keyboard.press(' ');
    await expect(panel.locator(`[data-stop="${String(row)}"]`)).toHaveClass(/td-row-picked/);
    await expect(bar.getByRole('button', { name: barClose(1) })).toHaveCount(1);

    // `Del` closes what is picked — one tab, and not the one in use, so §9 lets it go.
    await panel.keyboard.press('Delete');
    await expect(panel.locator('.td-row-title')).toHaveText([BETA.title, GAMMA.title]);
    await expect(bar).toHaveCount(0);
    expect(await tabsOpen(panel)).toBe(THREE.length);

    // The pointer holds the toast open, so the `Ctrl+Z` below is not a race against the 8 s.
    const toast = panel.locator('.td-toast');
    await toast.hover();
    await expect(toast.locator('.td-toast-text')).toHaveText(closedText(1), { timeout: 15_000 });

    // `Ctrl+Z` is on the document, so it answers from wherever the focus is — here, nowhere
    // in particular, because the row that had it has just been closed.
    await panel.keyboard.press('Control+z');
    await expect(toast).toHaveCount(0);
    await expect.poll(async () => tabsOpen(panel), { timeout: 20_000 }).toBe(THREE.length + 1);
  });

  test('§4.8: K keeps the row the keyboard is on, without closing it', async ({
    context,
    extensionId,
  }) => {
    const panel = await openPanel(context, extensionId);
    await seedThree(panel);

    expect(await tabIntoList(panel)).toBe('section:stale-unread');
    expect(await arrowDown(panel, 1)).toBe(
      await rowFor(panel, ALPHA.title).getAttribute('data-stop'),
    );

    await panel.keyboard.press('k');

    // A keep protects the page for seven days (§10), so the row leaves the list — and the
    // tab is still open, which is the whole difference between "Mantieni" and "Chiudi".
    await expect(panel.locator('.td-row-title')).toHaveText([BETA.title, GAMMA.title]);
    expect(await tabsOpen(panel)).toBe(THREE.length + 1);
  });
});
