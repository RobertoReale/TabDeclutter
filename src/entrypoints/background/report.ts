/**
 * Shutdown-aware error reporting for background service worker listeners (docs/DECISIONS.md, F.2).
 *
 * When the browser is shutting down it rejects whichever extension API call happens to be in
 * flight (`Error: The browser is shutting down.`). Probing `storage.local` distinguishes a
 * browser teardown (where the store no longer answers at all) from a genuine extension failure
 * without coupling to browser-specific error messages.
 */

import { activityItem } from '@/platform/storage';

interface BackgroundCommonApi {
  readonly alarms: {
    get(name: string): Promise<{ name: string } | undefined>;
    create(name: string, info: { periodInMinutes?: number; when?: number }): Promise<void> | void;
    clear(name: string): Promise<boolean> | void;
  };
  readonly windows: {
    getLastFocused(): Promise<{ id?: number }>;
  };
}

function commonApi(): BackgroundCommonApi {
  return browser as unknown as BackgroundCommonApi;
}

/** Narrowed `browser.alarms` accessor shared across background listeners. */
export function alarmsApi(): BackgroundCommonApi['alarms'] {
  return commonApi().alarms;
}

/** Creates a periodic alarm once without resetting an already-scheduled alarm countdown. */
export async function ensurePeriodicAlarm(name: string, periodInMinutes: number): Promise<void> {
  const alarms = alarmsApi();
  if ((await alarms.get(name)) !== undefined) return;
  await alarms.create(name, { periodInMinutes });
}

/** Returns the last focused browser window ID, or `undefined` when no window is focused. */
export async function focusedWindow(): Promise<number | undefined> {
  try {
    return (await commonApi().windows.getLastFocused()).id;
  } catch {
    return undefined;
  }
}

/** Shared no-op handler for keeping promise chains alive after handled errors. */
export function ignore(): void {
  /* intentional no-op */
}

export interface SerialQueue {
  <T>(action: () => Promise<T>): Promise<T>;
  tail(): Promise<unknown>;
}

/** Creates a serial async queue so overlapping background events never interleave. */
export function createSerialQueue(): SerialQueue {
  let chain: Promise<unknown> = Promise.resolve();
  const run = <T>(action: () => Promise<T>): Promise<T> => {
    const next = chain.then(action, action);
    chain = next.then(ignore, ignore);
    return next;
  };
  run.tail = () => chain;
  return run;
}

/** Returns a function that runs `fn` at most once per `ms` debounce window. */
export function createDebouncer(ms: number, fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    timer ??= setTimeout(() => {
      timer = undefined;
      fn();
    }, ms);
  };
}

export function watchLocalKeys(
  items: readonly { readonly name: string }[],
  onMatch: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => void,
): void {
  const watched = items.map((item) => item.name);
  browser.storage.onChanged.addListener(
    (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => {
      if (area === 'local' && watched.some((key) => key in changes)) onMatch(changes);
    },
  );
}

export function backgroundError(scope: string): (error: unknown) => void {
  return (error: unknown) => {
    void reportBackgroundError(scope, error);
  };
}

export async function reportBackgroundError(scope: string, error: unknown): Promise<void> {
  try {
    await activityItem.getValue();
  } catch {
    return;
  }
  console.error(`TabDeclutter: ${scope}`, error);
}
