/**
 * One row of the Archive list (PLAN.md §4.5).
 *
 * The four things §4.5 asks for, in two lines: the checkbox, the favicon, the title and
 * the domain; then when it was closed, why, and the two actions — "Ripristina" and
 * "Elimina" — which appear on hover or focus like the Declutter row's.
 *
 * Unlike that row, the checkbox here answers for itself and the row is not a tab stop.
 * The Declutter list is one ARIA grid with the single roving tab stop of §4.8, because ↑
 * and ↓ have to cross its section boundaries; the archive is one flat list, so `Tab`
 * through real controls is both simpler and the behaviour a person expects of a form —
 * and `Space` on the checkbox is then the browser's own (docs/DECISIONS.md).
 *
 * "Elimina" is the only `--td-danger` button in the product: §4.7 reserves the colour for
 * the one action nothing can undo.
 *
 * A title and a URL are a page's own text and are never trusted: they are JSX children
 * and an attribute, never markup (invariant 7).
 */

import { t } from '@/platform/i18n';
import { displayHost } from '@/core/url';
import type { ArchivedTab } from '@/core/types';
import { relativeAge } from '../format';
import { archiveReasonText } from '../reasons';
import {
  archivePickedSignal,
  forgetArchived,
  restoreArchived,
  toggleArchivePicked,
} from '../state/archive';
import { RowFavicon } from './RowFavicon';

export function ArchiveRow({
  entry,
  language,
  /** The snapshot's moment, so every row ages against the one the filter used. */
  at,
}: {
  entry: ArchivedTab;
  language: string;
  at: number;
}) {
  // A tab closed before it had a title is named by the page it was on, so the row is
  // never a blank line with a favicon.
  const host = displayHost(entry.url);
  const title = entry.title === '' ? host : entry.title;
  // Its own signal, so ticking another row does not re-render this one (§11).
  const picked = archivePickedSignal(entry.id).value;

  return (
    <div
      class={picked ? 'td-row td-row-picked' : 'td-row'}
      role="row"
      onClick={() => {
        toggleArchivePicked(entry.id);
      }}
    >
      <div class="td-row-cell" role="gridcell">
        <div class="td-row-line">
          <input
            type="checkbox"
            class="td-row-check td-check-live"
            checked={picked}
            aria-label={t('rowSelect', title)}
            // Its own handler, and the click stops here: the row answers a click on
            // itself, and the two would otherwise tick and untick in one gesture.
            onClick={(event) => {
              event.stopPropagation();
              toggleArchivePicked(entry.id);
            }}
          />
          <RowFavicon page={entry} />
          <span class="td-row-title" title={entry.url}>
            {title}
          </span>
          <span class="td-row-host">{host}</span>
        </div>

        <div class="td-row-line td-row-meta">
          <span class="td-row-reason">{archiveReasonText(entry.reason, t)}</span>
          {/*
           * `Intl`'s own wording for the age, as in the chips of §4.3: an archive read in
           * Italian says "2 giorni fa" the way the browser's own surfaces do.
           */}
          <span class="td-row-when">{relativeAge(Math.max(at - entry.closedAt, 0), language)}</span>
          <span class="td-row-actions">
            <button
              type="button"
              class="td-action"
              onClick={(event) => {
                event.stopPropagation();
                restoreArchived([entry]);
              }}
            >
              {t('actionRestore')}
            </button>
            <button
              type="button"
              class="td-action td-action-danger"
              onClick={(event) => {
                event.stopPropagation();
                forgetArchived([entry]);
              }}
            >
              {t('actionDelete')}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
