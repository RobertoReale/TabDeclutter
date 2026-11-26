/**
 * Pure YouTube video identification, HTML/ISO duration parsing, cache retention, and
 * in-place window/cluster sorting (`src/core/youtube.ts`).
 *
 * Pure TypeScript (invariant 4): no browser APIs, no network calls. Tab-suspender URLs
 * (`Tiny Suspender`, `The Great / Marvellous Suspender`, `Tab Suspender`) are unwrapped
 * via `unwrapSuspendedUrl`, and native browser `discarded` tabs carry their real URL,
 * so suspended YouTube tabs are recognized and sorted without ever waking or reloading them.
 */

import { tabUrl } from './duplicates';
import { isProtectedSite, keepKey } from './scoring';
import { DAY, MINUTE } from './time';
import type {
  Keeps,
  TabInfo,
  YouTubeDurationCache,
  YouTubeDurationEntry,
  YouTubeDurationOrder,
} from './types';
import { parseUrl, unwrapSuspendedUrl } from './url';

/** Maximum cached video durations kept in `local:ytDurations` (most recently fetched wins). */
export const YOUTUBE_CACHE_MAX = 500;
/** Finite video durations rarely change: keep for 30 days. */
export const YOUTUBE_KNOWN_TTL_MS = 30 * DAY;
/** Active live streams / unavailable videos expire quickly so ended VODs pick up their length. */
export const YOUTUBE_UNKNOWN_TTL_MS = 10 * MINUTE;

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PATH_VIDEO_RE = /^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})(?:\/|$)/i;
const ISO_DURATION_RE = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i;
const YOUTUBE_HOST_RE = /^(?:(?:www|m|music)\.)?youtube\.com$|^(?:www\.)?youtube-nocookie\.com$/;
const SHORT_HOST_RE = /^(?:www\.)?youtu\.be$/;

export type ParsedYouTubeDuration =
  | { readonly kind: 'duration'; readonly seconds: number }
  | { readonly kind: 'live' }
  | { readonly kind: 'unknown' };

export type ParsedYouTubeLikeStatus =
  | { readonly kind: 'liked' }
  | { readonly kind: 'not-liked' }
  | { readonly kind: 'logged-out' }
  | { readonly kind: 'unknown' };

/**
 * Extracts YouTube's `"LOGGED_IN":true|false` flag embedded near the start (~63 KB) of
 * desktop YouTube HTML documents, or `null` when absent.
 */
export function parseYouTubeLoggedIn(html: string): boolean | null {
  const m = /"LOGGED_IN"\s*:\s*(true|false)\b/.exec(html);
  return m?.[1] === undefined ? null : m[1] === 'true';
}

/**
 * Extracts the logged-in status and the up-to-100 most recently liked video IDs from
 * `https://www.youtube.com/playlist?list=LL` HTML (`playlistVideoRenderer.videoId`).
 */
export function parseYouTubeLikedPlaylistHtml(html: string): {
  readonly loggedIn: boolean | null;
  readonly likedIds: ReadonlySet<string>;
} {
  const loggedIn = parseYouTubeLoggedIn(html);
  const likedIds = new Set<string>();
  if (loggedIn !== false) {
    for (const m of html.matchAll(
      /"playlistVideoRenderer"\s*:\s*\{\s*"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/g,
    )) {
      if (m[1] !== undefined) likedIds.add(m[1]);
    }
  }
  return { loggedIn, likedIds };
}

/**
 * Decodes the URL-encoded Base64 `likeStatusEntity.key` (protobuf field 2 = `\x12\x0b<11-char-id>`)
 * so `parseYouTubeLikeStatusHtml` can verify that a `likeStatusEntity` belongs to the target video
 * and never to an unrelated comment or recommendation.
 */
export function decodeLikeEntityVideoId(encodedKey: string): string | null {
  if (encodedKey === '') return null;
  try {
    const raw = decodeURIComponent(encodedKey).replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(raw.padEnd(raw.length + ((4 - (raw.length % 4)) % 4), '='));
    // Protobuf tag 0x12 (field 2, length-delimited) followed by length 0x0b (11 bytes).
    const idx = decoded.indexOf('\x12\x0b');
    const id = idx >= 0 ? decoded.slice(idx + 2, idx + 13) : '';
    return VIDEO_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Extracts whether the signed-in user has liked the target video from `https://www.youtube.com/watch?v=<id>`
 * HTML. Fails safe (`'unknown'`) whenever YouTube markup is unrecognised so tabs are never closed by mistake.
 */
export function parseYouTubeLikeStatusHtml(
  html: string,
  expectedVideoId?: string,
): ParsedYouTubeLikeStatus {
  const loggedIn = parseYouTubeLoggedIn(html);
  if (loggedIn === false) return { kind: 'logged-out' };

  for (const match of html.matchAll(/"likeStatusEntity"\s*:\s*\{([^}]*)\}/g)) {
    const body = match[1] ?? '';
    const status = /"likeStatus"\s*:\s*"(LIKE|INDIFFERENT|DISLIKE)"/.exec(body)?.[1];
    if (status === undefined) continue;
    const key = expectedVideoId === undefined ? undefined : /"key"\s*:\s*"([^"]+)"/.exec(body)?.[1];
    const decodedId = key === undefined ? null : decodeLikeEntityVideoId(key);
    if (decodedId !== null && decodedId !== expectedVideoId) continue;
    return { kind: status === 'LIKE' ? 'liked' : 'not-liked' };
  }

  return { kind: 'unknown' };
}

export interface SelectLikedYouTubeOptions {
  /** Whether to include the active tab or a tab currently playing audio (default `false`). */
  readonly includeActiveOrAudible: boolean;
  readonly protectedSites?: readonly string[];
  readonly keeps?: Keeps;
  readonly now?: number;
  readonly excludeTabIds?: ReadonlySet<number>;
  readonly excludeWindowIds?: ReadonlySet<number>;
}

/**
 * Filters open (or suspended) tabs down to YouTube video tabs eligible for liked-video checks.
 * Pinned, hidden, incognito, kept, and protected-site tabs are always excluded; active and
 * audible tabs are excluded unless `options.includeActiveOrAudible` is `true`.
 */
export function eligibleLikedYouTubeTabs(
  tabs: readonly TabInfo[],
  options: SelectLikedYouTubeOptions,
): TabInfo[] {
  const {
    includeActiveOrAudible,
    protectedSites,
    keeps,
    now = 0,
    excludeTabIds,
    excludeWindowIds,
  } = options;
  return tabs.filter((tab) => {
    if (
      tab.incognito ||
      tab.pinned ||
      tab.hidden ||
      (!includeActiveOrAudible && (tab.active || tab.audible)) ||
      excludeWindowIds?.has(tab.windowId) ||
      excludeTabIds?.has(tab.id)
    ) {
      return false;
    }
    const url = tabUrl(tab);
    if (extractYouTubeVideoId(url) === null) return false;
    if (
      protectedSites !== undefined &&
      protectedSites.length > 0 &&
      isProtectedSite(url, protectedSites)
    ) {
      return false;
    }
    if (keeps !== undefined) {
      const until = keeps[keepKey(url)];
      if (until === null || (until !== undefined && until > now)) return false;
    }
    return true;
  });
}

/**
 * Selects open (or suspended) YouTube video tabs eligible for liked-video closing whose video ID
 * appears in `likedVideoIds`.
 */
export function selectLikedYouTubeTabsToClose(
  tabs: readonly TabInfo[],
  likedVideoIds: ReadonlySet<string>,
  options: SelectLikedYouTubeOptions,
): TabInfo[] {
  return eligibleLikedYouTubeTabs(tabs, options).filter((tab) =>
    likedVideoIds.has(extractYouTubeVideoId(tabUrl(tab))!),
  );
}

/**
 * Extracts the canonical 11-character YouTube video id from a tab URL (including wrapped
 * tab-suspender URLs), or `null` for non-YouTube pages and non-video YouTube pages (Home,
 * search results, channels, subscriptions, playlists without a video id).
 */
export function extractYouTubeVideoId(url: string): string | null {
  const parsed = parseUrl(unwrapSuspendedUrl(url));
  if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null;

  const host = parsed.hostname.toLowerCase();
  if (SHORT_HOST_RE.test(host)) {
    const seg = parsed.pathname.split('/')[1] ?? '';
    return VIDEO_ID_RE.test(seg) ? seg : null;
  }
  if (!YOUTUBE_HOST_RE.test(host)) return null;

  const path = parsed.pathname;
  if (path === '/watch' || path === '/watch/') {
    const v = parsed.searchParams.get('v') ?? '';
    return VIDEO_ID_RE.test(v) ? v : null;
  }
  const match = PATH_VIDEO_RE.exec(path);
  return match?.[1] ?? null;
}

/** Parses an ISO 8601 duration such as `PT5M42S` or `P1DT2H3M4S` into positive seconds. */
export function parseIsoDurationSeconds(iso: string): number | null {
  const match = ISO_DURATION_RE.exec(iso.trim());
  if (match === null) return null;
  const [, d, h, m, s] = match;
  if (d === undefined && h === undefined && m === undefined && s === undefined) return null;
  const total =
    Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(m ?? 0) * 60 + Number(s ?? 0);
  return total > 0 ? total : null;
}

/**
 * Extracts video duration from YouTube watch page HTML.
 *
 * Scopes `videoDetails` / `liveBroadcastDetails` checks to the player payload when present so
 * live streams in sidebar recommendations (`ytInitialData`) never falsely flag a regular video
 * as live. Distinguishes active live streams (`"isLive":true` / `"isLiveNow":true` / zero-length
 * live content) from ended live VODs (which keep `"isLiveContent":true` alongside a positive
 * `lengthSeconds`). Falls back to `approxDurationMs` and `<meta itemprop="duration" content="PT…">`.
 */
export function parseYouTubeDurationHtml(html: string): ParsedYouTubeDuration {
  const vdIdx = html.indexOf('"videoDetails":{');
  // Scope player inspection to the video's own `videoDetails` block (up to 16 KB to cover long
  // descriptions) and `liveBroadcastDetails`, ignoring sidebar recommendations in `ytInitialData`.
  const playerScope = vdIdx >= 0 ? html.slice(vdIdx, vdIdx + 16_384) : html;
  const lbdIdx = html.indexOf('"liveBroadcastDetails":{');
  const liveScope = lbdIdx >= 0 ? html.slice(lbdIdx, lbdIdx + 512) : playerScope;

  if (/"isLive"\s*:\s*true\b/.test(playerScope) || /"isLiveNow"\s*:\s*true\b/.test(liveScope)) {
    return { kind: 'live' };
  }

  const lengthMatch = /"lengthSeconds"\s*:\s*"(\d+)"/.exec(playerScope);
  if (lengthMatch?.[1] !== undefined) {
    const seconds = Number(lengthMatch[1]);
    if (seconds > 0) return { kind: 'duration', seconds };
    if (/"isLiveContent"\s*:\s*true\b/.test(playerScope)) return { kind: 'live' };
  }

  const approxMatch = /"approxDurationMs"\s*:\s*"(\d+)"/.exec(html);
  if (approxMatch?.[1] !== undefined) {
    const seconds = Math.round(Number(approxMatch[1]) / 1000);
    if (seconds > 0) return { kind: 'duration', seconds };
  }

  const metaMatch =
    /<meta\b[^>]*\bitemprop=["']duration["'][^>]*\bcontent=["']([^"']+)["']|<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bitemprop=["']duration["']/i.exec(
      html,
    );
  const rawIso = metaMatch?.[1] ?? metaMatch?.[2];
  if (rawIso !== undefined) {
    const seconds = parseIsoDurationSeconds(rawIso);
    if (seconds !== null) return { kind: 'duration', seconds };
  }

  return { kind: 'unknown' };
}

/** Whether a cached duration entry is still valid at `now`. */
export function isYouTubeDurationFresh(
  entry: YouTubeDurationEntry | undefined,
  now: number,
): boolean {
  if (entry === undefined) return false;
  const ttl = entry.seconds === null ? YOUTUBE_UNKNOWN_TTL_MS : YOUTUBE_KNOWN_TTL_MS;
  return now - entry.fetchedAt < ttl;
}

/** Drops expired entries and enforces the `YOUTUBE_CACHE_MAX` LRU cap (newest `fetchedAt` kept). */
export function pruneYouTubeCache(
  cache: YouTubeDurationCache,
  now: number,
  maxEntries: number = YOUTUBE_CACHE_MAX,
): YouTubeDurationCache {
  const fresh = Object.entries(cache)
    .filter(([, entry]) => isYouTubeDurationFresh(entry, now))
    .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
    .slice(0, maxEntries);
  const kept: YouTubeDurationCache = {};
  for (const [id, entry] of fresh) kept[id] = entry;
  return kept;
}

/** Formats a positive duration in seconds as `m:ss` or `h:mm:ss` for compact UI display. */
export function formatVideoDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const ss = String(secs).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

function durationOf(tab: TabInfo, durations: ReadonlyMap<string, number | null>): number | null {
  const videoId = extractYouTubeVideoId(tabUrl(tab));
  if (videoId === null) return null;
  const value = durations.get(videoId);
  return typeof value === 'number' && value > 0 ? value : null;
}

/**
 * Permutes only the slots occupied by YouTube video tabs inside `tabIds` by video duration,
 * leaving non-YouTube tabs (and non-video YouTube pages such as Home/Search/Channels) in their
 * exact original slots and preserving native `groupId` boundaries.
 *
 * Videos with a known finite duration always come before live streams or unavailable videos;
 * ties preserve their original relative order.
 */
export function sortYouTubeTabIds(
  tabIds: readonly number[],
  byId: ReadonlyMap<number, TabInfo>,
  durations: ReadonlyMap<string, number | null>,
  order: YouTubeDurationOrder,
): number[] {
  const result = [...tabIds];
  const slotsByGroup = new Map<number, { slot: number; tabId: number; seconds: number | null }[]>();

  for (let slot = 0; slot < tabIds.length; slot += 1) {
    const tabId = tabIds[slot] as number;
    const tab = byId.get(tabId);
    if (tab === undefined || extractYouTubeVideoId(tabUrl(tab)) === null) continue;
    const entry = { slot, tabId, seconds: durationOf(tab, durations) };
    const list = slotsByGroup.get(tab.groupId);
    if (list === undefined) slotsByGroup.set(tab.groupId, [entry]);
    else list.push(entry);
  }

  for (const entries of slotsByGroup.values()) {
    if (entries.length < 2) continue;
    // Skip reordering when no video in this slice has a known duration.
    if (!entries.some((entry) => entry.seconds !== null)) continue;

    const sorted = [...entries].sort((left, right) => {
      if (left.seconds !== null && right.seconds !== null) {
        if (left.seconds !== right.seconds) {
          return order === 'asc' ? left.seconds - right.seconds : right.seconds - left.seconds;
        }
        return left.slot - right.slot;
      }
      if (left.seconds !== null) return -1;
      if (right.seconds !== null) return 1;
      return left.slot - right.slot;
    });

    for (let i = 0; i < entries.length; i += 1) {
      result[entries[i]!.slot] = sorted[i]!.tabId;
    }
  }

  return result;
}

export interface PlannedTabMove {
  readonly tabId: number;
  readonly index: number;
}

/**
 * Computes the minimal sequence of `tabs.move` operations to rearrange only the tabs in
 * `movingSet` from `liveIds` into `desiredIds` (both arrays containing the same non-pinned
 * tab ids of one window), without ever issuing a move on any tab outside `movingSet`.
 */
export function planAnchorMoves(
  liveIds: readonly number[],
  desiredIds: readonly number[],
  movingSet: ReadonlySet<number>,
  pinnedCount: number,
): PlannedTabMove[] {
  const live = [...liveIds];
  const fixed: number[] = [];
  const placements: { readonly tabId: number; readonly fixedBefore: number }[] = [];
  for (const id of desiredIds) {
    if (movingSet.has(id)) {
      placements.push({ tabId: id, fixedBefore: fixed.length });
    } else {
      fixed.push(id);
    }
  }

  const moves: PlannedTabMove[] = [];
  for (let i = 0; i < placements.length; i += 1) {
    const current = placements[i]!;
    const prev = i > 0 ? placements[i - 1]! : undefined;
    const curIdx = live.indexOf(current.tabId);
    if (curIdx === -1) continue;

    let finalIdx: number;
    if (prev !== undefined && current.fixedBefore === prev.fixedBefore) {
      const anchorIdx = live.indexOf(prev.tabId);
      finalIdx = curIdx < anchorIdx ? anchorIdx : anchorIdx + 1;
    } else if (current.fixedBefore === 0) {
      finalIdx = 0;
    } else {
      const anchorIdx = live.indexOf(fixed[current.fixedBefore - 1]!);
      finalIdx = curIdx < anchorIdx ? anchorIdx : anchorIdx + 1;
    }

    if (curIdx !== finalIdx) {
      moves.push({ tabId: current.tabId, index: pinnedCount + finalIdx });
      live.splice(curIdx, 1);
      live.splice(finalIdx, 0, current.tabId);
    }
  }

  return moves;
}

/**
 * Computes the minimal sequence of `tabs.move` operations to reorder only the movable YouTube
 * video tabs of a single window into their sorted slots, without EVER moving pinned tabs,
 * non-YouTube tabs, or non-movable pages (such as `chrome://newtab`).
 *
 * Uses the exact splice semantics of Chrome and Firefox `tabs.move(tabId, { index })`.
 */
export function planYouTubeSlotMoves(
  windowTabs: readonly TabInfo[],
  movableIds: ReadonlySet<number>,
  durations: ReadonlyMap<string, number | null>,
  order: YouTubeDurationOrder,
): {
  readonly moves: readonly PlannedTabMove[];
  readonly videoCount: number;
  readonly knownCount: number;
} {
  const ordered = [...windowTabs].sort((a, b) => a.index - b.index);
  let pinnedCount = 0;
  const nonPinned: TabInfo[] = [];
  for (const tab of ordered) {
    if (tab.pinned) pinnedCount += 1;
    else nonPinned.push(tab);
  }

  const movableYtSet = new Set<number>();
  let knownCount = 0;
  for (const tab of nonPinned) {
    if (!movableIds.has(tab.id)) continue;
    const videoId = extractYouTubeVideoId(tabUrl(tab));
    if (videoId === null) continue;
    movableYtSet.add(tab.id);
    const secs = durations.get(videoId);
    if (typeof secs === 'number' && secs > 0) knownCount += 1;
  }

  const videoCount = movableYtSet.size;
  if (videoCount < 2 || knownCount === 0) {
    return { moves: [], videoCount, knownCount };
  }

  const live = nonPinned.map((tab) => tab.id);
  const desired = sortYouTubeTabIds(
    live,
    new Map(nonPinned.filter((tab) => movableYtSet.has(tab.id)).map((tab) => [tab.id, tab])),
    durations,
    order,
  );

  return {
    moves: planAnchorMoves(live, desired, movableYtSet, pinnedCount),
    videoCount,
    knownCount,
  };
}
