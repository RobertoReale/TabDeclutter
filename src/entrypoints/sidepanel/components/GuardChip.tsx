/**
 * The "🛡 Duplicati" chip of PLAN.md §4.2: what the protection is doing, a menu to change it,
 * and the counter that appears for five seconds when a duplicate is closed.
 *
 * The menu is a `role="menu"` popup owned by the chip: the chip says `aria-haspopup` and
 * `aria-expanded`, the three modes are `menuitemradio` in a group of their own — a mode is a
 * choice between three, not three switches — and the rest are plain items. Escape and moving the
 * focus out of it close it, which is what a menu is expected to do and also the only way to
 * dismiss it with the keyboard.
 *
 * Nothing here is sent to the background (§5.2): the items write settings and session state, and
 * "Chiudi tutti i duplicati" closes the tabs itself.
 */

import { useSignal } from '@preact/signals';

import { t, type MessageKey } from '@/platform/i18n';
import { closedTodayText, guardChipText, MODE_CHOICES } from '../guard-settings';
import { setArchiveOrigin } from '../state/archive';
import {
  closeAllDuplicates,
  closedToday,
  duplicateCount,
  guardStatus,
  pauseGuardFor,
  PAUSE_15_MIN_MS,
  PAUSE_1_HOUR_MS,
  PAUSE_UNTIL_RESTART_MS,
  resumeGuardNow,
  setGuardMode,
} from '../state/guard';
import { showSettings, showView } from '../state/view';

/** The three pauses of §4.2, with the labels the icon menu of §8.5 already uses. */
const PAUSES: readonly { readonly ms: number; readonly label: MessageKey }[] = [
  { ms: PAUSE_15_MIN_MS, label: 'menuPause15Min' },
  { ms: PAUSE_1_HOUR_MS, label: 'menuPause1Hour' },
  { ms: PAUSE_UNTIL_RESTART_MS, label: 'menuPauseRestart' },
];

export function GuardChip({ language }: { language: string }) {
  const open = useSignal(false);
  const status = guardStatus.value;
  // The clock is read at render: the chip is re-rendered whenever the mode or the pause
  // changes, and the alarm that ends a pause clears the session state, which is a change.
  const now = Date.now();
  const paused = status.pausedUntil !== undefined && status.pausedUntil > now;

  function close(): void {
    open.value = false;
  }

  return (
    <div
      class="td-guard"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open.value) return;
        event.stopPropagation();
        close();
      }}
      onFocusOut={(event) => {
        // A click inside the menu moves the focus within the same container, which is not a
        // dismissal; leaving it altogether is.
        const next = event.relatedTarget;
        if (next instanceof Node && event.currentTarget.contains(next)) return;
        close();
      }}
    >
      <button
        type="button"
        class="td-chip td-guard-chip"
        aria-haspopup="menu"
        aria-expanded={open.value}
        onClick={() => {
          open.value = !open.value;
        }}
      >
        {/* Decorative: the chip's text already says what it is. */}
        <span aria-hidden="true">🛡</span>
        <span>{guardChipText(status, now, t, language)}</span>
        <span aria-hidden="true">▾</span>
      </button>

      {open.value && (
        <div class="td-guard-menu" role="menu" aria-label={t('guardMenuLabel')}>
          <div role="group" aria-label={t('guardFieldMode')}>
            <p class="td-guard-menu-label" aria-hidden="true">
              {t('guardFieldMode')}
            </p>
            {MODE_CHOICES.map((choice) => (
              <button
                key={choice.value}
                type="button"
                class="td-guard-menu-item"
                role="menuitemradio"
                aria-checked={status.mode === choice.value}
                onClick={() => {
                  setGuardMode(choice.value);
                  close();
                }}
              >
                {t(choice.label)}
              </button>
            ))}
          </div>

          <div class="td-guard-menu-sep" role="separator" />

          {paused ? (
            <button
              type="button"
              class="td-guard-menu-item"
              role="menuitem"
              onClick={() => {
                resumeGuardNow();
                close();
              }}
            >
              {t('guardMenuResume')}
            </button>
          ) : (
            <div role="group" aria-label={t('menuPauseGuard')}>
              <p class="td-guard-menu-label" aria-hidden="true">
                {t('menuPauseGuard')}
              </p>
              {PAUSES.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  class="td-guard-menu-item"
                  role="menuitem"
                  onClick={() => {
                    pauseGuardFor(item.ms);
                    close();
                  }}
                >
                  {t(item.label)}
                </button>
              ))}
            </div>
          )}

          <div class="td-guard-menu-sep" role="separator" />

          <button
            type="button"
            class="td-guard-menu-item"
            role="menuitem"
            disabled={duplicateCount.value === 0}
            onClick={() => {
              closeAllDuplicates();
              close();
            }}
          >
            {t('guardMenuCloseAll', String(duplicateCount.value))}
          </button>
          <button
            type="button"
            class="td-guard-menu-item"
            role="menuitem"
            onClick={() => {
              showSettings();
              close();
            }}
          >
            {t('guardMenuSettings')}
          </button>
        </div>
      )}

      <GuardNotice language={language} />
    </div>
  );
}

/**
 * §4.2's "1 duplicato chiuso oggi · Vedi".
 *
 * The region is always in the document, like the toast's (`Toast.tsx`): a live region that
 * appears at the same moment as its text is announced by nothing.
 */
function GuardNotice({ language }: { language: string }) {
  const count = closedToday.value;

  return (
    <div class="td-guard-notice" role="status" aria-live="polite">
      {count !== null && (
        <>
          <span>{closedTodayText(count, t, language)}</span>
          <button
            type="button"
            class="td-guard-notice-link"
            onClick={() => {
              // The archive's own "Duplicati chiusi automaticamente" filter (§4.5).
              setArchiveOrigin('duplicates');
              showView('archive');
            }}
          >
            {t('guardNoticeSee')}
          </button>
        </>
      )}
    </div>
  );
}
