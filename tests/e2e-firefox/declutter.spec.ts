import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { afterAll, beforeAll, expect, test } from 'vitest';

import { declutterState, message, openDuplicatePair } from './fixtures/panel';
import type { DeclutterState, PanelSession } from './fixtures/panel';

/**
 * The Declutter list on Firefox (PLAN.md §4.3, §5.1, §14): that the view opens, reads the
 * real `browser.tabs` and `browser.storage`, and draws a section with a row that says why
 * it is there.
 *
 * A smoke test, and deliberately one section: a duplicate pair is the only suggestion
 * Firefox's panel can be made to show, for the reason `openDuplicatePair` gives. Everything
 * the ages do is Chromium's test (`tests/e2e/declutter.spec.ts`) and the unit tests.
 *
 * Only the `en` catalogue is asserted, for the reason `panel.spec.ts` gives.
 */

const PATH = '/same';

let server: Server;
let pageUrl = '';
let session: PanelSession;
let list: DeclutterState;

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
  list = await declutterState(session.page);
});

afterAll(async () => {
  await session?.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

test('the view shows the section the scores put the tab in', () => {
  expect(list.sections).toEqual([
    message('en', 'sectionHeading')
      .replace('$1', message('en', 'sectionDuplicates'))
      .replace('$2', '1'),
  ]);
});

test('the row says why it is on the list', () => {
  expect(list.reasons).toEqual([message('en', 'reasonDuplicate')]);
});

test('the extension logged no errors', () => {
  expect(session.errors.take()).toEqual([]);
});
