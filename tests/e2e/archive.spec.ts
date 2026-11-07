import { createServer } from 'node:http';
import type { Server } from 'node:http';

import type { Page } from '@playwright/test';

import type { ArchivedTab } from '../../src/core/types';
import { expect, message, test } from './fixtures/extension';

/**
 * The Archive view in the real browser (PLAN.md §4.5): that the search and the two filters
 * narrow the list the way `core/archive.ts` says they do, that "Ripristina" really brings
 * a tab back — one row, and several at once from the selection bar — and that "Svuota
 * archivio" asks before it empties and never through `confirm()`.
 *
 * The archive is seeded into `storage.local` rather than produced by closing tabs: what is
 * under test is the view, and a seed is the only way to have an entry ten days old without
 * waiting ten days. The URLs are local pages this test serves itself, so a restore opens a
 * real page and nothing reaches the network (invariant 1).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How old the one "Più vecchie" entry is. Ten days, not eight: the filter counts calendar
 * days, so ten is beyond the last seven whatever time of day the test runs at.
 */
const OLD_MS = 10 * DAY;

/** What `Intl` makes of `OLD_MS` on a row, in English, in the narrow style §4.5 uses. */
const OLD_AGE = '10d ago';

interface LocalPage {
  readonly path: string;
  readonly title: string;
}

const REPORT: LocalPage = { path: '/report', title: 'Quarterly report' };
const SHOPPING: LocalPage = { path: '/shopping', title: 'Shopping list' };
const GUARD: LocalPage = { path: '/guard', title: 'Quarterly report copy' };

const PAGES: readonly LocalPage[] = [REPORT, SHOPPING, GUARD];

let server: Server;
let base = '';

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const page = PAGES.find((candidate) => candidate.path === path);
    if (page === undefined) {
      response.writeHead(path === '/favicon.ico' ? 204 : 404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${page.title}</title></head><body><p>${page.title}</p></body></html>`,
    );
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

/** The slice of the extension API the panel page is asked for, inside the browser. */
interface SeedApi {
  tabs: {
    query(
      query: Record<string, unknown>,
    ): Promise<{ id?: number; url?: string; active?: boolean; windowId?: number }[]>;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
}

/**
 * The three entries of the seed, in the order the archive stores them: newest first, as
 * `addToArchive` writes them.
 *
 * One closed by hand just now, one closed by the duplicate guard just now, and one closed
 * with a whole window ten days ago — so that every filter of §4.5 has something to keep
 * and something to leave out, and so that "Oggi" and "Più vecchie" are decided by the
 * seed rather than by the hour the suite happens to run at.
 */
function seedEntries(windowId: number, now: number): ArchivedTab[] {
  return [
    {
      id: 'entry-report',
      url: `${base}${REPORT.path}`,
      title: REPORT.title,
      closedAt: now,
      reason: 'manual',
      windowId,
      index: 1,
    },
    {
      id: 'entry-guard',
      url: `${base}${GUARD.path}`,
      title: GUARD.title,
      closedAt: now,
      reason: 'duplicate-auto',
      windowId,
      index: 2,
    },
    {
      id: 'entry-shopping',
      url: `${base}${SHOPPING.path}`,
      title: SHOPPING.title,
      closedAt: now - OLD_MS,
      reason: 'window',
      windowId,
      index: 3,
    },
  ];
}

/**
 * Writes the archive as the background would have, before the view is opened.
 *
 * The window id is the browser's own, so a restore goes back to the window the tab was
 * closed from and not through §9's fallback.
 */
async function seed(panel: Page): Promise<void> {
  const windowId = await panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    return tab?.windowId ?? -1;
  });

  await panel.evaluate(
    async (archive) => {
      const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
      await api.storage.local.set({ archive });
    },
    seedEntries(windowId, Date.now()),
  );
}

/** The seeded archive, with the view open on it. */
async function archive(panel: Page): Promise<void> {
  await seed(panel);
  await panel.getByRole('button', { name: message('en', 'navArchive') }).click();
  await expect(panel.locator('.td-row')).toHaveCount(3);
}

/** How many entries `local:archive` holds, read from the store itself. */
async function storedCount(panel: Page): Promise<number> {
  return panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
    const stored = await api.storage.local.get('archive');
    return (stored.archive as unknown[] | undefined)?.length ?? 0;
  });
}

/** What the open tabs are on, which is how a restore is seen from outside the panel. */
async function openUrls(panel: Page): Promise<string[]> {
  return panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
    const tabs = await api.tabs.query({});
    return tabs.map((tab) => tab.url ?? '');
  });
}

/**
 * A row by the title it shows, matched whole: one of the seeded titles contains another,
 * and a substring match would resolve to two rows.
 */
function row(panel: Page, title: string) {
  return panel.locator('.td-row').filter({ has: panel.getByText(title, { exact: true }) });
}

/** A counted label such as "Restore 2", as the bar builds it. */
function counted(key: 'barRestore' | 'archiveConfirmEmpty', count: number): string {
  return message('en', key).replace('$1', String(count));
}

test.describe('in English', () => {
  test.use({ uiLanguage: 'en' });

  test('every closed tab is listed, and the search and the filters narrow it', async ({
    panel,
  }) => {
    await archive(panel);

    // §4.5's list: the title, the domain, why it was closed and when, newest first.
    await expect(panel.locator('.td-row-title')).toHaveText([
      REPORT.title,
      GUARD.title,
      SHOPPING.title,
    ]);
    await expect(panel.locator('.td-row-host')).toHaveText(['127.0.0.1', '127.0.0.1', '127.0.0.1']);
    await expect(panel.locator('.td-row-reason')).toHaveText([
      message('en', 'archiveReasonManual'),
      message('en', 'archiveReasonDuplicateAuto'),
      message('en', 'archiveReasonWindow'),
    ]);
    // Chromium's own ICU, which is the half the unit tests cannot see.
    await expect(row(panel, SHOPPING.title).locator('.td-row-when')).toHaveText(OLD_AGE);

    // The search covers the title and the address (§4.5): "shopping" is in both here, and
    // "guard" is in the address alone.
    const search = panel.getByRole('searchbox', { name: message('en', 'archiveSearch') });
    await search.fill('shopping');
    await expect(panel.locator('.td-row-title')).toHaveText([SHOPPING.title]);

    await search.fill('guard');
    await expect(panel.locator('.td-row-title')).toHaveText([GUARD.title]);

    // A search that matches nothing says so, rather than looking like an empty archive.
    await search.fill('nothing here matches');
    await expect(panel.locator('.td-row')).toHaveCount(0);
    await expect(panel.locator('.td-empty')).toHaveText(message('en', 'archiveNoMatch'));

    await search.fill('');
    await expect(panel.locator('.td-row')).toHaveCount(3);

    // The date filter, with the four choices §4.5 offers.
    const when = panel.getByLabel(message('en', 'archiveWhen'));
    await expect(when.locator('option')).toHaveText([
      message('en', 'archiveWhenAny'),
      message('en', 'archiveWhenToday'),
      message('en', 'archiveWhenWeek'),
      message('en', 'archiveWhenOlder'),
    ]);

    await when.selectOption('today');
    await expect(panel.locator('.td-row-title')).toHaveText([REPORT.title, GUARD.title]);

    await when.selectOption('older');
    await expect(panel.locator('.td-row-title')).toHaveText([SHOPPING.title]);

    await when.selectOption('any');

    // The origin filter: only what the duplicate guard closed on its own is "Duplicati
    // chiusi automaticamente", and a tab the user closed with its window is still theirs.
    const origin = panel.getByLabel(message('en', 'archiveOrigin'));
    await origin.selectOption('duplicates');
    await expect(panel.locator('.td-row-title')).toHaveText([GUARD.title]);

    await origin.selectOption('mine');
    await expect(panel.locator('.td-row-title')).toHaveText([REPORT.title, SHOPPING.title]);

    // The search and the filters narrow together, not one instead of the other.
    await search.fill('report');
    await expect(panel.locator('.td-row-title')).toHaveText([REPORT.title]);
  });

  test('"Ripristina" brings a row back, and the bar brings back everything ticked', async ({
    panel,
  }) => {
    await archive(panel);
    const before = (await openUrls(panel)).length;

    // One row, by its own button.
    await row(panel, REPORT.title)
      .getByRole('button', { name: message('en', 'actionRestore') })
      .click();

    // The tab is open again, in the background: a restore must not walk the user through
    // the pages it brings back (PLAN.md §9).
    await expect
      .poll(async () =>
        panel.evaluate(async () => {
          const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
          const tabs = await api.tabs.query({});
          return tabs.map((tab) => `${tab.url ?? ''} ${String(tab.active)}`);
        }),
      )
      .toContain(`${base}${REPORT.path} false`);

    // And it has left the archive: §4.5's list is what is still closed.
    await expect(panel.locator('.td-row-title')).toHaveText([GUARD.title, SHOPPING.title]);

    // The two that are left, together, through §4.5's multiple restore.
    await panel.getByRole('button', { name: message('en', 'sectionSelectAll') }).click();
    await expect(panel.locator('.td-row-check:checked')).toHaveCount(2);
    const bar = panel.getByRole('group', { name: message('en', 'barLabel') });
    await bar.getByRole('button', { name: counted('barRestore', 2) }).click();

    await expect
      .poll(async () => (await openUrls(panel)).filter((url) => url.startsWith(base)).sort())
      .toEqual([`${base}${GUARD.path}`, `${base}${REPORT.path}`, `${base}${SHOPPING.path}`]);
    expect((await openUrls(panel)).length).toBe(before + 3);

    // Nothing is left closed, so §4.5's tools go with the list they filtered.
    await expect(panel.getByRole('main')).toHaveText(message('en', 'archiveEmpty'));
    await expect.poll(async () => storedCount(panel)).toBe(0);
  });

  test('"Svuota archivio" asks inline before it empties (§9)', async ({ panel }) => {
    await archive(panel);
    const empty = panel.getByRole('button', { name: message('en', 'archiveEmptyAll') });

    await empty.click();

    // Inline, in the strip the button was in, and never a `confirm()`: the question is
    // part of the document, and it says how many entries the answer covers.
    const confirm = panel.locator('.td-confirm');
    await expect(confirm.locator('.td-confirm-text')).toHaveText(counted('archiveConfirmEmpty', 3));
    // Nothing else of the strip is pressable while it is open.
    await expect(empty).toHaveCount(0);
    // The question has the focus, so `Enter` answers it and a screen reader reads it out.
    await expect(
      confirm.getByRole('button', { name: message('en', 'actionConfirm') }),
    ).toBeFocused();

    // "Annulla" leaves the archive exactly as it was.
    await confirm.getByRole('button', { name: message('en', 'actionCancel') }).click();
    await expect(panel.locator('.td-row')).toHaveCount(3);
    await expect(empty).toBeVisible();

    await empty.click();
    await confirm.getByRole('button', { name: message('en', 'actionConfirm') }).click();

    await expect(panel.getByRole('main')).toHaveText(message('en', 'archiveEmpty'));
    // Emptied for good, not only on screen: what the view shows is what is stored.
    await expect.poll(async () => storedCount(panel)).toBe(0);
  });
});
