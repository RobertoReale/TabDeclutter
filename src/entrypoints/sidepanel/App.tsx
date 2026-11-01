/**
 * The panel's shell: the header of PLAN.md §4.2 and the view it is showing.
 *
 * The three views are only their empty state at this point — the rows are M2.2,
 * the groups M4.3, the archive M3.3 — but the header is already live: it reads
 * the signals of `state/tabs.ts`, so what it says is what the browser currently
 * has open.
 *
 * Every visible string goes through `t` (invariant 11) and nothing is ever
 * interpolated as HTML: a title or a URL is untrusted text (invariant 7), and
 * JSX children are text by construction.
 */

import { useSignal } from '@preact/signals';

import { panelLanguage, t } from '@/platform/i18n';
import { countsText, reviewText } from './format';
import { reviewCount, tabCount, windowCount } from './state/tabs';

/** The views the navigation of §4.2 switches between, in its order. */
const VIEWS = [
  { id: 'declutter', label: 'navDeclutter' },
  { id: 'organize', label: 'navOrganize' },
  { id: 'archive', label: 'navArchive' },
] as const;

type ViewId = (typeof VIEWS)[number]['id'];

export function App() {
  // The panel's language is fixed for the document's lifetime, so it is read
  // once rather than on every render.
  const language = panelLanguage();
  const view = useSignal<ViewId>('declutter');
  const settingsOpen = useSignal(false);

  return (
    <div class="td-panel">
      <header class="td-header">
        <div class="td-header-row">
          <h1 class="td-title">{t('extName')}</h1>
          <span class="td-counts">
            {countsText(tabCount.value, windowCount.value, t, language)}
          </span>
          <button
            type="button"
            class="td-icon-button"
            aria-label={t('navSettings')}
            title={t('navSettings')}
            aria-pressed={settingsOpen.value}
            onClick={() => {
              settingsOpen.value = !settingsOpen.value;
            }}
          >
            {/* Decorative: the button already has its name from `aria-label`. */}
            <span aria-hidden="true">⚙</span>
          </button>
        </div>
      </header>

      <nav class="td-nav" aria-label={t('navLabel')}>
        {VIEWS.map((item) => (
          <button
            // `key` by identity, never by index (PLAN.md §11).
            key={item.id}
            type="button"
            class="td-nav-item"
            aria-current={view.value === item.id && !settingsOpen.value ? 'page' : undefined}
            onClick={() => {
              view.value = item.id;
              settingsOpen.value = false;
            }}
          >
            {t(item.label)}
          </button>
        ))}
      </nav>

      <main class="td-main">
        {settingsOpen.value ? <SettingsView /> : <View id={view.value} language={language} />}
      </main>
    </div>
  );
}

function View({ id, language }: { id: ViewId; language: string }) {
  switch (id) {
    case 'declutter':
      return <DeclutterView language={language} />;
    case 'organize':
      return <p class="td-empty">{t('organizeEmpty')}</p>;
    case 'archive':
      return <p class="td-empty">{t('archiveEmpty')}</p>;
  }
}

/**
 * What the score found. The list itself is M2.2; until then the view says how
 * many tabs it would hold, which is the "N da rivedere" §4.2 puts next to the
 * health bar, or §4.3's empty state when the answer is none.
 */
function DeclutterView({ language }: { language: string }) {
  const count = reviewCount.value;
  if (count === 0) return <p class="td-empty">{t('declutterEmpty')}</p>;
  return <h2 class="td-section-title">{reviewText(count, t, language)}</h2>;
}

/** The settings are M6.1; the heading is here so the gear leads somewhere. */
function SettingsView() {
  return <h2 class="td-section-title">{t('navSettings')}</h2>;
}
