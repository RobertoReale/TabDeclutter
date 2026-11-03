/**
 * One row of the Declutter list (PLAN.md §4.3).
 *
 * Two lines: the favicon, the title and the domain in grey; then why the score suggests
 * it, with the chips that qualify it. The actions appear on hover or focus — "Vai" is the
 * only one M2.2 has, the rest come with the actions task — and nothing on the row changes
 * anything about the tab except by being clicked.
 *
 * A title and a URL are a page's own text and are never trusted: they are JSX children
 * and an attribute, never markup (invariant 7).
 */

import { t } from '@/platform/i18n';
import type { Favicon } from '@/platform/favicon';
import { faviconOf } from '@/platform/favicon';
import { activateTab } from '@/platform/tabs';
import { displayHost } from '@/core/url';
import type { DeclutterRow } from '../sections';
import { chipsOf, reasonText } from '../reasons';
import { Chip } from './Chip';

export function TabRow({ row, language }: { row: DeclutterRow; language: string }) {
  const { tab, scored } = row;
  const reason = reasonText(scored, t, language);
  const chips = chipsOf(scored, t, language);
  // A tab with no title yet (still loading) is named by the page it is on, so the row is
  // never a blank line with a favicon.
  const host = displayHost(tab.url);
  const title = tab.title === '' ? host : tab.title;

  return (
    <li class="td-row">
      <div class="td-row-line">
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
          <button
            type="button"
            class="td-action"
            onClick={() => {
              void activateTab(tab.id, tab.windowId).catch(failed);
            }}
          >
            {t('actionGo')}
          </button>
        </span>
      </div>
    </li>
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
