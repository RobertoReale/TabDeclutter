import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { afterAll, beforeAll, expect, test } from 'vitest';

import { siteKey, siteName } from '../../src/core/cluster';
import { clickButton, message, openPanel, openUrls, panelText, until } from './fixtures/panel';
import type { PanelSession } from './fixtures/panel';

/**
 * Organizing by site and undoing it on Firefox (PLAN.md §14's "organize by site + undo",
 * §13's M4 acceptance): that `browser.tabs.group` and `browser.tabGroups.*` really make the
 * group the preview proposed, and that Annulla takes it away again.
 *
 * A smoke test, as §14 asks for Firefox, and the narrow part that could differ between the
 * two browsers: the platform calls. Firefox has had native tab groups since 139 and the
 * manifest asks for 140 (`build/manifest.ts`), so this is not a capability the panel can
 * decline here — a browser without them shows §5.5's empty state instead, and the first
 * assertion below would say so.
 *
 * What the whole of §4.4 does — the inline rename, the colours, the order restored around a
 * pinned tab and a group the user made by hand — is Chromium's test
 * (`tests/e2e/organize.spec.ts`). The clicks go through the document rather than through a
 * pointer, for the reason `clickPanel` gives, and only the `en` catalogue is asserted, for
 * the reason `panel.spec.ts` gives.
 */

/** Three pages of one site: §7.1 groups a site from three tabs up. */
const PATHS = ['/one', '/two', '/three'] as const;

let server: Server;
let urls: string[] = [];
let session: PanelSession;

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (!PATHS.includes(path as (typeof PATHS)[number])) {
      response.writeHead(404).end();
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
  // Pages of this test's own, so nothing reaches the network (invariant 1).
  urls = PATHS.map((path) => `http://127.0.0.1:${String(address.port)}${path}`);

  session = await openPanel({ tabs: urls });
});

afterAll(async () => {
  await session?.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

/** One native group as this test judges it: its name and how many tabs are in it. */
interface NativeGroup {
  title: string;
  tabs: number;
}

/**
 * The groups the browser has, with their sizes, read through the extension APIs — which is
 * the only place the result of an apply can be seen from.
 *
 * The membership is counted off `tabs.query` rather than asked for with a `groupId` filter:
 * the filter is not in the WebExtension types the build uses, and counting is the same
 * answer from data the panel already has permission to read.
 */
async function nativeGroups(): Promise<NativeGroup[]> {
  return session.page.evaluate(async () => {
    const api = browser as unknown as {
      tabGroups?: {
        query(query: Record<string, unknown>): Promise<{ id: number; title?: string }[]>;
      };
    };
    const found = (await api.tabGroups?.query({})) ?? [];
    const tabs = (await browser.tabs.query({})) as unknown as { groupId?: number }[];
    return found.map((group) => ({
      title: group.title ?? '',
      tabs: tabs.filter((tab) => tab.groupId === group.id).length,
    }));
  });
}

/**
 * Picks a value in one of the panel's `<select>`s from inside the document, the way
 * `clickPanel` clicks: the value is set and `change` dispatched, which is the event Preact's
 * `onChange` is listening for.
 */
async function pickOption(selector: string, value: string): Promise<void> {
  // Polled, because the click that brought this view up renders it a tick later: on the
  // first look the `<select>` is simply not in the document yet.
  const picked = await until(
    async () =>
      session.page.evaluate(
        (target: { selector: string; value: string }) => {
          const select = document.querySelector<HTMLSelectElement>(target.selector);
          if (select === null) return false;
          select.value = target.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return select.value === target.value;
        },
        { selector, value },
      ),
    (done) => done,
  );
  if (!picked) throw new Error(`could not pick "${value}" in ${selector}`);
}

/** How many cards the preview is showing. */
async function cards(): Promise<number> {
  return session.page.evaluate(() => document.querySelectorAll('.td-group').length);
}

test('organizing by site creates one native group and Annulla removes it', async () => {
  // Nothing is grouped before the panel is asked to (§4.4: a preview changes nothing).
  expect(await nativeGroups()).toEqual([]);

  await clickButton(session.page, message('en', 'navOrganize'));

  /*
   * "Tutte le finestre" (§4.4.1), because which window Puppeteer puts a new tab in is not
   * this test's to decide (`PanelOptions`): with every window in scope the three pages are
   * one site whatever Firefox did with them.
   */
  // The first of the view's two selects is the scope one (`OrganizeView.tsx`).
  await pickOption('.td-organize .td-filter', 'all');

  // §4.4.3's preview: one card, because one site has three tabs and nothing else has.
  expect(
    await until(
      async () => cards(),
      (count) => count === 1,
    ),
  ).toBe(1);

  const before = await openUrls(session.page);
  await clickButton(session.page, message('en', 'organizeApply'));

  // §4.4.5 on Gecko: a real group, named as §7.1 names a site, with all three tabs in it.
  // Two steps on Gecko, so two things to wait for: `tabs.group` makes the group and
  // `tabGroups.update` names it, and in between it is a real group with an empty title.
  const applied = await until(
    nativeGroups,
    (groups) => groups.length === 1 && groups[0]?.title !== '',
  );
  expect(applied).toEqual([{ title: siteName(siteKey(urls[0] ?? '')), tabs: 3 }]);

  expect(await panelText(session.page, '.td-toast-text')).toContain(
    message('en', 'organizeAppliedOne').replace('$1', '1'),
  );

  await clickButton(session.page, message('en', 'actionUndo'));

  // Undone: no group left, and the tabs in the order they were in (§7.4).
  expect(await until(nativeGroups, (groups) => groups.length === 0)).toEqual([]);
  expect(await openUrls(session.page)).toEqual(before);
  expect(await panelText(session.page, '.td-toast')).toBeNull();
});

test('the extension logged no errors', () => {
  expect(session.errors.take()).toEqual([]);
});
