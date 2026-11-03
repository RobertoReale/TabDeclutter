/**
 * Where the keyboard can be in the Declutter list, and where ↑/↓ take it (PLAN.md §4.8).
 *
 * The list is one grid with one tab stop (the roving tabindex pattern): whatever ↑/↓ last
 * landed on is the element `Tab` reaches, and everything else is `tabindex="-1"`. This
 * module is the arithmetic of that — the flat sequence of places focus can rest, which
 * section header or row is holding the tab stop, and which one a key moves it to. It
 * touches no DOM and no browser API, so the order the keyboard walks in is checked in a
 * unit test rather than only in a browser.
 *
 * A stop is identified by a string (`data-stop` in the markup) rather than by its place in
 * the sequence, because the sequence changes under the user: a tab closes, a score moves a
 * row to another section, a section is folded. An id survives all of that, an index does
 * not.
 *
 * Relative imports, not `@/`: the `unit` vitest project runs without WXT's alias.
 */

import type { TabInfo } from '../../core/types';
import type { DeclutterSection, SectionId } from './sections';

/** One place the tab stop can rest: a section's header, or a row. */
export type Stop =
  | { readonly id: string; readonly kind: 'section'; readonly section: SectionId }
  | { readonly id: string; readonly kind: 'row'; readonly tab: TabInfo };

/** A section as the view is currently drawing it. */
export interface OpenSection {
  readonly section: DeclutterSection;
  /** Whether its rows are showing, which is whether they are stops at all. */
  readonly open: boolean;
}

export function sectionStopId(id: SectionId): string {
  return `section:${id}`;
}

export function rowStopId(tabId: number): string {
  return `row:${String(tabId)}`;
}

/**
 * Every stop, in the order ↑/↓ walk them: each section's header, then its rows when it is
 * open, section after section. A folded section is a single stop — its rows are not in the
 * document, so there is nothing to focus.
 */
export function stopsOf(sections: readonly OpenSection[]): readonly Stop[] {
  return sections.flatMap<Stop>(({ section, open }) => [
    { id: sectionStopId(section.id), kind: 'section', section: section.id },
    ...(open
      ? section.rows.map<Stop>((row) => ({
          id: rowStopId(row.tab.id),
          kind: 'row',
          tab: row.tab,
        }))
      : []),
  ]);
}

/**
 * The stop that holds `tabindex="0"`.
 *
 * `chosen` is where the user left the keyboard. When it is gone — the tab was closed, its
 * section folded, the score moved it — the tab stop falls back to the top of the list, so
 * the list always has exactly one way in.
 */
export function activeStop(stops: readonly Stop[], chosen: string | null): Stop | null {
  const found = stops.find((stop) => stop.id === chosen);
  return found ?? stops[0] ?? null;
}

/**
 * Where ↑ (`step` of -1) or ↓ (1) goes from `from`, or `null` when it would leave the
 * list.
 *
 * The ends do not wrap: in a list of suggestions, arriving back at the top after the last
 * row reads as the list having moved under you. ↑/↓ cross section boundaries, which is
 * §4.8's "navigable with the arrows" — one list, not five.
 */
export function nextStop(stops: readonly Stop[], from: string | null, step: number): Stop | null {
  const at = stops.findIndex((stop) => stop.id === from);
  if (at < 0) return stops[0] ?? null;
  return stops[at + step] ?? null;
}
