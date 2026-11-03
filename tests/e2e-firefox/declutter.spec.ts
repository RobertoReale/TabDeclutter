import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { afterAll, beforeAll, expect, test } from 'vitest';

import type { ActivityStore } from '../../src/core/types';
import { declutterState, message, openPanel } from './fixtures/panel';
import type { DeclutterState, PanelSession } from './fixtures/panel';

/**
 * The Declutter list on Firefox (PLAN.md §4.3, §5.1, §14): that the view opens, reads the
 * real `browser.tabs` and `browser.storage`, and draws a section with a row that says why
 * it is there.
 *
 * A smoke test, and deliberately one section. Firefox's panel cannot be given a clock:
 * `evaluateOnNewDocument` does not run on a `moz-extension://` document (see
 * `fixtures/panel.ts`), so the age the panel computes cannot be moved and no suggestion
 * that rests on an idle tab is reachable. A duplicate is: it needs two tabs on one URL and
 * a creation time, and the creation time comes from storage alone. Everything the ages do
 * is Chromium's test (`tests/e2e/declutter.spec.ts`) and the unit tests.
 *
 * Only the `en` catalogue is asserted, for the reason `panel.spec.ts` gives.
 */

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

/** Old enough to clear the two-hour grace period of step 1. */
const HISTORY_MS = 20 * DAY;

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

  session = await openPanel({ tabs: [pageUrl, pageUrl] });
  await trackerQuiet(session);
  await seed(session, pageUrl);
  list = await declutterState(session.page);
});

afterAll(async () => {
  await session?.close();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

/**
 * Waits until the background has stopped writing `local:activity`.
 *
 * It holds the store in memory and writes all of it at once, a second after the last tab
 * event (`src/entrypoints/background/tracker.ts`), so a seed written while it is still
 * flushing would be overwritten by what it remembers. Two identical, non-empty reads a
 * debounce apart mean the last event has landed; after that nothing writes unless a tab
 * is opened, closed or activated, and this test does none of those.
 */
async function trackerQuiet(open: PanelSession): Promise<void> {
  let previous = '';
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = await open.page.evaluate(async () => {
      const stored = await browser.storage.local.get('activity');
      return JSON.stringify(stored['activity'] ?? {});
    });
    if (current !== '{}' && current === previous) return;
    previous = current;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error('the background never stopped writing local:activity');
}

/**
 * The history that makes the two tabs a duplicate pair: both older than the grace period,
 * and one of them older than the other, so the keep rules of §8.4.3 ("Più vecchia") keep
 * one and the other is the single row on the list.
 *
 * Which one is kept is chosen here rather than left to chance. The active tab of a window
 * is protected (§6.4, step 1) and would be dropped from the list, and the test cannot tell
 * Firefox which tab to select (see `PanelOptions`) — so it asks which tab is selected and
 * makes that one the oldest. Selected or not, the kept tab is off the list and the other
 * one is on it: exactly one row, whatever Firefox decided.
 */
async function seed(open: PanelSession, url: string): Promise<void> {
  const { tabs, selected } = await open.page.evaluate(async () => {
    const found = await browser.tabs.query({});
    const active = await browser.tabs.query({ active: true });
    return {
      tabs: found.map((tab) => ({ id: tab.id ?? -1, url: tab.url ?? '' })),
      selected: active.map((tab) => tab.id ?? -1),
    };
  });

  const pair = tabs.filter((tab) => tab.url === url);
  if (pair.length !== 2) {
    throw new Error(`expected two tabs on ${url}, found ${pair.length}`);
  }
  // The selected tab first, so the oldest creation time lands on it.
  const oldestFirst = [...pair].sort(
    (left, right) => Number(selected.includes(right.id)) - Number(selected.includes(left.id)),
  );

  const now = Date.now();
  const activity: ActivityStore = {};
  for (const [at, tab] of oldestFirst.entries()) {
    const created = now - HISTORY_MS + at * HOUR;
    activity[tab.id] = {
      tabId: tab.id,
      url: tab.url,
      createdAt: created,
      lastActiveAt: created,
      activations: 0,
      foregroundMs: 0,
    };
  }

  // The whole key at once, which also drops the bootstrap record `runtime.onInstalled`
  // wrote when the extension was installed a moment ago: it protects every tab for a day.
  await open.page.evaluate(async (next: ActivityStore) => {
    await browser.storage.local.set({ activity: next });
  }, activity);
}

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
