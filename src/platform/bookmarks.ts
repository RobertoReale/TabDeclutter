/**
 * The bookmarks, behind the optional permission of PLAN.md §5.4.
 *
 * They are one signal of the score — "Already bookmarked +10" (§6.4): a page that is saved is
 * easier to close, because closing it loses nothing. Nothing else reads them, nothing is written
 * back, and the extension asks for the permission only when the user turns the setting on
 * (§4.6), inside the click that turns it on — Chrome and Firefox both grant
 * `permissions.request` only from a user gesture.
 *
 * The whole tree is walked once and kept as a set of `keepKey`s, invalidated by the bookmarks
 * events: the panel re-reads its state on every tab event (150 ms debounced), and a person with
 * thousands of bookmarks must not pay for that walk each time (PLAN.md §11).
 */

import { keepKey } from '@/core/scoring';

/** What `permissions.request` takes, with only the field this module uses. */
export interface PermissionRequest {
  readonly permissions: readonly string[];
}

/** The optional permission, as both manifests declare it (PLAN.md §5.4). */
const BOOKMARKS: PermissionRequest = { permissions: ['bookmarks'] };

/** A node of `bookmarks.getTree()`: a folder has children, a bookmark has a URL. */
interface BookmarkNode {
  readonly url?: string;
  readonly children?: readonly BookmarkNode[];
}

/** The part of the browser this module uses, so a test can hand in its own. */
export interface BookmarksApi {
  readonly permissions: {
    contains(permissions: PermissionRequest): Promise<boolean>;
    request(permissions: PermissionRequest): Promise<boolean>;
    remove(permissions: PermissionRequest): Promise<boolean>;
    readonly onAdded?: { addListener(listener: () => void): void };
    readonly onRemoved?: { addListener(listener: () => void): void };
  };
  readonly bookmarks?: {
    getTree(): Promise<readonly BookmarkNode[]>;
    readonly onCreated?: { addListener(listener: () => void): void };
    readonly onRemoved?: { addListener(listener: () => void): void };
    readonly onChanged?: { addListener(listener: () => void): void };
    readonly onMoved?: { addListener(listener: () => void): void };
  };
}

function api(given?: BookmarksApi): BookmarksApi {
  return given ?? (browser as unknown as BookmarksApi);
}

/** Whether the permission has already been granted. */
export async function hasBookmarksPermission(given?: BookmarksApi): Promise<boolean> {
  try {
    return await api(given).permissions.contains(BOOKMARKS);
  } catch {
    return false;
  }
}

/**
 * Asks for the permission. **Call it synchronously from the event handler**: an `await` before
 * it spends the user gesture and the browser refuses the request.
 */
export function requestBookmarksPermission(given?: BookmarksApi): Promise<boolean> {
  forget();
  return api(given).permissions.request(BOOKMARKS);
}

/**
 * Gives the permission back when the setting is turned off (PLAN.md §12.1: hold no access that
 * is not being used). A browser that refuses to drop it is not an error here — the setting is
 * off either way, so the bookmarks are no longer read.
 */
export async function removeBookmarksPermission(given?: BookmarksApi): Promise<boolean> {
  forget();
  try {
    return await api(given).permissions.remove(BOOKMARKS);
  } catch {
    return false;
  }
}

/**
 * Every bookmarked URL, by `keepKey`, which is how `core/scoring.ts` looks one up.
 *
 * An empty set when the permission was never granted, when the browser hides the API without
 * it, or when the walk fails: the signal is worth +10 out of 100 and is not worth a broken
 * panel.
 */
export async function bookmarkedKeys(given?: BookmarksApi): Promise<ReadonlySet<string>> {
  if (cache !== null) return cache;
  const browserApi = api(given);
  // The answer is cached whatever it is, including "no permission": the panel asks on every
  // refresh, and a grant made elsewhere arrives through `permissions.onAdded` below.
  watchPermissions(browserApi);
  cache = EMPTY;

  if (!(await hasBookmarksPermission(browserApi))) return EMPTY;
  const bookmarks = browserApi.bookmarks;
  if (bookmarks === undefined) return EMPTY;

  try {
    const keys = new Set<string>();
    collect(await bookmarks.getTree(), keys);
    watch(bookmarks);
    cache = keys;
    return keys;
  } catch {
    return EMPTY;
  }
}

/** Drops the cached set, so the next read walks the tree again. */
export function forget(): void {
  cache = null;
}

const EMPTY: ReadonlySet<string> = new Set<string>();

/** The walked tree, until a bookmark changes. */
let cache: ReadonlySet<string> | null = null;

/** Whether the invalidating listeners are in place. Registered once per context. */
let watching = false;

/** The same, for the permission itself, which can be granted or revoked from the browser's UI. */
let watchingPermissions = false;

function watchPermissions(browserApi: BookmarksApi): void {
  if (watchingPermissions) return;
  watchingPermissions = true;
  browserApi.permissions.onAdded?.addListener(forget);
  browserApi.permissions.onRemoved?.addListener(forget);
}

function collect(nodes: readonly BookmarkNode[], into: Set<string>): void {
  for (const node of nodes) {
    if (node.url !== undefined && node.url !== '') into.add(keepKey(node.url));
    if (node.children !== undefined) collect(node.children, into);
  }
}

/**
 * Keeps the cache honest: a bookmark added or removed while the panel is open changes the
 * score, and the panel already re-reads on `storage.onChanged` and on the tab events.
 */
function watch(bookmarks: NonNullable<BookmarksApi['bookmarks']>): void {
  if (watching) return;
  watching = true;
  for (const event of [
    bookmarks.onCreated,
    bookmarks.onRemoved,
    bookmarks.onChanged,
    bookmarks.onMoved,
  ]) {
    event?.addListener(forget);
  }
}

/** Forgets the listeners too, which only a test needs. */
export function resetBookmarks(): void {
  cache = null;
  watching = false;
  watchingPermissions = false;
}
