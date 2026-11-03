/**
 * The panel's shell: the header of PLAN.md §4.2 and the view it is showing.
 *
 * Declutter is live — its rows, its sections and its reasons are `views/
 * DeclutterView.tsx` — while Organize is still M4.3 and the archive M3.3, so
 * those two are only their empty state. The header reads the signals of
 * `state/tabs.ts`, so what it says is what the browser currently has open.
 *
 * Every visible string goes through `t` (invariant 11) and nothing is ever
 * interpolated as HTML: a title or a URL is untrusted text (invariant 7), and
 * JSX children are text by construction.
 */

import { useSignal } from '@preact/signals';

import { panelLanguage, t } from '@/platform/i18n';
import { countsText } from './format';
import { tabCount, windowCount } from './state/tabs';
import { DeclutterView } from './views/DeclutterView';

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

/** The settings are M6.1; the heading is here so the gear leads somewhere. */
function SettingsView() {
  return <h2 class="td-section-title">{t('navSettings')}</h2>;
}
