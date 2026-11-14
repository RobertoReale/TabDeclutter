/**
 * The "Organizza" view (PLAN.md §4.4): what the groups would be, editable, and then applied.
 *
 * Nothing happens to the browser until "Applica" (§3, invariant 2 in spirit): the view is a
 * preview the user can change, and the one irreversible-looking step comes with "Annulla".
 *
 * The whole module is reached through `import()` in `App.tsx` (§11): the clustering of
 * `core/cluster.ts` and this view's components are only loaded by someone who opens
 * Organize, so the Declutter list — what the panel opens on — does not pay for them.
 *
 * The scope, the mode, the options and the draft live in `state/organize.ts`, not here, so
 * leaving the view and coming back finds the same preview, and the toast still has its
 * subject after the tabs it grouped have changed underneath.
 *
 * On a browser with no tab groups the view says so and offers nothing (§5.5): the entry
 * stays in the nav because it is where a user looks for the feature, and a page that
 * explains is better than one that is missing.
 */

import { useEffect } from 'preact/hooks';

import { caps } from '@/platform/capabilities';
import { t, type MessageKey } from '@/platform/i18n';
import type { ClusterMode } from '@/core/cluster';
import { EmptyState } from '../components/EmptyState';
import { GroupPreview } from '../components/GroupPreview';
import { appliedGroupsText, formatCount, formatPercent, pairText } from '../format';
import type { OrganizeOptions, OrganizeScope } from '../organize';
import {
  aiActive,
  aiOffered,
  availability,
  checkAi,
  downloadProgress,
  enableAi,
  setUseAi,
  useAi,
} from '../state/ai';
import {
  aiBadge,
  aiQuestion,
  aiWorking,
  appliedMessage,
  applyDraft,
  brought,
  cancelAiGrouping,
  dismissApplied,
  draft,
  mode,
  options,
  plannedTabs,
  scope,
  setMode,
  setOptions,
  setScope,
  startAiGrouping,
  undoApply,
  working,
} from '../state/organize';
import { tabs } from '../state/tabs';

/** §4.4.1's scope, without "Selezione", which only exists once something was brought in. */
const SCOPES: readonly { readonly value: OrganizeScope; readonly label: MessageKey }[] = [
  { value: 'window', label: 'organizeScopeWindow' },
  { value: 'all', label: 'organizeScopeAll' },
];

/**
 * §4.4.2's two ways of grouping. "Per argomento" is one mode and not two: whether the
 * on-device model answers it is `AiPanel`'s business below, and on a browser without one
 * the heuristic of §7.2 answers the very same question (PLAN.md §5.5).
 */
const MODES: readonly { readonly value: ClusterMode; readonly label: MessageKey }[] = [
  { value: 'site', label: 'organizeModeSite' },
  { value: 'topic', label: 'organizeModeTopic' },
];

/**
 * §4.4.4's options, each one a plain switch over `OrganizeOptions`. `pick` builds the
 * change rather than the row naming its key twice: that way the key and the value it
 * carries are checked against `OrganizeOptions` by the compiler.
 */
const OPTIONS: readonly {
  readonly id: keyof OrganizeOptions;
  readonly label: MessageKey;
  readonly pick: (value: boolean) => Partial<OrganizeOptions>;
}[] = [
  {
    id: 'sortByGroup',
    label: 'organizeOptionSort',
    pick: (sortByGroup) => ({ sortByGroup }),
  },
  {
    id: 'collapse',
    label: 'organizeOptionCollapse',
    pick: (collapse) => ({ collapse }),
  },
  {
    id: 'leavePinnedOut',
    label: 'organizeOptionLeavePinned',
    pick: (leavePinnedOut) => ({ leavePinnedOut }),
  },
  {
    id: 'includeGrouped',
    label: 'organizeOptionIncludeGrouped',
    pick: (includeGrouped) => ({ includeGrouped }),
  },
];

export function OrganizeView({ language }: { language: string }) {
  if (!caps.tabGroups) return <EmptyState text={t('organizeNoGroups')} />;

  const current = draft.value;
  const chosen = options.value;
  const carried = brought.value;

  // The titles the preview shows, by id. Built here and not in the preview: the draft holds
  // ids only, which is what lets the edits be pure functions over numbers.
  const titles = new Map(tabs.value.map((tab) => [tab.id, tab.title]));

  return (
    <section class="td-organize">
      <label class="td-field">
        <span class="td-field-label">{t('organizeScope')}</span>
        <select
          class="td-filter"
          value={scope.value}
          onChange={(event) => {
            setScope(event.currentTarget.value as OrganizeScope);
          }}
        >
          {SCOPES.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.label)}
            </option>
          ))}
          {/*
           * Only once Declutter has sent a selection over: the option is what that
           * selection *is*, so without one there is nothing for it to mean.
           */}
          {carried !== null && (
            <option value="selection">
              {t('organizeScopeSelection', formatCount(carried.length, language))}
            </option>
          )}
        </select>
      </label>

      <label class="td-field">
        <span class="td-field-label">{t('organizeMode')}</span>
        <select
          class="td-filter"
          value={mode.value}
          onChange={(event) => {
            setMode(event.currentTarget.value as ClusterMode);
          }}
        >
          {MODES.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.label)}
            </option>
          ))}
        </select>
      </label>

      {mode.value === 'topic' && <AiPanel language={language} />}

      <h3 class="td-settings-group">{t('organizeOptions')}</h3>
      {OPTIONS.map((option) => (
        <label key={option.id} class="td-check">
          <input
            type="checkbox"
            checked={chosen[option.id]}
            onChange={(event) => {
              setOptions(option.pick(event.currentTarget.checked));
            }}
          />
          <span>{t(option.label)}</span>
        </label>
      ))}

      {current.groups.length === 0 ? (
        <EmptyState text={t('organizeEmpty')} />
      ) : (
        <>
          <h3 class="td-settings-group">
            {t('organizePreview')}
            {/* §4.4.2: the badge says who proposed what is on screen, and nothing more. */}
            {aiBadge.value && <span class="td-chip td-ai-badge">{t('organizeAiBadge')}</span>}
          </h3>
          <GroupPreview draft={current} titles={titles} language={language} />
        </>
      )}

      <div class="td-footer">
        <AppliedToast language={language} />
        {current.groups.length > 0 && (
          <div class="td-bar td-organize-actions" role="group" aria-label={t('organizePreview')}>
            <button
              type="button"
              class="td-action td-action-primary"
              // Nothing to apply is not an error to report: the button simply cannot be
              // pressed while every group is deselected, or while one apply is in flight.
              disabled={working.value || plannedTabs.value === 0}
              onClick={applyDraft}
            >
              {t('organizeApply')}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The on-device model in the Organize view (PLAN.md §7.3, §4.4.2), when grouping by topic.
 *
 * It is one component and not three pieces spread through the view because it is one
 * thing: what the browser can do, what the user chose, and what the model is doing right
 * now. Where there is no model — Firefox, or a Chrome that will not give one — it renders
 * nothing: §7.2 answers "per argomento" perfectly well, and an option that cannot be taken
 * is worse than no option (PLAN.md §5.5).
 *
 * The two effects are here and not in `OrganizeView` because the view returns early on a
 * browser without tab groups, and a hook after that return is a hook that sometimes runs.
 * Mounted only in topic mode, they also keep the model's module unfetched until the user
 * asks for the one feature that can use it (§11).
 */
function AiPanel({ language }: { language: string }) {
  useEffect(() => {
    void checkAi().catch(report);
  }, []);

  // Asked again whenever the question changes, and never while the model is not active:
  // `startAiGrouping` decides for itself, so the effect only has to tell it that
  // something moved.
  const active = aiActive.value;
  const question = aiQuestion.value;
  useEffect(() => {
    void startAiGrouping().catch(report);
  }, [active, question]);

  const state = availability.value;
  if (!aiOffered.value) return null;

  return (
    <div class="td-ai">
      {state === 'downloadable' && (
        <>
          {/*
           * The one place the download can start (§7.3): it is several gigabytes and the
           * browser only allows it with a click behind it, so it is asked for and never
           * assumed.
           */}
          <button
            type="button"
            class="td-action"
            onClick={() => {
              void enableAi().catch(report);
            }}
          >
            {t('organizeAiEnable')}
          </button>
          <p class="td-field-hint">{t('organizeAiEnableHint')}</p>
        </>
      )}

      {state === 'downloading' && (
        <p class="td-field-hint" role="status" aria-live="polite">
          {t('organizeAiDownloading', formatPercent(downloadProgress.value ?? 0, language))}
        </p>
      )}

      {state === 'available' && (
        <label class="td-check">
          <input
            type="checkbox"
            checked={useAi.value}
            onChange={(event) => {
              void setUseAi(event.currentTarget.checked).catch(report);
            }}
          />
          <span>{t('organizeAiUse')}</span>
        </label>
      )}

      {aiWorking.value && (
        <p class="td-ai-working" role="status" aria-live="polite">
          <span>{t('organizeAiWorking')}</span>
          {/* §7.3: the wait is always interruptible, and §7.2's groups are already there. */}
          <button type="button" class="td-action" onClick={cancelAiGrouping}>
            {t('organizeAiCancel')}
          </button>
        </p>
      )}
    </div>
  );
}

/** Nothing the user has to read: the heuristic has answered either way. */
function report(error: unknown): void {
  console.error('TabDeclutter: on-device AI', error);
}

/**
 * §4.4.5's toast: what was created, what stayed out, and "Annulla".
 *
 * It does not expire, unlike the close toast of §4.3: a close is kept in the archive for
 * weeks and can be undone long after the toast is gone, while a grouping is only undoable
 * from here. "Chiudi" is how it goes away (docs/DECISIONS.md, M4.3).
 */
function AppliedToast({ language }: { language: string }) {
  const message = appliedMessage.value;

  return (
    // The slot is always in the document, as the Declutter and Archive ones are: that is
    // what makes `aria-live` announce the toast when it appears inside it.
    <div class="td-toast-slot" role="status" aria-live="polite">
      {message !== null && (
        <div class="td-toast">
          <span class="td-toast-text">
            {appliedGroupsText(message.groups, t, language)}
            {message.skipped !== null && ` · ${pairText(message.skipped, t, language)}`}
          </span>
          <button type="button" class="td-toast-undo" onClick={undoApply}>
            {t('actionUndo')}
          </button>
          <button type="button" class="td-toast-undo" onClick={dismissApplied}>
            {t('organizeDismiss')}
          </button>
        </div>
      )}
    </div>
  );
}
