import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import type { BrowserContext, Page } from '@playwright/test';

import type { MessageKey } from '../../src/platform/i18n';
import { expect, message, test } from './fixtures/extension';

/**
 * The duplicate protection at work in the real browser (PLAN.md §8, §14): every
 * acceptance point of the feature, driven through the browser's own tab API and the
 * panel's own whitelist editor, against pages this test serves itself.
 *
 * What the unit tests cannot see is here: that `tabs.onCreated` and `tabs.onUpdated`
 * really do carry what `resolveDuplicate` reads off them (an opener, an index, a URL the
 * tab does not have yet), that Chrome's own "Duplicate tab" looks different from a
 * Ctrl+click on a link, and that the whole chain — event, decision, `tabs.remove`,
 * `tabs.move`, `tabs.update` — fits in the 300 ms §14 asks for.
 *
 * Three things are driven from `storage` rather than from a gesture, and each for a
 * reason a test cannot get around:
 *
 * - **the mode**, because §5.2 forbids the panel to message the background: writing
 *   `local:settings` is exactly what the chip's menu does, and `guard-ui.spec.ts` checks
 *   that the menu writes it;
 * - **the settings** of §8.3 (scope, keep rule, after-action), the same way;
 * - **the pause**, because it is only ever started by a keyboard command or the icon's
 *   context menu, neither of which a test can fire. The deadline in `storage.session` is
 *   the whole of a pause (`pauseGuard`), and `tests/ext/` covers the gestures that set it.
 *
 * Everything else is the browser doing it: tabs opened with `tabs.create`, a real
 * Ctrl+click on a real link, `tabs.duplicate` for Chrome's own copy, and the panel's
 * rows, bar, toast and whitelist editor clicked as a person would.
 */

/** §14: "the second opening closes in under 300 ms". */
const LATENCY_BUDGET_MS = 300;

/**
 * How long "nothing happened" waits before it counts as nothing.
 *
 * Five times the budget above, and twenty times the 50 ms §8.2 aims at: long enough that
 * a guard which was merely slow would be caught by the assertion rather than passed by it.
 */
const QUIET_MS = 1_500;

/** §8.6: Chrome's own duplicate has to survive "at least ten seconds". */
const SURVIVE_MS = 10_000;

/** How long a pause lasts here. Long enough to open a tab inside it and look twice. */
const PAUSE_MS = 3_000;

/** §8.4.2: "twenty tabs opened at once leave one". */
const AT_ONCE = 20;

/**
 * How far ahead the panel's clock runs for the one test that needs the panel's own rows.
 *
 * Mirrors `actions.spec.ts` and `declutter.spec.ts`: a tab opened a moment ago is inside
 * §6's two-hour grace and gets no row, and no test can wait two hours.
 */
const SHIFT_MS = 12 * 24 * 60 * 60 * 1_000 + 60 * 60 * 1_000;

interface LocalPage {
  readonly path: string;
  readonly title: string;
}

/** The page every duplicate in this spec is a duplicate of. */
const PAGE: LocalPage = { path: '/page', title: 'Page' };
/** A second page, for the assertions that need a set of their own. */
const OTHER: LocalPage = { path: '/other', title: 'Other' };
/** A third, whitelisted by nothing: the control that says the guard was on. */
const THIRD: LocalPage = { path: '/third', title: 'Third' };
/** The home page of §8.6's "Duplicate tab". */
const HOME: LocalPage = { path: '/', title: 'Home' };
/** And its deep page, visited with the long query string below. */
const DEEP: LocalPage = { path: '/deep', title: 'Deep' };
/** A page holding a link to `PAGE`, for the Ctrl+click of §8.4.4. */
const LINK: LocalPage = { path: '/link', title: 'Link' };

/** The two pages a login flow starts and ends on, one per flow. */
const DASHBOARD_ONE: LocalPage = { path: '/app/one', title: 'Dashboard one' };
const DASHBOARD_TWO: LocalPage = { path: '/app/two', title: 'Dashboard two' };

/**
 * The identity provider's two pages and the site's callback.
 *
 * All three are `auth` by their path alone (`src/core/classify.ts`): `-sso-`, `-login-`,
 * `-oauth2-` and `-callback-` are tokens of `AUTH_PATH_TOKENS`. The hosts of
 * `AUTH_HOSTS` cannot be used here — nothing local answers for `accounts.google.com`,
 * and invariant 1 forbids reaching the real one.
 */
const LOGIN_PATH = '/sso/login';
const AUTHORIZE_PATH = '/oauth2/authorize';
const CALLBACK_PATH = '/auth/callback';

const PAGES: readonly LocalPage[] = [
  PAGE,
  OTHER,
  THIRD,
  HOME,
  DEEP,
  LINK,
  DASHBOARD_ONE,
  DASHBOARD_TWO,
  { path: LOGIN_PATH, title: 'Sign in' },
];

/**
 * The deep page's query string: long, and none of it is a tracking parameter, so the two
 * tabs of §8.6's duplicate share a key the normalizer did not have to work for.
 */
const LONG_QUERY = `q=${encodeURIComponent('duplicate protection, every acceptance point')}&page=7&sort=relevance&facets=a,b,c,d,e&session=0123456789abcdef0123456789abcdef`;

let server: Server;
let providerServer: Server | null = null;
/** The site: `http://127.0.0.1:<port>`. */
let base = '';
/** The identity provider: the same server on `localhost`, which is another host entirely. */
let provider = '';

function html(title: string, body = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><p>${title}</p>${body}</body></html>`;
}

/** The provider's login page, with the page to come back to. */
function loginUrl(back: LocalPage): string {
  return `${provider}${LOGIN_PATH}?next=${encodeURIComponent(`${base}${back.path}`)}`;
}

/** The step after it: two redirects, ending on `back`. */
function authorizeUrl(back: LocalPage): string {
  return `${provider}${AUTHORIZE_PATH}?next=${encodeURIComponent(`${base}${back.path}`)}`;
}

test.beforeAll(async () => {
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
      // The link page carries the link Ctrl+click needs; it is relative, so it points at
      // the host the page was served from.
      const body =
        page === LINK
          ? `<a id="dup" href="${PAGE.path}">${PAGE.title}</a>`
          : page === DASHBOARD_ONE || page === DASHBOARD_TWO
            ? `<a id="signin" href="${LOGIN_PATH}">Sign in</a>`
            : '';
      response.end(html(page.title, body));
      return;
    }

    // Chrome asks for this on its own; "nothing here" keeps the tab off the network.
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
});

test.afterAll(async () => {
  for (const open of [server, providerServer]) {
    if (open === null) continue;
    await new Promise<void>((resolve, reject) => {
      open.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
});

/** A tab as the extension API hands it over. */
interface RawTab {
  id?: number;
  url?: string;
  pendingUrl?: string;
  index?: number;
  active?: boolean;
  windowId?: number;
  status?: string;
}

/** The slice of the extension API this spec drives the browser through. */
interface GuardApi {
  tabs: {
    query(query: Record<string, unknown>): Promise<RawTab[]>;
    get(tabId: number): Promise<RawTab>;
    create(properties: Record<string, unknown>): Promise<RawTab>;
    update(tabId: number, properties: Record<string, unknown>): Promise<RawTab>;
    duplicate(tabId: number): Promise<RawTab | undefined>;
    onCreated: {
      addListener(listener: (tab: RawTab) => void): void;
      removeListener(listener: (tab: RawTab) => void): void;
    };
    onRemoved: {
      addListener(listener: (tabId: number) => void): void;
      removeListener(listener: (tabId: number) => void): void;
    };
    onActivated: { addListener(listener: (info: { tabId: number }) => void): void };
  };
  windows: { create(properties: Record<string, unknown>): Promise<{ id?: number }> };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
    session: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
}

/** What the browser did to tabs while a test was watching. */
interface TabLog {
  readonly created: number[];
  readonly removed: number[];
  readonly activated: number[];
}

/** The outcome of one opening or one navigation: when it was asked for, and what went. */
interface Settled {
  /** The tab that was opened, or the one that was navigated. */
  readonly id: number;
  /** When the step was asked for, on the browser's clock. */
  readonly start: number;
  /** Every tab the browser announced while waiting, in order: §14's event. */
  readonly opened: readonly { id: number; at: number }[];
  /** Every tab the browser removed while waiting, in order. */
  readonly closed: readonly { id: number; at: number }[];
}

/** `sidepanel.html` in the window's first tab, which leaves the panel active. */
async function openPanel(context: BrowserContext, extensionId: string): Promise<Page> {
  const panel = context.pages()[0] ?? (await context.newPage());
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return panel;
}

/**
 * The same panel with its clock `SHIFT_MS` ahead, for the test that goes through the
 * panel's rows, bar and toast.
 *
 * The clock is installed before the document exists: `startPanelState` captures `Date.now`
 * when it is imported, so one installed after the panel has loaded would never be read.
 */
async function openShiftedPanel(context: BrowserContext, extensionId: string): Promise<Page> {
  const panel = context.pages()[0] ?? (await context.newPage());
  await panel.addInitScript((shift: number) => {
    const real = Date.now;
    Date.now = () => real() + shift;
  }, SHIFT_MS);
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return panel;
}

/** The bar's close button, "Close 1". */
function barClose(tabs: number): string {
  return message('en', 'barClose').replace('$1', String(tabs));
}

/** What the toast says it has just done. */
function closedText(tabs: number): string {
  const key: MessageKey = tabs === 1 ? 'toastClosedOne' : 'toastClosedOther';
  return message('en', key).replace('$1', String(tabs));
}

/** A plain wait, for the assertions whose whole content is that nothing happened. */
async function settle(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Changes the guard's settings, the way the chip's menu and §8.3's form do it: a
 * read-modify-write of `local:settings`.
 *
 * The wait is for the background's `storage.onChanged`, which is what drops its cached
 * settings: it is one event dispatch away, and a tab opened in that window would still be
 * answered with the mode from before.
 */
async function setGuard(panel: Page, patch: Record<string, unknown>): Promise<void> {
  await panel.evaluate(async (change) => {
    const api = (globalThis as unknown as { chrome: GuardApi }).chrome;
    const stored = await api.storage.local.get('settings');
    const settings = (stored.settings as Record<string, unknown> | undefined) ?? {};
    const guard = (settings.guard as Record<string, unknown> | undefined) ?? {};
    await api.storage.local.set({ settings: { ...settings, guard: { ...guard, ...change } } });
  }, patch);
  await settle(300);
}

/** `local:settings.guard.mode`, read from the browser rather than inferred. */
async function storedMode(panel: Page): Promise<string> {
  return panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: GuardApi }).chrome;
    const stored = await api.storage.local.get('settings');
    const settings = stored.settings as { guard?: { mode?: string } } | undefined;
    return settings?.guard?.mode ?? '';
  });
}

/** `local:duplicateWhitelist`, the list the guard compiles. */
async function storedWhitelist(panel: Page): Promise<string[]> {
  return panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: GuardApi }).chrome;
    const stored = await api.storage.local.get('duplicateWhitelist');
    return (stored.duplicateWhitelist as string[] | undefined) ?? [];
  });
}

/**
 * Pauses the guard until `ms` from now, and gives back the deadline.
 *
 * Exactly what `pauseGuard` writes: a deadline in `storage.session` and the mode the
 * icon's menu says the pause will return to. The stored mode is deliberately left alone —
 * a pause that rewrote it would outlive the browser (see `src/platform/storage.ts`).
 */
async function pauseGuard(panel: Page, ms: number, resumeMode: string): Promise<number> {
  return panel.evaluate(
    async ({ duration, mode }) => {
      const api = (globalThis as unknown as { chrome: GuardApi }).chrome;
      const stored = await api.storage.session.get('guardState');
      const state = (stored.guardState as Record<string, unknown> | undefined) ?? {};
      const pausedUntil = Date.now() + duration;
      await api.storage.session.set({
        guardState: { ...state, pausedUntil, resumeMode: mode },
      });
      return pausedUntil;
    },
    { duration: ms, mode: resumeMode },
  );
}

/** `session:guardState`, for the deadline and the mode the pause says it will return to. */
async function guardState(panel: Page): Promise<Record<string, unknown>> {
  return panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: GuardApi }).chrome;
    const stored = await api.storage.session.get('guardState');
    return (stored.guardState as Record<string, unknown> | undefined) ?? {};
  });
}

/** Opens tabs in the panel's own window, inactive, and waits until every one has loaded. */
async function openTabs(
  panel: Page,
  urls: readonly string[],
  properties: Record<string, unknown> = {},
): Promise<number[]> {
  const ids: number[] = [];
  for (const url of urls) {
    ids.push(
      await panel.evaluate(
        async ({ target, extra }) => {
          const api = (globalThis as unknown as { chrome: GuardApi }).chrome;
          const tab = await api.tabs.create({ url: target, active: false, ...extra });
          return tab.id ?? -1;
        },
        { target: url, extra: properties },
      ),
    );
  }
  await waitLoaded(panel, ids);
  return ids;
}

/** One tab, for the openings that need its id and no more. */
async function openTab(
  panel: Page,
  url: string,
  properties: Record<string, unknown> = {},
): Promise<number> {
  const [id = -1] = await openTabs(panel, [url], properties);
  return id;
}

/** Waits until every one of `ids` has finished loading. */
async function waitLoaded(panel: Page, ids: readonly number[]): Promise<void> {
  await expect
    .poll(
      async () =>
        panel.evaluate(async (wanted) => {
          const api = (globalThis as unknown as { chrome: GuardApi }).chrome;
          const tabs = await api.tabs.query({});
          return tabs.filter((tab) => wanted.includes(tab.id ?? -1) && tab.status !== 'complete')
            .length;
        }, ids),
      { timeout: 30_000 },
    )
    .toBe(0);
}

/** A second window, left in the background. Its tab is `about:blank`, which §8.3 ignores. */
async function openWindow(panel: Page): Promise<number> {
  const windowId = await panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: GuardApi }).chrome;
    const created = await api.windows.create({ focused: false });
    return created.id ?? -1;
  });
  // A new window can take the foreground whatever `focused: false` asks for, and the
  // window in front is one of §8.4.3's keep rules.
  await panel.bringToFront();
  return windowId;
}

/** An empty tab, exactly as the browser opens one: the start of a duplicate made by hand. */
async function openBlankTab(panel: Page): Promise<number> {
  return panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: GuardApi }).chrome;
    return (await api.tabs.create({ active: false })).id ?? -1;
  });
}

interface Step {
  /** `tabs.create` properties, for an opening. */
  readonly create?: Record<string, unknown>;
  /** A tab and where to take it, for a navigation. */
  readonly navigate?: { readonly id: number; readonly url: string };
}

interface WatchOptions {
  /** `self` waits for the tab the step touched, `any` for the first tab to go. */
  readonly watch?: 'self' | 'any';
  readonly timeout?: number;
}

/**
 * Takes one step and waits until the guard has closed a tab, or until the timeout has
 * passed with nothing closed.
 *
 * Both halves happen inside the panel page, because the only honest measure of §14's
 * 300 ms is the browser's own clock: a round trip to the test runner between the opening
 * and the close would be timed along with it. The removals are collected from the first
 * moment, not polled for, so a close that beats `tabs.create`'s own answer is still seen.
 */
async function settleStep(panel: Page, step: Step, options: WatchOptions = {}): Promise<Settled> {
  return panel.evaluate(
    async ({ action, watch, timeout }) => {
      const api = (globalThis as unknown as { chrome: GuardApi }).chrome;
      const opened: { id: number; at: number }[] = [];
      const closed: { id: number; at: number }[] = [];
      let wake: (() => void) | undefined;
      const onCreated = (tab: RawTab): void => {
        opened.push({ id: tab.id ?? -1, at: Date.now() });
      };
      const onRemoved = (tabId: number): void => {
        closed.push({ id: tabId, at: Date.now() });
        wake?.();
      };
      api.tabs.onCreated.addListener(onCreated);
      api.tabs.onRemoved.addListener(onRemoved);
      try {
        const start = Date.now();
        let id = -1;
        if (action.create !== undefined) {
          id = (await api.tabs.create(action.create)).id ?? -1;
        } else if (action.navigate !== undefined) {
          id = action.navigate.id;
          await api.tabs.update(id, { url: action.navigate.url });
        }

        const done = (): boolean =>
          watch === 'any' ? closed.length > 0 : closed.some((gone) => gone.id === id);
        const deadline = Date.now() + timeout;
        while (!done() && Date.now() < deadline) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 25);
          });
        }
        return { id, start, opened, closed };
      } finally {
        api.tabs.onCreated.removeListener(onCreated);
        api.tabs.onRemoved.removeListener(onRemoved);
      }
    },
    { action: step, watch: options.watch ?? 'self', timeout: options.timeout ?? 5_000 },
  );
}

/** Opens a tab and waits for the guard's answer. */
async function openAndSettle(
  panel: Page,
  properties: Record<string, unknown>,
  options: WatchOptions = {},
): Promise<Settled> {
  return settleStep(panel, { create: properties }, options);
}

/** Takes an existing tab to a URL and waits for the guard's answer. */
async function navigateAndSettle(
  panel: Page,
  id: number,
  url: string,
  options: WatchOptions = {},
): Promise<Settled> {
  return settleStep(panel, { navigate: { id, url } }, options);
}

/** How long the guard took to close `id`, or `null` if it never did. */
function latency(settled: Settled, id: number): number | null {
  const gone = settled.closed.find((closed) => closed.id === id);
  return gone === undefined ? null : gone.at - settled.start;
}

/**
 * §14's budget: "from event to close". The event is `tabs.onCreated` — the moment the
 * browser says the duplicate exists, which is the same moment the worker is handed — and
 * not the `tabs.create` call before it: opening a tab and loading a page in it is work
 * Chrome does on its own, and on this machine it takes longer than the budget by itself.
 */
function reaction(settled: Settled, id: number): number | null {
  const gone = settled.closed.find((closed) => closed.id === id);
  if (gone === undefined) return null;
  const born = settled.opened.find((opened) => opened.id === id);
  return gone.at - (born?.at ?? settled.start);
}

/** Starts watching what happens to tabs, from the panel, which sees the guard's events. */
async function watch(panel: Page): Promise<void> {
  await panel.evaluate(() => {
    const api = (globalThis as unknown as { chrome: GuardApi }).chrome;
    const log: TabLog = { created: [], removed: [], activated: [] };
    const host = globalThis as unknown as { tdLog?: TabLog; tdWatching?: boolean };
    host.tdLog = log;
    // One set of listeners per page, whatever a test asks for: re-watching resets the log.
    if (host.tdWatching === true) return;
    host.tdWatching = true;
    api.tabs.onCreated.addListener((tab) => host.tdLog?.created.push(tab.id ?? -1));
    api.tabs.onRemoved.addListener((tabId) => host.tdLog?.removed.push(tabId));
    api.tabs.onActivated.addListener((info) => host.tdLog?.activated.push(info.tabId));
  });
}

/** What has happened since `watch`. */
async function watched(panel: Page): Promise<TabLog> {
  return panel.evaluate(() => {
    const host = globalThis as unknown as { tdLog?: TabLog };
    return host.tdLog ?? { created: [], removed: [], activated: [] };
  });
}

/** The ids of the tabs on `url` right now, lowest first. A pending URL counts as the URL. */
async function tabIds(panel: Page, url: string): Promise<number[]> {
  const ids = await panel.evaluate(async (target) => {
    const api = (globalThis as unknown as { chrome: GuardApi }).chrome;
    const tabs = await api.tabs.query({});
    return tabs
      .filter((tab) => (tab.url === '' ? tab.pendingUrl : tab.url) === target)
      .map((tab) => tab.id ?? -1);
  }, url);
  return ids.sort((a, b) => a - b);
}

/** Which of `ids` are still open, in the order they were given. */
async function aliveIds(panel: Page, ids: readonly number[]): Promise<number[]> {
  const open = await panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: GuardApi }).chrome;
    return (await api.tabs.query({})).map((tab) => tab.id ?? -1);
  });
  return ids.filter((id) => open.includes(id));
}

/** One tab as the browser has it now. */
async function tabAt(panel: Page, id: number): Promise<RawTab> {
  return panel.evaluate(async (target) => {
    const api = (globalThis as unknown as { chrome: GuardApi }).chrome;
    try {
      return await api.tabs.get(target);
    } catch {
      return {};
    }
  }, id);
}

/** Where a tab is, or `''` when it is not there any more. */
async function tabUrlOf(panel: Page, id: number): Promise<string> {
  return (await tabAt(panel, id)).url ?? '';
}

/** The active tab of the window the panel is in. */
async function activeTabId(panel: Page): Promise<number> {
  return panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: GuardApi }).chrome;
    const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.id ?? -1;
  });
}

/** Chrome's own "Duplicate tab", which is the command the tab menu runs (PLAN.md §8.6). */
async function duplicateTab(panel: Page, id: number): Promise<number> {
  return panel.evaluate(async (target) => {
    const api = (globalThis as unknown as { chrome: GuardApi }).chrome;
    const copy = await api.tabs.duplicate(target);
    return copy?.id ?? -1;
  }, id);
}

/** Takes a tab somewhere without waiting for the guard: the step of a flow. */
async function goTo(panel: Page, id: number, url: string): Promise<void> {
  await panel.evaluate(
    async ({ target, to }) => {
      const api = (globalThis as unknown as { chrome: GuardApi }).chrome;
      await api.tabs.update(target, { url: to });
    },
    { target: id, to: url },
  );
}

test.describe('in English', () => {
  test.use({ uiLanguage: 'en' });

  test('§14: the second opening of a page closes in under 300 ms, and the first comes forward', async ({
    context,
    extensionId,
  }) => {
    const panel = await openPanel(context, extensionId);
    const url = `${base}${PAGE.path}`;

    /*
     * The first tab goes to the *left* of the panel. When Chrome closes the active tab it
     * falls back to the neighbour on the right, or to the left one when there is none —
     * which here is the panel. So "the first tab is active" at the end is §8.4.4's
     * "Attivala" and not the browser's own fallback.
     */
    const first = await openTab(panel, url, { index: 0 });
    await setGuard(panel, { mode: 'auto' });

    const second = await openAndSettle(panel, { url, active: true });
    const took = reaction(second, second.id);
    expect(took, 'the second opening was not closed').not.toBeNull();
    expect(took ?? Infinity).toBeLessThan(LATENCY_BUDGET_MS);

    expect(await tabIds(panel, url)).toEqual([first]);
    await expect.poll(async () => activeTabId(panel), { timeout: 5_000 }).toBe(first);
  });

  test('§8.3: a whitelist pasted in Duplicate Tabs Closer format is the one the guard obeys', async ({
    context,
    extensionId,
  }) => {
    test.slow();
    const panel = await openPanel(context, extensionId);

    /*
     * One wildcard line and one regular expression, in the syntax `core/patterns.ts` took
     * from Duplicate Tabs Closer: the port is whatever the server got, so the wildcard
     * has to cover it, and `\d+` is a thing no wildcard can say.
     */
    const wildcard = `http://127.0.0.1:*${PAGE.path}`;
    const regex = `/:\\d+${OTHER.path}$/`;

    const [page = -1, other = -1, third = -1] = await openTabs(panel, [
      `${base}${PAGE.path}`,
      `${base}${OTHER.path}`,
      `${base}${THIRD.path}`,
    ]);
    await setGuard(panel, { mode: 'auto' });

    // Through the editor §8.3 gives the user for it, reached from the chip's own menu,
    // with the blank line a pasted list usually carries.
    await panel.locator('.td-guard-chip').click();
    await panel.getByRole('menuitem', { name: message('en', 'guardMenuSettings') }).click();
    await panel.locator('#td-whitelist').fill(`${wildcard}\n\n${regex}`);
    await panel.getByRole('button', { name: message('en', 'whitelistSave') }).click();
    await expect.poll(async () => storedWhitelist(panel)).toEqual([wildcard, regex]);
    // The same dispatch the mode's write waits for: the list is recompiled on the change.
    await settle(300);

    const wildcarded = await openAndSettle(
      panel,
      { url: `${base}${PAGE.path}`, active: false },
      { watch: 'any', timeout: QUIET_MS },
    );
    expect(wildcarded.closed, 'the wildcard line did not protect the page').toEqual([]);
    expect(await tabIds(panel, `${base}${PAGE.path}`)).toEqual(
      [page, wildcarded.id].sort((a, b) => a - b),
    );

    const matched = await openAndSettle(
      panel,
      { url: `${base}${OTHER.path}`, active: false },
      { watch: 'any', timeout: QUIET_MS },
    );
    expect(matched.closed, 'the regular expression did not protect the page').toEqual([]);
    expect(await tabIds(panel, `${base}${OTHER.path}`)).toEqual(
      [other, matched.id].sort((a, b) => a - b),
    );

    // And the page no line covers: the protection is on, it was the list that spared the
    // other two.
    const control = await openAndSettle(panel, { url: `${base}${THIRD.path}`, active: false });
    expect(latency(control, control.id), 'the guard was not on at all').not.toBeNull();
    expect(await tabIds(panel, `${base}${THIRD.path}`)).toEqual([third]);
  });

  test('§8.1: a paused guard closes nothing, and goes back to the mode it was in', async ({
    context,
    extensionId,
  }) => {
    const panel = await openPanel(context, extensionId);
    const url = `${base}${PAGE.path}`;
    const first = await openTab(panel, url);
    await setGuard(panel, { mode: 'auto' });

    const pausedUntil = await pauseGuard(panel, PAUSE_MS, 'auto');

    const during = await openAndSettle(
      panel,
      { url, active: false },
      { watch: 'any', timeout: QUIET_MS },
    );
    expect(during.closed, 'a tab was closed while the guard was paused').toEqual([]);
    expect((await tabIds(panel, url)).length).toBe(2);

    // What the pause did *not* do: §8.1's pause is a deadline, not a mode. The stored mode
    // is untouched, so what the guard returns to is still "Chiudi automaticamente", and the
    // icon's menu has the same answer in `resumeMode`.
    expect(await storedMode(panel)).toBe('auto');
    expect(await guardState(panel)).toMatchObject({ pausedUntil, resumeMode: 'auto' });

    const left = pausedUntil - (await panel.evaluate(() => Date.now()));
    if (left > 0) await settle(left + 100);

    const after = await openAndSettle(panel, { url, active: false });
    expect(latency(after, after.id), 'the pause outlived its deadline').not.toBeNull();
    expect(await storedMode(panel)).toBe('auto');
    // The tab the pause spared is still there: the guard closes one tab per event (§8.4.2),
    // it does not catch up on what it let through.
    expect((await tabIds(panel, url)).length).toBe(2);
    expect(await aliveIds(panel, [first, during.id])).toEqual([first, during.id]);
  });

  test('§8.4.4: a background tab opened with Ctrl+click goes without moving the focus', async ({
    context,
    extensionId,
  }) => {
    const panel = await openPanel(context, extensionId);
    const url = `${base}${PAGE.path}`;
    const target = await openTab(panel, url, { index: 0 });
    await setGuard(panel, { mode: 'auto' });

    // A real page with a real link, in the foreground: Ctrl+click is a gesture, and the
    // tab it opens is the one case §8.4.4 is about — it carries an opener and an index but
    // no URL yet, which is what tells it apart from Chrome's own copy.
    const linkPage = await context.newPage();
    await linkPage.goto(`${base}${LINK.path}`);
    const clicker = await activeTabId(panel);

    await watch(panel);
    await linkPage.click('#dup', { modifiers: ['Control'] });

    await expect.poll(async () => tabIds(panel, url), { timeout: 10_000 }).toEqual([target]);

    const log = await watched(panel);
    expect(log.created, 'Ctrl+click did not open a background tab').toHaveLength(1);
    expect(log.removed, 'the tab that opened is not the one that went').toEqual(log.created);
    // §8.4.4: "no action if the tab was opened in the background". Nothing was activated,
    // and the tab the user is reading is still the one in front.
    expect(log.activated, 'the focus moved').toEqual([]);
    expect(await activeTabId(panel)).toBe(clicker);
  });

  test('§8.6: the tab Annulla brings back is not closed again', async ({
    context,
    extensionId,
  }) => {
    test.slow();
    const panel = await openShiftedPanel(context, extensionId);
    const url = `${base}${PAGE.path}`;

    // Two tabs on one page, opened while the mode is still "Solo avvisi" so that both
    // live, and the protection armed only then: the guard answers events, so what is
    // already open stays open.
    await openTabs(panel, [url, url]);
    await setGuard(panel, { mode: 'auto' });

    // §4.3's first section is the duplicates one, holding every tab but the one §8.4.3's
    // keep rules chose.
    const duplicates = panel.locator('.td-section').first();
    await expect(duplicates.locator('.td-row')).toHaveCount(1, { timeout: 20_000 });
    await duplicates.getByRole('button', { name: message('en', 'sectionSelectAll') }).click();
    await expect(duplicates.locator('.td-row-picked')).toHaveCount(1);

    const bar = panel.locator('.td-bar');
    await bar.getByRole('button', { name: barClose(1) }).click();
    await expect.poll(async () => tabIds(panel, url), { timeout: 20_000 }).toHaveLength(1);

    // The pointer holds the toast's 8 s open, so the undo is not a race against them.
    const toast = panel.locator('.td-toast');
    await toast.hover();
    await expect(toast.locator('.td-toast-text')).toHaveText(closedText(1), { timeout: 20_000 });
    await toast.getByRole('button', { name: message('en', 'actionUndo') }).click();
    await expect(toast).toHaveCount(0);

    /*
     * What comes back is a duplicate of the tab that stayed, and it arrives as a brand new
     * tab — an `onCreated` the guard would answer by closing it again, if the undo had not
     * written §8.6's exemption first. So it comes back, and it is still there afterwards.
     */
    await expect.poll(async () => tabIds(panel, url), { timeout: 20_000 }).toHaveLength(2);
    await settle(QUIET_MS);
    expect(await tabIds(panel, url), 'the restored tab was closed again').toHaveLength(2);

    /*
     * And the protection was on all along: a duplicate of another page, which no undo has
     * touched and so no exemption covers, is closed. (How long an exemption lasts is the
     * unit tests': it is written with the panel's clock, which here runs twelve days
     * ahead.)
     */
    const other = `${base}${OTHER.path}`;
    await openTabs(panel, [other]);
    const control = await openAndSettle(panel, { url: other, active: false });
    expect(latency(control, control.id), 'the guard was not on at all').not.toBeNull();
  });

  test('§8.4.2: twenty openings of one page at once leave exactly one tab', async ({
    context,
    extensionId,
  }) => {
    test.slow();
    const panel = await openPanel(context, extensionId);
    const url = `${base}${PAGE.path}`;
    await setGuard(panel, { mode: 'auto' });

    // All twenty asked for before any answer comes back: §8.4.2's "N tabs opened at once",
    // which is what the guard's serial queue is for.
    const ids = await panel.evaluate(
      async ({ target, count }) => {
        const api = (globalThis as unknown as { chrome: GuardApi }).chrome;
        const created = await Promise.all(
          Array.from({ length: count }, () => api.tabs.create({ url: target, active: false })),
        );
        return created.map((tab) => tab.id ?? -1);
      },
      { target: url, count: AT_ONCE },
    );
    expect(ids).toHaveLength(AT_ONCE);

    // The survivor is the one that was there first: §8.4.3's age rule and the tab id that
    // decides a tie both point at it.
    const survivor = Math.min(...ids);
    await expect.poll(async () => tabIds(panel, url), { timeout: 60_000 }).toEqual([survivor]);
    // And it stays: one close per event means the last tab is never the one that goes.
    await settle(QUIET_MS);
    expect(await tabIds(panel, url)).toEqual([survivor]);
  });

  test('§8.3: "Stessa finestra" leaves another window alone, "Tutte le finestre" does not', async ({
    context,
    extensionId,
  }) => {
    test.slow();
    const panel = await openPanel(context, extensionId);
    const here = `${base}${PAGE.path}`;
    const first = await openTab(panel, here);
    /*
     * "Prefer the active window" is off throughout: it is the one keep rule that reads
     * which window is in front, and a headless browser's idea of that is not something a
     * test should make the scope's assertions depend on. §8.4.3.5 is the unit tests'.
     */
    await setGuard(panel, { mode: 'auto', scope: 'window', preferActiveWindow: false });

    const second = await openWindow(panel);

    const across = await openAndSettle(
      panel,
      { url: here, windowId: second, active: false },
      { watch: 'any', timeout: QUIET_MS },
    );
    expect(across.closed, 'a tab in another window was closed under "Stessa finestra"').toEqual([]);
    expect(await tabIds(panel, here)).toEqual([first, across.id].sort((a, b) => a - b));

    // In that same window, the same page does close: the scope narrows what is compared,
    // it does not switch the guard off.
    const inside = await openAndSettle(panel, { url: here, windowId: second, active: false });
    expect(latency(inside, inside.id), 'a duplicate in one window survived').not.toBeNull();
    // The two tabs left are one per window — which is what "Stessa finestra" means.
    expect(await tabIds(panel, here)).toEqual([first, across.id].sort((a, b) => a - b));

    // "Tutte le finestre", on a page of its own so the set is unambiguous.
    const everywhere = `${base}${OTHER.path}`;
    const lone = await openTab(panel, everywhere);
    await setGuard(panel, { mode: 'auto', scope: 'all-windows', preferActiveWindow: false });

    const elsewhere = await openAndSettle(panel, {
      url: everywhere,
      windowId: second,
      active: false,
    });
    expect(
      latency(elsewhere, elsewhere.id),
      'a duplicate in another window survived "Tutte le finestre"',
    ).not.toBeNull();
    expect(await tabIds(panel, everywhere)).toEqual([lone]);
  });

  test('§8.4.4: "Sposta e attiva" puts the surviving tab where the closed one was', async ({
    context,
    extensionId,
  }) => {
    const panel = await openPanel(context, extensionId);
    const url = `${base}${PAGE.path}`;
    // The strip is `/page`, the panel, `/other`, and the duplicate opens *between* the
    // first two: so the move has somewhere to go and the assertion can see it.
    const first = await openTab(panel, url, { index: 0 });
    await openTabs(panel, [`${base}${OTHER.path}`]);
    await setGuard(panel, { mode: 'auto', after: 'move-activate' });

    const second = await openAndSettle(panel, { url, index: 1, active: true });
    expect(latency(second, second.id), 'the duplicate was not closed').not.toBeNull();

    await expect.poll(async () => (await tabAt(panel, first)).index, { timeout: 10_000 }).toBe(1);
    expect((await tabAt(panel, first)).active, '"Sposta e attiva" did not activate it').toBe(true);
  });

  test('§8.4.3.4: "Più vecchia ricaricata" keeps the old tab and takes it to the new URL', async ({
    context,
    extensionId,
  }) => {
    const panel = await openPanel(context, extensionId);
    const url = `${base}${PAGE.path}`;
    const first = await openTab(panel, url);
    await setGuard(panel, { mode: 'auto', keep: 'oldest-reloaded' });

    // The same page with a tracking parameter: one duplicate key (§8.3 drops `utm_*`), two
    // different URLs — which is the only case where "ricaricata" has anything to do.
    const tagged = `${url}?utm_source=newsletter`;
    const second = await openAndSettle(panel, { url: tagged, active: false });
    expect(latency(second, second.id), 'the duplicate was not closed').not.toBeNull();

    expect(await tabIds(panel, tagged)).toEqual([]);
    await expect.poll(async () => tabUrlOf(panel, first), { timeout: 10_000 }).toBe(tagged);
  });

  test('§8.4.3.2: the active tab that navigated to the page stays, the older one goes', async ({
    context,
    extensionId,
  }) => {
    const panel = await openPanel(context, extensionId);
    const url = `${base}${PAGE.path}`;

    // The older tab, in the background, and the tab the user is actually reading.
    const sleeping = await openTab(panel, url, { index: 0 });
    const visitor = await openTab(panel, `${base}${OTHER.path}`, { active: true });
    await setGuard(panel, { mode: 'auto' });
    await watch(panel);

    // The user follows a link to the page they already had open somewhere: §8.4.3.2 keeps
    // the tab in front, even though it is the newer one, because it is where they are.
    await goTo(panel, visitor, url);

    await expect.poll(async () => tabIds(panel, url), { timeout: 10_000 }).toEqual([visitor]);
    expect((await watched(panel)).removed).toEqual([sleeping]);
    expect((await tabAt(panel, visitor)).active, 'the tab in front was not left in front').toBe(
      true,
    );
  });

  test('§8.6: Chrome\'s own "Duplicate tab" is left alone, on a home page and on a deep one', async ({
    context,
    extensionId,
  }) => {
    test.slow();
    const panel = await openPanel(context, extensionId);
    await setGuard(panel, { mode: 'auto' });

    /*
     * `tabs.duplicate` is the command the tab's context menu runs, so the opener, the
     * index and the URL the guard reads are Chrome's own and not a test's imitation
     * (developer.chrome.com/docs/extensions/reference/api/tabs#method-duplicate).
     *
     * Both gestures: the home page is duplicated from the tab strip while the user is
     * elsewhere, the deep page while they are looking at it. Chrome reports a different
     * opener for the two (`docs/DECISIONS.md`, M3b.5) and, on the second, the copy is the
     * active tab — which is where a guard that mistook the copy's own load for a
     * navigation would close the original instead.
     */
    const pages = [
      { url: `${base}${HOME.path}`, active: false },
      { url: `${base}${DEEP.path}?${LONG_QUERY}`, active: true },
    ];
    for (const { url, active } of pages) {
      const original = await openTab(panel, url, { active });
      const copy = await duplicateTab(panel, original);
      expect(copy, `tabs.duplicate gave no tab for ${url}`).toBeGreaterThan(0);

      await settle(SURVIVE_MS);
      expect(await aliveIds(panel, [original, copy]), `a copy of ${url} was closed`).toEqual([
        original,
        copy,
      ]);
    }

    /*
     * The same page, duplicated by hand instead: a new tab, then the URL. It is closed —
     * so the guard was on for the twenty seconds above, and what it let through was the
     * duplicate the user asked for by name.
     */
    const blank = await openBlankTab(panel);
    const byHand = await navigateAndSettle(panel, blank, `${base}${HOME.path}`);
    expect(latency(byHand, blank), 'the guard was not on at all').not.toBeNull();
  });

  test('§8.6: a multi-step login is never cut in half, in one tab or in two', async ({
    context,
    extensionId,
  }) => {
    test.slow();
    const panel = await openPanel(context, extensionId);
    await setGuard(panel, { mode: 'auto' });
    await watch(panel);

    /*
     * One tab, the whole flow: the site, the identity provider's login, the step that
     * redirects through the site's callback, and back to where it started. `localhost` and
     * `127.0.0.1` are two hosts to the browser and to `duplicateKey`, so this really does
     * leave and come back.
     */
    const alone = await openTab(panel, `${base}${DASHBOARD_ONE.path}`);
    await goTo(panel, alone, loginUrl(DASHBOARD_ONE));
    await expect
      .poll(async () => tabUrlOf(panel, alone), { timeout: 15_000 })
      .toBe(loginUrl(DASHBOARD_ONE));
    await goTo(panel, alone, authorizeUrl(DASHBOARD_ONE));
    await expect
      .poll(async () => tabUrlOf(panel, alone), { timeout: 15_000 })
      .toBe(`${base}${DASHBOARD_ONE.path}`);

    /*
     * And the same flow with the login page open twice. The two tabs are on the very same
     * URL, so without §8.6's rule for auth pages one of them would be the duplicate the
     * guard closes — and the user would be logged in in a tab they are not looking at, or
     * nowhere at all.
     */
    const [waiting = -1, acting = -1] = await openTabs(panel, [
      loginUrl(DASHBOARD_TWO),
      loginUrl(DASHBOARD_TWO),
    ]);
    await settle(QUIET_MS);
    await goTo(panel, acting, authorizeUrl(DASHBOARD_TWO));
    await expect
      .poll(async () => tabUrlOf(panel, acting), { timeout: 15_000 })
      .toBe(`${base}${DASHBOARD_TWO.path}`);
    expect(await tabUrlOf(panel, waiting), 'the other login tab went').toBe(
      loginUrl(DASHBOARD_TWO),
    );

    expect((await watched(panel)).removed, 'a tab was closed during a login').toEqual([]);

    // The protection was on the whole time: a duplicate with no login in it is closed.
    await openTabs(panel, [`${base}${PAGE.path}`]);
    const control = await openAndSettle(panel, { url: `${base}${PAGE.path}`, active: false });
    expect(latency(control, control.id), 'the guard was not on at all').not.toBeNull();
  });
});
