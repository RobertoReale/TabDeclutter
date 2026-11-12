/**
 * A collapsible section of the Declutter list (PLAN.md §4.3, §4.8).
 *
 * In the grid the list is, a section is a `rowgroup` whose first row is its header: the
 * header's name is the heading itself ("Duplicati (4)") and its `aria-expanded` says
 * whether the rows below it are showing, which is the pattern a screen reader already
 * knows from every collapsible table. It is a row and not a `<button>` inside one because
 * a grid's rows are what ↑/↓ walk, and the header is one of the stops: giving it a button
 * of its own would put a second tab stop inside the single one §4.8 asks for. The two
 * actions §4.3 puts in the header — "Seleziona tutti", "Chiudi tutti (N)" — are out of the
 * tab order for the same reason, and the keyboard reaches them as `Ctrl+A` and `Del` on
 * the header itself.
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
import { requestClose } from '../state/commands';
import { closeAllDuplicates, duplicateCount } from '../state/guard';
import { allSelected, deselectTabs, selectTabs } from '../state/selection';
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
  const tabIds = section.rows.map((row) => row.tab.id);

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

          {/*
           * §4.3's two section actions. Both stop the click: the header folds the section
           * when it is clicked, and picking or closing its tabs is not that. Out of the tab
           * order for the same reason as the row's (§4.8's single tab stop), with `Ctrl+A`
           * and `Del` on the header doing from the keyboard what they do.
           */}
          <SelectAllButton tabIds={tabIds} />
          <CloseAllButton section={section} tabIds={tabIds} language={language} />
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

/**
 * §4.3's "Chiudi tutti (N)".
 *
 * In the "Duplicati" section this is §8.7's action, not a close of the rows as listed: the
 * guard's own decision is recomputed, so the priorities are the ones in the settings and the
 * archive records the entries as duplicates with the tab each one lost to. The two close the
 * same tabs — the section lists exactly the ones the keep rules did not choose — but only §8.7's
 * path says *why* in the archive, which is what makes those entries findable later (§4.5).
 *
 * Its own component so that only the duplicates section subscribes to the sweep.
 */
function CloseAllButton({
  section,
  tabIds,
  language,
}: {
  section: DeclutterSection;
  tabIds: readonly number[];
  language: string;
}) {
  const duplicates = section.id === 'duplicates';
  const count = duplicates ? duplicateCount.value : tabIds.length;

  return (
    <button
      type="button"
      class="td-action td-section-action"
      tabIndex={-1}
      onClick={(event) => {
        event.stopPropagation();
        if (duplicates) closeAllDuplicates();
        else requestClose(tabIds);
      }}
    >
      {t('sectionCloseAll', formatCount(count, language))}
    </button>
  );
}

/**
 * §4.3's "Seleziona tutti", with the label that follows what it would do next.
 *
 * Its own component because it is the one thing in the header that reads the selection,
 * and reading it in `Section` would subscribe the section — and so re-render all of its
 * rows — every time a single row is picked (§11).
 */
function SelectAllButton({ tabIds }: { tabIds: readonly number[] }) {
  const all = allSelected(tabIds);

  return (
    <button
      type="button"
      class="td-action td-section-action"
      tabIndex={-1}
      onClick={(event) => {
        event.stopPropagation();
        if (all) deselectTabs(tabIds);
        else selectTabs(tabIds);
      }}
    >
      {t(all ? 'sectionDeselectAll' : 'sectionSelectAll')}
    </button>
  );
}
