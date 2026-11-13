import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { afterAll, beforeAll, expect, test } from 'vitest';

import { openPanel, until } from './fixtures/panel';
import type { PanelSession } from './fixtures/panel';

/**
 * The duplicate protection on Firefox (PLAN.md §8, §14's "duplicate guard" smoke): that
 * the guard really closes a second tab on the same URL on Gecko, and that the rule which
 * must never fire — §8.6's auth pages — does not fire there either.
 *
 * A smoke test, as §14 asks for Firefox. Every acceptance point of §8 is Chromium's test
 * (`tests/e2e/guard.spec.ts`); what is asked here is the part that could differ, because
 * Firefox is where the guard's inputs differ: `tabs.onCreated` carries no URL, openers are
 * reported differently (PLAN.md §5.5), and the background is an event page that has to be
 * woken up for every tab the user opens. The login flow is here in full rather than as a
 * smoke, because TASKS.md §M3b.5 asks for it on both browsers: a login cut in half is the
 * one failure of this feature a person cannot undo.
 *
 * The mode is written to `local:settings`, which is exactly what the chip's menu does
 * (§5.2 forbids the panel to message the background); everything else is the browser
 * doing it, through `browser.tabs`.
 */

interface LocalPage {
  readonly path: string;
  readonly title: string;
}

/** The page the smoke test opens twice. */
const PAGE: LocalPage = { path: '/page', title: 'Page' };
/** A page of its own for the control that says the guard was still on. */
const CONTROL: LocalPage = { path: '/control', title: 'Control' };
/** The two pages a login flow starts and ends on, one per flow. */
const DASHBOARD_ONE: LocalPage = { path: '/app/one', title: 'Dashboard one' };
const DASHBOARD_TWO: LocalPage = { path: '/app/two', title: 'Dashboard two' };

/**
 * The identity provider's two pages and the site's callback.
 *
 * All three are `auth` by their path alone (`src/core/classify.ts`): `-sso-`, `-login-`,
 * `-oauth2-` and `-callback-` are tokens of `AUTH_PATH_TOKENS`. The hosts of `AUTH_HOSTS`
 * cannot be used here — nothing local answers for `accounts.google.com`, and invariant 1
 * forbids reaching the real one.
 */
const LOGIN_PATH = '/sso/login';
const AUTHORIZE_PATH = '/oauth2/authorize';
const CALLBACK_PATH = '/auth/callback';

const PAGES: readonly LocalPage[] = [
  PAGE,
  CONTROL,
  DASHBOARD_ONE,
  DASHBOARD_TWO,
  { path: LOGIN_PATH, title: 'Sign in' },
];

let server: Server;
let providerServer: Server | null = null;
let session: PanelSession;
/** The site: `http://127.0.0.1:<port>`. */
let base = '';
/** The identity provider: the same server on `localhost`, which is another host entirely. */
let provider = '';

function html(title: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><p>${title}</p></body></html>`;
}

/** The provider's login page, with the page to come back to. */
function loginUrl(back: LocalPage): string {
  return `${provider}${LOGIN_PATH}?next=${encodeURIComponent(`${base}${back.path}`)}`;
}

/** The step after it: two redirects, ending on `back`. */
function authorizeUrl(back: LocalPage): string {
  return `${provider}${AUTHORIZE_PATH}?next=${encodeURIComponent(`${base}${back.path}`)}`;
}

beforeAll(async () => {
  const serve = (request: IncomingMessage, response: ServerResponse): void => {
    const url = new URL(request.url ?? '/', base === '' ? 'http://127.0.0.1' : base);
    const path = url.pathname;

    // The provider's second step, and the site's callback: the redirect chain a login is
    // made of (PLAN.md §8.6, "Redirect/auth").
    if (path === AUTHORIZE_PATH) {
      const next = url.searchParams.get('next') ?? base;
      response
        .writeHead(302, {
          location: `${base}${CALLBACK_PATH}?code=abc123&next=${encodeURIComponent(next)}`,
        })
        .end();
      return;
    }
    if (path === CALLBACK_PATH) {
      response.writeHead(302, { location: url.searchParams.get('next') ?? base }).end();
      return;
    }

    const page = PAGES.find((candidate) => candidate.path === path);
    if (page !== undefined) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html(page.title));
      return;
    }

    // The browser asks for this on its own; "nothing here" keeps the tab off the network.
    response.writeHead(path === '/favicon.ico' ? 204 : 404).end();
  };

  server = createServer(serve);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server did not get a port');
  }
  // Pages of this test's own, so nothing reaches the network (invariant 1).
  base = `http://127.0.0.1:${address.port}`;
  provider = `http://localhost:${address.port}`;

  /*
   * `localhost` is the same machine but not the same address: the browser may resolve it
   * to `::1`, which the socket above is not listening on. A second socket on the IPv6
   * loopback, same handler, same port — and if this machine has no IPv6 at all, the
   * browser has only `127.0.0.1` to resolve it to anyway.
   */
  const sibling = createServer(serve);
  await new Promise<void>((resolve) => {
    sibling.once('error', () => resolve());
    sibling.listen(address.port, '::1', () => {
      providerServer = sibling;
      resolve();
    });
  });

  session = await openPanel();
  await setGuard({ mode: 'auto' });
});

afterAll(async () => {
  await session?.close();
  for (const open of [server, providerServer]) {
    if (open === null) continue;
    await new Promise<void>((resolve, reject) => {
      open.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
});

/**
 * Changes the guard's settings the way the chip's menu does: a read-modify-write of
 * `local:settings`. The wait is for the background's `storage.onChanged`, which is what
 * drops its cached settings; a tab opened before it lands would get the mode from before.
 */
async function setGuard(patch: Record<string, unknown>): Promise<void> {
  await session.page.evaluate(async (change: Record<string, unknown>) => {
    const stored = await browser.storage.local.get('settings');
    const settings = (stored['settings'] as Record<string, unknown> | undefined) ?? {};
    const guard = (settings['guard'] as Record<string, unknown> | undefined) ?? {};
    await browser.storage.local.set({ settings: { ...settings, guard: { ...guard, ...change } } });
  }, patch);
  await new Promise((resolve) => setTimeout(resolve, 500));
}

/** The browser's tabs, with the ids a close can be told apart by. */
async function tabRows(): Promise<{ id: number; url: string }[]> {
  return session.page.evaluate(async () => {
    const found = await browser.tabs.query({});
    return found.map((tab) => ({ id: tab.id ?? -1, url: tab.url ?? '' }));
  });
}

/** The ids of the tabs on one URL, oldest first. */
async function tabsOn(url: string): Promise<number[]> {
  return (await tabRows()).filter((tab) => tab.url === url).map((tab) => tab.id);
}

/** Which of these tabs the browser still has, in the order they were asked about. */
async function aliveIds(ids: readonly number[]): Promise<number[]> {
  const open = new Set((await tabRows()).map((tab) => tab.id));
  return ids.filter((id) => open.has(id));
}

/** The URL of one tab, or `null` once it is gone. */
async function urlOf(id: number): Promise<string | null> {
  return (await tabRows()).find((tab) => tab.id === id)?.url ?? null;
}

/**
 * Opens a tab in the background and waits until the browser says it is on `url`.
 *
 * In the background because the panel is a privileged document Gecko will not bring back
 * to the front (`PanelOptions`), and the tab that is in front is the one every following
 * `evaluate` would have to fight for.
 */
async function openTab(url: string): Promise<number> {
  const id = await session.page.evaluate(async (target: string) => {
    const tab = await browser.tabs.create({ url: target, active: false });
    return tab.id ?? -1;
  }, url);
  await until(
    async () => urlOf(id),
    (current) => current === url || current === null,
  );
  return id;
}

/** Sends a tab to another page, the way a click on a link would. */
async function goTo(id: number, url: string): Promise<void> {
  await session.page.evaluate(
    async (tabId: number, target: string) => {
      await browser.tabs.update(tabId, { url: target });
    },
    id,
    url,
  );
}

test('§8.2: the second tab on a URL is closed, and the first one stays', async () => {
  const url = `${base}${PAGE.path}`;
  const first = await openTab(url);
  const second = await openTab(url);
  expect(second, 'the second tab was never opened').not.toBe(first);

  /*
   * One tab left, and it is the one that was already there: §8.4.3's "Più vecchia" on
   * Gecko, where `onCreated` carries no URL and the decision rests on the `onUpdated`
   * that follows it.
   */
  const left = await until(
    async () => tabsOn(url),
    (ids) => ids.length === 1,
  );
  expect(left).toEqual([first]);
});

test('§8.6: a login flow in one tab is never interrupted', async () => {
  /*
   * The site, the identity provider's login, the step that redirects through the site's
   * callback, and back where it started. `localhost` and `127.0.0.1` are two hosts to the
   * browser and to `duplicateKey`, so this really does leave the site and come back.
   */
  const home = `${base}${DASHBOARD_ONE.path}`;
  const tab = await openTab(home);

  await goTo(tab, loginUrl(DASHBOARD_ONE));
  expect(
    await until(
      async () => urlOf(tab),
      (url) => url === loginUrl(DASHBOARD_ONE),
    ),
    'the tab never reached the login page',
  ).toBe(loginUrl(DASHBOARD_ONE));

  await goTo(tab, authorizeUrl(DASHBOARD_ONE));
  expect(
    await until(
      async () => urlOf(tab),
      (url) => url === home,
    ),
    'the login did not come back to the page it started from',
  ).toBe(home);
});

test('§8.6: the login page open twice keeps both tabs, and a plain duplicate still goes', async () => {
  /*
   * The two tabs are on the very same URL, so without §8.6's rule for auth pages one of
   * them would be the duplicate the guard closes — and the user would end up logged in in
   * a tab they are not looking at, or nowhere at all.
   */
  const login = loginUrl(DASHBOARD_TWO);
  const waiting = await openTab(login);
  const acting = await openTab(login);
  expect(acting, 'the second login tab was never opened').not.toBe(waiting);

  const home = `${base}${DASHBOARD_TWO.path}`;
  await goTo(acting, authorizeUrl(DASHBOARD_TWO));
  expect(
    await until(
      async () => urlOf(acting),
      (url) => url === home,
    ),
    'the login did not come back to the site',
  ).toBe(home);

  expect(await aliveIds([waiting, acting]), 'a tab was closed during a login').toEqual([
    waiting,
    acting,
  ]);
  expect(await urlOf(waiting), 'the other login tab was sent somewhere').toBe(login);

  // The protection was on the whole time: a duplicate with no login in it is closed.
  const control = `${base}${CONTROL.path}`;
  const kept = await openTab(control);
  await openTab(control);
  expect(
    await until(
      async () => tabsOn(control),
      (ids) => ids.length === 1,
    ),
    'the guard was not on at all',
  ).toEqual([kept]);
});

test('the extension logged no errors', () => {
  expect(session.errors.take()).toEqual([]);
});
