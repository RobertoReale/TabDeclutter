/**
 * The archive, as the Archive view and the 6 h cleanup read it (PLAN.md §4.5, §10).
 *
 * Two jobs, one module, because both answer the same question — which entries matter now:
 *
 * - **what the view shows**: §4.5's text search over title and URL, its date filter
 *   ("Oggi", "Ultimi 7 giorni", "Più vecchie") and its origin filter ("Chiuse da me",
 *   "Duplicati chiusi automaticamente"), plus the Markdown export of whatever came out;
 * - **what the cleanup keeps**: §10's retention, the cap of `ARCHIVE_CAP`, and the
 *   activity records left behind by tabs that no longer exist.
 *
 * Pure, like everything in `src/core/` (invariant 4): no browser API and no ambient
 * clock — `now` arrives as a number, so "Oggi" and "30 giorni" are exact in a test.
 */

import { isTabActivity } from './reconcile';
import { DAY } from './time';
import { ARCHIVE_CAP } from './types';
import type { ActivityStore, ArchiveReason, ArchivedTab } from './types';
import { displayHost } from './url';

/** §4.5's date filter. `any` is the view's own fourth option: no filter at all. */
export type ArchiveWhen = 'any' | 'today' | 'week' | 'older';

/** §4.5's origin filter, with the same `any`. */
export type ArchiveOrigin = 'any' | 'mine' | 'duplicates';

/** What the view is asking of the archive. */
export interface ArchiveFilter {
  /** The search box, as typed. Whitespace-separated terms, all of which must match. */
  readonly query: string;
  readonly when: ArchiveWhen;
  readonly origin: ArchiveOrigin;
}

/** Everything, which is what the view opens on. */
export const ANY_ARCHIVE: ArchiveFilter = { query: '', when: 'any', origin: 'any' };

/** How many days "Ultimi 7 giorni" is, today included. */
const WEEK_DAYS = 7;

/**
 * Where an entry came from, in the two words §4.5's filter offers.
 *
 * `duplicate-auto` is the guard closing a tab as it opens (§8), the one close in the
 * product the user did not ask for one by one — so it is the only thing under "Duplicati
 * chiusi automaticamente". `duplicate-manual` is "Chiudi tutti i duplicati", which the
 * user asked for, and `window` is a whole window they took: both are "Chiuse da me".
 */
export function originOf(reason: ArchiveReason): 'mine' | 'duplicates' {
  return reason === 'duplicate-auto' ? 'duplicates' : 'mine';
}

/**
 * Midnight before `now`, in the browser's own time zone.
 *
 * "Oggi" is a day on a calendar and not the last 24 hours: a tab closed at 23:50 is
 * yesterday's as soon as the clock passes midnight, which is what the user means.
 */
export function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * The entries the view lists: the filter and the search, in the order they were stored
 * (`addToArchive` puts the newest first, which is the order §4.5 shows).
 *
 * The three date options are filters and not buckets: "Oggi" is inside "Ultimi 7 giorni",
 * and "Più vecchie" is exactly the complement of the latter, so nothing is unreachable.
 */
export function filterArchive(
  entries: readonly ArchivedTab[],
  filter: ArchiveFilter,
  now: number,
): readonly ArchivedTab[] {
  const needles = terms(filter.query);
  const today = startOfDay(now);
  const weekStart = today - (WEEK_DAYS - 1) * DAY;

  return entries.filter((entry) => {
    if (filter.when === 'today' && entry.closedAt < today) return false;
    if (filter.when === 'week' && entry.closedAt < weekStart) return false;
    if (filter.when === 'older' && entry.closedAt >= weekStart) return false;
    if (filter.origin !== 'any' && originOf(entry.reason) !== filter.origin) return false;
    return matches(entry, needles);
  });
}

/** The search box split into terms, lower-cased. An empty box is no term at all. */
function terms(query: string): readonly string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== '');
}

/**
 * Whether an entry satisfies every term, in its title or in its URL (§4.5: "ricerca
 * testuale (titolo + URL)"). Every term, not any, so a second word narrows a long list.
 */
function matches(entry: ArchivedTab, needles: readonly string[]): boolean {
  if (needles.length === 0) return true;
  const haystack = `${entry.title}\n${entry.url}`.toLowerCase();
  return needles.every((needle) => haystack.includes(needle));
}

/**
 * §4.5's "Esporta": the entries as a Markdown list of links, one per line, no trailing
 * newline. Empty in, empty out — the view does not offer the button in that case anyway.
 */
export function exportArchive(entries: readonly ArchivedTab[]): string {
  return entries.map((entry) => `- [${linkText(entry)}](${destination(entry.url)})`).join('\n');
}

/**
 * What the link says: the title, or the domain when the page never had one, or the URL
 * itself when it has no domain either (`about:blank`). A title is a page's own text and
 * can hold anything, so the brackets that would end the link early are escaped — the
 * export is text, but it is text somebody will paste into a document (invariant 7's
 * reasoning, one layer out).
 */
function linkText(entry: ArchivedTab): string {
  const named = entry.title.trim() === '' ? displayHost(entry.url) : entry.title;
  const shown = named === '' ? entry.url : named;
  return shown.replace(/[\\[\]]/g, '\\$&');
}

/**
 * A link destination Markdown reads back whole. A space or a parenthesis would end the
 * destination early, so such a URL goes in angle brackets, and the two characters that
 * would end *those* are percent-encoded — which is what a browser does to them anyway.
 */
function destination(url: string): string {
  if (!/[()\s<>]/.test(url)) return url;
  const escaped = url.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/\s/g, '%20');
  return `<${escaped}>`;
}

/** What a prune kept, and how many it dropped, so the caller can skip a pointless write. */
export interface ArchivePrune {
  /** The entries that stay, in the order they were given. */
  readonly kept: readonly ArchivedTab[];
  readonly dropped: number;
}

export interface RetentionOptions {
  readonly now: number;
  /** `Settings.archiveRetentionDays`, PLAN.md §4.6: 30 days by default. */
  readonly retentionDays: number;
  /** Defaults to `ARCHIVE_CAP`. Injected only so a test need not build 1000 entries. */
  readonly cap?: number;
}

/**
 * §10's half of the 6 h cleanup: the entries past retention, then the ones past the cap.
 *
 * Retention first, because an archive under the cap can still hold month-old entries, and
 * dropping them may bring the rest under the cap for free.
 */
export function pruneArchiveEntries(
  entries: readonly ArchivedTab[],
  options: RetentionOptions,
): ArchivePrune {
  const cap = Math.max(options.cap ?? ARCHIVE_CAP, 0);
  const oldest = options.now - Math.max(options.retentionDays, 0) * DAY;
  const fresh = entries.filter((entry) => entry.closedAt > oldest);
  const kept = fresh.length <= cap ? fresh : withinCap(fresh, cap);
  return { kept, dropped: entries.length - kept.length };
}

/**
 * The `cap` newest entries, still in the order they were given.
 *
 * `addToArchive` keeps the archive newest first, so in practice this is its own
 * `slice(0, cap)`; going through `closedAt` makes "the oldest go" true of a store that is
 * not in that order, which a migration or a hand-edited profile can leave behind.
 */
function withinCap(entries: readonly ArchivedTab[], cap: number): readonly ArchivedTab[] {
  const keep = new Set(
    entries
      .map((entry, position) => ({ closedAt: entry.closedAt, position }))
      // Newest first, and on a tie the one that was stored first: the stored order is
      // itself the record of which close came last.
      .sort((a, b) => b.closedAt - a.closedAt || a.position - b.position)
      .slice(0, cap)
      .map(({ position }) => position),
  );
  return entries.filter((_, position) => keep.has(position));
}

/** What a sweep kept, and how many records went. */
export interface ActivitySweep {
  readonly kept: ActivityStore;
  readonly dropped: number;
}

/**
 * §10's "orphaned activity records": a record for every open tab, and nothing else.
 *
 * The tracker deletes a record the moment its tab goes (`tabs.onRemoved`), so a record
 * for a tab that does not exist means nobody was listening — a crashed worker, a forced
 * restart. Anything in the store that is not a record at all goes the same way, because
 * only `isTabActivity` can tell the two apart and a score would have to guess.
 */
export function sweepActivity(saved: ActivityStore, openTabIds: readonly number[]): ActivitySweep {
  const open = new Set(openTabIds);
  const kept: ActivityStore = {};
  for (const [key, record] of Object.entries(saved)) {
    const tabId = Number(key);
    // A key that is not a number is not a tab id, so `has` says no and it is dropped.
    if (!open.has(tabId) || !isTabActivity(record)) continue;
    kept[tabId] = record;
  }
  return { kept, dropped: Object.keys(saved).length - Object.keys(kept).length };
}
