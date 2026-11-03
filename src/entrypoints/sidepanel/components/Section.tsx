/**
 * A collapsible section of the Declutter list (PLAN.md §4.3).
 *
 * The header is a button whose name is the heading itself ("Duplicati (4)") and whose
 * `aria-expanded` says whether the rows are showing, which is the pattern a screen reader
 * and a keyboard already know — no extra label, no `role` of our own.
 *
 * A folded section renders no rows at all rather than hiding them: 500 rows that are not
 * in the document cost nothing, which is the cheapest half of §11.
 *
 * Whether it starts folded comes from the list (`DeclutterSection.collapsed`, which is
 * §4.3's "«Da valutare» collapsed, «Da chiudere» expanded"); once the user has folded or
 * unfolded it by hand, their choice stands for as long as the panel is open.
 */

import { useSignal } from '@preact/signals';

import { t, type MessageKey } from '@/platform/i18n';
import { formatCount } from '../format';
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

export function Section({ section, language }: { section: DeclutterSection; language: string }) {
  const open = useSignal(!section.collapsed);
  const heading = t(
    'sectionHeading',
    t(NAMES[section.id]),
    formatCount(section.rows.length, language),
  );

  return (
    <section class="td-section">
      <h2 class="td-section-title">
        <button
          type="button"
          class="td-section-toggle"
          aria-expanded={open.value}
          onClick={() => {
            open.value = !open.value;
          }}
        >
          {/* Decorative: `aria-expanded` is what says which way it points. */}
          <span class="td-caret" aria-hidden="true">
            {open.value ? '▾' : '▸'}
          </span>
          <span class="td-section-name">{heading}</span>
        </button>
      </h2>

      {open.value && (
        <ul class="td-rows">
          {section.rows.map((row) => (
            // By tab id, never by index (§11): a row keeps its DOM node while the list
            // around it changes.
            <TabRow key={row.tab.id} row={row} language={language} />
          ))}
        </ul>
      )}
    </section>
  );
}
