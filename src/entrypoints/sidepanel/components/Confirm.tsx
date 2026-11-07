/**
 * An inline confirmation (PLAN.md §9): the question, [Conferma], [Annulla].
 *
 * Inline and never `confirm()`: §9 forbids the modal, and a sheet that steals the focus
 * from the whole panel would be the same thing with nicer corners. This is a strip in the
 * bar, exactly where the button the user pressed was.
 *
 * It takes the focus to [Conferma] when it appears, which does three things at once: the
 * question is read out (through `aria-describedby`, so no `aria-live` has to shout over
 * the bar's own counts), `Enter` answers it, and `Escape` — the view's — dismisses it.
 */

import { useEffect, useRef } from 'preact/hooks';

import { t } from '@/platform/i18n';

/** The id the confirm button points at, so the question is its description. */
const QUESTION_ID = 'td-confirm-question';

export function Confirm({
  question,
  onConfirm,
  onCancel,
}: {
  question: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirm = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirm.current?.focus();
  }, []);

  return (
    <div class="td-confirm">
      <span class="td-confirm-text" id={QUESTION_ID}>
        {question}
      </span>
      <button
        ref={confirm}
        type="button"
        class="td-action td-action-primary"
        aria-describedby={QUESTION_ID}
        onClick={onConfirm}
      >
        {t('actionConfirm')}
      </button>
      <button type="button" class="td-action" onClick={onCancel}>
        {t('actionCancel')}
      </button>
    </div>
  );
}
