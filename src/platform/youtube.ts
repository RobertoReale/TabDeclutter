/**
 * Optional YouTube duration lookup, behind `optional_host_permissions: ['https://www.youtube.com/*']`.
 *
 * Mirrors `platform/bookmarks.ts`: the permission is never requested until the user enables
 * YouTube duration sorting in Settings, is requested synchronously inside the click handler so
 * both Chrome and Firefox honour the user gesture, and is revoked when turned off.
 *
 * Durations are read directly from `https://www.youtube.com/watch?v=<id>` without opening,
 * activating, or waking suspended/discarded tabs (neither native Chrome/Firefox discard nor
 * URL-rewriting tab suspenders), streamed with early cancellation once metadata is found, and
 * cached in `local:ytDurations` so each video is fetched at most once.
 */

import { tabUrl } from '@/core/duplicates';
import type { TabInfo, YouTubeDurationCache, YouTubeDurationEntry } from '@/core/types';
import {
  extractYouTubeVideoId,
  isYouTubeDurationFresh,
  parseYouTubeDurationHtml,
  parseYouTubeLikedPlaylistHtml,
  parseYouTubeLikeStatusHtml,
  type ParsedYouTubeDuration,
  type ParsedYouTubeLikeStatus,
} from '@/core/youtube';
import { mergeYouTubeDurations, readYouTubeDurations } from './storage';

const YT_BASE = 'https://www.youtube.com';
const LOGGED_OUT_RE = /"LOGGED_IN"\s*:\s*false\b/;

/** The single optional host pattern declared in both manifests. */
export const YOUTUBE_ORIGIN = `${YT_BASE}/*`;

export interface OriginPermissionRequest {
  readonly origins: readonly string[];
}

const YOUTUBE_PERMISSION: OriginPermissionRequest = { origins: [YOUTUBE_ORIGIN] };

/** Bound concurrent fetches to stay polite to YouTube while resolving a 30-tab window quickly. */
const FETCH_CONCURRENCY = 4;
/** Per-video network timeout so a stalled request never hangs sorting. */
const FETCH_TIMEOUT_MS = 10_000;
/**
 * Upper bound on streamed watch HTML. Real desktop YouTube watch pages place `videoDetails`
 * around 850 KB–1.2 MB inside a 1.4–1.8 MB document, so stopping after `videoDetails` saves
 * the trailing `ytInitialData` while 3 MB prevents ever truncating before player metadata.
 */
const MAX_HTML_BYTES = 3 * 1024 * 1024;
/** Max characters after `lengthSeconds` to wait for `isLiveContent` / `isLive` inside `videoDetails`. */
const VIDEO_DETAILS_TAIL_CHARS = 12_288;

function uniqueVideoIds(tabs: readonly TabInfo[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const tab of tabs) {
    const id = extractYouTubeVideoId(tabUrl(tab));
    if (id !== null && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

async function runPool(
  items: readonly string[],
  signal: AbortSignal | undefined,
  task: (id: string) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length && !signal?.aborted) {
      await task(items[cursor++]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, items.length) }, worker));
}

export interface YouTubePermissionApi {
  readonly permissions: {
    contains(permissions: OriginPermissionRequest): Promise<boolean>;
    request(permissions: OriginPermissionRequest): Promise<boolean>;
    remove(permissions: OriginPermissionRequest): Promise<boolean>;
  };
}

function permApi(given?: YouTubePermissionApi): YouTubePermissionApi {
  return given ?? (browser as unknown as YouTubePermissionApi);
}

/** Whether optional host access to `https://www.youtube.com/*` is currently granted. */
export async function hasYouTubePermission(given?: YouTubePermissionApi): Promise<boolean> {
  try {
    return await permApi(given).permissions.contains(YOUTUBE_PERMISSION);
  } catch {
    return false;
  }
}

/**
 * Requests optional host access to `https://www.youtube.com/*`.
 * **Call synchronously from the user click handler** before any `await`.
 */
export function requestYouTubePermission(given?: YouTubePermissionApi): Promise<boolean> {
  return permApi(given).permissions.request(YOUTUBE_PERMISSION);
}

/** Revokes optional host access to `https://www.youtube.com/*` when the feature is turned off. */
export async function removeYouTubePermission(given?: YouTubePermissionApi): Promise<boolean> {
  try {
    return await permApi(given).permissions.remove(YOUTUBE_PERMISSION);
  } catch {
    return false;
  }
}

export type YouTubeFetcher = (
  videoId: string,
  signal: AbortSignal,
) => Promise<ParsedYouTubeDuration | null>;

/** Runs `action` under an `AbortSignal` bounded by `timeoutMs` and linked to optional `outer`. */
export async function withAbortTimeout<T>(
  timeoutMs: number,
  outer: AbortSignal | undefined,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort(outer?.reason);
  };
  if (outer?.aborted) onAbort();
  else outer?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new DOMException('', 'TimeoutError'));
  }, timeoutMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    return await action(controller.signal);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

/**
 * Fetches `url` with a bounded timeout and streams UTF-8 chunks, stopping early as soon as
 * `shouldStop(html, recent, scanFrom)` returns `true` or `MAX_HTML_BYTES` is reached.
 */
async function fetchYouTubeHtml(
  url: string,
  credentials: RequestCredentials,
  signal: AbortSignal | undefined,
  shouldStop: (html: string, recent: string, scanFrom: number) => boolean,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  if (signal?.aborted) return null;
  try {
    return await withAbortTimeout(FETCH_TIMEOUT_MS, signal, async (fetchSignal) => {
      const response = await fetchFn(url, { credentials, signal: fetchSignal });
      if (!response.ok) return null;
      const reader = response.body?.getReader();
      if (reader === undefined) return await response.text();
      const decoder = new TextDecoder();
      let html = '';
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          const prevLen = html.length;
          html += decoder.decode(value, { stream: true });
          const scanFrom = Math.max(0, prevLen - 64);
          if (shouldStop(html, html.slice(scanFrom), scanFrom) || bytes >= MAX_HTML_BYTES) {
            void reader.cancel().catch(() => undefined);
            break;
          }
        }
        html += decoder.decode();
      } catch {
        // Return any partial HTML collected before cancellation/abort.
      }
      return html;
    });
  } catch {
    return null;
  }
}

/**
 * Fetches duration metadata for a single YouTube video id.
 *
 * Uses an anonymous fetch (`credentials: 'omit'`) first so no Google/YouTube account cookies
 * are sent for public videos, and retries once with `credentials: 'include'` only if the
 * anonymous response could not yield a duration (e.g. EU consent screen or signed-in/age-gated
 * videos). Returns `null` on transport/HTTP errors so transient offline failures are NOT cached.
 */
export async function fetchYouTubeVideoDuration(
  videoId: string,
  signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<ParsedYouTubeDuration | null> {
  const attemptFetch = async (
    credentials: RequestCredentials,
  ): Promise<ParsedYouTubeDuration | null> => {
    let lenAt = -1;
    const html = await fetchYouTubeHtml(
      `${YT_BASE}/watch?v=${videoId}`,
      credentials,
      signal,
      (full, recent, scanFrom) => {
        if (lenAt === -1) {
          const lenMatch = /"lengthSeconds"\s*:\s*"\d+"/.exec(recent);
          if (lenMatch !== null) lenAt = scanFrom + lenMatch.index;
        }
        return (
          /"isLive"\s*:\s*true\b|"isLiveNow"\s*:\s*true\b/.test(recent) ||
          (lenAt !== -1 &&
            (/"isLiveContent"\s*:\s*(?:true|false)\b/.test(full.slice(lenAt)) ||
              full.length - lenAt >= VIDEO_DETAILS_TAIL_CHARS))
        );
      },
      fetchFn,
    );
    return html === null ? null : parseYouTubeDurationHtml(html);
  };

  const anonymous = await attemptFetch('omit');
  if (anonymous === null || anonymous.kind !== 'unknown' || signal?.aborted) return anonymous;
  return attemptFetch('include');
}

/** Deduplicates concurrent fetches for the same video id within one extension context. */
const inFlight = new Map<string, Promise<ParsedYouTubeDuration | null>>();

function fetchDeduped(
  videoId: string,
  signal: AbortSignal | undefined,
  fetcher?: YouTubeFetcher,
): Promise<ParsedYouTubeDuration | null> {
  const existing = inFlight.get(videoId);
  if (existing !== undefined) return existing;
  const run = (
    fetcher !== undefined
      ? fetcher(videoId, signal ?? new AbortController().signal)
      : fetchYouTubeVideoDuration(videoId, signal)
  ).finally(() => {
    if (inFlight.get(videoId) === run) inFlight.delete(videoId);
  });
  inFlight.set(videoId, run);
  return run;
}

export interface ResolveYouTubeOptions {
  /** Whether to fetch uncached video ids from YouTube (false = cache-only, zero network). */
  readonly allowNetwork?: boolean;
  readonly now?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (done: number, total: number) => void;
  readonly permissionApi?: YouTubePermissionApi;
  readonly fetcher?: YouTubeFetcher;
}

/**
 * Resolves video durations (in seconds, or `null` for live/unavailable) for all YouTube video
 * tabs in `tabs`, hitting `local:ytDurations` first and fetching only missing/stale video ids
 * when `allowNetwork` is true and the optional `youtube.com` host permission is granted.
 */
export async function resolveYouTubeDurations(
  tabs: readonly TabInfo[],
  options: ResolveYouTubeOptions = {},
): Promise<Map<string, number | null>> {
  const now = options.now ?? Date.now();
  const videoIds = uniqueVideoIds(tabs);
  const resolved = new Map<string, number | null>();
  if (videoIds.length === 0) return resolved;

  const cached: YouTubeDurationCache = await readYouTubeDurations().catch(
    (): YouTubeDurationCache => ({}),
  );
  const missing: string[] = [];
  for (const id of videoIds) {
    const entry = cached[id];
    if (isYouTubeDurationFresh(entry, now)) resolved.set(id, entry!.seconds);
    else missing.push(id);
  }

  if (missing.length === 0 || options.allowNetwork === false) return resolved;
  if (options.fetcher === undefined && !(await hasYouTubePermission(options.permissionApi))) {
    return resolved;
  }

  let done = videoIds.length - missing.length;
  const total = videoIds.length;
  options.onProgress?.(done, total);

  const updates: Record<string, YouTubeDurationEntry> = {};
  await runPool(missing, options.signal, async (id) => {
    const parsed = await fetchDeduped(id, options.signal, options.fetcher);
    options.onProgress?.(++done, total);
    if (parsed === null || parsed.kind === 'unknown') return;
    const seconds = parsed.kind === 'duration' ? parsed.seconds : null;
    resolved.set(id, seconds);
    updates[id] = { seconds, fetchedAt: now };
  });

  if (Object.keys(updates).length > 0) {
    await mergeYouTubeDurations(updates, now).catch(() => undefined);
  }

  return resolved;
}

/** Clears in-flight dedupe state (used by tests). */
export function resetYouTubeFetcher(): void {
  inFlight.clear();
}

export type YouTubeLikedPlaylistFetcher = (
  signal: AbortSignal,
) => Promise<{ readonly loggedIn: boolean | null; readonly likedIds: ReadonlySet<string> } | null>;

export type YouTubeLikeStatusFetcher = (
  videoId: string,
  signal: AbortSignal,
) => Promise<ParsedYouTubeLikeStatus | null>;

/**
 * Tier 1 fast-path: fetches `https://www.youtube.com/playlist?list=LL` with the browser's
 * YouTube session cookies, stopping early at ~63 KB if `"LOGGED_IN":false` appears.
 */
export async function fetchYouTubeLikedPlaylist(
  signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<{ readonly loggedIn: boolean | null; readonly likedIds: ReadonlySet<string> } | null> {
  const html = await fetchYouTubeHtml(
    `${YT_BASE}/playlist?list=LL`,
    'include',
    signal,
    (_full, recent) => LOGGED_OUT_RE.test(recent),
    fetchFn,
  );
  return html === null ? null : parseYouTubeLikedPlaylistHtml(html);
}

/**
 * Tier 2 per-video check: streams `https://www.youtube.com/watch?v=<id>` with session cookies
 * and stops as soon as `"LOGGED_IN":false` or `"likeStatusEntity":{...}` arrives.
 */
export async function fetchYouTubeVideoLikeStatus(
  videoId: string,
  signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<ParsedYouTubeLikeStatus | null> {
  const html = await fetchYouTubeHtml(
    `${YT_BASE}/watch?v=${videoId}`,
    'include',
    signal,
    (_full, recent) =>
      LOGGED_OUT_RE.test(recent) ||
      /"likeStatusEntity"\s*:\s*\{[^}]*"likeStatus"\s*:\s*"(?:LIKE|INDIFFERENT|DISLIKE)"/.test(
        recent,
      ),
    fetchFn,
  );
  return html === null ? null : parseYouTubeLikeStatusHtml(html, videoId);
}

export interface ResolveLikedYouTubeOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (done: number, total: number) => void;
  readonly permissionApi?: YouTubePermissionApi;
  readonly playlistFetcher?: YouTubeLikedPlaylistFetcher;
  readonly videoFetcher?: YouTubeLikeStatusFetcher;
}

export interface ResolveLikedYouTubeResult {
  readonly status: 'ok' | 'logged-out' | 'no-permission' | 'unavailable';
  readonly likedVideoIds: ReadonlySet<string>;
  readonly checkedCount: number;
}

const emptyLiked = (
  status: ResolveLikedYouTubeResult['status'],
): ResolveLikedYouTubeResult => ({ status, likedVideoIds: new Set(), checkedCount: 0 });

/**
 * Resolves which YouTube video IDs among `tabs` (including suspended/discarded tabs without
 * waking them) are currently liked by the signed-in YouTube user:
 *
 * 1. Fetches the `LL` ("Liked videos") playlist in 1 request to catch the ~100 most recent likes
 *    and immediately detect signed-out browsers (`"LOGGED_IN":false`).
 * 2. Checks remaining video IDs via streaming `/watch?v=<id>` requests (`likeStatusEntity`) so
 *    older likes beyond the first 100 are detected accurately too.
 */
export async function resolveLikedYouTubeVideos(
  tabs: readonly TabInfo[],
  options: ResolveLikedYouTubeOptions = {},
): Promise<ResolveLikedYouTubeResult> {
  const videoIds = uniqueVideoIds(tabs);
  if (videoIds.length === 0) return emptyLiked('ok');
  if (
    options.playlistFetcher === undefined &&
    options.videoFetcher === undefined &&
    !(await hasYouTubePermission(options.permissionApi))
  ) {
    return emptyLiked('no-permission');
  }
  if (options.signal?.aborted) return emptyLiked('unavailable');

  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort(options.signal?.reason);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  const likedVideoIds = new Set<string>();
  const total = videoIds.length;
  let done = 0;
  let checkedCount = 0;
  let loggedOut = false;

  try {
    options.onProgress?.(0, total);
    const playlist = await (options.playlistFetcher ?? ((s) => fetchYouTubeLikedPlaylist(s)))(
      controller.signal,
    );
    if (controller.signal.aborted) return { status: 'unavailable', likedVideoIds, checkedCount };
    if (playlist !== null) {
      if (playlist.loggedIn === false) return emptyLiked('logged-out');
      for (const id of videoIds) {
        if (playlist.likedIds.has(id)) {
          likedVideoIds.add(id);
          checkedCount += 1;
          done += 1;
        }
      }
      options.onProgress?.(done, total);
    }

    const remaining = videoIds.filter((id) => !likedVideoIds.has(id));
    if (remaining.length > 0) {
      const fetchOne = options.videoFetcher ?? ((id, s) => fetchYouTubeVideoLikeStatus(id, s));
      await runPool(remaining, controller.signal, async (id) => {
        const status = await fetchOne(id, controller.signal);
        options.onProgress?.(++done, total);
        if (status === null) return;
        if (status.kind === 'logged-out') {
          loggedOut = true;
          controller.abort();
        } else if (status.kind !== 'unknown') {
          if (status.kind === 'liked') likedVideoIds.add(id);
          checkedCount += 1;
        }
      });
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }

  if (loggedOut) return emptyLiked('logged-out');
  if (checkedCount === 0 && likedVideoIds.size === 0) return emptyLiked('unavailable');
  return { status: 'ok', likedVideoIds, checkedCount };
}
