import { render } from 'preact';

import { panelLanguage, t } from '../../platform/i18n';
import { App } from './App';
import { startGuardState } from './state/guard';
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

const root = document.getElementById('app');
if (root) {
  render(<App />, root);
}
