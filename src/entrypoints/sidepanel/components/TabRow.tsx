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
import type { Favicon } from '@/platform/favicon';
import { faviconOf } from '@/platform/favicon';
import { activateTab } from '@/platform/tabs';
import { displayHost } from '@/core/url';
import { rowStopId } from '../keyboard';
import type { DeclutterRow } from '../sections';
import { chipsOf, reasonText } from '../reasons';
import { keepTabs, requestClose } from '../state/commands';
import { selectedSignal, toggleSelected } from '../state/selection';
import { Chip } from './Chip';

export function TabRow({
  row,
  language,
  focused,
}: {
  row: DeclutterRow;
  language: string;
  /** Whether this row holds the list's `tabindex="0"`. */
  focused: boolean;
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

  return (
    <div
      class={selected ? 'td-row td-row-picked' : 'td-row'}
      role="row"
      data-stop={rowStopId(tab.id)}
      tabIndex={focused ? 0 : -1}
      onClick={() => {
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
          <TabFavicon tab={tab} />
          <span class="td-row-title" title={tab.url}>
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

/**
 * The 16 px icon. `faviconOf` decides between the browser's own cached icon and an
 * avatar; this only draws the answer.
 */
function TabFavicon({ tab }: { tab: { url: string; favIconUrl?: string } }) {
  const favicon: Favicon = faviconOf(tab);

  if (favicon.kind === 'image') {
    // Decorative: the title beside it names the tab, and an alt text repeating the
    // domain would be read twice. `loading="lazy"` keeps a long list cheap (§11).
    return <img class="td-favicon" src={favicon.src} alt="" loading="lazy" decoding="async" />;
  }

  return (
    <span
      class="td-favicon td-avatar"
      aria-hidden="true"
      // A custom property, so the hue is the only thing the component decides: the
      // saturation, the lightness and the contrast stay in the stylesheet (§4.8).
      style={`--td-avatar-hue: ${favicon.hue}`}
    >
      {favicon.initial}
    </span>
  );
}

function failed(error: unknown): void {
  console.error('TabDeclutter: go to tab', error);
}
