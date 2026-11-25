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
 *
 * The second test is the other half of M4's acceptance (PLAN.md §13): "apply and undo
 * restore exactly the original order and groups". It is the one case the unit tests cannot
 * even approximate, because what has to come back is the browser's own state — every
 * tab's index and the group it was in, including a group the user made by hand before the
 * preview existed.
 */

/** Everything the test server answers; a test takes the slice of them it needs. */
const PATHS = ['/one', '/two', '/three', '/four', '/five'] as const;

/** Three per host: the minimum §7.1 asks for before a site earns a group. */
const SITE_PATHS = PATHS.slice(0, 3);

/** The group the second test makes by hand, which §4.4 must leave exactly as it is. */
const MINE = { title: 'Mine', color: 'purple' } as const;

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

/** A tab as the browser reports it, in the two tests' terms. */
interface RawTab {
  id?: number;
  url?: string;
  index: number;
  pinned?: boolean;
  groupId?: number;
}

/** The slice of the extension API the panel page is asked for, inside the browser. */
interface GroupsApi {
  tabs: {
    create(properties: { url: string; active: boolean }): Promise<unknown>;
    query(query: Record<string, unknown>): Promise<RawTab[]>;
    group(options: { tabIds: readonly number[] }): Promise<number>;
    update(tabId: number, properties: { pinned: boolean }): Promise<unknown>;
  };
  tabGroups: {
    query(
      query: Record<string, unknown>,
    ): Promise<{ id: number; title?: string; color?: string }[]>;
    update(groupId: number, properties: { title: string; color: string }): Promise<unknown>;
  };
}

/** The URLs of `hosts` × `paths`, host by host: what §7.1 sees as one site each. */
function urlsOf(hosts: readonly string[], paths: readonly string[]): string[] {
  return hosts.flatMap((host) => paths.map((path) => `http://${host}:${String(port)}${path}`));
}

/**
 * The pages, opened from the panel's own tab so they land in the panel's window — which is
 * the "Finestra corrente" the view starts on.
 *
 * `chrome.tabs.create` rather than `context.newPage()`: a Playwright page is a tab of its
 * own in the same window either way, but this keeps the panel focused and the created
 * tabs in the background, so the window the preview reads is the one under test.
 */
async function openTabs(panel: Page, urls: readonly string[]): Promise<void> {
  await panel.evaluate(async (list) => {
    const api = (globalThis as unknown as { chrome: GroupsApi }).chrome;
    for (const url of list) {
      await api.tabs.create({ url, active: false });
    }
  }, urls);
}

/** The six pages of the first test: two sites of three tabs. */
async function openSites(panel: Page): Promise<void> {
  await openTabs(panel, urlsOf(['127.0.0.1', 'localhost'], SITE_PATHS));
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

/** One tab of the window as undo has to give it back: where it sits and what it is in. */
interface TabState {
  url: string;
  index: number;
  pinned: boolean;
  /** `"<title>/<color>"` of its group, or `null`. By name because ids do not survive. */
  group: string | null;
}

/**
 * The whole window in index order: the thing PLAN.md §13's "apply and undo restore exactly
 * the original order and groups" is a statement about.
 *
 * The group is read as its title and colour rather than its id: `platform/groups.ts` may
 * legitimately rebuild a group it could not find again (PLAN.md §5.5), so an id that
 * changed is not a failure, while a title or a colour that changed is.
 */
async function windowState(panel: Page): Promise<TabState[]> {
  return panel.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: GroupsApi }).chrome;
    const groups = await api.tabGroups.query({});
    const names = new Map(
      groups.map((group) => [group.id, `${group.title ?? ''}/${group.color ?? ''}`]),
    );
    const tabs = await api.tabs.query({ currentWindow: true });
    return tabs
      .slice()
      .sort((left, right) => left.index - right.index)
      .map((tab) => ({
        url: tab.url ?? '',
        index: tab.index,
        pinned: tab.pinned === true,
        group: names.get(tab.groupId ?? -1) ?? null,
      }));
  });
}

/** The ids of those URLs, in the order they are named. */
async function idsOf(panel: Page, urls: readonly string[]): Promise<number[]> {
  return panel.evaluate(async (list) => {
    const api = (globalThis as unknown as { chrome: GroupsApi }).chrome;
    const tabs = await api.tabs.query({ currentWindow: true });
    const byUrl = new Map(tabs.map((tab) => [tab.url ?? '', tab.id ?? -1]));
    return list.map((url) => byUrl.get(url) ?? -1);
  }, urls);
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

  test('apply and undo restore exactly the order and the groups', async ({ panel }) => {
    // Interleaved on purpose: the two sites alternate in the strip, so grouping them has
    // to move tabs and "Ordina le schede nella finestra per gruppo" has something to sort.
    const here = urlsOf(['127.0.0.1'], PATHS);
    const there = urlsOf(['localhost'], PATHS.slice(0, 4));
    await openTabs(panel, [
      here[0] ?? '',
      there[0] ?? '',
      here[1] ?? '',
      there[1] ?? '',
      here[2] ?? '',
      there[2] ?? '',
      here[3] ?? '',
      there[3] ?? '',
      here[4] ?? '',
    ]);

    // One pinned tab and one group the user made by hand: the two things §4.4 promises to
    // leave alone, and the two the restore is easiest to get wrong on. Both come out of
    // the proposal, which leaves three tabs per site — exactly §7.1's minimum.
    //
    // Polled, because a tab the browser has only just created may not be reporting its URL
    // yet, and these three are identified by theirs.
    const wanted = [there[3] ?? '', here[3] ?? '', here[4] ?? ''];
    await expect.poll(async () => (await idsOf(panel, wanted)).includes(-1)).toBe(false);
    const [pinned, ...mine] = await idsOf(panel, wanted);
    await panel.evaluate(
      async (own) => {
        const api = (globalThis as unknown as { chrome: GroupsApi }).chrome;
        await api.tabs.update(own.pin, { pinned: true });
        const groupId = await api.tabs.group({ tabIds: own.group });
        await api.tabGroups.update(groupId, { title: own.title, color: own.color });
      },
      { pin: pinned ?? -1, group: mine, title: MINE.title, color: MINE.color },
    );

    await panel.getByRole('button', { name: message('en', 'navOrganize') }).click();
    await panel
      .getByRole('checkbox', { name: message('en', 'organizeOptionSort') })
      .setChecked(true);

    await expect(panel.locator('.td-group')).toHaveCount(2);
    await expect(panel.locator('.td-groups .td-group-tab')).toHaveCount(6);

    // The window as it is now, with the user's own group and the pinned tab at its head:
    // this is the state the whole test is about.
    const before = await windowState(panel);
    expect(before.filter((tab) => tab.group === `${MINE.title}/${MINE.color}`)).toHaveLength(2);
    expect(before[0]?.pinned).toBe(true);

    await panel.getByRole('button', { name: message('en', 'organizeApply') }).click();

    // The toast is the signal that the apply — grouping and sorting both — is over, so
    // what is compared below is the finished window and not one mid-move.
    const toast = panel.locator('.td-toast');
    await expect(toast).toContainText(message('en', 'organizeAppliedOther').replace('$1', '2'));

    // Three groups now: the user's, untouched, and the two that were applied (§4.4).
    expect(await nativeGroups(panel)).toHaveLength(3);

    // The sort really did move things, so what undo has to put back is a different window
    // and not the same one. Without this the restore could pass by having done nothing.
    expect(await windowState(panel)).not.toEqual(before);

    await toast.getByRole('button', { name: message('en', 'actionUndo') }).click();

    // §13's acceptance for M4, in one assertion: every tab back at its index, in the group
    // it was in — including the hand-made one — and the pinned tab pinned.
    await expect.poll(async () => windowState(panel)).toEqual(before);
  });

  test('saves individual and all Windows and topics clusters as native tab groups with undo and autopilot protection', async ({
    panel,
  }) => {
    await openSites(panel);

    // Switch to the default window-organization overview (`useTabGroups: false`, `mode: site`)
    // where "Windows and topics" is displayed.
    await panel.evaluate(async () => {
      const storage = (
        globalThis as unknown as {
          chrome: {
            storage: {
              local: {
                get(key: string): Promise<Record<string, Record<string, unknown>>>;
                set(items: Record<string, unknown>): Promise<void>;
              };
            };
          };
        }
      ).chrome.storage.local;
      const current = (await storage.get('settings')).settings ?? {};
      await storage.set({
        settings: {
          ...current,
          useTabGroups: false,
          autoOrganize: false,
          autoOrganizeMode: 'site',
          autoWindowMode: 'merge-windows',
        },
      });
    });

    await panel.getByRole('button', { name: message('en', 'navOrganize') }).click();
    await expect(panel.locator('.td-window-plan')).toBeVisible();
    await expect(panel.locator('.td-window-plan-save')).toHaveCount(2);

    // 1. One-click save a single cluster as a native browser tab group.
    const firstSave = panel.locator('.td-window-plan-save').first();
    await firstSave.click();

    await expect.poll(async () => (await nativeGroups(panel)).length).toBe(1);
    await expect(panel.locator('.td-window-plan-saved')).toHaveCount(1);
    await expect(panel.locator('.td-window-plan-save')).toHaveCount(1);

    const savedSingle = await nativeGroups(panel);

    // 2. Running window organization must preserve the newly saved native tab group intact.
    await panel.getByRole('button', { name: message('en', 'windowOrganizeNow') }).click();
    await expect.poll(async () => nativeGroups(panel)).toEqual(savedSingle);

    // 3. One-click Undo removes the native tab group and restores the Save group button.
    const groupToast = panel.locator('.td-toast').filter({ hasText: savedSingle[0]?.title ?? '' });
    await expect(groupToast).toBeVisible();
    await groupToast.getByRole('button', { name: message('en', 'actionUndo') }).click();

    await expect.poll(async () => nativeGroups(panel)).toEqual([]);
    await expect(panel.locator('.td-window-plan-save')).toHaveCount(2);

    // 4. One-click "Save all as tab groups" converts every cluster in the overview at once.
    const saveAllBtn = panel.getByRole('button', { name: message('en', 'windowPlanSaveAll') });
    await saveAllBtn.click();

    await expect.poll(async () => (await nativeGroups(panel)).length).toBe(2);
    await expect(panel.locator('.td-window-plan-saved')).toHaveCount(2);
    await expect(saveAllBtn).toBeDisabled();

    const allToast = panel
      .locator('.td-toast')
      .filter({ hasText: message('en', 'windowPlanSavedOther').replace('$1', '2') });
    await expect(allToast).toBeVisible();
    await allToast.getByRole('button', { name: message('en', 'actionUndo') }).click();

    await expect.poll(async () => nativeGroups(panel)).toEqual([]);
    await expect(saveAllBtn).toBeEnabled();
  });
});
