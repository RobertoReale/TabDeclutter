/**
 * The undo toast (PLAN.md §4.3): "17 schede chiuse · Annulla", for eight seconds.
 *
 * Its clock and its state are `state/undo.ts`'s; this is the part on screen, and the part
 * that says when the user is reading it: the pointer or the focus arriving holds the eight
 * seconds (§4.3's "non scompare se il mouse è sopra"), and leaving starts them again, so
 * the toast can never vanish from under the hand reaching for Annulla.
 *
 * The live region is the slot, not the toast, and the slot is always in the document:
 * `aria-live` only announces what changes *inside* a region that was already there, so a
 * toast that arrived with its own `aria-live` would be read by some screen readers and not
 * by others. `role="status"` is the polite one §4.8 asks for.
 */

import { t } from '@/platform/i18n';
import { closedText } from '../format';
import { undoClose } from '../state/commands';
import { holdUndo, lastClose, releaseUndo } from '../state/undo';

export function Toast({ language }: { language: string }) {
  const closed = lastClose.value;

  return (
    <div class="td-toast-slot" role="status" aria-live="polite">
      {closed !== null && (
        <div
          class="td-toast"
          // Focusable, as §4.3 asks: `Tab` out of the list reaches the toast, and while it
          // is there the eight seconds are held, so there is time to read it.
          tabIndex={0}
          onPointerEnter={holdUndo}
          onPointerLeave={releaseUndo}
          onFocusIn={holdUndo}
          onFocusOut={releaseUndo}
        >
          <span class="td-toast-text">{closedText(closed.entries.length, t, language)}</span>
          <button type="button" class="td-action td-toast-undo" onClick={undoClose}>
            {t('actionUndo')}
          </button>
        </div>
      )}
    </div>
  );
}
