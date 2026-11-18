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

import { useEffect, useRef } from 'preact/hooks';

import { caps } from '@/platform/capabilities';
import { t, type MessageKey } from '@/platform/i18n';
import { ungroupAllOpenTabs } from '@/platform/windows';
import type { ClusterMode } from '@/core/cluster';
import { NO_GROUP_ID, type AutoWindowMode } from '@/core/types';
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
  aiFallbackDetail,
  aiFallbackNotice,
  aiQuestion,
  aiWorking,
  appliedMessage,
  applyDraft,
  brought,
  cancelAiGrouping,
  clearAiFallbackNotice,
  dismissApplied,
  dismissWindowOrganized,
  draft,
  mode,
  options,
  organizeWindowsWithAi,
  plannedTabs,
  scope,
  setMode,
  setOptions,
  setScope,
  startAiGrouping,
  undoApply,
  undoWindowOrganize,
  windowOrganized,
  windowWorking,
  working,
} from '../state/organize';
import { setSetting, settings } from '../state/settings';
import { loaded, panelData, tabs } from '../state/tabs';

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

  const ready = loaded.value;
  const current = draft.value;
  const chosen = options.value;
  const carried = brought.value;
  const currentSettings = settings.value;
  const isAuto = currentSettings.autoOrganize;
  const hasGroupedTabs = tabs.value.some((tab) => tab.groupId !== NO_GROUP_ID);

  function runWindowOrganizeNow(
    nextWindowMode: AutoWindowMode = currentSettings.autoWindowMode,
    nextClusterMode: ClusterMode = mode.value,
    nextUseTabGroups: boolean = currentSettings.useTabGroups,
    nextUseAi: boolean = useAi.value,
  ): void {
    void organizeWindowsWithAi({
      windowMode: nextWindowMode,
      clusterMode: nextClusterMode,
      useTabGroups: nextUseTabGroups,
      useAi: nextUseAi,
      focusedWindowId: panelData.value?.focusedWindowId,
    }).catch(report);
  }

  function handleToggleAi(checked: boolean): void {
    if (!checked) {
      cancelAiGrouping();
      clearAiFallbackNotice();
    }
    void setUseAi(checked)
      .then(() => {
        if (checked && !currentSettings.useTabGroups && currentSettings.autoOrganize) {
          runWindowOrganizeNow(
            currentSettings.autoWindowMode,
            mode.value,
            currentSettings.useTabGroups,
            true,
          );
        }
      })
      .catch(report);
  }

  // When autoOrganize and useTabGroups are enabled, apply any proposed groups automatically.
  const lastAutoApplied = useRef<string>('');
  const autoProposalKey = JSON.stringify([
    chosen,
    current.groups.filter((g) => g.selected).map((g) => [g.key, g.title, g.color, g.tabIds]),
  ]);
  useEffect(() => {
    if (!ready || !isAuto || !currentSettings.useTabGroups) {
      lastAutoApplied.current = '';
      return;
    }
    if (working.value || plannedTabs.value === 0) return;
    if (lastAutoApplied.current === autoProposalKey) return;
    const timer = setTimeout(() => {
      if (working.value || plannedTabs.value === 0) return;
      lastAutoApplied.current = autoProposalKey;
      applyDraft();
    }, 600);
    return () => {
      clearTimeout(timer);
    };
  }, [ready, isAuto, currentSettings.useTabGroups, autoProposalKey]);

  // Wait for the persisted settings snapshot before painting the form so defaults never flash.
  if (!ready) return null;

  // The titles the preview shows, by id. Built here and not in the preview: the draft holds
  // ids only, which is what lets the edits be pure functions over numbers.
  const titles = new Map(tabs.value.map((tab) => [tab.id, tab.title]));

  return (
    <section class="td-organize">
      <p class="td-view-intro">{t('organizeIntro')}</p>

      <div class="td-autopilot-card">
        <label class="td-check">
          <input
            type="checkbox"
            checked={currentSettings.autoOrganize}
            onChange={(event) => {
              const checked = event.currentTarget.checked;
              setSetting('autoOrganize', checked);
              if (checked) runWindowOrganizeNow();
            }}
          />
          <span>{t('autopilotOrganize')}</span>
        </label>
        <div class="td-pattern-actions">
          <button
            type="button"
            class="td-action td-action-primary"
            disabled={windowWorking.value || aiWorking.value}
            onClick={() => {
              runWindowOrganizeNow();
            }}
          >
            {t('windowOrganizeNow')}
          </button>
          {hasGroupedTabs && (
            <button
              type="button"
              class="td-action"
              onClick={() => {
                void ungroupAllOpenTabs().catch(report);
              }}
            >
              {t('windowUngroupAll')}
            </button>
          )}
        </div>
      </div>

      <fieldset class="td-onboarding-group td-window-modes">
        <legend class="td-field-label">{t('windowModeHeading')}</legend>
        <label class="td-mode-card">
          <input
            type="radio"
            name="td-window-mode"
            value="merge-windows"
            checked={currentSettings.autoWindowMode === 'merge-windows'}
            onChange={() => {
              setSetting('autoWindowMode', 'merge-windows');
              runWindowOrganizeNow('merge-windows');
            }}
          />
          <div>
            <div class="td-field-label">{t('windowModeMergeTitle')}</div>
            <p class="td-field-hint">{t('windowModeMergeHint')}</p>
          </div>
        </label>

        <label class="td-mode-card">
          <input
            type="radio"
            name="td-window-mode"
            value="split-windows"
            checked={currentSettings.autoWindowMode === 'split-windows'}
            onChange={() => {
              setSetting('autoWindowMode', 'split-windows');
              runWindowOrganizeNow('split-windows');
            }}
          />
          <div>
            <div class="td-field-label">{t('windowModeSplitTitle')}</div>
            <p class="td-field-hint">{t('windowModeSplitHint')}</p>
          </div>
        </label>
      </fieldset>

      {currentSettings.useTabGroups && (
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
            {carried !== null && (
              <option value="selection">
                {t('organizeScopeSelection', formatCount(carried.length, language))}
              </option>
            )}
          </select>
        </label>
      )}

      <label class="td-field">
        <span class="td-field-label">{t('organizeMode')}</span>
        <select
          class="td-filter"
          value={mode.value}
          onChange={(event) => {
            const nextMode = event.currentTarget.value as ClusterMode;
            if (nextMode !== 'topic') {
              cancelAiGrouping();
              clearAiFallbackNotice();
            }
            setMode(nextMode);
            setSetting('autoOrganizeMode', nextMode);
            if (currentSettings.autoOrganize) {
              runWindowOrganizeNow(currentSettings.autoWindowMode, nextMode);
            }
          }}
        >
          {MODES.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.label)}
            </option>
          ))}
        </select>
      </label>
      <p class="td-field-hint">{t('windowUseTabGroupsHint')}</p>

      {/* Experimental on-device AI panel is only shown when the user explicitly opted in under Settings. */}
      {mode.value === 'topic' && useAi.value && (
        <AiPanel
          language={language}
          useTabGroups={currentSettings.useTabGroups}
          onToggleAi={handleToggleAi}
        />
      )}

      {currentSettings.useTabGroups && (
        <>
          <label class="td-check">
            <input
              type="checkbox"
              checked={currentSettings.useTabGroups}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setSetting('useTabGroups', checked);
                if (!checked) void ungroupAllOpenTabs().catch(report);
              }}
            />
            <span>{t('windowUseTabGroups')}</span>
          </label>

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
                {aiBadge.value && <span class="td-chip td-ai-badge">{t('organizeAiBadge')}</span>}
              </h3>
              <GroupPreview draft={current} titles={titles} language={language} />
            </>
          )}

          <div class="td-footer">
            <AppliedToast language={language} />
            {current.groups.length > 0 && (
              <div
                class="td-bar td-organize-actions"
                role="group"
                aria-label={t('organizePreview')}
              >
                <button
                  type="button"
                  class="td-action td-action-primary"
                  disabled={working.value || plannedTabs.value === 0}
                  onClick={applyDraft}
                >
                  {t('organizeApply')}
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {!currentSettings.useTabGroups && (
        <div class="td-footer">
          <WindowOrganizedToast language={language} />
        </div>
      )}
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
function AiPanel({
  language,
  useTabGroups,
  onToggleAi,
}: {
  language: string;
  useTabGroups: boolean;
  onToggleAi: (checked: boolean) => void;
}) {
  const wanted = useAi.value;
  useEffect(() => {
    if (wanted) void checkAi().catch(report);
  }, [wanted]);

  // Asked again whenever the question changes, and only when the tab-groups preview is active:
  // when organizing windows without tab groups, the AI runs inside `organizeWindowsWithAi` over
  // all windows rather than computing an unused preview.
  const active = aiActive.value;
  const question = aiQuestion.value;
  useEffect(() => {
    if (!useTabGroups) return;
    void startAiGrouping().catch(report);
  }, [useTabGroups, active, question]);

  const state = availability.value;
  // Never hide or discard the AI panel once the user has turned on-device AI on: if the model
  // becomes unavailable or unsupported, keep their checkbox checked and show a clear warning.
  if (!wanted && !aiOffered.value) return null;

  const unavailable = state === 'unavailable' || state === 'unsupported';
  const showCheckbox = wanted || state === 'available';

  return (
    <div class="td-ai">
      {showCheckbox && (
        <label class="td-check">
          <input
            type="checkbox"
            checked={wanted}
            onChange={(event) => {
              onToggleAi(event.currentTarget.checked);
            }}
          />
          <span>{t('organizeAiUse')}</span>
        </label>
      )}

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

      {wanted && unavailable && (
        <p class="td-warning" role="status" aria-live="polite">
          {t('organizeAiUnavailable')}
        </p>
      )}

      {wanted && !unavailable && aiFallbackNotice.value && (
        <>
          <p class="td-warning" role="status" aria-live="polite">
            {t('organizeAiFallback')}
          </p>
          {aiFallbackDetail.value !== null && (
            <p class="td-field-hint">{t('organizeAiFallbackDetail', aiFallbackDetail.value)}</p>
          )}
        </>
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
          <button type="button" class="td-action td-toast-undo" onClick={undoApply}>
            {t('actionUndo')}
          </button>
          <button type="button" class="td-action td-toast-undo" onClick={dismissApplied}>
            {t('organizeDismiss')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Undo toast for window organization (`Organize windows now`): lets the user restore every
 * moved tab back to its original window and position in one click.
 */
function WindowOrganizedToast({ language }: { language: string }) {
  const result = windowOrganized.value;
  const count = result === null ? '' : formatCount(result.windowsCount, language);

  return (
    <div class="td-toast-slot" role="status" aria-live="polite">
      {result !== null && (
        <div class="td-toast">
          <span class="td-toast-text">
            {t(result.windowsCount === 1 ? 'windowOrganizedOne' : 'windowOrganizedOther', count)}
          </span>
          <button
            type="button"
            class="td-action td-toast-undo"
            disabled={windowWorking.value}
            onClick={() => {
              void undoWindowOrganize();
            }}
          >
            {t('actionUndo')}
          </button>
          <button type="button" class="td-action td-toast-undo" onClick={dismissWindowOrganized}>
            {t('organizeDismiss')}
          </button>
        </div>
      )}
    </div>
  );
}
