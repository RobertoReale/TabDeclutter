/**
 * The tabs, as the extension sees them and acts on them (PLAN.md §5.3, §9).
 *
 * `src/core/` reasons about `TabInfo` and never about a `browser.tabs.Tab`
 * (invariant 4), so the mapping between the two lives here, in one place, for both
 * browsers: the panel reads the tabs through `queryTabs()` and the fields it keeps are
 * exactly the ones the rules look at.
 *
 * The actions of PLAN.md §9 live here too, for the same reason: `core/actions.ts` decides
 * what goes in the archive and what the user has to confirm, and this file is the only
 * part that talks to the browser. Two rules hold for every one of them:
 *
 * - **the archive is written before the tabs are gone** (invariant 3), in one write per
 *   action (PLAN.md §10), so a close that fails half-way is still a close that can be
 *   undone;
 * - **a call that fails because the thing is already gone is not an error** (PLAN.md
 *   §8.6): a tab the user closed in the meantime, a window that went with it, a group
 *   that no longer exists. `attempt()` below is that rule.
 *
 * The API is a parameter with a default, which is how everything in `src/platform/` is
 * written: the extension gets `browser`, a test gets its own object and no extension
 * context is needed to check what we call and with what.
 */

import type { Capabilities } from './capabilities';
import { caps } from './capabilities';
import {
  addExemptions,
  addKeep,
  addProtectedDomain,
  addToArchive,
  removeFromArchive,
} from './storage';
import { archiveEntries, planRestores } from '../core/actions';
import type { ArchivedTab, ArchiveReason, TabInfo } from '../core/types';
import { DEFAULT_KEEP_MS, NO_GROUP_ID } from '../core/types';
import { registrableDomain } from '../core/url';

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
    /** One tab. Rejects on Chrome, resolves with nothing on Firefox, when it is gone. */
    get(tabId: number): Promise<BrowserTab | undefined>;
    update(tabId: number, properties: { active?: boolean; url?: string }): Promise<unknown>;
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

/**
 * `sessions.MAX_SESSION_RESULTS`: the most entries either browser will report, and the
 * window PLAN.md §9 restores inside ("the last 25 closed tabs").
 */
export const MAX_SESSION_RESULTS = 25;

/** A tab group, as both browsers report it (PLAN.md §5.5 "Tab groups"). */
export interface BrowserTabGroup {
  id?: number;
  windowId?: number;
  title?: string;
}

/** One entry of `sessions.getRecentlyClosed`: a closed tab, or a whole closed window. */
export interface ClosedSession {
  tab?: BrowserTab & { sessionId?: string };
  window?: unknown;
}

/** The API the actions of PLAN.md §9 need, on top of what reading the tabs needs. */
export interface ActionsApi extends TabsApi {
  tabs: TabsApi['tabs'] & {
    create(properties: {
      url: string;
      windowId?: number;
      index?: number;
      active: boolean;
    }): Promise<BrowserTab>;
    remove(tabIds: readonly number[]): Promise<unknown>;
    move(tabId: number, properties: { windowId?: number; index: number }): Promise<unknown>;
    discard(tabId: number): Promise<unknown>;
    group(options: { tabIds: readonly number[]; groupId: number }): Promise<unknown>;
  };
  windows: TabsApi['windows'] & {
    remove(windowId: number): Promise<unknown>;
  };
  /** Absent where there are no native tab groups (`capabilities.tabGroups`). */
  tabGroups?: {
    query(query: Record<string, unknown>): Promise<BrowserTabGroup[]>;
  };
  /** Absent in a browser that does not grant `sessions`. */
  sessions?: {
    getRecentlyClosed(filter: { maxResults: number }): Promise<ClosedSession[]>;
    restore(sessionId: string): Promise<{ tab?: BrowserTab } | undefined>;
  };
}

function actionsApi(): ActionsApi {
  return browser as unknown as ActionsApi;
}

/** What every action takes: the API to call and the capabilities to respect. */
export interface ActionContext {
  readonly api?: ActionsApi;
  readonly capabilities?: Capabilities;
}

/** The outcome of a call that is allowed to fail because the thing is already gone. */
export type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/**
 * Runs a browser call and reports failure instead of throwing (PLAN.md §8.6: "Tab closed
 * in the meantime (`tabs.remove` fails) | Ignore the error and rebuild the index").
 *
 * A discriminated result rather than `undefined` for failure, because several of these
 * calls resolve with `undefined` when they succeed: Firefox's `tabs.discard` is one, so
 * "did it work" cannot be read off the value.
 *
 * Exported because the same rule governs applying and undoing groups (PLAN.md §7.4, "a
 * tab closed in the meantime"), and one definition of "already gone is not an error" is
 * worth more than a second copy of these six lines in `groups.ts`.
 */
export async function attempt<T>(action: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await action() };
  } catch {
    // The tab, window or group is gone — which is the state the caller wanted anyway.
    return { ok: false };
  }
}

/**
 * `groupId` → title, for the groups the given tabs are in (PLAN.md §5.5): what an archive
 * entry keeps so a restore can find the group again by name.
 *
 * Nothing is asked of a browser without native tab groups, and nothing when no tab is in
 * one — the common case, and one query saved on every close.
 */
export async function groupTitlesOf(
  tabs: readonly TabInfo[],
  context: ActionContext = {},
): Promise<ReadonlyMap<number, string>> {
  const titles = new Map<number, string>();
  const capabilities = context.capabilities ?? caps;
  if (!capabilities.tabGroups) return titles;
  if (!tabs.some((tab) => tab.groupId !== NO_GROUP_ID)) return titles;

  const api = context.api ?? actionsApi();
  const found = await attempt(async () => (await api.tabGroups?.query({})) ?? []);
  if (!found.ok) return titles;
  for (const group of found.value) {
    if (group.id === undefined || group.title === undefined || group.title === '') continue;
    titles.set(group.id, group.title);
  }
  return titles;
}

export interface CloseOptions extends ActionContext {
  /** Why the tabs are going; `'manual'` unless the guard or a window close says otherwise. */
  readonly reason?: ArchiveReason;
  /** For a `duplicate-*` close: tab id → the URL of the tab kept instead. */
  readonly duplicateOfUrl?: ReadonlyMap<number, string>;
}

/**
 * "Chiudi" (PLAN.md §9): the tabs go to the archive, then they go.
 *
 * In that order, and not the other way round: invariant 3 says no tab is closed without
 * being recoverable, so a close that is interrupted after the write is a close the user
 * can undo, while one interrupted before the write would be a tab lost. Both halves are a
 * single call — one storage write (PLAN.md §10) and one `tabs.remove` with every id — so
 * the browser animates it as one action and `onRemoved` arrives as one burst.
 *
 * Returns the entries written, which is what an "Annulla" toast needs to hand back to
 * `restoreTabs`.
 */
export async function closeTabs(
  tabs: readonly TabInfo[],
  now: number,
  options: CloseOptions = {},
): Promise<readonly ArchivedTab[]> {
  if (tabs.length === 0) return [];
  const api = options.api ?? actionsApi();

  const entries = archiveEntries(tabs, now, {
    ...(options.reason === undefined ? {} : { reason: options.reason }),
    ...(options.duplicateOfUrl === undefined ? {} : { duplicateOfUrl: options.duplicateOfUrl }),
    groupTitles: await groupTitlesOf(tabs, options),
  });
  await addToArchive(entries);
  // One call for the batch: a tab the user closed a moment ago makes the whole call fail
  // on Chrome, so the ids are tried again one by one rather than left open.
  const removed = await attempt(() => api.tabs.remove(tabs.map((tab) => tab.id)));
  if (!removed.ok) {
    for (const tab of tabs) await attempt(() => api.tabs.remove([tab.id]));
  }
  return entries;
}

/**
 * "Chiudi la finestra" (PLAN.md §9): every tab of the window is archived, then the window
 * is closed.
 *
 * `tabs` is the whole tab list, not the window's: the window's own tabs are picked out of
 * it here, so a caller never has to query again. Archiving them with `reason: 'window'`
 * is what lets the Archive view offer "restore the window" later.
 */
export async function closeWindow(
  windowId: number,
  tabs: readonly TabInfo[],
  now: number,
  options: ActionContext = {},
): Promise<readonly ArchivedTab[]> {
  const api = options.api ?? actionsApi();
  const inWindow = tabs.filter((tab) => tab.windowId === windowId);
  // No tab of ours in it: a window we cannot archive is a window we do not close.
  if (inWindow.length === 0) return [];

  const entries = archiveEntries(inWindow, now, {
    reason: 'window',
    groupTitles: await groupTitlesOf(inWindow, options),
  });
  await addToArchive(entries);
  await attempt(() => api.windows.remove(windowId));
  return entries;
}

/**
 * "Annulla" and "Ripristina" (PLAN.md §9), which are one operation: an archive entry goes
 * back to being a tab, and leaves the archive.
 *
 * The browser's own memory of the close is preferred — `sessions.restore` brings back the
 * page's history and scroll position, which `tabs.create` cannot — and the last 25 closes
 * are all it keeps, so an older entry falls back to `tabs.create` with the window and
 * index it was closed at. A window that is gone makes that `create` fail, and it is tried
 * again in the current window, which is what §9 asks of a restore from the archive.
 *
 * The exemptions come in two writes and the first one happens **before** any tab exists
 * (PLAN.md §8.6): the duplicate guard reacts to `onCreated`, so a restore that registered
 * itself afterwards would race the guard and could have its tab closed again. The URL is
 * known in advance and is enough to recognise the tab; the id is only known afterwards,
 * and is written then so a tab that navigates away still stays exempt.
 *
 * Only the entries that came back are removed from the archive: one that could not be
 * restored is still a tab the user may want, and leaving it there is the recoverable half
 * of the failure.
 */
export async function restoreTabs(
  entries: readonly ArchivedTab[],
  now: number,
  options: ActionContext = {},
): Promise<readonly number[]> {
  if (entries.length === 0) return [];
  const api = options.api ?? actionsApi();

  await addExemptions(
    entries.map((entry) => ({ url: entry.url })),
    now,
  );

  const closed = await attempt(
    async () => (await api.sessions?.getRecentlyClosed({ maxResults: MAX_SESSION_RESULTS })) ?? [],
  );
  const steps = planRestores(
    entries,
    (closed.ok ? closed.value : [])
      .map((session) => session.tab)
      .filter((tab): tab is BrowserTab & { sessionId?: string } => tab !== undefined)
      .map((tab) => ({
        ...(tab.sessionId === undefined ? {} : { sessionId: tab.sessionId }),
        ...(tab.url === undefined ? {} : { url: tab.url }),
      })),
  );

  const restoredIds: number[] = [];
  const restoredEntryIds: string[] = [];
  for (const step of steps) {
    const tab = await restoreOne(step, api);
    if (tab === null) continue;
    restoredEntryIds.push(step.entry.id);
    if (tab.id !== undefined) {
      restoredIds.push(tab.id);
      await regroup(tab, step.entry.groupTitle, api, options.capabilities ?? caps);
    }
  }

  await addExemptions(
    restoredIds.map((tabId) => ({ tabId })),
    now,
  );
  await removeFromArchive(restoredEntryIds);
  return restoredIds;
}

/**
 * One archive entry back on screen, or `null` when neither route worked.
 *
 * Restored tabs are created inactive: a restore of twenty tabs must not walk the user
 * through twenty pages, and "Annulla" puts back what was there without changing where
 * they are.
 */
async function restoreOne(
  step: { readonly entry: ArchivedTab; readonly sessionId?: string },
  api: ActionsApi,
): Promise<BrowserTab | null> {
  const sessions = api.sessions;
  const sessionId = step.sessionId;
  if (sessions !== undefined && sessionId !== undefined) {
    const session = await attempt(() => sessions.restore(sessionId));
    // Chrome resolves with the session it restored; Firefox's own `restore` does too, but
    // an older build may resolve with nothing, and the tab is back either way.
    if (session.ok) return session.value?.tab ?? {};
  }

  const entry = step.entry;
  const created = await attempt(() =>
    api.tabs.create({
      url: entry.url,
      windowId: entry.windowId,
      index: entry.index,
      active: false,
    }),
  );
  if (created.ok) return created.value;

  // The window it was closed from is gone: PLAN.md §9 puts the tab in the current one.
  const fallback = await attempt(() => api.tabs.create({ url: entry.url, active: false }));
  return fallback.ok ? fallback.value : null;
}

/**
 * Puts a restored tab back in its group, found by title (PLAN.md §5.5).
 *
 * By title and not by id, because a group id does not survive a restart and Firefox's
 * `sessions` never reports one. The titles are compared here, exactly, rather than through
 * `tabGroups.query({ title })`: Chrome treats that filter as a **pattern**, so a group
 * called "Work *" would match groups the user never meant. A group in the tab's own window
 * wins over one with the same name elsewhere; a group that no longer exists leaves the tab
 * where it is, ungrouped, which is the honest result of a group the user deleted.
 */
async function regroup(
  tab: BrowserTab,
  groupTitle: string | undefined,
  api: ActionsApi,
  capabilities: Capabilities,
): Promise<void> {
  if (groupTitle === undefined || tab.id === undefined) return;
  if (!capabilities.tabGroups) return;

  const found = await attempt(async () => (await api.tabGroups?.query({})) ?? []);
  if (!found.ok) return;
  const matching = found.value.filter(
    (group) => group.id !== undefined && group.title === groupTitle,
  );
  const group = matching.find((candidate) => candidate.windowId === tab.windowId) ?? matching[0];
  if (group?.id === undefined) return;

  const tabId = tab.id;
  const groupId = group.id;
  await attempt(() => api.tabs.group({ tabIds: [tabId], groupId }));
}

/**
 * "Mantieni" (PLAN.md §9): the page stops being suggested, for seven days or for good.
 *
 * The choice is a boolean rather than a duration because §9 offers exactly two: the
 * default of §6.4 and "Sempre".
 */
export async function keepTab(url: string, now: number, forever = false): Promise<void> {
  await addKeep(url, now, forever ? null : DEFAULT_KEEP_MS);
}

/**
 * "Proteggi il sito" (PLAN.md §9): the tab's registrable domain joins "Siti protetti".
 *
 * Returns the domain that was added, or `null` for a URL that has none — `about:debugging`
 * is not a site, and silently adding nothing is better than adding `about`.
 */
export async function protectSite(url: string): Promise<string | null> {
  const domain = registrableDomain(url);
  if (domain === null || domain === '') return null;
  await addProtectedDomain(domain);
  return domain;
}

/**
 * "Sospendi" (PLAN.md §9, §5.5): the tab lets go of its memory and keeps its place.
 *
 * Two tabs are never discarded: the active one, which would reload under the user, and one
 * already discarded. Both are checked here rather than left to the browser, because
 * Chrome rejects the call and Firefox quietly does nothing, and the caller needs the same
 * answer on both. `false` also means the browser refused — a tab playing audio, or one
 * that cannot be discarded at all.
 */
export async function discardTab(
  tab: Pick<TabInfo, 'id' | 'active' | 'discarded'>,
  options: ActionContext = {},
): Promise<boolean> {
  if (tab.active || tab.discarded) return false;
  const api = options.api ?? actionsApi();
  const discarded = await attempt(() => api.tabs.discard(tab.id));
  return discarded.ok;
}

/**
 * One tab as the core sees it, or `null` when it is not there to be acted on.
 *
 * The guard re-reads a tab between deciding about it and touching it (PLAN.md §8.6, "Tab
 * closed in the meantime"), and the two browsers disagree about what gone looks like:
 * Chrome rejects the call, Firefox resolves with nothing. Both answer `null` here, and so
 * does a tab another extension has hidden — for the same reason `asTabInfos` drops it, it
 * is not on screen (PLAN.md §5.5).
 */
export async function getTab(tabId: number, tabsApi: TabsApi = api()): Promise<TabInfo | null> {
  const found = await attempt(() => tabsApi.tabs.get(tabId));
  if (!found.ok || found.value === undefined) return null;
  const [tab] = asTabInfos([found.value]);
  return tab ?? null;
}

/**
 * "Sposta e attiva" (PLAN.md §8.4.4), the moving half: the tab that stays takes the place
 * of the one that went.
 *
 * `NO_WINDOW` means "leave it where it is and only change the index", which is what a
 * closed tab with no window of its own can ask for. Failure is not an error: the tab, or
 * the window it was going to, may be gone by now.
 */
export async function moveTab(
  tabId: number,
  windowId: number,
  index: number,
  options: ActionContext = {},
): Promise<boolean> {
  const api = options.api ?? actionsApi();
  const moved = await attempt(() =>
    api.tabs.move(tabId, { ...(windowId === NO_WINDOW ? {} : { windowId }), index }),
  );
  return moved.ok;
}

/**
 * `reloadKeptWith` (PLAN.md §8.4.3.4): the tab that stays loads the URL that triggered the
 * close, which is the whole point of "Più vecchia ricaricata con la nuova URL".
 *
 * `tabs.update` and not `tabs.reload`: the tab is being sent to a *different* URL, one that
 * differs from its own in a part the comparison ignores.
 */
export async function navigateTab(
  tabId: number,
  url: string,
  tabsApi: TabsApi = api(),
): Promise<boolean> {
  const navigated = await attempt(() => tabsApi.tabs.update(tabId, { url }));
  return navigated.ok;
}
