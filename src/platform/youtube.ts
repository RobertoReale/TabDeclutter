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
  type ParsedYouTubeDuration,
} from '@/core/youtube';
import { mergeYouTubeDurations, readYouTubeDurations } from './storage';

/** The single optional host pattern declared in both manifests. */
export const YOUTUBE_ORIGIN = 'https://www.youtube.com/*';

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

/**
 * Reads `response` incrementally and cancels the stream as soon as `ytInitialPlayerResponse`'s
 * duration/live markers appear, avoiding downloading the full ~900 KB watch page.
 */
async function readWatchHtml(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return response.text();
  const decoder = new TextDecoder('utf-8');
  let html = '';
  let bytes = 0;
  let lenAt = -1;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      const chunk = decoder.decode(value, { stream: true });
      const prevLen = html.length;
      html += chunk;
      // Scan only the newly appended region (+ small overlap) so streaming stays O(N).
      const scanFrom = Math.max(0, prevLen - 64);
      const recent = html.slice(scanFrom);
      if (lenAt === -1) {
        const lenMatch = /"lengthSeconds"\s*:\s*"\d+"/.exec(recent);
        if (lenMatch !== null) lenAt = scanFrom + lenMatch.index;
      }
      const hasLive = /"isLive"\s*:\s*true\b|"isLiveNow"\s*:\s*true\b/.test(recent);
      const hasLengthWithContext =
        lenAt !== -1 &&
        (/"isLiveContent"\s*:\s*(?:true|false)\b/.test(html.slice(lenAt)) ||
          html.length - lenAt >= VIDEO_DETAILS_TAIL_CHARS);
      if (hasLive || hasLengthWithContext || bytes >= MAX_HTML_BYTES) {
        void reader.cancel().catch(() => undefined);
        break;
      }
    }
    html += decoder.decode();
    return html;
  } catch {
    return html;
  }
}

/**
 * Fetches duration metadata for a single YouTube video id.
 *
 * Returns `null` on transport/HTTP errors (so transient offline failures are NOT cached),
 * or `ParsedYouTubeDuration` when YouTube returned a 200 HTML response.
 */
export async function fetchYouTubeVideoDuration(
  videoId: string,
  signal?: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<ParsedYouTubeDuration | null> {
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort(signal?.reason);
  };
  if (signal?.aborted) return null;
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new DOMException('YouTube fetch timed out', 'TimeoutError'));
  }, FETCH_TIMEOUT_MS);
  (timer as unknown as { unref?: () => void }).unref?.();

  try {
    const response = await fetchFn(`https://www.youtube.com/watch?v=${videoId}`, {
      credentials: 'include',
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const html = await readWatchHtml(response);
    return parseYouTubeDurationHtml(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
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
  const videoIds: string[] = [];
  const seen = new Set<string>();
  for (const tab of tabs) {
    const id = extractYouTubeVideoId(tabUrl(tab));
    if (id !== null && !seen.has(id)) {
      seen.add(id);
      videoIds.push(id);
    }
  }

  const resolved = new Map<string, number | null>();
  if (videoIds.length === 0) return resolved;

  const cached: YouTubeDurationCache = await readYouTubeDurations().catch(
    (): YouTubeDurationCache => ({}),
  );
  const missing: string[] = [];
  for (const id of videoIds) {
    const entry = cached[id];
    if (isYouTubeDurationFresh(entry, now)) {
      resolved.set(id, entry!.seconds);
    } else {
      missing.push(id);
    }
  }

  const allowNetwork = options.allowNetwork !== false;
  if (missing.length === 0 || !allowNetwork) return resolved;

  const permitted =
    options.fetcher !== undefined || (await hasYouTubePermission(options.permissionApi));
  if (!permitted) return resolved;

  let done = videoIds.length - missing.length;
  const total = videoIds.length;
  options.onProgress?.(done, total);

  const updates: Record<string, YouTubeDurationEntry> = {};
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < missing.length) {
      if (options.signal?.aborted) return;
      const id = missing[cursor]!;
      cursor += 1;
      const parsed = await fetchDeduped(id, options.signal, options.fetcher);
      done += 1;
      options.onProgress?.(done, total);
      if (parsed === null) continue;
      if (parsed.kind === 'duration') {
        resolved.set(id, parsed.seconds);
        updates[id] = { seconds: parsed.seconds, fetchedAt: now };
      } else if (parsed.kind === 'live') {
        resolved.set(id, null);
        updates[id] = { seconds: null, fetchedAt: now };
      }
      // `parsed.kind === 'unknown'` (e.g. consent wall or unavailable) is left uncached so
      // a retry after consenting or signing into YouTube succeeds immediately.
    }
  };

  const workers = Array.from({ length: Math.min(FETCH_CONCURRENCY, missing.length) }, () =>
    worker(),
  );
  await Promise.all(workers);

  if (Object.keys(updates).length > 0) {
    await mergeYouTubeDurations(updates, now).catch(() => undefined);
  }

  return resolved;
}

/** Clears in-flight dedupe state (used by tests). */
export function resetYouTubeFetcher(): void {
  inFlight.clear();
}
