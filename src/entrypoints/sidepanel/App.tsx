/**
 * The panel's shell: the header of PLAN.md §4.2 and the view it is showing.
 *
 * Declutter is live — its rows, its sections and its reasons are `views/
 * DeclutterView.tsx` — and so are the archive (`views/ArchiveView.tsx`) and
 * Organize. The header reads the signals of `state/tabs.ts`, so what it says is
 * what the browser currently has open.
 *
 * Organize is the one view reached through `import()` (PLAN.md §11): it brings in
 * the clustering of `core/cluster.ts` and its own components, and the panel opens
 * on Declutter, so nobody who never presses "Organizza" downloads or parses them.
 * The module is kept in a module-level variable once loaded, so coming back to the
 * view is immediate and the chunk is fetched at most once per document.
 *
 * Every visible string goes through `t` (invariant 11) and nothing is ever
 * interpolated as HTML: a title or a URL is untrusted text (invariant 7), and
 * JSX children are text by construction.
 */

import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';

import { t, type MessageKey } from '@/platform/i18n';
import { GuardChip } from './components/GuardChip';
import { countsText } from './format';
import { language as panelLanguageSignal } from './state/settings';
import { tabCount, windowCount } from './state/tabs';
import type { ViewId } from './state/view';
import { settingsOpen, showView, toggleSettings, view } from './state/view';
import { ArchiveView } from './views/ArchiveView';
import { DeclutterView } from './views/DeclutterView';
// Type-only, so it is erased and the chunk is still fetched by the `import()` below.
import type * as OrganizeModule from './views/OrganizeView';
import { SettingsView } from './views/SettingsView';

/** The views the navigation of §4.2 switches between, in its order. */
const VIEWS: readonly { readonly id: ViewId; readonly label: MessageKey }[] = [
  { id: 'declutter', label: 'navDeclutter' },
  { id: 'organize', label: 'navOrganize' },
  { id: 'archive', label: 'navArchive' },
];

export function App() {
  // §4.6 lets the language be changed while the panel is open, so it is read from the signal
  // `state/settings.ts` keeps: every view takes it as a prop, so one change re-renders the shell
  // and with it everything that writes a date, a count or a duration.
  const language = panelLanguageSignal.value;

  return (
    <div class="td-panel">
      <header class="td-header">
        <div class="td-header-row">
          <h1 class="td-title">{t('extName')}</h1>
          {/* §4.8: the counts are a polite live region (see `HealthBar`). */}
          <span class="td-counts" aria-live="polite">
            {countsText(tabCount.value, windowCount.value, t, language)}
          </span>
          {/* §4.2 puts the protection's state on the counts line. */}
          <GuardChip language={language} />
          <button
            type="button"
            class="td-icon-button"
            aria-label={t('navSettings')}
            title={t('navSettings')}
            aria-pressed={settingsOpen.value}
            onClick={toggleSettings}
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
              showView(item.id);
            }}
          >
            {t(item.label)}
          </button>
        ))}
      </nav>

      <main class="td-main">
        {settingsOpen.value ? (
          <SettingsView language={language} />
        ) : (
          <View id={view.value} language={language} />
        )}
      </main>
    </div>
  );
}

function View({ id, language }: { id: ViewId; language: string }) {
  switch (id) {
    case 'declutter':
      return <DeclutterView language={language} />;
    case 'organize':
      return <OrganizeSlot language={language} />;
    case 'archive':
      return <ArchiveView language={language} />;
  }
}

/** The Organize chunk, once it has been fetched. Outside the component, so it survives. */
let organizeModule: typeof OrganizeModule | null = null;

/**
 * Loads `views/OrganizeView.tsx` the first time Organize is opened, and renders nothing
 * while it is in flight: the chunk is local, a few tens of kilobytes and already in the
 * extension's own package, so a spinner would flash rather than inform.
 */
function OrganizeSlot({ language }: { language: string }) {
  const loaded = useSignal(organizeModule);

  useEffect(() => {
    if (organizeModule !== null) return undefined;
    // Guards against a setState after the view has been left again mid-fetch.
    let alive = true;
    void import('./views/OrganizeView')
      .then((module) => {
        organizeModule = module;
        if (alive) loaded.value = module;
      })
      .catch((error: unknown) => {
        console.error('TabDeclutter: load Organize', error);
      });
    return () => {
      alive = false;
    };
  }, [loaded]);

  const module = loaded.value;
  if (module === null) return null;
  return <module.OrganizeView language={language} />;
}
