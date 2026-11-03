/**
 * The tabs, as the extension sees them and acts on them (PLAN.md §5.3).
 *
 * `src/core/` reasons about `TabInfo` and never about a `browser.tabs.Tab`
 * (invariant 4), so the mapping between the two lives here, in one place, for both
 * browsers: the panel reads the tabs through `queryTabs()` and the fields it keeps are
 * exactly the ones the rules look at.
 *
 * The API is a parameter with a default, which is how everything in `src/platform/` is
 * written: the extension gets `browser`, a test gets its own object and no extension
 * context is needed to check what we call and with what.
 */

import type { TabInfo } from '../core/types';
import { NO_GROUP_ID } from '../core/types';

/** `windows.WINDOW_ID_NONE`, for a tab that belongs to no window. */
export const NO_WINDOW = -1;

/**
 * What we need of a tab, whichever browser's type it came from. Everything is optional:
 * the two browsers disagree about what is always present, and a tab can arrive from an
 * event payload with most of it missing.
 */
export interface BrowserTab {
  id?: number;
  windowId?: number;
  index?: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  favIconUrl?: string;
  pinned?: boolean;
  audible?: boolean;
  active?: boolean;
  discarded?: boolean;
  hidden?: boolean;
  groupId?: number;
  cookieStoreId?: string;
  incognito?: boolean;
  openerTabId?: number;
  lastAccessed?: number;
}

/** The slice of the extension API this module uses. */
export interface TabsApi {
  tabs: {
    query(query: Record<string, unknown>): Promise<BrowserTab[]>;
    update(tabId: number, properties: { active: boolean }): Promise<unknown>;
  };
  windows: {
    update(windowId: number, properties: { focused: boolean }): Promise<unknown>;
  };
}

function api(): TabsApi {
  return browser as unknown as TabsApi;
}

/**
 * The tabs the core reasons about: the ones with an id, minus the ones another extension
 * hid, which PLAN.md §5.5 excludes everywhere. In the browser's own order, which is what
 * `tabs.query({})` returns and what the list uses to break ties.
 */
export function asTabInfos(browserTabs: readonly BrowserTab[]): readonly TabInfo[] {
  return browserTabs
    .filter((tab): tab is BrowserTab & { id: number } => tab.id !== undefined)
    .filter((tab) => tab.hidden !== true)
    .map((tab) => ({
      id: tab.id,
      windowId: tab.windowId ?? NO_WINDOW,
      index: tab.index ?? 0,
      url: tab.url ?? '',
      pendingUrl: tab.pendingUrl,
      title: tab.title ?? '',
      favIconUrl: tab.favIconUrl,
      pinned: tab.pinned === true,
      audible: tab.audible === true,
      active: tab.active === true,
      discarded: tab.discarded === true,
      hidden: false,
      groupId: tab.groupId ?? NO_GROUP_ID,
      cookieStoreId: tab.cookieStoreId,
      incognito: tab.incognito === true,
      openerTabId: tab.openerTabId,
      lastAccessed: tab.lastAccessed,
    }));
}

/** Every open tab, mapped. One call, no filter: the rules decide what to ignore. */
export async function queryTabs(tabsApi: TabsApi = api()): Promise<readonly TabInfo[]> {
  return asTabInfos(await tabsApi.tabs.query({}));
}

/**
 * "Vai" (PLAN.md §4.3): the tab becomes the active one of its window, and the window
 * comes to the front — on its own, activating a tab in another window leaves the user
 * looking at the window they were already in.
 *
 * The window is focused after the tab is activated, so the window that comes forward is
 * already showing the right page. A tab that belongs to no window (`NO_WINDOW`, which is
 * what a tab in a tab strip being moved reports) is only activated.
 */
export async function activateTab(
  tabId: number,
  windowId: number,
  tabsApi: TabsApi = api(),
): Promise<void> {
  await tabsApi.tabs.update(tabId, { active: true });
  if (windowId !== NO_WINDOW) await tabsApi.windows.update(windowId, { focused: true });
}
