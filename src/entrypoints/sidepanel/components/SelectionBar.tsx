/**
 * The sticky selection bar (PLAN.md §4.3) and the questions of §9.
 *
 * It appears only when something is picked, and it is one strip with three buttons:
 * "Chiudi N", "Mantieni", "Sospendi". ("Raggruppa" is the grouping task, TASKS.md M4.3.)
 *
 * The close button is where two of §9's three safeguards show: its wording already says
 * when a window goes with the tabs ("Chiudi 3 schede e la finestra"), and when the close
 * has to be asked about the whole strip becomes the question, in place of the buttons —
 * the answer is wanted where the user just pressed, and nothing else should be pressable
 * while it is open.
 *
 * What it closes is not the raw selection but `selectionSafeguards`, so an id whose tab is
 * already gone is not counted in "Chiudi N" (`state/selection.ts`).
 */

import { t } from '@/platform/i18n';
import { closeSelectionText, confirmCloseText } from '../format';
import {
  asking,
  cancelClose,
  confirmClose,
  discardTabs,
  keepTabs,
  requestClose,
  selectionSafeguards,
  type PendingClose,
} from '../state/commands';
import { Confirm } from './Confirm';

export function SelectionBar({ language }: { language: string }) {
  const pending = asking.value;
  const safeguards = selectionSafeguards.value;

  if (pending !== null) {
    return (
      <div class="td-bar" role="group" aria-label={t('barLabel')}>
        <Confirm
          question={questionFor(pending, language)}
          onConfirm={confirmClose}
          onCancel={cancelClose}
        />
      </div>
    );
  }

  const { tabs } = safeguards;
  if (tabs.length === 0) return null;

  return (
    <div class="td-bar" role="group" aria-label={t('barLabel')}>
      <button
        type="button"
        class="td-action td-action-primary"
        onClick={() => {
          requestClose(tabs.map((tab) => tab.id));
        }}
      >
        {closeSelectionText(tabs.length, safeguards.wholeWindowIds.length, t, language)}
      </button>
      <button
        type="button"
        class="td-action"
        onClick={() => {
          keepTabs(tabs);
        }}
      >
        {t('actionKeep')}
      </button>
      <button
        type="button"
        class="td-action"
        onClick={() => {
          discardTabs(tabs);
        }}
      >
        {t('actionDiscard')}
      </button>
    </div>
  );
}

/**
 * Which of §9's two questions this close raises. The active tab wins when both apply: it
 * is the specific one, and the user who answers it has already been told how many go — the
 * rows behind the bar are ticked, and the button said so a moment ago.
 */
function questionFor(pending: PendingClose, language: string): string {
  const { safeguards } = pending;
  if (safeguards.activeTab !== undefined) return t('confirmCloseActive');
  return confirmCloseText(safeguards.tabs.length, t, language);
}
