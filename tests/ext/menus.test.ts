import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { keepKey } from '../../src/core/scoring';
import type { ArchivedTab } from '../../src/core/types';
import type { GuardActions } from '../../src/entrypoints/background/guard';
import type {
  ClickedTab,
  MenuClickInfo,
  MenuItemProperties,
  MenusApi,
  MenusOptions,
} from '../../src/entrypoints/background/menus';
import {
  ALLOW_DUPLICATES_ID,
  KEEP_ALWAYS_ID,
  PAUSE_1_HOUR_ID,
  PAUSE_1_HOUR_MS,
  PAUSE_15_MIN_ID,
  PAUSE_15_MIN_MS,
  PAUSE_GUARD_ID,
  PAUSE_RESTART_ID,
  PROTECT_SITE_ID,
  REOPEN_ALLOW_SITE_ID,
  REOPEN_DUPLICATE_ID,
  duplicateWhitelistPattern,
  registerMenus,
} from '../../src/entrypoints/background/menus';
import {
  duplicateWhitelistItem,
  keepsItem,
  protectedDomainsItem,
} from '../../src/platform/storage';

/**
 * The items of PLAN.md §4.1: the three on the page and the tab strip, and the guard's own
 * on the extension icon (§8.5, §8.7). That they are created once, with their localized
 * titles and on the contexts the browser has, and that each one does what it promises and
 * nothing else.
 *
 * `fakeBrowser` leaves `contextMenus` unimplemented — `create`, `removeAll` and even
 * `onClicked.addListener` throw — so the menus API is injected here, recording what it was
 * asked to do and handing a click to whatever the background registered. The guard is
 * injected the same way, recording the gestures it was asked for; what it then does to the
 * tabs is `tests/ext/guard.test.ts`'s. `onInstalled` and the storage are `fakeBrowser`'s own.
 */

const NOW = Date.UTC(2026, 1, 3, 9, 30, 0);

/** The ids on the page and the tab strip, which are not the icon menu's. */
const PAGE_IDS: readonly string[] = [KEEP_ALWAYS_ID, PROTECT_SITE_ID, ALLOW_DUPLICATES_ID];

/** Every item `install()` creates: the three of §4.1 and the six of the icon menu. */
const ALL_ITEMS = 9;

beforeEach(() => {
  fakeBrowser.reset();
  // `t` reads `browser.i18n.getMessage`, which `fakeBrowser` does not implement. Echoing
  // the key makes a title assertion say which string was asked for.
  vi.spyOn(fakeBrowser.i18n, 'getMessage').mockImplementation((key: string) => `t:${key}`);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The injected menus API, with everything it was asked to do kept. */
interface RecordingMenusApi extends MenusApi {
  readonly created: MenuItemProperties[];
  /** How many times `removeAll` was called, and before which `create`. */
  readonly calls: string[];
  /** Delivers a click to the listener the background registered, as the browser would. */
  clickThrough(info: MenuClickInfo, tab?: ClickedTab): void;
}

function recorder(): RecordingMenusApi {
  const created: MenuItemProperties[] = [];
  const calls: string[] = [];
  const listeners: ((info: MenuClickInfo, tab?: ClickedTab) => void)[] = [];
  return {
    created,
    calls,
    create(properties) {
      calls.push(`create:${properties.id}`);
      created.push(properties);
    },
    removeAll() {
      calls.push('removeAll');
    },
    onClicked: {
      addListener(listener) {
        listeners.push(listener);
      },
    },
    clickThrough(info, tab) {
      for (const listener of listeners) listener(info, tab);
    },
  };
}

/** The guard as the menu sees it: every gesture asked for, in order. */
interface RecordingGuard extends GuardActions {
  readonly asked: string[];
  /** What the next `reopenLastDuplicate` answers. `null` is "nothing to reopen". */
  reopens: ArchivedTab | null;
}

function guardRecorder(): RecordingGuard {
  const asked: string[] = [];
  const guard: RecordingGuard = {
    asked,
    reopens: null,
    pause(durationMs) {
      asked.push(`pause:${durationMs === null ? 'restart' : String(durationMs)}`);
      return Promise.resolve();
    },
    toggle() {
      asked.push('toggle');
      return Promise.resolve();
    },
    closeAllDuplicates() {
      asked.push('closeAllDuplicates');
      return Promise.resolve([]);
    },
    reopenLastDuplicate() {
      asked.push('reopenLastDuplicate');
      return Promise.resolve(guard.reopens);
    },
  };
  return guard;
}

/** One archive entry, as the guard would answer with it after a reopen. */
function entry(url: string): ArchivedTab {
  return {
    id: 'a1',
    url,
    title: 'Example',
    closedAt: NOW - 1_000,
    reason: 'duplicate-auto',
    windowId: 1,
    index: 3,
  };
}

function start(overrides: Partial<MenusOptions> = {}) {
  const api = overrides.api ?? recorder();
  const guard = (overrides.guard ?? guardRecorder()) as RecordingGuard;
  const menus = registerMenus({ now: () => NOW, tabContext: false, ...overrides, api, guard });
  return { menus, api: api as RecordingMenusApi, guard };
}

function click(menuItemId: string | number, url?: string): MenuClickInfo {
  return { menuItemId, pageUrl: url };
}

function tab(url: string): ClickedTab {
  return { url };
}

/** Long enough for the listener's own promise, which nothing hands back to the caller. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('creating the items', () => {
  it('creates the three items of PLAN.md §4.1, in order, with their localized titles', async () => {
    const { menus, api } = start();

    await menus.install();

    expect(api.created.slice(0, 3).map((item) => item.id)).toEqual([
      KEEP_ALWAYS_ID,
      PROTECT_SITE_ID,
      ALLOW_DUPLICATES_ID,
    ]);
    expect(api.created.slice(0, 3).map((item) => item.title)).toEqual([
      't:menuKeepAlways',
      't:menuProtectSite',
      't:menuAllowDuplicates',
    ]);
  });

  it('creates the icon menu of PLAN.md §8.5 and §8.7, titles and all', async () => {
    const { menus, api } = start();

    await menus.install();

    const action = api.created.filter((item) => !PAGE_IDS.includes(item.id));
    expect(action.map((item) => item.id)).toEqual([
      REOPEN_DUPLICATE_ID,
      REOPEN_ALLOW_SITE_ID,
      PAUSE_GUARD_ID,
      PAUSE_15_MIN_ID,
      PAUSE_1_HOUR_ID,
      PAUSE_RESTART_ID,
    ]);
    expect(action.map((item) => item.title)).toEqual([
      't:menuReopenDuplicate',
      't:menuReopenAllowSite',
      't:menuPauseGuard',
      't:menuPause15Min',
      't:menuPause1Hour',
      't:menuPauseRestart',
    ]);
  });

  it('hangs the three durations under “Pausa protezione duplicati”', async () => {
    const { menus, api } = start();

    await menus.install();

    const parents = new Map(api.created.map((item) => [item.id, item.parentId]));
    expect(parents.get(PAUSE_15_MIN_ID)).toBe(PAUSE_GUARD_ID);
    expect(parents.get(PAUSE_1_HOUR_ID)).toBe(PAUSE_GUARD_ID);
    expect(parents.get(PAUSE_RESTART_ID)).toBe(PAUSE_GUARD_ID);
    // The parent before its children: `create` with a `parentId` nothing answers to fails.
    const ids = api.created.map((item) => item.id);
    expect(ids.indexOf(PAUSE_GUARD_ID)).toBeLessThan(ids.indexOf(PAUSE_15_MIN_ID));
    // Everything else stands on its own.
    for (const id of [...PAGE_IDS, REOPEN_DUPLICATE_ID, REOPEN_ALLOW_SITE_ID, PAUSE_GUARD_ID]) {
      expect(parents.get(id)).toBeUndefined();
    }
  });

  it('puts the guard’s items on the icon, children included', async () => {
    const { menus, api } = start({ tabContext: true });

    await menus.install();

    // Firefox defaults an item with no `contexts` to `['page']`, which would file the
    // three durations on the page menu instead of under their parent.
    for (const item of api.created.filter((created) => !PAGE_IDS.includes(created.id))) {
      expect(item.contexts).toEqual(['action']);
    }
  });

  it('clears the previous version’s items before creating its own', async () => {
    const { menus, api } = start();

    await menus.install();

    // An update fires `onInstalled` with the old items possibly still installed, and
    // `create` with an id that already exists is an error.
    expect(api.calls[0]).toBe('removeAll');
    expect(api.calls.filter((call) => call === 'removeAll')).toHaveLength(1);
  });

  it('asks for the page context only where there is no tab context', async () => {
    const { menus, api } = start({ tabContext: false });

    await menus.install();

    // Chrome rejects the whole `create` call when a context it has no name for is asked
    // for, so all three items would be lost (invariant 10).
    for (const item of api.created.filter((created) => PAGE_IDS.includes(created.id))) {
      expect(item.contexts).toEqual(['page']);
    }
  });

  it('asks for the tab strip too where there is a tab context', async () => {
    const { menus, api } = start({ tabContext: true });

    await menus.install();

    for (const item of api.created.filter((created) => PAGE_IDS.includes(created.id))) {
      expect(item.contexts).toEqual(['page', 'tab']);
    }
  });

  it('creates them when the browser says the extension was installed', async () => {
    const { api } = start();

    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'install' });
    await settle();

    expect(api.created).toHaveLength(ALL_ITEMS);
  });
});

describe('“Mantieni sempre questa scheda”', () => {
  it('keeps the tab with no expiry', async () => {
    const { menus } = start();

    await menus.clicked(click(KEEP_ALWAYS_ID), tab('https://example.com/article?x=1'));

    // `null`, not a date: "Sempre" (PLAN.md §9), which no 6 h sweep may prune.
    expect(await keepsItem.getValue()).toEqual({
      [keepKey('https://example.com/article?x=1')]: null,
    });
  });

  it('falls back to the URL the menu was opened on', async () => {
    const { menus } = start();

    // The `page` context gives `pageUrl`; a click on the tab strip gives the tab.
    await menus.clicked(click(KEEP_ALWAYS_ID, 'https://example.com/'));

    expect(Object.keys(await keepsItem.getValue())).toEqual([keepKey('https://example.com/')]);
  });

  it('writes nothing for a click with no URL at all', async () => {
    const { menus } = start();

    await menus.clicked(click(KEEP_ALWAYS_ID));

    expect(await keepsItem.getValue()).toEqual({});
  });
});

describe('“Proteggi sempre questo sito”', () => {
  it('protects the registrable domain, not the host', async () => {
    const { menus } = start();

    await menus.clicked(click(PROTECT_SITE_ID), tab('https://mail.example.co.uk/inbox'));

    // The whole site is protected, every subdomain of it included (PLAN.md §6.3).
    expect(await protectedDomainsItem.getValue()).toEqual(['example.co.uk']);
  });

  it('writes nothing for a page that is not a site', async () => {
    const { menus } = start();

    await menus.clicked(click(PROTECT_SITE_ID), tab('about:blank'));

    expect(await protectedDomainsItem.getValue()).toEqual([]);
  });
});

describe('“Consenti duplicati per questo sito”', () => {
  it('whitelists the host the user right-clicked on', async () => {
    const { menus } = start();

    await menus.clicked(click(ALLOW_DUPLICATES_ID), tab('https://www.example.com/a/b?c=d'));

    // The host and not the domain: a whitelist line is matched against the raw URL, and
    // `*://example.com/*` has nothing to match in `https://www.example.com/…`.
    expect(await duplicateWhitelistItem.getValue()).toEqual(['*://www.example.com/*']);
  });

  it('keeps the port, which the URL has too', () => {
    expect(duplicateWhitelistPattern('http://localhost:3000/dev')).toBe('*://localhost:3000/*');
  });

  it('has no pattern for a page that is not a site', () => {
    expect(duplicateWhitelistPattern('about:blank')).toBeNull();
    expect(duplicateWhitelistPattern('file:///C:/notes.txt')).toBeNull();
    expect(duplicateWhitelistPattern('not a url')).toBeNull();
  });

  it('does not write the same pattern twice', async () => {
    const { menus } = start();

    await menus.clicked(click(ALLOW_DUPLICATES_ID), tab('https://example.com/one'));
    await menus.clicked(click(ALLOW_DUPLICATES_ID), tab('https://example.com/two'));

    expect(await duplicateWhitelistItem.getValue()).toEqual(['*://example.com/*']);
  });

  it('leaves the patterns the user wrote where they were', async () => {
    await duplicateWhitelistItem.setValue(['/^https:\\/\\/news\\./i']);
    const { menus } = start();

    await menus.clicked(click(ALLOW_DUPLICATES_ID), tab('https://example.com/'));

    // Appended, and nothing re-cased: a whitelist line may be a case-sensitive regex.
    expect(await duplicateWhitelistItem.getValue()).toEqual([
      '/^https:\\/\\/news\\./i',
      '*://example.com/*',
    ]);
  });
});

describe('“Riapri l’ultimo duplicato chiuso”', () => {
  it('asks the guard to reopen it, with no page under the menu at all', async () => {
    const { menus, guard } = start();
    guard.reopens = entry('https://example.com/a');

    // The icon menu has no page and no tab: the tab it is about is the one that was closed.
    await menus.clicked(click(REOPEN_DUPLICATE_ID));

    expect(guard.asked).toEqual(['reopenLastDuplicate']);
  });

  it('writes no whitelist on its own', async () => {
    const { menus, guard } = start();
    guard.reopens = entry('https://example.com/a');

    await menus.clicked(click(REOPEN_DUPLICATE_ID));

    // One item reopens, the other reopens *and* allows: this is the first one.
    expect(await duplicateWhitelistItem.getValue()).toEqual([]);
  });

  it('does nothing when there is nothing to reopen', async () => {
    const { menus, guard } = start();
    guard.reopens = null;

    await menus.clicked(click(REOPEN_DUPLICATE_ID));

    expect(guard.asked).toEqual(['reopenLastDuplicate']);
    expect(await duplicateWhitelistItem.getValue()).toEqual([]);
  });
});

describe('“…e consenti sempre duplicati per questo sito”', () => {
  it('reopens the tab and whitelists the site it came from', async () => {
    const { menus, guard } = start();
    guard.reopens = entry('https://www.example.com/a?b=c');

    await menus.clicked(click(REOPEN_ALLOW_SITE_ID));

    expect(guard.asked).toEqual(['reopenLastDuplicate']);
    // The site comes from the archive entry: nothing else here knows which it was.
    expect(await duplicateWhitelistItem.getValue()).toEqual(['*://www.example.com/*']);
  });

  it('whitelists nothing when there was nothing to reopen', async () => {
    const { menus, guard } = start();
    guard.reopens = null;

    await menus.clicked(click(REOPEN_ALLOW_SITE_ID));

    expect(await duplicateWhitelistItem.getValue()).toEqual([]);
  });

  it('whitelists nothing for a reopened page that is not a site', async () => {
    const { menus, guard } = start();
    guard.reopens = entry('file:///C:/notes.txt');

    await menus.clicked(click(REOPEN_ALLOW_SITE_ID));

    expect(await duplicateWhitelistItem.getValue()).toEqual([]);
  });
});

describe('“Pausa protezione duplicati”', () => {
  it('pauses for the duration the item names', async () => {
    const { menus, guard } = start();

    await menus.clicked(click(PAUSE_15_MIN_ID));
    await menus.clicked(click(PAUSE_1_HOUR_ID));
    await menus.clicked(click(PAUSE_RESTART_ID));

    expect(guard.asked).toEqual([
      `pause:${String(PAUSE_15_MIN_MS)}`,
      `pause:${String(PAUSE_1_HOUR_MS)}`,
      // `null`: until the browser restarts, which needs no alarm.
      'pause:restart',
    ]);
  });

  it('does nothing for the parent, which only opens its submenu', async () => {
    const { menus, guard } = start();

    await menus.clicked(click(PAUSE_GUARD_ID));

    expect(guard.asked).toEqual([]);
  });
});

describe('a click the menus did not ask for', () => {
  it('is ignored, and writes nothing anywhere', async () => {
    const { menus } = start();

    // Another extension's item, or one of ours from a version that had more.
    await menus.clicked(click('some-other-extension-item'), tab('https://example.com/'));

    expect(await keepsItem.getValue()).toEqual({});
    expect(await protectedDomainsItem.getValue()).toEqual([]);
    expect(await duplicateWhitelistItem.getValue()).toEqual([]);
  });
});

describe('the namespace the browser keeps the menus in', () => {
  /** `fakeBrowser` has no `menus`, the name Firefox uses; this adds one for a test. */
  function withMenusNamespace(api: MenusApi): void {
    (fakeBrowser as unknown as { menus?: MenusApi }).menus = api;
  }

  afterEach(() => {
    delete (fakeBrowser as unknown as { menus?: MenusApi }).menus;
  });

  it('prefers `menus`, which is the only one Firefox gives us', async () => {
    // With the `menus` permission of PLAN.md §5.4 Firefox defines no `contextMenus`
    // alias, and a top-level read of it took the whole background script down.
    const firefox = recorder();
    withMenusNamespace(firefox);

    await registerMenus({ guard: guardRecorder(), now: () => NOW, tabContext: true }).install();

    expect(firefox.created).toHaveLength(ALL_ITEMS);
  });

  it('keeps working when there is no menus API at all', async () => {
    const complained = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const removed = (fakeBrowser as unknown as { contextMenus?: unknown }).contextMenus;
    delete (fakeBrowser as unknown as { contextMenus?: unknown }).contextMenus;
    try {
      // No throw: items the browser will not show are not worth the background script,
      // which also runs the tracker, the badge and the cleanup.
      const menus = registerMenus({ guard: guardRecorder(), now: () => NOW });
      await menus.install();
      await menus.clicked(click(KEEP_ALWAYS_ID), tab('https://example.com/'));

      expect(complained).toHaveBeenCalledOnce();
      // The click still did its work: only the items could not be created.
      expect(Object.keys(await keepsItem.getValue())).toHaveLength(1);
    } finally {
      (fakeBrowser as unknown as { contextMenus?: unknown }).contextMenus = removed;
    }
  });
});

describe('the click listener', () => {
  it('is registered at once, so a woken worker is already listening', async () => {
    // No `install()` and no `onInstalled`: registration alone has to leave the background
    // ready for the click that woke it (invariant 6).
    const { api } = start();

    api.clickThrough(click(PROTECT_SITE_ID, 'https://example.com/'));
    await settle();

    expect(await protectedDomainsItem.getValue()).toEqual(['example.com']);
  });
});
