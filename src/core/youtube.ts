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
import { DAY, MINUTE } from './time';
import type {
  TabInfo,
  YouTubeDurationCache,
  YouTubeDurationEntry,
  YouTubeDurationOrder,
} from './types';
import { unwrapSuspendedUrl } from './url';

/** Maximum cached video durations kept in `local:ytDurations` (most recently fetched wins). */
export const YOUTUBE_CACHE_MAX = 500;
/** Finite video durations rarely change: keep for 30 days. */
export const YOUTUBE_KNOWN_TTL_MS = 30 * DAY;
/** Active live streams / unavailable videos expire quickly so ended VODs pick up their length. */
export const YOUTUBE_UNKNOWN_TTL_MS = 10 * MINUTE;

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PATH_VIDEO_RE = /^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})(?:\/|$)/i;
const ISO_DURATION_RE = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);

export type ParsedYouTubeDuration =
  | { readonly kind: 'duration'; readonly seconds: number }
  | { readonly kind: 'live' }
  | { readonly kind: 'unknown' };

/**
 * Extracts the canonical 11-character YouTube video id from a tab URL (including wrapped
 * tab-suspender URLs), or `null` for non-YouTube pages and non-video YouTube pages (Home,
 * search results, channels, subscriptions, playlists without a video id).
 */
export function extractYouTubeVideoId(url: string): string | null {
  const unwrapped = unwrapSuspendedUrl(url).trim();
  if (unwrapped === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(unwrapped);
  } catch {
    return null;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return null;

  const host = parsed.hostname.toLowerCase();
  if (SHORT_HOSTS.has(host)) {
    const seg = parsed.pathname.split('/')[1] ?? '';
    return VIDEO_ID_RE.test(seg) ? seg : null;
  }
  if (!YOUTUBE_HOSTS.has(host)) return null;

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
