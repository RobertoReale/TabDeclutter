/**
 * One row of the Declutter list (PLAN.md §4.3, §4.8).
 *
 * Two lines: the checkbox, the favicon, the title and the domain in grey; then why the
 * score suggests it, with the chips that qualify it and the three actions of §4.3 — "Vai",
 * "Mantieni", "Chiudi" — which appear on hover or focus.
 *
 * A click anywhere else on the row picks it, which is why the checkbox has no handler of
 * its own: one gesture, one place that answers it, and a 24 px target that is the whole
 * row rather than a 16 px box (§4.8). The three buttons stop the click, so pressing one
 * never also ticks the row.
 *
 * It is a `row` of the grid the list is, with everything it shows in one `gridcell`, so a
 * screen reader reads the title, the domain, the reason and the chips as one thing, which
 * is what the row is. Whether this row holds the single tab stop of §4.8 is the view's
 * answer, because ↑/↓ cross section boundaries; `Enter` on it goes to the tab, and the
 * view handles that too, where the key bubbles to.
 *
 * A title and a URL are a page's own text and are never trusted: they are JSX children
 * and an attribute, never markup (invariant 7).
 */

import { t } from '@/platform/i18n';
import { activateTab } from '@/platform/tabs';
import { displayHost, unwrapSuspendedUrl } from '@/core/url';
import { rowStopId } from '../keyboard';
import type { DeclutterRow } from '../sections';
import { chipsOf, reasonText } from '../reasons';
import { keepTabs, requestClose } from '../state/commands';
import { selectedSignal, toggleSelected } from '../state/selection';
import { Chip } from './Chip';
import { RowFavicon } from './RowFavicon';

export function TabRow({
  row,
  language,
  focused,
  closing = false,
}: {
  row: DeclutterRow;
  language: string;
  /** Whether this row holds the list's `tabindex="0"`. */
  focused: boolean;
  /**
   * §4.7's height collapse: a ghost of a row that `Section` is animating out after the
   * real one has already left `section.rows`. Not a tab stop and not interactive — the
   * tab it describes may already be gone.
   */
  closing?: boolean;
}) {
  const { tab, scored } = row;
  const reason = reasonText(scored, t, language);
  const chips = chipsOf(scored, t, language);
  // A tab with no title yet (still loading) is named by the page it is on, so the row is
  // never a blank line with a favicon.
  const host = displayHost(tab.url);
  const title = tab.title === '' ? host : tab.title;
  // Its own signal, so a `Space` on another row does not re-render this one (§11).
  const selected = selectedSignal(tab.id).value;

  const classes = ['td-row'];
  if (selected) classes.push('td-row-picked');
  if (closing) classes.push('td-row-closing');

  return (
    <div
      class={classes.join(' ')}
      role="row"
      aria-hidden={closing || undefined}
      data-stop={rowStopId(tab.id)}
      tabIndex={closing ? -1 : focused ? 0 : -1}
      onClick={() => {
        if (closing) return;
        toggleSelected(tab.id);
      }}
    >
      <div class="td-row-cell" role="gridcell">
        <div class="td-row-line">
          <input
            type="checkbox"
            class="td-row-check"
            checked={selected}
            aria-label={t('rowSelect', title)}
            // Out of the tab order (§4.8's single tab stop) and without a handler: the
            // click it makes reaches the row, which is what picks the tab.
            tabIndex={-1}
          />
          <RowFavicon page={tab} />
          <span class="td-row-title" title={unwrapSuspendedUrl(tab.url)}>
            {title}
          </span>
          <span class="td-row-host">{host}</span>
        </div>

        <div class="td-row-line td-row-meta">
          {reason !== '' && <span class="td-row-reason">{reason}</span>}
          {chips.map((chip) => (
            <Chip key={chip.id} text={chip.text} />
          ))}
          <span class="td-row-actions">
            {/*
             * All three out of the tab order, so the list stays the single tab stop of
             * §4.8: the keys of §4.8 do from the row what these do with the mouse.
             */}
            <button
              type="button"
              class="td-action"
              tabIndex={-1}
              onClick={(event) => {
                event.stopPropagation();
                void activateTab(tab.id, tab.windowId).catch(failed);
              }}
            >
              {t('actionGo')}
            </button>
            <button
              type="button"
              class="td-action"
              tabIndex={-1}
              onClick={(event) => {
                event.stopPropagation();
                keepTabs([tab]);
              }}
            >
              {t('actionKeep')}
            </button>
            <button
              type="button"
              class="td-action"
              tabIndex={-1}
              onClick={(event) => {
                event.stopPropagation();
                requestClose([tab.id]);
              }}
            >
              {t('actionClose')}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

function failed(error: unknown): void {
  console.error('TabDeclutter: go to tab', error);
}
