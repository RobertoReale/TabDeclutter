/**
 * A collapsible section of the Declutter list (PLAN.md §4.3, §4.8).
 *
 * In the grid the list is, a section is a `rowgroup` whose first row is its header: the
 * header's name is the heading itself ("Duplicati (4)") and its `aria-expanded` says
 * whether the rows below it are showing, which is the pattern a screen reader already
 * knows from every collapsible table. It is a row and not a `<button>` inside one because
 * a grid's rows are what ↑/↓ walk, and the header is one of the stops: giving it a button
 * of its own would put a second tab stop inside the single one §4.8 asks for.
 *
 * A folded section renders no rows at all rather than hiding them: 500 rows that are not
 * in the document cost nothing, which is the cheapest half of §11, and they are not stops
 * either.
 *
 * Whether it is folded, and which row holds the tab stop, are the view's: ↑ and ↓ cross
 * section boundaries, so only whoever sees the whole list can answer them.
 */

import { t, type MessageKey } from '@/platform/i18n';
import { formatCount } from '../format';
import { rowStopId, sectionStopId } from '../keyboard';
import type { DeclutterSection, SectionId } from '../sections';
import { TabRow } from './TabRow';

/** §4.3's section names, in `sections.ts`'s order. */
const NAMES: Readonly<Record<SectionId, MessageKey>> = {
  duplicates: 'sectionDuplicates',
  transient: 'sectionTransient',
  'stale-unread': 'sectionStaleUnread',
  stale: 'sectionStale',
  review: 'sectionReview',
};

export function Section({
  section,
  open,
  activeStop,
  language,
  onToggle,
}: {
  section: DeclutterSection;
  /** Whether the rows are showing. */
  open: boolean;
  /** The id of the stop holding `tabindex="0"`, which may be in another section. */
  activeStop: string | null;
  language: string;
  onToggle: () => void;
}) {
  const heading = t(
    'sectionHeading',
    t(NAMES[section.id]),
    formatCount(section.rows.length, language),
  );
  const stop = sectionStopId(section.id);

  return (
    <div class="td-section" role="rowgroup">
      <div
        class="td-section-toggle"
        role="row"
        aria-expanded={open}
        data-stop={stop}
        tabIndex={activeStop === stop ? 0 : -1}
        onClick={onToggle}
      >
        <span class="td-section-head" role="gridcell">
          {/* Decorative: `aria-expanded` is what says which way it points. */}
          <span class="td-caret" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span class="td-section-name">{heading}</span>
        </span>
      </div>

      {open &&
        section.rows.map((row) => (
          // By tab id, never by index (§11): a row keeps its DOM node while the list
          // around it changes.
          <TabRow
            key={row.tab.id}
            row={row}
            language={language}
            focused={activeStop === rowStopId(row.tab.id)}
          />
        ))}
    </div>
  );
}
