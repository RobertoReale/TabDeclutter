import { render } from 'preact';

import { panelLanguage, t } from '../../platform/i18n';
import { App } from './App';
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

const root = document.getElementById('app');
if (root) {
  render(<App />, root);
}
