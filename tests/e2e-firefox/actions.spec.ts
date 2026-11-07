import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { afterAll, beforeAll, expect, test } from 'vitest';

import {
  clickButton,
  clickPanel,
  focusPanel,
  message,
  openDuplicatePair,
  openUrls,
  panelText,
  until,
} from './fixtures/panel';
import type { PanelSession } from './fixtures/panel';

/**
 * Closing a tab and taking it back on Firefox (PLAN.md §14's "close + undo", §13's M3
 * acceptance): that picking a row raises §4.3's bar, that the bar's Chiudi really removes
 * the tab through `browser.tabs`, and that the toast's Annulla puts the same page back.
 *
 * A smoke test, as §14 asks for Firefox: the one row comes from a duplicate pair, which is
 * the only suggestion this browser's panel can be made to show (`openDuplicatePair`). What
 * the whole of §4.3 and §9 do — ten tabs across two windows, the two inline confirmations,
 * the keys, the pointer holding the eight seconds — is Chromium's test
 * (`tests/e2e/actions.spec.ts`). What is being asked here is narrower and is the part that
 * could differ: that the platform calls underneath behave the same on Gecko.
 *
 * The clicks go through the document rather than through a pointer, for the reason
 * `clickPanel` gives. Only the `en` catalogue is asserted, for the reason `panel.spec.ts`
 * gives.
 */

const PATH = '/same';

let server: Server;
let pageUrl = '';
let session: PanelSession;

beforeAll(async () => {
  server = createServer((request, response) => {
    if ((request.url ?? '/').split('?')[0] !== PATH) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Same page</title></head><body><p>Same page</p></body></html>',
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
  // A page of this test's own, so nothing reaches the network (invariant 1).
  pageUrl = `http://127.0.0.1:${address.port}${PATH}`;

  session = await openDuplicatePair(pageUrl);
});

afterAll(async () => {
  await session?.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

/** How many of the browser's tabs are on the page this test serves. */
async function onPage(): Promise<number> {
  return (await openUrls(session.page)).filter((url) => url === pageUrl).length;
}

test('a picked row closes from the bar and comes back with Annulla', async () => {
  // The seed's single row, and both tabs still open: the kept one and the one on the list.
  const row = await until(
    async () => panelText(session.page, '.td-row-title'),
    (title) => title !== null,
  );
  expect(row).not.toBeNull();
  expect(await onPage()).toBe(2);

  // A click anywhere on the row picks it, and the selection is what raises §4.3's bar.
  await clickPanel(session.page, '.td-row');
  const bar = await until(
    async () => panelText(session.page, '.td-bar'),
    (text) => text !== null,
  );
  expect(bar).not.toBeNull();

  /*
   * One tab, not the one in use — the seed keeps the selected tab off the list — and the
   * window keeps the kept tab and the panel, so none of §9's three safeguards is in the
   * way and the click closes it.
   */
  await clickButton(session.page, message('en', 'barClose').replace('$1', '1'));
  expect(
    await until(
      async () => onPage(),
      (count) => count === 1,
    ),
  ).toBe(1);

  /*
   * §4.3's toast. The focus goes onto it as soon as it is there, which holds the eight
   * seconds the way the pointer does on Chromium, so the Annulla below is not a race.
   */
  const toast = await until(
    async () => panelText(session.page, '.td-toast-text'),
    (text) => text !== null && text !== '',
  );
  await focusPanel(session.page, '.td-toast');
  expect(toast).toBe(message('en', 'toastClosedOne').replace('$1', '1'));

  await clickButton(session.page, message('en', 'actionUndo'));

  // Back on the same page: invariant 3, with `browser.sessions` or the `tabs.create`
  // fallback doing the work — whichever it is, the tab the user had is the tab they get.
  expect(
    await until(
      async () => onPage(),
      (count) => count === 2,
    ),
  ).toBe(2);
  expect(await panelText(session.page, '.td-toast')).toBeNull();
});

test('the extension logged no errors', () => {
  expect(session.errors.take()).toEqual([]);
});
