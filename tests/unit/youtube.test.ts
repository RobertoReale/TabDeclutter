import { describe, expect, it } from 'vitest';

import { DAY, MINUTE } from '../../src/core/time';
import { NO_GROUP_ID, type TabInfo, type YouTubeDurationCache } from '../../src/core/types';
import {
  extractYouTubeVideoId,
  formatVideoDuration,
  isYouTubeDurationFresh,
  parseIsoDurationSeconds,
  parseYouTubeDurationHtml,
  planAnchorMoves,
  planYouTubeSlotMoves,
  pruneYouTubeCache,
  sortYouTubeTabIds,
  YOUTUBE_KNOWN_TTL_MS,
  YOUTUBE_UNKNOWN_TTL_MS,
} from '../../src/core/youtube';

const NOW = Date.UTC(2026, 10, 25, 9, 0, 0);

function tab(id: number, url: string, overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id,
    windowId: 1,
    index: id,
    url,
    title: `Tab ${id}`,
    pinned: false,
    audible: false,
    active: false,
    discarded: false,
    hidden: false,
    groupId: NO_GROUP_ID,
    incognito: false,
    ...overrides,
  };
}

/** Simulates Chrome/Firefox `tabs.move(tabId, { index })` splicing semantics exactly. */
function applyBrowserMoves(
  initialIds: readonly number[],
  moves: readonly { readonly tabId: number; readonly index: number }[],
): number[] {
  const order = [...initialIds];
  for (const move of moves) {
    const from = order.indexOf(move.tabId);
    if (from === -1) throw new Error(`missing tab ${move.tabId}`);
    order.splice(from, 1);
    order.splice(move.index, 0, move.tabId);
  }
  return order;
}

describe('extractYouTubeVideoId', () => {
  it('recognizes standard watch, mobile, music, nocookie, shorts, live, embed, v, and youtu.be URLs', () => {
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s')).toBe(
      'dQw4w9WgXcQ',
    );
    expect(extractYouTubeVideoId('https://youtube.com/watch/?v=AbCdEf_1234&list=PL999')).toBe(
      'AbCdEf_1234',
    );
    expect(extractYouTubeVideoId('https://m.youtube.com/watch?v=1234567890a')).toBe('1234567890a');
    expect(extractYouTubeVideoId('https://music.youtube.com/watch?v=1234567890b')).toBe(
      '1234567890b',
    );
    expect(extractYouTubeVideoId('https://www.youtube.com/shorts/ShOrTs12345')).toBe('ShOrTs12345');
    expect(extractYouTubeVideoId('https://www.youtube.com/live/LiVeStReAm1?si=xyz')).toBe(
      'LiVeStReAm1',
    );
    expect(extractYouTubeVideoId('https://www.youtube-nocookie.com/embed/EmBeD123456')).toBe(
      'EmBeD123456',
    );
    expect(extractYouTubeVideoId('https://www.youtube.com/v/LegacyId_01')).toBe('LegacyId_01');
    expect(extractYouTubeVideoId('https://youtu.be/ShortLink01?t=10')).toBe('ShortLink01');
    expect(extractYouTubeVideoId('https://www.youtu.be/ShortLink02/')).toBe('ShortLink02');
  });

  it('unwraps tab-suspender URLs so suspended YouTube tabs are recognized without reloading', () => {
    expect(
      extractYouTubeVideoId(
        'chrome-extension://bbomjaikkcabgmfaomdichgcodnaeecf/suspend.html?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DSuspended01',
      ),
    ).toBe('Suspended01');
    expect(
      extractYouTubeVideoId(
        'chrome-extension://klbibkeccnjlkjkiokjodocebajanakg/suspended.html#ttl=Video&pos=0&uri=https://www.youtube.com/watch?v=Suspended02&t=12',
      ),
    ).toBe('Suspended02');
    expect(
      extractYouTubeVideoId(
        'moz-extension://1234-5678/park.html?url=https%3A%2F%2Fyoutu.be%2FSuspended03',
      ),
    ).toBe('Suspended03');
  });

  it('returns null for non-video YouTube pages, invalid ids, non-web schemes, and other sites', () => {
    expect(extractYouTubeVideoId('')).toBeNull();
    expect(extractYouTubeVideoId('not a url')).toBeNull();
    expect(extractYouTubeVideoId('file:///watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(extractYouTubeVideoId('https://github.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(extractYouTubeVideoId('https://www.youtube.com/')).toBeNull();
    expect(extractYouTubeVideoId('https://www.youtube.com/results?search_query=music')).toBeNull();
    expect(extractYouTubeVideoId('https://www.youtube.com/feed/subscriptions')).toBeNull();
    expect(extractYouTubeVideoId('https://www.youtube.com/@veritasium')).toBeNull();
    expect(extractYouTubeVideoId('https://www.youtube.com/playlist?list=PL12345')).toBeNull();
    expect(extractYouTubeVideoId('https://www.youtube.com/watch?v=tooShort')).toBeNull();
    expect(extractYouTubeVideoId('https://www.youtube.com/watch')).toBeNull();
    expect(extractYouTubeVideoId('https://youtu.be/')).toBeNull();
    expect(extractYouTubeVideoId('https://youtu.be/bad')).toBeNull();
  });
});

describe('parseIsoDurationSeconds', () => {
  it('parses days, hours, minutes, and seconds into positive totals', () => {
    expect(parseIsoDurationSeconds('PT44S')).toBe(44);
    expect(parseIsoDurationSeconds('PT5M42S')).toBe(342);
    expect(parseIsoDurationSeconds('PT1H2M3S')).toBe(3723);
    expect(parseIsoDurationSeconds('P1DT2H3M4S')).toBe(93_784);
    expect(parseIsoDurationSeconds('PT2H')).toBe(7200);
  });

  it('rejects zero, empty, and malformed ISO duration strings', () => {
    expect(parseIsoDurationSeconds('PT0S')).toBeNull();
    expect(parseIsoDurationSeconds('PT0M0S')).toBeNull();
    expect(parseIsoDurationSeconds('PT')).toBeNull();
    expect(parseIsoDurationSeconds('P')).toBeNull();
    expect(parseIsoDurationSeconds('5:42')).toBeNull();
  });
});

describe('parseYouTubeDurationHtml', () => {
  it('parses lengthSeconds for standard videos, Shorts, and ended live VODs', () => {
    expect(
      parseYouTubeDurationHtml(
        '<script>var ytInitialPlayerResponse = {"videoDetails":{"lengthSeconds":"754","isLiveContent":false}};</script>',
      ),
    ).toEqual({ kind: 'duration', seconds: 754 });

    // Ended livestream VODs retain `isLiveContent:true` alongside a positive `lengthSeconds`.
    expect(
      parseYouTubeDurationHtml(
        '<script>var ytInitialPlayerResponse = {"videoDetails":{"lengthSeconds":"3612","isLiveContent":true}};</script>',
      ),
    ).toEqual({ kind: 'duration', seconds: 3612 });

    // A live stream in sidebar recommendations (`ytInitialData`) must not override this video's duration.
    expect(
      parseYouTubeDurationHtml(
        '<script>var ytInitialPlayerResponse = {"videoDetails":{"lengthSeconds":"213","isLiveContent":false},"microformat":{"playerMicroformatRenderer":{"liveBroadcastDetails":{"isLiveNow":false}}}};</script>' +
          'X'.repeat(20_000) +
          '<script>var ytInitialData = {"recommended":{"isLive":true,"isLiveNow":true}};</script>',
      ),
    ).toEqual({ kind: 'duration', seconds: 213 });
  });

  it('identifies active live streams even when DVR lengthSeconds is present', () => {
    expect(
      parseYouTubeDurationHtml(
        '{"videoDetails":{"lengthSeconds":"1420","isLive":true,"isLiveContent":true}}',
      ),
    ).toEqual({ kind: 'live' });

    expect(
      parseYouTubeDurationHtml('{"liveBroadcastDetails":{"isLiveNow":true},"lengthSeconds":"0"}'),
    ).toEqual({ kind: 'live' });

    expect(
      parseYouTubeDurationHtml('{"videoDetails":{"lengthSeconds":"0","isLiveContent":true}}'),
    ).toEqual({ kind: 'live' });
  });

  it('falls back to approxDurationMs and schema.org itemprop="duration" in either attribute order', () => {
    expect(parseYouTubeDurationHtml('{"approxDurationMs":"125600"}')).toEqual({
      kind: 'duration',
      seconds: 126,
    });
    expect(parseYouTubeDurationHtml('<meta itemprop="duration" content="PT3M15S">')).toEqual({
      kind: 'duration',
      seconds: 195,
    });
    expect(parseYouTubeDurationHtml('<meta content="PT0M45S" itemprop="duration">')).toEqual({
      kind: 'duration',
      seconds: 45,
    });
  });

  it('returns unknown when no valid duration or live marker exists', () => {
    expect(parseYouTubeDurationHtml('<html><body>Consent screen</body></html>')).toEqual({
      kind: 'unknown',
    });
    expect(parseYouTubeDurationHtml('{"lengthSeconds":"0","approxDurationMs":"0"}')).toEqual({
      kind: 'unknown',
    });
    expect(parseYouTubeDurationHtml('<meta itemprop="duration" content="PT0S">')).toEqual({
      kind: 'unknown',
    });
  });
});

describe('cache freshness, pruning, and duration formatting', () => {
  it('applies 30-day TTL for known durations and 10-minute TTL for live/unknown entries', () => {
    expect(isYouTubeDurationFresh(undefined, NOW)).toBe(false);
    expect(isYouTubeDurationFresh({ seconds: 120, fetchedAt: NOW - 29 * DAY }, NOW)).toBe(true);
    expect(
      isYouTubeDurationFresh({ seconds: 120, fetchedAt: NOW - YOUTUBE_KNOWN_TTL_MS }, NOW),
    ).toBe(false);
    expect(isYouTubeDurationFresh({ seconds: null, fetchedAt: NOW - 5 * MINUTE }, NOW)).toBe(true);
    expect(
      isYouTubeDurationFresh({ seconds: null, fetchedAt: NOW - YOUTUBE_UNKNOWN_TTL_MS }, NOW),
    ).toBe(false);
  });

  it('prunes expired entries and retains the newest entries up to maxEntries', () => {
    const cache: YouTubeDurationCache = {
      expiredKnown: { seconds: 100, fetchedAt: NOW - 31 * DAY },
      expiredLive: { seconds: null, fetchedAt: NOW - 11 * MINUTE },
      older: { seconds: 200, fetchedAt: NOW - 5 * DAY },
      middle: { seconds: 300, fetchedAt: NOW - 2 * DAY },
      newest: { seconds: 400, fetchedAt: NOW - MINUTE },
    };
    expect(pruneYouTubeCache(cache, NOW, 2)).toEqual({
      newest: { seconds: 400, fetchedAt: NOW - MINUTE },
      middle: { seconds: 300, fetchedAt: NOW - 2 * DAY },
    });
  });

  it('formats durations as m:ss or h:mm:ss', () => {
    expect(formatVideoDuration(0)).toBe('0:00');
    expect(formatVideoDuration(44)).toBe('0:44');
    expect(formatVideoDuration(342)).toBe('5:42');
    expect(formatVideoDuration(3600)).toBe('1:00:00');
    expect(formatVideoDuration(3723)).toBe('1:02:03');
  });
});

describe('sortYouTubeTabIds', () => {
  it('permutes only YouTube video slots in place while leaving non-YT and non-video YT tabs untouched', () => {
    const tabs = [
      tab(1, 'https://mail.google.com/mail/u/0/'),
      tab(2, 'https://www.youtube.com/watch?v=VideoLong01'),
      tab(3, 'https://www.youtube.com/results?search_query=rust'),
      tab(4, 'https://www.youtube.com/watch?v=VideoShort1', { discarded: true }),
      tab(5, 'https://docs.google.com/document/d/1'),
      tab(
        6,
        'chrome-extension://bbomjaikkcabgmfaomdichgcodnaeecf/suspend.html?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DVideoMid001',
      ),
      tab(7, 'https://www.youtube.com/live/LiveNow0001'),
    ];
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const durations = new Map<string, number | null>([
      ['VideoLong01', 1800],
      ['VideoShort1', 90],
      ['VideoMid001', 600],
      ['LiveNow0001', null],
    ]);

    expect(sortYouTubeTabIds([1, 2, 3, 4, 5, 6, 7], byId, durations, 'asc')).toEqual([
      1, 4, 3, 6, 5, 2, 7,
    ]);
    // Descending puts longest first, while keeping live/unknown at the end and non-YT slots fixed.
    expect(sortYouTubeTabIds([1, 2, 3, 4, 5, 6, 7], byId, durations, 'desc')).toEqual([
      1, 2, 3, 6, 5, 4, 7,
    ]);
  });

  it('preserves native tab group boundaries and breaks ties stably', () => {
    const tabs = [
      tab(1, 'https://www.youtube.com/watch?v=Grp1Long001', { groupId: 10 }),
      tab(2, 'https://www.youtube.com/watch?v=Grp1Short01', { groupId: 10 }),
      tab(3, 'https://www.youtube.com/watch?v=Grp2Tie0001', { groupId: 20 }),
      tab(4, 'https://www.youtube.com/watch?v=Grp2Tie0002', { groupId: 20 }),
      tab(5, 'https://www.youtube.com/watch?v=Grp2Short01', { groupId: 20 }),
      tab(6, 'https://www.youtube.com/watch?v=UngrpSingle'),
      tab(7, 'https://www.youtube.com/watch?v=UnknownA001', { groupId: 30 }),
      tab(8, 'https://www.youtube.com/watch?v=UnknownB001', { groupId: 30 }),
    ];
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const durations = new Map<string, number | null>([
      ['Grp1Long001', 900],
      ['Grp1Short01', 100],
      ['Grp2Tie0001', 300],
      ['Grp2Tie0002', 300],
      ['Grp2Short01', 50],
      ['UngrpSingle', 400],
      ['UnknownA001', null],
      ['UnknownB001', null],
    ]);

    expect(sortYouTubeTabIds([1, 2, 3, 4, 5, 6, 7, 8], byId, durations, 'asc')).toEqual([
      2, 1, 5, 3, 4, 6, 7, 8,
    ]);
  });

  it('places unknown/live tabs after known ones even when live comes first', () => {
    const tabs = [
      tab(1, 'https://www.youtube.com/watch?v=LiveFirst01'),
      tab(2, 'https://www.youtube.com/watch?v=LiveSecond1'),
      tab(3, 'https://www.youtube.com/watch?v=FiniteVid01'),
    ];
    const byId = new Map(tabs.map((t) => [t.id, t]));
    const durations = new Map<string, number | null>([
      ['LiveFirst01', null],
      ['FiniteVid01', 120],
    ]);

    expect(sortYouTubeTabIds([1, 2, 3], byId, durations, 'asc')).toEqual([3, 1, 2]);
  });
});

describe('planYouTubeSlotMoves and planAnchorMoves', () => {
  it('reorders only movable YouTube tabs under exact browser splice semantics without touching pinned, newtab, or non-YT tabs', () => {
    const windowTabs = [
      tab(1, 'https://www.youtube.com/watch?v=PinnedVid01', { index: 0, pinned: true }),
      tab(2, 'https://www.youtube.com/watch?v=VidLong0001', { index: 1 }),
      tab(3, 'chrome://newtab/', { index: 2 }),
      tab(4, 'https://mail.google.com/', { index: 3 }),
      tab(5, 'https://www.youtube.com/watch?v=VidShort001', { index: 4, discarded: true }),
      tab(6, 'https://www.youtube.com/watch?v=VidMid00001', { index: 5 }),
    ];
    const movableIds = new Set([2, 4, 5, 6]);
    const durations = new Map<string, number | null>([
      ['PinnedVid01', 9999],
      ['VidLong0001', 1200],
      ['VidShort001', 60],
      ['VidMid00001', 300],
    ]);

    const plan = planYouTubeSlotMoves(windowTabs, movableIds, durations, 'asc');
    expect(plan.videoCount).toBe(3);
    expect(plan.knownCount).toBe(3);
    // Neither pinned tab (1), newtab (3), nor Gmail (4) is ever moved.
    expect(plan.moves.every((m) => [2, 5, 6].includes(m.tabId))).toBe(true);

    const after = applyBrowserMoves([1, 2, 3, 4, 5, 6], plan.moves);
    expect(after).toEqual([1, 5, 3, 4, 6, 2]);
  });

  it('handles leading non-YT tabs and descending order cleanly', () => {
    const windowTabs = [
      tab(1, 'https://github.com/a', { index: 0 }),
      tab(2, 'https://www.youtube.com/watch?v=VidA0000001', { index: 1 }),
      tab(3, 'https://www.youtube.com/watch?v=VidB0000001', { index: 2 }),
      tab(4, 'https://docs.google.com/', { index: 3 }),
      tab(5, 'https://www.youtube.com/watch?v=VidC0000001', { index: 4 }),
    ];
    const movableIds = new Set([1, 2, 3, 4, 5]);
    const durations = new Map<string, number | null>([
      ['VidA0000001', 60],
      ['VidB0000001', 600],
      ['VidC0000001', 1800],
    ]);

    const plan = planYouTubeSlotMoves(windowTabs, movableIds, durations, 'desc');
    expect(plan.moves.every((m) => [2, 3, 5].includes(m.tabId))).toBe(true);
    expect(applyBrowserMoves([1, 2, 3, 4, 5], plan.moves)).toEqual([1, 5, 3, 4, 2]);
  });

  it('emits zero moves when already ordered, fewer than 2 videos, or no known durations', () => {
    const ordered = [
      tab(1, 'https://www.youtube.com/watch?v=VidA0000001', { index: 0 }),
      tab(2, 'https://www.youtube.com/watch?v=VidB0000001', { index: 1 }),
    ];
    const durations = new Map<string, number | null>([
      ['VidA0000001', 60],
      ['VidB0000001', 300],
    ]);
    expect(planYouTubeSlotMoves(ordered, new Set([1, 2]), durations, 'asc').moves).toEqual([]);
    expect(planYouTubeSlotMoves(ordered.slice(0, 1), new Set([1]), durations, 'asc')).toEqual({
      moves: [],
      videoCount: 1,
      knownCount: 1,
    });
    expect(planYouTubeSlotMoves(ordered, new Set([1, 2]), new Map(), 'asc')).toEqual({
      moves: [],
      videoCount: 2,
      knownCount: 0,
    });
  });

  it('ignores missing tab ids safely in planAnchorMoves', () => {
    expect(planAnchorMoves([1, 2], [99, 2, 1], new Set([99, 1, 2]), 0)).toEqual([
      { tabId: 2, index: 0 },
    ]);
  });
});
