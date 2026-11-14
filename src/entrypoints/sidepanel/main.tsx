import { render } from 'preact';

import { panelLanguage, t } from '../../platform/i18n';
import { App } from './App';
import { closeAi } from './state/ai';
import { startGuardState } from './state/guard';
import { startLanguage } from './state/settings';
import { startPanelState } from './state/tabs';
// Tokens first: `base.css` reads them and declares no value of its own.
import './styles/tokens.css';
import './styles/base.css';

// `__MSG_*__` is resolved in the manifest and in CSS, never in HTML, so the
// document's own title and language are set here instead.
document.documentElement.lang = panelLanguage();
document.title = t('extName');

// Before the first render, so the listeners are in place while the first read
// is still in flight and the panel never misses a change.
startPanelState();
// The guard's state is in `storage.session`, which the panel's state deliberately does not
// watch, and the chip of §4.2 is in the header of every view: it follows it from here.
startGuardState();
// §4.6's language: `browser.i18n` cannot be switched at runtime, so the setting is followed here
// and `platform/i18n.ts` answers from the catalogue it asks for (docs/DECISIONS.md M6.1).
startLanguage();

// PLAN.md §7.3: the model's session is destroyed when the panel closes. `pagehide` and not
// `unload`, which a bfcached document never gets; `closeAi` does nothing when there was no
// session, which is the usual case.
addEventListener('pagehide', closeAi);

const root = document.getElementById('app');
if (root) {
  render(<App />, root);
}
