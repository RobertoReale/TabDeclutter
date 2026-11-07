/**
 * The "Archivio" view (PLAN.md §4.5): everything TabDeclutter closed, searchable, and
 * every row restorable.
 *
 * It renders `shownArchive` — the search and the two filters applied to one snapshot — and
 * decides nothing itself: what matches is `core/archive.ts`'s answer, what a restore means
 * is `platform/tabs.ts`'s, and the wording of a reason is `reasons.ts`'s.
 *
 * The archive is read here and not by the panel: up to 1000 entries nobody has asked for
 * are not worth reading to show the Declutter list, so `startArchiveState` begins when this
 * view mounts and its `stop()` takes the `storage.onChanged` listener away again (PLAN.md
 * §11, docs/DECISIONS.md).
 *
 * Two of §4.5's actions are destructive and are treated differently on purpose. "Elimina"
 * on a row takes one entry and the user is pointing at it, so it happens. "Svuota archivio"
 * takes all of them at once, so it asks — inline, in the strip where the button was, never
 * `confirm()` (§9). "Esporta" copies what the filter left, which is how a search chooses
 * what to export, and it reports back: the clipboard is the one thing here the browser can
 * refuse.
 */

import { useSignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';

import { t, type MessageKey } from '@/platform/i18n';
import type { ArchiveOrigin, ArchiveWhen } from '@/core/archive';
import { Confirm } from '../components/Confirm';
import { ArchiveRow } from '../components/ArchiveRow';
import { EmptyState } from '../components/EmptyState';
import { formatCount } from '../format';
import {
  allArchiveSelected,
  archiveData,
  archiveFilter,
  copyArchived,
  emptyArchived,
  forgetArchived,
  pickedArchive,
  restoreArchived,
  setArchiveOrigin,
  setArchiveQuery,
  setArchiveWhen,
  shownArchive,
  startArchiveState,
  toggleArchiveAll,
} from '../state/archive';

/** How long the "Copiato" confirmation stays, as §4.3's toast does for a close. */
const COPIED_MS = 4000;

/** §4.5's date filter, in the order it offers them. */
const WHEN: readonly { readonly value: ArchiveWhen; readonly label: MessageKey }[] = [
  { value: 'any', label: 'archiveWhenAny' },
  { value: 'today', label: 'archiveWhenToday' },
  { value: 'week', label: 'archiveWhenWeek' },
  { value: 'older', label: 'archiveWhenOlder' },
];

/** §4.5's origin filter: who closed the tab. */
const ORIGIN: readonly { readonly value: ArchiveOrigin; readonly label: MessageKey }[] = [
  { value: 'any', label: 'archiveOriginAny' },
  { value: 'mine', label: 'archiveOriginMine' },
  { value: 'duplicates', label: 'archiveOriginDuplicates' },
];

export function ArchiveView({ language }: { language: string }) {
  /** Whether "Svuota archivio" is waiting for its answer. */
  const asking = useSignal(false);
  /** Whether the export has just succeeded, for the status line below the list. */
  const copied = useSignal(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const handle = startArchiveState();
    return () => {
      handle.stop();
    };
  }, []);

  // Clears the pending timer when the view goes away, so a status line cannot be set on
  // an unmounted view.
  useEffect(
    () => () => {
      if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const data = archiveData.value;
  const filter = archiveFilter.value;
  const shown = shownArchive.value;

  // Nothing at all until the first read comes back: an empty state that turns into a list
  // a moment later would be a wrong answer, not a slow one.
  if (data === null) return null;

  if (data.entries.length === 0) {
    // No search box over an empty archive: there is nothing to search, and §4.5's filters
    // only make sense once something has been closed.
    return <EmptyState text={t('archiveEmpty')} />;
  }

  function onCopy(): void {
    void copyArchived(shown).then((done) => {
      if (!done) return;
      copied.value = true;
      if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => {
        copied.value = false;
      }, COPIED_MS);
    });
  }

  return (
    <>
      <div class="td-tools" role="group" aria-label={t('archiveTools')}>
        <input
          type="search"
          class="td-search"
          value={filter.query}
          aria-label={t('archiveSearch')}
          placeholder={t('archiveSearch')}
          onInput={(event) => {
            setArchiveQuery(event.currentTarget.value);
          }}
        />
        <select
          class="td-filter"
          aria-label={t('archiveWhen')}
          value={filter.when}
          onChange={(event) => {
            setArchiveWhen(event.currentTarget.value as ArchiveWhen);
          }}
        >
          {WHEN.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.label)}
            </option>
          ))}
        </select>
        <select
          class="td-filter"
          aria-label={t('archiveOrigin')}
          value={filter.origin}
          onChange={(event) => {
            setArchiveOrigin(event.currentTarget.value as ArchiveOrigin);
          }}
        >
          {ORIGIN.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.label)}
            </option>
          ))}
        </select>
      </div>

      {/*
       * The archive's own actions, and the place its one question is asked: the question
       * replaces the buttons rather than appearing beside them, so nothing else is
       * pressable while it is open (§9).
       */}
      <div class="td-tools td-tools-actions">
        {asking.value ? (
          <Confirm
            question={t('archiveConfirmEmpty', formatCount(data.entries.length, language))}
            onConfirm={() => {
              asking.value = false;
              emptyArchived();
            }}
            onCancel={() => {
              asking.value = false;
            }}
          />
        ) : (
          <>
            <SelectAllButton />
            <button type="button" class="td-action td-section-action" onClick={onCopy}>
              {t('archiveExport')}
            </button>
            <button
              type="button"
              class="td-action td-section-action td-action-danger"
              onClick={() => {
                asking.value = true;
              }}
            >
              {t('archiveEmptyAll')}
            </button>
          </>
        )}
      </div>

      {shown.length === 0 ? (
        <p class="td-empty">{t('archiveNoMatch')}</p>
      ) : (
        /*
         * A `grid`, as the Declutter list is and for the same reason: a row holds a
         * checkbox and two buttons. Unlike that list it has no roving tab stop — it has no
         * sections to cross, so its controls are plain tab stops (docs/DECISIONS.md).
         */
        <div class="td-list" role="grid" aria-label={t('archiveList')}>
          {shown.map((entry) => (
            // By entry id, never by index (§11).
            <ArchiveRow key={entry.id} entry={entry} language={language} at={data.at} />
          ))}
        </div>
      )}

      <div class="td-footer">
        {/*
         * The live region is the slot and is always in the document, as the undo toast's
         * is: `aria-live` announces what changes inside a region that was already there.
         */}
        <div class="td-toast-slot" role="status" aria-live="polite">
          {copied.value && (
            <div class="td-toast">
              <span class="td-toast-text">{t('archiveCopied')}</span>
            </div>
          )}
        </div>
        <ArchiveBar language={language} />
      </div>
    </>
  );
}

/**
 * §4.5's multiple restore and multiple delete, in the strip §4.3 puts a selection's
 * actions in. Its own component because it reads the selection: reading it in the view
 * would re-render every row each time one is ticked (§11).
 */
function ArchiveBar({ language }: { language: string }) {
  const picked = pickedArchive.value;
  if (picked.length === 0) return null;
  const count = formatCount(picked.length, language);

  return (
    <div class="td-bar" role="group" aria-label={t('barLabel')}>
      <button
        type="button"
        class="td-action td-action-primary"
        onClick={() => {
          restoreArchived(picked);
        }}
      >
        {t('barRestore', count)}
      </button>
      {/*
       * No question here, unlike "Svuota archivio": the rows this deletes are the ones the
       * user ticked and can see, and the button says how many.
       */}
      <button
        type="button"
        class="td-action td-action-danger"
        onClick={() => {
          forgetArchived(picked);
        }}
      >
        {t('barDelete', count)}
      </button>
    </div>
  );
}

/** "Seleziona tutti" over what the filter left, with the label its next press earns. */
function SelectAllButton() {
  const all = allArchiveSelected.value;

  return (
    <button type="button" class="td-action td-section-action" onClick={toggleArchiveAll}>
      {t(all ? 'sectionDeselectAll' : 'sectionSelectAll')}
    </button>
  );
}
