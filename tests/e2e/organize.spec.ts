import { createServer } from 'node:http';
import type { Server } from 'node:http';

import type { Page } from '@playwright/test';

import { siteKey, siteName } from '../../src/core/cluster';
import { expect, message, test } from './fixtures/extension';

/**
 * The Organize view in the real browser (PLAN.md §4.4): that the preview is what
 * `core/cluster.ts` proposes, that an edit to it survives into what is applied, that
 * "Applica" produces real native tab groups with the title and the colour the preview
 * showed, and that "Annulla" takes them away again.
 *
 * This is the half the unit tests cannot reach. The edits are pure and are covered in
 * `tests/unit/organize.test.ts`; `chrome.tabs.group` and `chrome.tabGroups.update` are
 * not, and neither is whether Chromium accepts the colour names §7.3 uses.
 *
 * The tabs are two local sites served by this test — `127.0.0.1` and `localhost` on the
 * same port, which the browser treats as two hosts — with three tabs each, because §7.1
 * groups a site only from three tabs up. Nothing reaches the network (invariant 1).
 */

const PATHS = ['/one', '/two', '/three'] as const;

let server: Server;
let port = 0;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (!PATHS.includes(path as (typeof PATHS)[number])) {
      response.writeHead(path === '/favicon.ico' ? 204 : 404).end();
      return;
    }
    const title = `Page ${path.slice(1)}`;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><p>${title}</p></body></html>`,
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
  port = address.port;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

/** The slice of the extension API the panel page is asked for, inside the browser. */
interface GroupsApi {
  tabs: {
    create(properties: { url: string; active: boolean }): Promise<unknown>;
  };
  tabGroups: {
    query(query: Record<string, unknown>): Promise<{ title?: string; color?: string }[]>;
  };
}

/**
 * The six pages, opened from the panel's own tab so they land in the panel's window —
 * which is the "Finestra corrente" the view starts on.
 *
 * `chrome.tabs.create` rather than `context.newPage()`: a Playwright page is a tab of its
 * own in the same window either way, but this keeps the panel focused and the created
 * tabs in the background, so the window the preview reads is the one under test.
 */
async function openSites(panel: Page): Promise<void> {
  const urls = ['127.0.0.1', 'localhost'].flatMap((host) =>
    PATHS.map((path) => `http://${host}:${String(port)}${path}`),
  );

  await panel.evaluate(async (list) => {
    const api = (globalThis as unknown as { chrome: GroupsApi }).chrome;
    for (const url of list) {
      await api.tabs.create({ url, active: false });
    }
  }, urls);
}

/** The native groups, as the browser has them: what "Applica" is judged by. */
async function nativeGroups(panel: Page): Promise<{ title: string; color: string }[]> {
  return panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: GroupsApi }).chrome;
    const groups = await api.tabGroups.query({});
    return groups
      .map((group) => ({ title: group.title ?? '', color: group.color ?? '' }))
      .sort((left, right) => left.title.localeCompare(right.title));
  });
}

/** What the cards show, in the order the preview lists them. */
async function preview(panel: Page): Promise<{ title: string; color: string }[]> {
  return panel.locator('.td-group').evaluateAll((cards) =>
    cards.map((card) => ({
      title: (card.querySelector('.td-group-name') as HTMLInputElement | null)?.value ?? '',
      color: (card.querySelector('.td-group-color') as HTMLSelectElement | null)?.value ?? '',
    })),
  );
}

function byTitle(groups: readonly { title: string; color: string }[]) {
  return [...groups].sort((left, right) => left.title.localeCompare(right.title));
}

test.describe('in English', () => {
  test.use({ uiLanguage: 'en' });

  test('the preview by site is renamed, applied as native groups and undone', async ({ panel }) => {
    await openSites(panel);
    await panel.getByRole('button', { name: message('en', 'navOrganize') }).click();

    // §4.4.3: one card per proposed group, and the two sites are two groups of three.
    await expect(panel.locator('.td-group')).toHaveCount(2);
    await expect(panel.locator('.td-groups .td-group-tab')).toHaveCount(6);

    // The names `core/cluster.ts` gives those two hosts, computed rather than written out:
    // what is under test is that the view shows them, not what §7.1 calls a loopback.
    const proposed = byTitle(await preview(panel));
    expect(proposed.map((group) => group.title)).toEqual(
      [`http://localhost:${String(port)}/one`, `http://127.0.0.1:${String(port)}/one`]
        .map((url) => siteName(siteKey(url)))
        .sort((left, right) => left.localeCompare(right)),
    );

    // §4.4.3's inline rename: typed into the card, not asked for in a dialog.
    const renamed = 'Work pages';
    const first = panel.locator('.td-group').first();
    await first.locator('.td-group-name').fill(renamed);
    await expect(first.locator('.td-group-name')).toHaveValue(renamed);

    // What the preview now promises: the titles as they read and the colours as the
    // swatches show them.
    const expected = byTitle(await preview(panel));
    expect(expected.map((group) => group.title)).toContain(renamed);

    // Nothing has happened to the browser yet: the preview is a proposal (§4.4).
    expect(await nativeGroups(panel)).toEqual([]);

    await panel.getByRole('button', { name: message('en', 'organizeApply') }).click();

    // §4.4.5: real groups, with the title that was typed and the colour that was shown.
    await expect.poll(async () => nativeGroups(panel)).toEqual(expected);

    // The toast says how many were created, and offers to take them back (§4.4.5).
    const toast = panel.locator('.td-toast');
    await expect(toast).toContainText(message('en', 'organizeAppliedOther').replace('$1', '2'));

    await toast.getByRole('button', { name: message('en', 'actionUndo') }).click();

    // Undone means ungrouped: §4.4.5's "Annulla" puts the window back as it was.
    await expect.poll(async () => nativeGroups(panel)).toEqual([]);
    await expect(toast).toHaveCount(0);
  });
});
