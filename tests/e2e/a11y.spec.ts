import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { AxeBuilder } from '@axe-core/playwright';
import type { BrowserContext, Page } from '@playwright/test';

import type { ActivityStore, ArchivedTab } from '../../src/core/types';
import { expect, message, test } from './fixtures/extension';

/**
 * The accessibility audit of PLAN.md §13 M6 and §4.8: axe-core over every view of the
 * panel — Declutter, Organize, Archive, Settings, Duplicate protection and Onboarding —
 * in the light theme and in the dark one, with zero "serious" and zero "critical"
 * violations.
 *
 * Both themes, because half of what axe can prove is contrast and the two palettes of
 * §4.7 are two different sets of colours. `prefers-color-scheme` is the only thing that
 * picks a theme, so it is set on the context (`fixtures/extension.ts`) rather than toggled
 * in the page.
 *
 * Every view is audited with something in it. An empty list has no rows, no chips and no
 * selection bar, so auditing a fresh profile would prove nothing about the widgets the
 * user actually reaches: the tabs are local pages this test serves itself (invariant 1),
 * the archive is seeded, and the audit also covers the three surfaces that only exist
 * after a gesture — the selection bar, the duplicate protection menu and the archive's
 * inline confirmation.
 *
 * The rule set is axe's default one, filtered by impact rather than by tag: §13 M6's
 * acceptance is about "serious" and "critical", whichever tag the rule carries.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How far the panel's clock runs ahead, as in `declutter.spec.ts`: the score reads the
 * later of the stored `lastActiveAt` and Chrome's own `lastAccessed`, which is always a
 * few seconds ago, so the only way to have an idle tab is to open the panel in the future.
 * Twelve days is past `staleDays`, past the two-hour grace period and past the one-day
 * bootstrap grace.
 */
const SHIFT_MS = 12 * DAY + HOUR;

/** How long ago the seeded records say the tabs were created. */
const HISTORY_MS = 20 * DAY;

/** How old the one archive entry outside "Oggi" is. */
const OLD_MS = 10 * DAY;

const PATHS = ['/one', '/two', '/three', '/login'] as const;

let server: Server;
let port = 0;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (!(PATHS as readonly string[]).includes(path)) {
      // Chrome asks for the favicon on its own; "nothing here" keeps the row on Chrome's
      // own favicon cache (PLAN.md §5.5) instead of a request of ours.
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

/**
 * The tabs the panel is audited on.
 *
 * `127.0.0.1` and `localhost` are the same server on the same port and two different sites
 * to the browser, so each of them reaches the three tabs §7.1 asks for before the Organize
 * preview proposes a group. `/three` twice on the first host gives §4.3 its duplicate pair,
 * and `/login` is `auth` by its path alone (`src/core/rules.ts`), so the list carries more
 * than one kind of reason.
 */
function seededUrls(): string[] {
  const here = (host: string, path: string) => `http://${host}:${String(port)}${path}`;
  return [
    ...['/one', '/two', '/three', '/three', '/login'].map((path) => here('127.0.0.1', path)),
    ...['/one', '/two', '/three'].map((path) => here('localhost', path)),
  ];
}

/** The slice of the extension API this spec asks the panel page for. */
interface SeedApi {
  tabs: {
    create(properties: { url: string; active: boolean }): Promise<unknown>;
    query(
      query: Record<string, unknown>,
    ): Promise<{ id?: number; url?: string; windowId?: number }[]>;
  };
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
}

interface SeedTab {
  readonly id: number;
  readonly url: string;
}

async function openTabs(panel: Page, urls: readonly string[]): Promise<void> {
  await panel.evaluate(async (list) => {
    const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
    for (const url of list) await api.tabs.create({ url, active: false });
  }, urls);
}

async function openTabIds(panel: Page): Promise<readonly SeedTab[]> {
  return panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
    const tabs = await api.tabs.query({});
    return tabs.map((tab) => ({ id: tab.id ?? -1, url: tab.url ?? '' }));
  });
}

async function storedActivity(panel: Page): Promise<ActivityStore> {
  return panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
    const stored = await api.storage.local.get('activity');
    return (stored.activity ?? {}) as ActivityStore;
  });
}

/**
 * Waits until the background has stopped writing, as `declutter.spec.ts` does: the tracker
 * debounces its writes by a second and writes the whole store at once, so a seed written
 * while it is still flushing would be thrown away.
 */
async function trackerQuiet(panel: Page): Promise<void> {
  let previous = '';
  await expect
    .poll(
      async () => {
        const current = JSON.stringify(await storedActivity(panel));
        const quiet = current !== '{}' && current === previous;
        previous = current;
        return quiet;
      },
      { intervals: Array.from({ length: 8 }, () => 1_500), timeout: 15_000 },
    )
    .toBe(true);
}

/** Every tab created long ago and never read: the whole strip is due, so no section is folded. */
function historyFor(tabs: readonly SeedTab[]): ActivityStore {
  const at = Date.now() - HISTORY_MS;
  const activity: ActivityStore = {};
  for (const tab of tabs) {
    activity[tab.id] = {
      tabId: tab.id,
      url: tab.url,
      createdAt: at,
      lastActiveAt: at,
      activations: 0,
      foregroundMs: 0,
    };
  }
  return activity;
}

/** Three entries, one per origin of §4.5 and one of them outside "Oggi". */
function archiveEntries(windowId: number): ArchivedTab[] {
  const now = Date.now();
  return [
    {
      id: 'a11y-manual',
      url: `http://127.0.0.1:${String(port)}/one`,
      title: 'Page one',
      closedAt: now,
      reason: 'manual',
      windowId,
      index: 1,
    },
    {
      id: 'a11y-guard',
      url: `http://127.0.0.1:${String(port)}/two`,
      title: 'Page two',
      closedAt: now,
      reason: 'duplicate-auto',
      windowId,
      index: 2,
    },
    {
      id: 'a11y-window',
      url: `http://127.0.0.1:${String(port)}/three`,
      title: 'Page three',
      closedAt: now - OLD_MS,
      reason: 'window',
      windowId,
      index: 3,
    },
  ];
}

/**
 * The panel, open on a browser whose tabs are all old and whose archive is not empty.
 *
 * The page is created here rather than taken from the `panel` fixture because the clock has
 * to be installed before the document exists: `startPanelState` reads `Date.now` when it is
 * imported, so a clock set afterwards would never be seen.
 */
async function seededPanel(context: BrowserContext, extensionId: string): Promise<Page> {
  const panel = await context.newPage();
  await panel.addInitScript((shift: number) => {
    const real = Date.now;
    Date.now = () => real() + shift;
  }, SHIFT_MS);
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);

  await openTabs(panel, seededUrls());
  await trackerQuiet(panel);

  const tabs = await openTabIds(panel);
  const windowId = await panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    return tab?.windowId ?? -1;
  });

  await panel.evaluate(
    async ([activity, archive]) => {
      const api = (globalThis as unknown as { chrome: SeedApi }).chrome;
      await api.storage.local.set({ activity, archive });
    },
    [historyFor(tabs), archiveEntries(windowId)] as [ActivityStore, ArchivedTab[]],
  );

  // The seed reaches the panel as a `storage.onChanged`, so the list on screen is the
  // seeded one only once the rows are there.
  await expect(panel.locator('.td-row')).not.toHaveCount(0);
  return panel;
}

/** One violation, as the failure message prints it. */
function described(violation: {
  id: string;
  impact?: string | null;
  nodes: { target: unknown[] }[];
}): string {
  const where = violation.nodes.map((node) => node.target.join(' ')).join(', ');
  return `${violation.impact ?? 'unknown'} ${violation.id}: ${where}`;
}

/**
 * Asserts §13 M6's acceptance on whatever is on screen.
 *
 * The violations are listed in the failure rather than counted, because an axe failure is
 * only useful if it says which rule broke on which element.
 *
 * The audit waits for the fades to finish first. axe reads the colours at the instant it
 * runs, and a row's actions are `opacity: 0` until the row is hovered or focused
 * (`base.css`), so the 150 ms of `--td-duration` after a click that moves the focus away
 * leave them half transparent: axe then blends them into the surface behind and reports a
 * contrast violation that no user can see. Measured on the duplicate protection menu, whose
 * audit follows the click that opens it. Only transitions are awaited — never a looping
 * animation, which would never settle.
 */
async function expectAccessible(panel: Page, surface: string): Promise<void> {
  await panel.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) => !(animation instanceof CSSTransition) || animation.playState !== 'running',
      ),
  );
  const { violations } = await new AxeBuilder({ page: panel }).analyze();
  const serious = violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map(described);
  expect(serious, `axe on ${surface}`).toEqual([]);
}

/** The gesture-only surfaces of the Declutter view, audited where the user meets them. */
async function auditDeclutter(panel: Page): Promise<void> {
  await expectAccessible(panel, 'Declutter');

  // §4.2's selection bar, which only exists once something is picked.
  await panel.locator('.td-row').first().click();
  await expect(panel.locator('.td-bar')).toBeVisible();
  await expectAccessible(panel, 'Declutter with a selection');
  await panel.locator('.td-row').first().click();

  // §8.3's chip menu: a `role="menu"` with radio items, which is the one popup in the shell.
  await panel.locator('.td-guard-chip').click();
  await expect(panel.locator('.td-guard-menu')).toBeVisible();
  await expectAccessible(panel, 'the duplicate protection menu');
  await panel.keyboard.press('Escape');
}

async function auditOrganize(panel: Page): Promise<void> {
  await panel.getByRole('button', { name: message('en', 'navOrganize') }).click();
  // Two sites of three tabs up: §7.1 proposes a group for each.
  await expect(panel.locator('.td-group')).not.toHaveCount(0);
  await expectAccessible(panel, 'Organize');
}

async function auditArchive(panel: Page): Promise<void> {
  await panel.getByRole('button', { name: message('en', 'navArchive') }).click();
  await expect(panel.locator('.td-row')).toHaveCount(3);
  await expectAccessible(panel, 'Archive');

  // §9's inline question, the one place the panel asks anything.
  await panel.getByRole('button', { name: message('en', 'archiveEmptyAll') }).click();
  await expect(panel.locator('.td-confirm')).toBeVisible();
  await expectAccessible(panel, "the archive's confirmation");
  await panel.getByRole('button', { name: message('en', 'actionCancel') }).click();
}

async function auditSettings(panel: Page): Promise<void> {
  await panel.getByRole('button', { name: message('en', 'navSettings') }).click();
  await expect(panel.locator('.td-settings')).toBeVisible();
  await expectAccessible(panel, 'Settings');

  await panel.getByRole('button', { name: message('en', 'settingsOpenDuplicates') }).click();
  await expect(
    panel.getByRole('heading', { name: message('en', 'settingsDuplicates'), level: 2 }),
  ).toBeVisible();
  await expectAccessible(panel, 'Duplicate protection');
}

/** Every view but the first run, which needs a profile that has never been answered. */
async function auditEveryView(context: BrowserContext, extensionId: string): Promise<void> {
  const panel = await seededPanel(context, extensionId);
  await auditDeclutter(panel);
  await auditOrganize(panel);
  await auditArchive(panel);
  await auditSettings(panel);
}

/*
 * The second half of §4.8's promise, and the one axe cannot see: at 200% zoom the panel
 * must still fit its width rather than ask the user to scroll sideways to read a row
 * (WCAG 1.4.4 and 1.4.10). CSS `zoom` on the root is what Chromium's own zoom control does
 * to layout, so doubling it reflows the panel exactly as pressing Ctrl+ would.
 */
test('the panel still fits its width at 200% zoom', async ({ context, extensionId }) => {
  test.slow();
  const panel = await seededPanel(context, extensionId);
  // 640 at zoom 2 leaves the 320 CSS pixels of content width WCAG 1.4.10 asks to reflow
  // into, which is also about the narrowest a side panel can be dragged to.
  await panel.setViewportSize({ width: 640, height: 800 });
  await panel.evaluate(() => {
    document.documentElement.style.zoom = '2';
  });

  const overflow = await panel.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow, 'horizontal overflow in CSS pixels').toBeLessThanOrEqual(1);
  await expectAccessible(panel, 'the panel at 200% zoom');
});

for (const theme of ['light', 'dark'] as const) {
  test.describe(`with a ${theme} system theme`, () => {
    test.use({ colorScheme: theme });

    test('axe finds nothing serious in any view', async ({ context, extensionId }) => {
      // Eight tabs, a debounce to wait out and seven axe runs.
      test.slow();
      await auditEveryView(context, extensionId);
    });

    // §17's screen is the whole panel on a profile that has never answered it, so it
    // cannot be reached from the walk above: it needs a fresh install of its own.
    test.describe('on the first run', () => {
      test.use({ onboarded: false });

      test('axe finds nothing serious on the onboarding screen', async ({ panel }) => {
        await expect(panel.getByText(message('en', 'onboardingIntro'))).toBeVisible();
        await expectAccessible(panel, 'Onboarding');
      });
    });
  });
}
