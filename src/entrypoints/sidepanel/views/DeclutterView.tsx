/**
 * The "Riordina" view (PLAN.md §4.3): what to close, grouped by reason.
 *
 * It renders `declutter`, the grouped list `state/tabs.ts` computes, and decides nothing
 * itself — which section a tab is in and in which order the rows go is `sections.ts`'s
 * answer, and the wording is `reasons.ts`'s. The selection, the bulk actions and the
 * sticky bar §4.3 also draws are the actions task; what is here is the list, its reasons
 * and "Vai".
 */

import { t } from '@/platform/i18n';
import { EmptyState } from '../components/EmptyState';
import { HealthBar } from '../components/HealthBar';
import { Section } from '../components/Section';
import { forgottenWindowText } from '../reasons';
import type { ForgottenWindow } from '../sections';
import { declutter, tabCount } from '../state/tabs';

export function DeclutterView({ language }: { language: string }) {
  const list = declutter.value;

  if (list.total === 0) return <EmptyState text={t('declutterEmpty')} />;

  return (
    <>
      <HealthBar review={list.total} total={tabCount.value} language={language} />

      {list.windows.map((window) => (
        <WindowCard key={window.windowId} window={window} language={language} />
      ))}

      {list.sections.map((section) => (
        <Section key={section.id} section={section} language={language} />
      ))}
    </>
  );
}

/**
 * §4.3's whole-window suggestion: "Finestra con 12 schede non toccata da 3 settimane".
 * The button that closes it belongs to the actions task, so for now the card is the
 * sentence — the tabs themselves are in the sections below it either way.
 */
function WindowCard({ window, language }: { window: ForgottenWindow; language: string }) {
  return (
    <p class="td-window-card">{forgottenWindowText(window.tabCount, window.idleMs, t, language)}</p>
  );
}
