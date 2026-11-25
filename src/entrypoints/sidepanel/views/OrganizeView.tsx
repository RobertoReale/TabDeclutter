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

import { useEffect, useRef, useState } from 'preact/hooks';

import { caps } from '@/platform/capabilities';
import { t, type MessageKey } from '@/platform/i18n';
import { activateTab } from '@/platform/tabs';
import { ungroupAllOpenTabs } from '@/platform/windows';
import { requestYouTubePermission } from '@/platform/youtube';
import type { ClusterMode } from '@/core/cluster';
import { tabUrl } from '@/core/duplicates';
import { isClusterSavedAsTabGroup } from '@/core/plan-groups';
import {
  NO_GROUP_ID,
  type AutoWindowMode,
  type TabInfo,
  type YouTubeDurationCache,
  type YouTubeDurationOrder,
} from '@/core/types';
import { displayHost } from '@/core/url';
import { extractYouTubeVideoId, formatVideoDuration } from '@/core/youtube';
import { EmptyState } from '../components/EmptyState';
import { GroupPreview } from '../components/GroupPreview';
import { appliedGroupsText, formatCount, formatPercent, pairText } from '../format';
import type { OrganizeOptions, OrganizeScope } from '../organize';
import { YOUTUBE_ORDER_CHOICES } from '../settings-fields';
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
  aiProposalFreshForAutoRefresh,
  aiQuestion,
  aiStageDetail,
  aiWorking,
  appliedMessage,
  applyDraft,
  brought,
  cancelAiGrouping,
  cancelYouTubeSort,
  clearAiAutoCooldown,
  clearAiFallbackNotice,
  clearSavedAiProposal,
  dismissApplied,
  dismissWindowGroupSaved,
  dismissWindowOrganized,
  dismissYouTubeSorted,
  draft,
  focusedWindowYouTubeTabs,
  isAiAutoCoolingDown,
  lastAutoWindowAiSignature,
  loadSavedAiProposal,
  loadSavedYouTubeDurations,
  mode,
  movableTabSignature,
  movableTabs,
  options,
  organizeWindowsWithAi,
  plannedTabs,
  saveWindowPlanGroups,
  savedAiProposal,
  savedAiProposalLoaded,
  savedAiProposalSignature,
  savedYouTubeDurations,
  scope,
  setMode,
  setOptions,
  setScope,
  sortCurrentWindowYouTube,
  startAiGrouping,
  undoApply,
  undoWindowOrganize,
  undoWindowPlanGroups,
  undoYouTubeSort,
  windowGroupSavedMessage,
  windowGroupWorking,
  windowOrganized,
  windowPlan,
  windowWorking,
  working,
  youTubeSortProgress,
  youTubeSortStatus,
  youTubeSortWorking,
  youTubeSorted,
  type WindowPlan,
} from '../state/organize';
import {
  checkYouTubePermission,
  setSetting,
  settings,
  youTubeDenied,
  youTubeGranted,
} from '../state/settings';
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
    automatic = false,
  ): void {
    void organizeWindowsWithAi({
      windowMode: nextWindowMode,
      clusterMode: nextClusterMode,
      useTabGroups: nextUseTabGroups,
      useAi: nextUseAi,
      automatic,
      focusedWindowId: panelData.value?.focusedWindowId,
    }).catch(report);
  }

  function handleToggleAi(checked: boolean): void {
    if (!checked) {
      cancelAiGrouping();
      clearAiFallbackNotice();
      clearSavedAiProposal();
    } else {
      clearAiAutoCooldown();
      lastAutoWindowAiSignature.value = null;
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

  // Hydrate any cached session AI proposal when viewing the window-organization mode so
  // the overview and auto-AI refresh accurately reflect background state.
  useEffect(() => {
    if (!ready || currentSettings.useTabGroups) return;
    void loadSavedAiProposal();
  }, [ready, currentSettings.useTabGroups]);

  // Hydrate cached YouTube video durations and verify optional host permission when enabled.
  useEffect(() => {
    if (!ready || !currentSettings.sortYouTubeByDuration) return;
    checkYouTubePermission();
    void loadSavedYouTubeDurations();
  }, [ready, currentSettings.sortYouTubeByDuration]);

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
                dismissWindowGroupSaved();
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
          isAuto={isAuto}
          refreshEveryTab={currentSettings.aiRefreshEveryTab}
          onToggleAi={handleToggleAi}
          onToggleRefreshEveryTab={(checked) => {
            if (checked) {
              clearAiAutoCooldown();
              lastAutoWindowAiSignature.value = null;
            }
            setSetting('aiRefreshEveryTab', checked);
          }}
          onAutoRunAi={() => {
            runWindowOrganizeNow(undefined, undefined, undefined, undefined, true);
          }}
        />
      )}

      {currentSettings.sortYouTubeByDuration && (
        <YouTubeSortCard
          order={currentSettings.youTubeDurationOrder}
          language={language}
          focusedWindowId={panelData.value?.focusedWindowId}
        />
      )}

      {!currentSettings.useTabGroups && (
        <WindowPlanOverview
          plan={windowPlan.value}
          tabs={tabs.value}
          durations={currentSettings.sortYouTubeByDuration ? savedYouTubeDurations.value : null}
          focusedWindowId={panelData.value?.focusedWindowId}
          language={language}
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
            <YouTubeSortedToast language={language} />
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
          <YouTubeSortedToast language={language} />
          <WindowGroupSavedToast language={language} />
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
  isAuto,
  refreshEveryTab,
  onToggleAi,
  onToggleRefreshEveryTab,
  onAutoRunAi,
}: {
  language: string;
  useTabGroups: boolean;
  isAuto: boolean;
  refreshEveryTab: boolean;
  onToggleAi: (checked: boolean) => void;
  onToggleRefreshEveryTab: (checked: boolean) => void;
  onAutoRunAi: () => void;
}) {
  const wanted = useAi.value;
  useEffect(() => {
    if (wanted) void checkAi().catch(report);
  }, [wanted]);

  // Asked again whenever the question changes in tab-groups preview mode.
  const active = aiActive.value;
  const question = aiQuestion.value;
  useEffect(() => {
    if (!useTabGroups) return;
    void startAiGrouping().catch(report);
  }, [useTabGroups, active, question]);

  // In window-organization mode with Auto-organize + AI enabled, automatically refresh
  // windows with the on-device model when no cached proposal covers the open tabs yet.
  const hydrated = savedAiProposalLoaded.value;
  const movableSig = movableTabSignature.value;
  const lastAutoSig = lastAutoWindowAiSignature.value;
  const busy = aiWorking.value || windowWorking.value;
  useEffect(() => {
    if (useTabGroups || !isAuto || !active || !hydrated || busy || movableSig === '') return;
    if (isAiAutoCoolingDown()) return;
    if (lastAutoSig === movableSig) return;
    if (
      aiProposalFreshForAutoRefresh(
        savedAiProposal.value,
        movableTabs.value,
        savedAiProposalSignature.value,
        refreshEveryTab,
      )
    ) {
      return;
    }
    lastAutoWindowAiSignature.value = movableSig;
    onAutoRunAi();
  }, [useTabGroups, isAuto, active, hydrated, busy, movableSig, lastAutoSig, refreshEveryTab]);

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

      {wanted && !useTabGroups && isAuto && !unavailable && (
        <>
          <label class="td-check">
            <input
              type="checkbox"
              checked={refreshEveryTab}
              onChange={(event) => {
                onToggleRefreshEveryTab(event.currentTarget.checked);
              }}
            />
            <span>{t('organizeAiRefreshEveryTab')}</span>
          </label>
          <p class="td-field-hint">{t('organizeAiRefreshEveryTabHint')}</p>
        </>
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
        <>
          <p class="td-ai-working" role="status" aria-live="polite">
            <span>{t('organizeAiWorking')}</span>
            {/* §7.3: the wait is always interruptible, and §7.2's groups are already there. */}
            <button type="button" class="td-action" onClick={cancelAiGrouping}>
              {t('organizeAiCancel')}
            </button>
          </p>
          {aiStageDetail.value !== null && <p class="td-field-hint">{aiStageDetail.value}</p>}
        </>
      )}
    </div>
  );
}

/**
 * Optional YouTube duration sorting card in Organize: sorts only YouTube video tabs in the
 * current window in place (including suspended tabs without waking them), with direction toggle,
 * live progress, and 1-click Undo.
 */
function YouTubeSortCard({
  order,
  language,
  focusedWindowId,
}: {
  order: YouTubeDurationOrder;
  language: string;
  focusedWindowId?: number;
}) {
  const videoCount = focusedWindowYouTubeTabs.value.length;
  const progress = youTubeSortProgress.value;
  const status = youTubeSortStatus.value;
  const busy = youTubeSortWorking.value || windowWorking.value;

  function triggerSort(nextOrder: YouTubeDurationOrder): void {
    if (!youTubeGranted.value) {
      // Request synchronously inside the click handler if permission was revoked externally.
      void requestYouTubePermission()
        .then((granted) => {
          youTubeGranted.value = granted;
          youTubeDenied.value = !granted;
          if (granted) {
            return sortCurrentWindowYouTube(nextOrder, focusedWindowId);
          }
          return undefined;
        })
        .catch(report);
      return;
    }
    void sortCurrentWindowYouTube(nextOrder, focusedWindowId).catch(report);
  }

  return (
    <section class="td-youtube-card" aria-label={t('youtubeSortHeading')}>
      <div class="td-youtube-card-head">
        <h3 class="td-settings-group">{t('youtubeSortHeading')}</h3>
        <span class="td-chip td-settings-status">{formatCount(videoCount, language)}</span>
      </div>
      <p class="td-field-hint">{t('youtubeSortHint')}</p>

      <label class="td-field">
        <span class="td-field-label">{t('settingsYouTubeOrder')}</span>
        <select
          class="td-filter"
          value={order}
          onChange={(event) => {
            const nextOrder = event.currentTarget.value as YouTubeDurationOrder;
            setSetting('youTubeDurationOrder', nextOrder);
          }}
        >
          {YOUTUBE_ORDER_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {t(choice.label)}
            </option>
          ))}
        </select>
      </label>

      <div class="td-pattern-actions">
        <button
          type="button"
          class="td-action td-action-primary"
          disabled={busy || videoCount < 2}
          onClick={() => {
            triggerSort(order);
          }}
        >
          {t('youtubeSortNow')}
        </button>
      </div>

      {videoCount < 2 && !busy && <p class="td-field-hint">{t('youtubeSortNeedTwo')}</p>}

      {youTubeSortWorking.value && progress !== null && (
        <p class="td-ai-working" role="status" aria-live="polite">
          <span>
            {t(
              'youtubeSortReading',
              formatCount(progress.done, language),
              formatCount(progress.total, language),
            )}
          </span>
          <button type="button" class="td-action" onClick={cancelYouTubeSort}>
            {t('organizeAiCancel')}
          </button>
        </p>
      )}

      <div class="td-warnings" role="status" aria-live="polite">
        {youTubeDenied.value && <p class="td-warning">{t('settingsYouTubeDenied')}</p>}
        {status === 'already-ordered' && (
          <p class="td-field-hint">{t('youtubeSortAlreadyOrdered')}</p>
        )}
        {status === 'unavailable' && <p class="td-warning">{t('youtubeSortUnavailable')}</p>}
      </div>
    </section>
  );
}

/** Compact collapsible overview of how open tabs are grouped across windows when tab groups are off. */
function WindowPlanOverview({
  plan,
  tabs: openTabs,
  durations,
  focusedWindowId,
  language,
}: {
  plan: WindowPlan;
  tabs: readonly TabInfo[];
  durations: YouTubeDurationCache | null;
  focusedWindowId?: number;
  language: string;
}) {
  const [expanded, setExpanded] = useState<Readonly<Record<string, boolean>>>({});

  if (plan.groups.length === 0 && plan.ungrouped.length === 0) return null;
  const byId = new Map(openTabs.map((tab) => [tab.id, tab]));
  const busy = windowGroupWorking.value || windowWorking.value;
  const savedFlags = plan.groups.map((group) => isClusterSavedAsTabGroup(group.tabIds, byId));
  const hasUnsavedGroups = savedFlags.some((saved) => !saved);

  function toggleRow(key: string): void {
    setExpanded((prev) => ({ ...prev, [key]: prev[key] !== true }));
  }

  function renderTabs(tabIds: readonly number[]) {
    return (
      <ul class="td-window-plan-list">
        {tabIds.map((tabId) => {
          const tab = byId.get(tabId);
          if (tab === undefined) return null;
          const host = displayHost(tab.url);
          const videoId = durations === null ? null : extractYouTubeVideoId(tabUrl(tab));
          const seconds = videoId === null ? null : (durations?.[videoId]?.seconds ?? null);
          return (
            <li key={tabId}>
              <button
                type="button"
                class="td-window-plan-tab"
                onClick={() => {
                  void activateTab(tab.id, tab.windowId).catch(report);
                }}
              >
                <span class="td-window-plan-tab-title">{tab.title || host}</span>
                {seconds !== null && seconds > 0 && (
                  <span class="td-window-plan-tab-duration">{formatVideoDuration(seconds)}</span>
                )}
                {host !== '' && <span class="td-window-plan-tab-host">{host}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  const otherExpanded = expanded.__other === true;

  return (
    <section class="td-window-plan" aria-label={t('windowPlanHeading')}>
      <div class="td-window-plan-head">
        <h3 class="td-settings-group">{t('windowPlanHeading')}</h3>
        <span class={plan.source === 'ai' ? 'td-chip td-ai-badge' : 'td-chip td-settings-status'}>
          {t(plan.source === 'ai' ? 'organizeAiBadge' : 'windowPlanSourceLocal')}
        </span>
      </div>
      <p class="td-field-hint">{t('windowPlanHint')}</p>

      {plan.groups.length > 0 && (
        <div class="td-window-plan-actions">
          <button
            type="button"
            class="td-action"
            disabled={busy || !hasUnsavedGroups}
            onClick={() => {
              void saveWindowPlanGroups(plan.groups, focusedWindowId).catch(report);
            }}
          >
            {t('windowPlanSaveAll')}
          </button>
        </div>
      )}

      {plan.groups.map((group, index) => {
        const isOpen = expanded[group.key] === true;
        const isSaved = savedFlags[index] === true;
        return (
          <div key={group.key} class="td-window-plan-group">
            <div class="td-window-plan-row">
              <button
                type="button"
                class="td-window-plan-summary"
                aria-expanded={isOpen}
                onClick={() => {
                  toggleRow(group.key);
                }}
              >
                <span class="td-window-plan-chevron" aria-hidden="true">
                  {isOpen ? '▾' : '▸'}
                </span>
                <span class="td-group-swatch" data-color={group.color} aria-hidden="true" />
                <span class="td-window-plan-name">
                  {t('sectionHeading', group.title, formatCount(group.tabIds.length, language))}
                </span>
              </button>
              {isSaved ? (
                <span class="td-chip td-window-plan-saved">{t('windowPlanGroupSaved')}</span>
              ) : (
                <button
                  type="button"
                  class="td-action td-window-plan-save"
                  disabled={busy}
                  aria-label={t('windowPlanSaveGroupAria', group.title)}
                  onClick={() => {
                    void saveWindowPlanGroups([group], focusedWindowId).catch(report);
                  }}
                >
                  {t('windowPlanSaveGroup')}
                </button>
              )}
            </div>
            {isOpen && renderTabs(group.tabIds)}
          </div>
        );
      })}

      {plan.ungrouped.length > 0 && (
        <div class="td-window-plan-group">
          <div class="td-window-plan-row">
            <button
              type="button"
              class="td-window-plan-summary"
              aria-expanded={otherExpanded}
              onClick={() => {
                toggleRow('__other');
              }}
            >
              <span class="td-window-plan-chevron" aria-hidden="true">
                {otherExpanded ? '▾' : '▸'}
              </span>
              <span class="td-group-swatch" data-color="grey" aria-hidden="true" />
              <span class="td-window-plan-name">
                {t(
                  'sectionHeading',
                  t('organizeOther'),
                  formatCount(plan.ungrouped.length, language),
                )}
              </span>
            </button>
          </div>
          {otherExpanded && renderTabs(plan.ungrouped)}
        </div>
      )}
    </section>
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
 * Undo toast for YouTube duration sorting: lets the user restore the window's YouTube tabs
 * back to their original slots in one click.
 */
function YouTubeSortedToast({ language }: { language: string }) {
  const result = youTubeSorted.value;
  const sortedCount = result === null ? '' : formatCount(result.sortedCount, language);
  const unknownCount = result === null ? '' : formatCount(result.unknownCount, language);

  return (
    <div class="td-toast-slot" role="status" aria-live="polite">
      {result !== null && (
        <div class="td-toast">
          <span class="td-toast-text">
            {result.unknownCount > 0
              ? t('youtubeSortDoneWithUnknown', sortedCount, unknownCount)
              : t('youtubeSortDone', sortedCount)}
          </span>
          <button
            type="button"
            class="td-action td-toast-undo"
            disabled={youTubeSortWorking.value}
            onClick={() => {
              void undoYouTubeSort();
            }}
          >
            {t('actionUndo')}
          </button>
          <button type="button" class="td-action td-toast-undo" onClick={dismissYouTubeSorted}>
            {t('organizeDismiss')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Undo toast for 1-click saving "Windows and topics" clusters as native browser tab groups.
 */
function WindowGroupSavedToast({ language }: { language: string }) {
  const message = windowGroupSavedMessage.value;

  return (
    <div class="td-toast-slot" role="status" aria-live="polite">
      {message !== null && (
        <div class="td-toast">
          <span class="td-toast-text">
            {message.count === 1
              ? t('windowPlanSavedOne', message.firstTitle)
              : t('windowPlanSavedOther', formatCount(message.count, language))}
            {message.skipped !== null && ` · ${pairText(message.skipped, t, language)}`}
          </span>
          <button
            type="button"
            class="td-action td-toast-undo"
            disabled={windowGroupWorking.value}
            onClick={() => {
              void undoWindowPlanGroups();
            }}
          >
            {t('actionUndo')}
          </button>
          <button type="button" class="td-action td-toast-undo" onClick={dismissWindowGroupSaved}>
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
