/**
 * The bookmarks behind the optional permission (PLAN.md §5.4, §6.4's "+10").
 *
 * The browser is a hand-made `BookmarksApi` (TASKS.md §2.4: every seam is a parameter), so what
 * is checked is the contract the panel depends on — nothing is read without the permission, the
 * request happens inside the gesture, the tree is walked once, and every event that can change
 * the answer drops the cache.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { keepKey } from '../../src/core/scoring';
import type { BookmarksApi, PermissionRequest } from '../../src/platform/bookmarks';
import {
  bookmarkedKeys,
  hasBookmarksPermission,
  removeBookmarksPermission,
  requestBookmarksPermission,
  resetBookmarks,
} from '../../src/platform/bookmarks';

/** A browser that records what it was asked and fires the events a test wants. */
function fake(options: {
  readonly granted?: boolean;
  readonly tree?: unknown;
  readonly failTree?: boolean;
  readonly noBookmarks?: boolean;
}) {
  const calls = { contains: 0, request: 0, remove: 0, getTree: 0 };
  const asked: PermissionRequest[] = [];
  const listeners: Record<string, (() => void)[]> = {};
  const event = (name: string) => ({
    addListener(listener: () => void): void {
      (listeners[name] ??= []).push(listener);
    },
  });
  let granted = options.granted ?? false;

  const api: BookmarksApi = {
    permissions: {
      contains(permissions) {
        calls.contains += 1;
        asked.push(permissions);
        return Promise.resolve(granted);
      },
      request(permissions) {
        calls.request += 1;
        asked.push(permissions);
        granted = options.granted ?? false;
        return Promise.resolve(granted);
      },
      remove(permissions) {
        calls.remove += 1;
        asked.push(permissions);
        granted = false;
        return Promise.resolve(true);
      },
      onAdded: event('permissionAdded'),
      onRemoved: event('permissionRemoved'),
    },
    bookmarks: options.noBookmarks
      ? undefined
      : {
          getTree() {
            calls.getTree += 1;
            if (options.failTree === true) return Promise.reject(new Error('no'));
            return Promise.resolve((options.tree ?? []) as readonly { readonly url?: string }[]);
          },
          onCreated: event('created'),
          onRemoved: event('removed'),
          onChanged: event('changed'),
          onMoved: event('moved'),
        },
  };

  return {
    api,
    calls,
    asked,
    /** Fires one of the browser's events, the way the browser would. */
    fire(name: string): void {
      for (const listener of listeners[name] ?? []) listener();
    },
    names: (): string[] => Object.keys(listeners),
  };
}

/** Two bookmarks in a folder and one at the root, which is what `getTree` hands back. */
const TREE = [
  {
    children: [
      { url: 'https://example.com/doc' },
      { title: 'Folder', children: [{ url: 'https://news.example/one?utm_source=x' }] },
      { title: 'Not a bookmark', url: '' },
    ],
  },
  { url: 'https://other.example/' },
];

/** The cache and the listener flags are module state. */
beforeEach(() => {
  resetBookmarks();
});

describe('the permission', () => {
  it('is asked about with exactly the one of §5.4', async () => {
    const browserApi = fake({ granted: true });

    expect(await hasBookmarksPermission(browserApi.api)).toBe(true);
    expect(browserApi.asked).toEqual([{ permissions: ['bookmarks'] }]);
  });

  it('is "no" when the browser throws, which a Firefox without it does', async () => {
    const api: BookmarksApi = {
      permissions: {
        contains() {
          throw new Error('unsupported');
        },
        request: () => Promise.resolve(false),
        remove: () => Promise.resolve(false),
      },
    };

    expect(await hasBookmarksPermission(api)).toBe(false);
  });

  it('is requested without anything awaited first, so the gesture is still ours', () => {
    const browserApi = fake({ granted: true });

    // Synchronous on purpose: the call happens before this expression is even awaited.
    const answer = requestBookmarksPermission(browserApi.api);

    expect(browserApi.calls.request).toBe(1);
    expect(browserApi.calls.contains).toBe(0);
    return expect(answer).resolves.toBe(true);
  });

  it('is given back when the setting is turned off (§12.1)', async () => {
    const browserApi = fake({ granted: true });

    expect(await removeBookmarksPermission(browserApi.api)).toBe(true);
    expect(browserApi.calls.remove).toBe(1);
  });

  it('is reported as dropped even when the browser refuses to drop it', async () => {
    const api: BookmarksApi = {
      permissions: {
        contains: () => Promise.resolve(true),
        request: () => Promise.resolve(true),
        remove() {
          throw new Error('required');
        },
      },
    };

    expect(await removeBookmarksPermission(api)).toBe(false);
  });
});

describe('the bookmarked URLs', () => {
  it('are empty, and unread, without the permission', async () => {
    const browserApi = fake({ granted: false, tree: TREE });

    expect(await bookmarkedKeys(browserApi.api)).toEqual(new Set());
    expect(browserApi.calls.getTree).toBe(0);
  });

  it('are every URL of the tree, by the key the score looks up', async () => {
    const browserApi = fake({ granted: true, tree: TREE });

    expect(await bookmarkedKeys(browserApi.api)).toEqual(
      new Set([
        keepKey('https://example.com/doc'),
        keepKey('https://news.example/one?utm_source=x'),
        keepKey('https://other.example/'),
      ]),
    );
  });

  it('are empty when the browser hides the API despite the permission', async () => {
    const browserApi = fake({ granted: true, noBookmarks: true });

    expect(await bookmarkedKeys(browserApi.api)).toEqual(new Set());
  });

  it('are empty when the walk fails, because +10 is not worth a broken panel', async () => {
    const browserApi = fake({ granted: true, failTree: true });

    expect(await bookmarkedKeys(browserApi.api)).toEqual(new Set());
  });
});

describe('the cache (PLAN.md §11)', () => {
  it('walks the tree once, however often the panel re-reads', async () => {
    const browserApi = fake({ granted: true, tree: TREE });

    await bookmarkedKeys(browserApi.api);
    await bookmarkedKeys(browserApi.api);
    await bookmarkedKeys(browserApi.api);

    expect(browserApi.calls.getTree).toBe(1);
  });

  it('is dropped by a bookmark changing while the panel is open', async () => {
    const browserApi = fake({ granted: true, tree: TREE });
    await bookmarkedKeys(browserApi.api);

    for (const name of ['created', 'removed', 'changed', 'moved']) {
      browserApi.fire(name);
      await bookmarkedKeys(browserApi.api);
    }

    expect(browserApi.calls.getTree).toBe(5);
  });

  it('is dropped by the permission being granted or revoked elsewhere', async () => {
    const browserApi = fake({ granted: false, tree: TREE });

    expect(await bookmarkedKeys(browserApi.api)).toEqual(new Set());
    // "No permission" is cached too, so without the event the panel would stay empty.
    expect(await bookmarkedKeys(browserApi.api)).toEqual(new Set());
    expect(browserApi.calls.contains).toBe(1);

    browserApi.fire('permissionAdded');
    await bookmarkedKeys(browserApi.api);
    expect(browserApi.calls.contains).toBe(2);

    browserApi.fire('permissionRemoved');
    await bookmarkedKeys(browserApi.api);
    expect(browserApi.calls.contains).toBe(3);
  });

  it('is dropped by the request itself, so the answer is not the stale one', async () => {
    const browserApi = fake({ granted: true, tree: TREE });
    await bookmarkedKeys(browserApi.api);

    await requestBookmarksPermission(browserApi.api);
    await bookmarkedKeys(browserApi.api);

    expect(browserApi.calls.getTree).toBe(2);
  });

  it('survives a browser without the events, which is not an error', async () => {
    const api: BookmarksApi = {
      permissions: {
        contains: () => Promise.resolve(true),
        request: () => Promise.resolve(true),
        remove: () => Promise.resolve(true),
      },
      bookmarks: {
        getTree: () => Promise.resolve([{ url: 'https://example.com/doc' }]),
      },
    };

    expect(await bookmarkedKeys(api)).toEqual(new Set([keepKey('https://example.com/doc')]));
  });

  it('coalesces concurrent reads into one tree walk so neither caller sees a premature empty set', async () => {
    let finishTree: () => void = () => undefined;
    let markTreeStarted: () => void = () => undefined;
    const treeStarted = new Promise<void>((resolve) => {
      markTreeStarted = resolve;
    });
    let calls = 0;
    const api: BookmarksApi = {
      permissions: {
        contains: () => Promise.resolve(true),
        request: () => Promise.resolve(true),
        remove: () => Promise.resolve(true),
      },
      bookmarks: {
        getTree: () => {
          calls += 1;
          markTreeStarted();
          return new Promise((resolve) => {
            finishTree = () => resolve([{ url: 'https://example.com/saved' }]);
          });
        },
      },
    };

    const first = bookmarkedKeys(api);
    const second = bookmarkedKeys(api);
    await treeStarted;
    finishTree();

    const [a, b] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(a).toEqual(new Set([keepKey('https://example.com/saved')]));
    expect(b).toEqual(a);
  });
});
