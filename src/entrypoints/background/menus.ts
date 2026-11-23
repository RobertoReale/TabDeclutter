/**
 * The context menu on the page and on the tab strip, PLAN.md §4.1.
 *
 * Three items, which are the three standing decisions a user makes about a page they are
 * looking at, one right-click away instead of a trip through the panel:
 *
 * - "Mantieni sempre questa scheda" — the keep of §9, with no expiry ("Sempre");
 * - "Proteggi sempre questo sito" — the tab's registrable domain joins "Siti protetti";
 * - "Consenti duplicati per questo sito" — `*://<host>/*` joins the duplicate whitelist.
 *
 * None of them closes anything (invariant 2): all three only ever *add* a reason to leave
 * a tab alone, which is why they are safe on a surface where a mis-click is one pixel
 * away from the page's own menu.
 *
 * **Why `onInstalled` and not every startup.** Menu items are the browser's, not ours: it
 * keeps them while the extension is installed and clears them when it updates, so the one
 * moment they have to be created is the one `onInstalled` names. A service worker that
 * wakes for a click must not have to rebuild them first — and could not, since it wakes
 * *because* of the click (PLAN.md §5.2, invariant 6). `removeAll` comes first because an
 * update fires `onInstalled` with the previous version's items possibly still there, and
 * `create` with an id that already exists is an error.
 *
 * **The contexts.** `page` on both browsers, plus `tab` where it exists: Chrome has no
 * `tab` context and rejects the whole `create` call when it is named, so the capability
 * decides (PLAN.md §5.5, `caps.tabContextMenu`). Nothing here asks what browser it is.
 *
 * **The menu on the icon** (`contexts: ['action']`, PLAN.md §4.1) is the guard's, and holds
 * what §8.5 and §8.7 ask for: reopening the last duplicate closed, reopening it and
 * whitelisting its site in one move, and pausing the protection for a while. It is on the
 * icon and not on the page because none of the three is about the page in front of the user
 * — a tab that is gone has no page left to right-click.
 */

import { HOUR, MINUTE } from '@/core/time';
import { caps } from '@/platform/capabilities';
import { t } from '@/platform/i18n';
import type { MessageKey } from '@/platform/i18n';
import { addDuplicateWhitelistPattern } from '@/platform/storage';
import { keepTab, protectSite } from '@/platform/tabs';

import type { GuardActions } from './guard';
import { backgroundError } from './report';

/** The ids are ours and stable: `onClicked` reports the one that was chosen. */
export const KEEP_ALWAYS_ID = 'keep-always';
export const PROTECT_SITE_ID = 'protect-site';
export const ALLOW_DUPLICATES_ID = 'allow-duplicates';
export const REOPEN_DUPLICATE_ID = 'reopen-duplicate';
export const REOPEN_ALLOW_SITE_ID = 'reopen-allow-site';
export const PAUSE_GUARD_ID = 'pause-guard';
export const PAUSE_15_MIN_ID = 'pause-guard-15m';
export const PAUSE_1_HOUR_ID = 'pause-guard-1h';
export const PAUSE_RESTART_ID = 'pause-guard-restart';

/** The two timed pauses of PLAN.md §8.1. "Fino al riavvio" has no duration (`null`). */
export const PAUSE_15_MIN_MS = 15 * MINUTE;
export const PAUSE_1_HOUR_MS = HOUR;

/** The three items, in the order they are shown, each with the key of its title. */
const ITEMS: readonly (readonly [string, MessageKey])[] = [
  [KEEP_ALWAYS_ID, 'menuKeepAlways'],
  [PROTECT_SITE_ID, 'menuProtectSite'],
  [ALLOW_DUPLICATES_ID, 'menuAllowDuplicates'],
];

/** The context of the menu on the icon, which is where the guard's items live. */
const ACTION_CONTEXTS: readonly string[] = ['action'];

/**
 * The icon menu, in order: the two reopens, then "Pausa protezione duplicati" with its
 * three durations under it.
 *
 * Every child names `ACTION_CONTEXTS` as well. Firefox defaults an item with no `contexts`
 * to `['page']`, which would file the children on the page menu instead of under their
 * parent; Chrome inherits the parent's, so saying it is right on both.
 */
const ACTION_ITEMS: readonly (readonly [string, MessageKey, string?])[] = [
  [REOPEN_DUPLICATE_ID, 'menuReopenDuplicate'],
  [REOPEN_ALLOW_SITE_ID, 'menuReopenAllowSite'],
  [PAUSE_GUARD_ID, 'menuPauseGuard'],
  [PAUSE_15_MIN_ID, 'menuPause15Min', PAUSE_GUARD_ID],
  [PAUSE_1_HOUR_ID, 'menuPause1Hour', PAUSE_GUARD_ID],
  [PAUSE_RESTART_ID, 'menuPauseRestart', PAUSE_GUARD_ID],
];

/** What one item is created with. The shape both browsers accept. */
export interface MenuItemProperties {
  readonly id: string;
  readonly title: string;
  readonly contexts: readonly string[];
  /** Only on a child of a submenu. */
  readonly parentId?: string | undefined;
}

/** What a click reports. `menuItemId` is typed wider than our ids by both browsers. */
export interface MenuClickInfo {
  readonly menuItemId: string | number;
  /** The URL of the page the menu was opened on. Absent on some internal pages. */
  readonly pageUrl?: string | undefined;
}

/** The part of the clicked tab this module reads. */
export interface ClickedTab {
  readonly url?: string | undefined;
}

/** The part of `browser.contextMenus` this module uses, so a test can supply its own. */
export interface MenusApi {
  create(properties: MenuItemProperties): void;
  removeAll(): Promise<void> | void;
  readonly onClicked: {
    addListener(listener: (info: MenuClickInfo, tab?: ClickedTab) => void): void;
  };
}

export interface MenusOptions {
  /** The guard, for the icon menu's items. The same object the shortcuts act on. */
  readonly guard: GuardActions;
  /** The clock, injected so a test can be exact about when a keep was made. */
  readonly now?: () => number;
  readonly api?: MenusApi;
  /** Whether the browser has a `tab` context. Defaults to `caps.tabContextMenu`. */
  readonly tabContext?: boolean;
}

export interface Menus {
  /** Creates the items, which is what `onInstalled` asks for. */
  install(): Promise<void>;
  /** Carries out one click. `onClicked` hands it exactly what it was given. */
  clicked(info: MenuClickInfo, tab?: ClickedTab): Promise<void>;
}

/**
 * Registers the menus. Called at the top level of the background, before any `await`,
 * because a worker woken by a click must already be listening for it (invariant 6).
 */
export function registerMenus(options: MenusOptions): Menus {
  const { guard } = options;
  const now = options.now ?? Date.now;
  const api = options.api ?? menusApi();
  const tabContext = options.tabContext ?? caps.tabContextMenu;
  const contexts = tabContext ? ['page', 'tab'] : ['page'];

  async function install(): Promise<void> {
    if (api === undefined) return;
    // The previous version's items, if the browser still holds them: `create` with an id
    // that already exists is an error, and an update fires `onInstalled`.
    await api.removeAll();
    for (const [id, titleKey] of ITEMS) api.create({ id, title: t(titleKey), contexts });
    // The parent before its children: `create` with a `parentId` that does not exist yet is
    // an error, and `ACTION_ITEMS` is in that order.
    for (const [id, titleKey, parentId] of ACTION_ITEMS) {
      api.create({ id, title: t(titleKey), contexts: ACTION_CONTEXTS, parentId });
    }
  }

  /**
   * The icon menu's items (PLAN.md §8.5, §8.7), which are about the guard and not about a
   * page. `true` when the click was one of them.
   *
   * Handled before the URL is looked at: the tab these act on is one the guard closed, so
   * there is no page under the menu and often no tab at all.
   */
  async function guardClicked(menuItemId: string | number): Promise<boolean> {
    if (menuItemId === REOPEN_DUPLICATE_ID || menuItemId === REOPEN_ALLOW_SITE_ID) {
      const entry = await guard.reopenLastDuplicate();
      if (menuItemId === REOPEN_ALLOW_SITE_ID && entry !== null) {
        const pattern = duplicateWhitelistPattern(entry.url);
        if (pattern !== null) await addDuplicateWhitelistPattern(pattern);
      }
      return true;
    }
    if (
      menuItemId === PAUSE_15_MIN_ID ||
      menuItemId === PAUSE_1_HOUR_ID ||
      menuItemId === PAUSE_RESTART_ID
    ) {
      await guard.pause(
        menuItemId === PAUSE_15_MIN_ID
          ? PAUSE_15_MIN_MS
          : menuItemId === PAUSE_1_HOUR_ID
            ? PAUSE_1_HOUR_MS
            : null,
      );
      return true;
    }
    return false;
  }

  async function clicked(info: MenuClickInfo, tab?: ClickedTab): Promise<void> {
    if (await guardClicked(info.menuItemId)) return;

    // The tab's own URL first: it is the page as the browser currently has it, while
    // `pageUrl` is the URL the menu was opened on. They differ only if the page navigated
    // with the menu open, and then the tab is what the user is now looking at. On the
    // `tab` context Firefox gives no `pageUrl` at all, so one of the two is needed anyway.
    const url = tab?.url ?? info.pageUrl ?? '';
    if (url === '') return;
    switch (info.menuItemId) {
      case KEEP_ALWAYS_ID:
        // `true`: the title says "sempre", which is the keep of §9 with no expiry.
        await keepTab(url, now(), true);
        return;
      case PROTECT_SITE_ID:
        // A URL with no registrable domain adds nothing, and says so by answering `null`.
        await protectSite(url);
        return;
      case ALLOW_DUPLICATES_ID: {
        const pattern = duplicateWhitelistPattern(url);
        if (pattern !== null) await addDuplicateWhitelistPattern(pattern);
        return;
      }
      // Another extension's item, or one of ours from a version that had more.
      default:
        return;
    }
  }

  // A profile with no menus API at all keeps the rest of the extension: three items the
  // browser will not show are not worth taking the background script down for.
  if (api === undefined) {
    console.error('TabDeclutter: menus', new Error('no menus API'));
    return { install, clicked };
  }

  api.onClicked.addListener((info, tab) => {
    void clicked(info, tab).catch(failed);
  });

  browser.runtime.onInstalled.addListener(() => {
    void install().catch(failed);
  });

  return { install, clicked };
}

/**
 * The whitelist pattern for a URL's site, `*://<host>/*` (PLAN.md §4.1), or `null` for a
 * URL that is not a site: `about:blank`, a `file:` path, something unparseable.
 *
 * **The host, with its port, and not the registrable domain.** A whitelist line is matched
 * against the tab's raw URL as a literal with `*` for any run of characters
 * (`core/patterns.ts`), so `*://example.com/*` does not match `https://www.example.com/x`
 * — it has no `://example.com/` in it. A pattern built from the registrable domain would
 * therefore fail to whitelist the very tab the user right-clicked, which is the one thing
 * the item has to do. The host is what the URL actually says, so the pattern covers that
 * site and leaves its siblings to another right-click (docs/DECISIONS.md, M3.4).
 */
export function duplicateWhitelistPattern(url: string): string | null {
  let host: string;
  try {
    // `host`, not `hostname`: it keeps the port, which the raw URL has too.
    host = new URL(url.trim()).host;
  } catch {
    return null;
  }
  if (host === '') return null;
  return `*://${host}/*`;
}

/**
 * WXT's `browser`, narrowed to what this module uses.
 *
 * `menus` first, then `contextMenus`: Firefox calls the namespace `menus` and only aliases
 * it as `contextMenus` for a profile that asked for the `contextMenus` permission, which
 * this manifest does not — it asks for `menus` (build/manifest.ts, PLAN.md §5.4). Reading
 * `contextMenus` alone is `undefined` there, and a top-level `undefined.onClicked` takes
 * the whole background script down with it, which is what the Firefox E2E caught.
 */
function menusApi(): MenusApi | undefined {
  const api = browser as unknown as {
    menus?: MenusApi | undefined;
    contextMenus?: MenusApi | undefined;
  };
  return api.menus ?? api.contextMenus;
}

const failed = backgroundError('menus');
