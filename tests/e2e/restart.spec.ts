import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

import { extensionIdOf, launchExtension, message } from './fixtures/extension';
import { createRecorder } from './fixtures/recorder';

/**
 * That a closed tab is still recoverable after the browser has been shut down and started
 * again (PLAN.md §4.5, §13's M3 acceptance, invariant 3).
 *
 * Every other spec gets its browser from the `context` fixture, which is one context per
 * test. A restart is two contexts on one profile, so this one launches them itself with
 * `launchExtension` and does by hand the two things the `health` fixture would have done —
 * with the same recorder attached to both, so the checks cover the restart as well.
 *
 * What makes the test mean anything is that nothing is seeded: the entry is written by a
 * real close, through the panel, in the first browser, and read back in the second one from
 * `storage.local` alone — no service worker, no window and no tab of the first run survives
 * it. The restore afterwards therefore cannot be `sessions.restore` into the original
 * window: that window is gone, which is exactly the fallback §9 keeps for the case.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How far ahead the first panel's clock runs, so both tabs look idle. See `actions.spec.ts`. */
const SHIFT_MS = 12 * DAY + HOUR;

interface LocalPage {
  readonly path: string;
  readonly title: string;
}

const REPORT: LocalPage = { path: '/report', title: 'Quarterly report' };
const NOTES: LocalPage = { path: '/notes', title: 'Notes' };

const PAGES: readonly LocalPage[] = [REPORT, NOTES];

let server: Server;
let base = '';

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const page = PAGES.find((candidate) => candidate.path === path);
    if (page !== undefined) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${page.title}</title></head><body><p>${page.title}</p></body></html>`,
      );
      return;
    }
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

/** The slice of the extension API this spec asks the panel page for. */
interface SeedApi {
  tabs: {
    query(
      query: Record<string, unknown>,
    ): Promise<{ id?: number; status?: string; url?: string }[]>;
    create(properties: Record<string, unknown>): Promise<{ id?: number }>;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
    };
  };
}

/**
 * `sidepanel.html` in the window's first tab, optionally `shiftMs` into the future.
 *
 * The shift has to be installed before the document exists, because `startPanelState`
 * captures `Date.now` when it is imported. The second run does not need it: the archive is
 * read from storage whatever the clock says.
 */
async function openPanel(context: BrowserContext, extensionId: string, shiftMs = 0): Promise<Page> {
  const panel = context.pages()[0] ?? (await context.newPage());
  if (shiftMs !== 0) {
    await panel.addInitScript((shift: number) => {
      const real = Date.now;
      Date.now = () => real() + shift;
    }, shiftMs);
  }
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return panel;
}

/** Opens `urls` in the panel's window, in the background, and waits for them to load. */
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

/** What `local:archive` holds, as URLs: the store itself, not the view's reading of it. */
async function storedArchive(panel: Page): Promise<string[]> {
  return panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
    const stored = await api.storage.local.get('archive');
    const entries = (stored.archive as { url?: string }[] | undefined) ?? [];
    return entries.map((entry) => entry.url ?? '');
  });
}

/** What the open tabs are on, which is how a restore is seen from outside the panel. */
async function openUrls(panel: Page): Promise<string[]> {
  return panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
    return (await api.tabs.query({})).map((tab) => tab.url ?? '');
  });
}

/** A row by the page it shows. */
function rowFor(panel: Page, title: string) {
  return panel.locator('.td-row').filter({ hasText: title });
}

test('a closed tab is still in the archive after the browser restarts, and restores', async ({
  headless,
  colorScheme,
}, testInfo) => {
  // Two real browser launches, which the 30 s default cannot cover.
  test.slow();

  const profile = testInfo.outputPath('profile');
  const launch = { uiLanguage: 'en' as const, headless, colorScheme };
  // One recorder for both runs: a console error while the second browser boots is as much a
  // failure as one in the first, and neither has a fixture watching for it.
  const recorder = createRecorder();

  const first = await launchExtension(profile, launch);
  recorder.attach(first);
  const extensionId = await extensionIdOf(first);

  try {
    const panel = await openPanel(first, extensionId, SHIFT_MS);
    await openTabs(panel, [`${base}${REPORT.path}`, `${base}${NOTES.path}`]);
    await expect(panel.locator('.td-row-title')).toHaveText([REPORT.title, NOTES.title], {
      timeout: 20_000,
    });

    // One tab, closed by hand from its own row: a real close, which is the only thing that
    // writes the archive (invariant 3).
    await rowFor(panel, REPORT.title)
      .getByRole('button', { name: message('en', 'actionClose') })
      .click();
    await expect(panel.locator('.td-row-title')).toHaveText([NOTES.title]);

    // On disk before the browser goes, or the restart below would prove nothing.
    await expect
      .poll(async () => storedArchive(panel), { timeout: 20_000 })
      .toEqual([`${base}${REPORT.path}`]);
  } finally {
    await first.close();
  }

  // The same profile, started again: that is what a restart is. An unpacked extension's id
  // comes from the directory it was loaded from, so the id above still names this one — and
  // asserting it is also what keeps the request check below pointed at the right origin.
  const second = await launchExtension(profile, launch);
  recorder.attach(second);

  try {
    expect(await extensionIdOf(second)).toBe(extensionId);

    const panel = await openPanel(second, extensionId);
    await panel.getByRole('button', { name: message('en', 'navArchive') }).click();

    // §4.5's list, rebuilt from `storage.local` alone.
    await expect(panel.locator('.td-row-title')).toHaveText([REPORT.title], { timeout: 20_000 });
    await expect(panel.locator('.td-row-reason')).toHaveText(message('en', 'archiveReasonManual'));

    // And still restorable. The window it was closed from no longer exists, so this is the
    // `tabs.create` fallback rather than `sessions.restore` putting the tab back.
    await rowFor(panel, REPORT.title)
      .getByRole('button', { name: message('en', 'actionRestore') })
      .click();
    await expect
      .poll(async () => openUrls(panel), { timeout: 20_000 })
      .toContain(`${base}${REPORT.path}`);

    // Restored means no longer closed: §4.5's list is what is still gone.
    await expect(panel.getByRole('main')).toHaveText(message('en', 'archiveEmpty'));
    await expect.poll(async () => storedArchive(panel), { timeout: 20_000 }).toEqual([]);

    // What the `health` fixture does for every other spec, over both runs at once.
    expect(recorder.takeConsoleErrors(), 'the extension logged errors').toEqual([]);
    expect(
      recorder.takeForeignRequests(extensionId),
      'invariant 1: an extension context made a request outside its own origin',
    ).toEqual([]);
  } finally {
    await second.close();
  }
});
