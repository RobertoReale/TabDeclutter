import { t } from '../../platform/i18n';

// Placeholder shell: the real panel is M2.1. Every string goes through `t`
// (invariant 11).
export function App() {
  return <main>{t('hello')}</main>;
}
