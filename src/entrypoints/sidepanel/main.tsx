import { render } from 'preact';

import { panelLanguage, t } from '../../platform/i18n';
import { App } from './App';

// `__MSG_*__` is resolved in the manifest and in CSS, never in HTML, so the
// document's own title and language are set here instead.
document.documentElement.lang = panelLanguage();
document.title = t('extName');

const root = document.getElementById('app');
if (root) {
  render(<App />, root);
}
