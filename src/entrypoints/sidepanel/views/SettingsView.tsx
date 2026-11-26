/**
 * The settings, as the gear of PLAN.md §4.2 opens them: every row of §4.6, then the way to
 * "Protezione duplicati" (§8.3), which stays a sub-page of its own because it is a page of
 * twenty options.
 *
 * Every change is written as it is made — settings are a small object and `storage.local` is
 * cheap — so the page has no "Salva" of its own. "Siti protetti" has one, like the whitelist:
 * a half-typed domain is not a choice yet.
 *
 * Two rows are more than a stored value. The bookmarks ask for the optional permission of §5.4
 * inside the click (`state/settings.ts`), and the AI row says where the browser stands rather
 * than offering a switch it cannot honour (§5.5, §7.3).
 */

import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';

import { caps } from '@/platform/capabilities';
import type { LanguageSetting, YouTubeDurationOrder } from '@/core/types';
import { t, type MessageKey } from '@/platform/i18n';
import { saveAiProposalState } from '@/platform/storage';
import {
  domainsText,
  durationChoices,
  GRACE_MS,
  IN_DAYS,
  IN_MS,
  LANGUAGE_CHOICES,
  parseDomains,
  RETENTION_DAYS,
  STALE_DAYS,
  YOUTUBE_ORDER_CHOICES,
  aiStateKey,
  type DurationChoice,
} from '../settings-fields';
import type { Choice } from '../guard-settings';
import { availability, checkAi } from '../state/ai';
import { guardSettings, matchOptions, setMatchOption } from '../state/guard';
import { MODE_CHOICES } from '../guard-settings';
import {
  bookmarksDenied,
  bookmarksGranted,
  checkBookmarksPermission,
  checkYouTubePermission,
  protectedSites,
  saveProtectedSites,
  setCloseLikedYouTube,
  setSetting,
  setSortYouTubeByDuration,
  setUseBookmarks,
  settings,
  youTubeDenied,
  youTubeGranted,
} from '../state/settings';
import { settingsPage } from '../state/view';
import { DuplicateSettingsView } from './DuplicateSettingsView';

export function SettingsView({ language }: { language: string }) {
  if (settingsPage.value === 'duplicates') {
    return (
      <>
        <button
          type="button"
          class="td-link-button"
          onClick={() => {
            settingsPage.value = 'main';
          }}
        >
          {t('settingsBack')}
        </button>
        <DuplicateSettingsView language={language} />
      </>
    );
  }
  return <MainSettings language={language} />;
}

function MainSettings({ language }: { language: string }) {
  const current = settings.value;
  const guard = guardSettings.value;
  const match = matchOptions.value;
  const aiState = aiStateKey(availability.value);
  const guardModeLabel =
    MODE_CHOICES.find((choice) => choice.value === guard.mode)?.label ?? 'guardModeWarn';

  // The optional permissions are checked when the page opens; the AI availability is only probed
  // once `useOnDeviceAi` is on, so Chrome does not log an extension warning when its built-in AI
  // is disabled in chrome://settings/ai.
  useEffect(() => {
    checkBookmarksPermission();
    checkYouTubePermission();
  }, []);

  useEffect(() => {
    if (current.useOnDeviceAi) void checkAi();
  }, [current.useOnDeviceAi]);

  return (
    <section class="td-settings">
      <h2 class="td-section-title">{t('navSettings')}</h2>
      <p class="td-view-intro">{t('settingsIntro')}</p>

      <div class="td-settings-card">
        <h3 class="td-settings-group">{t('autopilotTitle')}</h3>
        <p class="td-field-hint">{t('autopilotHint')}</p>
        <CheckField
          label="autopilotDeclutter"
          value={current.autoDeclutter}
          onPick={(value) => {
            setSetting('autoDeclutter', value);
          }}
        />
        <CheckField
          label="autopilotOrganize"
          value={current.autoOrganize}
          onPick={(value) => {
            setSetting('autoOrganize', value);
          }}
        />
      </div>

      <div class="td-settings-card">
        <h3 class="td-settings-group">{t('settingsGroupYouTube')}</h3>
        <CheckField
          label="settingsYouTubeSort"
          hint="settingsYouTubeSortHint"
          value={current.sortYouTubeByDuration && youTubeGranted.value}
          onPick={setSortYouTubeByDuration}
        />
        {current.sortYouTubeByDuration && youTubeGranted.value && (
          <ChoiceField
            label="settingsYouTubeOrder"
            choices={YOUTUBE_ORDER_CHOICES}
            value={current.youTubeDurationOrder}
            onPick={(value: YouTubeDurationOrder) => {
              setSetting('youTubeDurationOrder', value);
            }}
          />
        )}
        <CheckField
          label="settingsYouTubeCloseLiked"
          hint="settingsYouTubeCloseLikedHint"
          value={current.closeLikedYouTube && youTubeGranted.value}
          onPick={setCloseLikedYouTube}
        />
        {current.closeLikedYouTube && youTubeGranted.value && (
          <CheckField
            label="settingsYouTubeCloseLikedActive"
            hint="settingsYouTubeCloseLikedActiveHint"
            value={current.closeLikedYouTubeActive}
            onPick={(value) => {
              setSetting('closeLikedYouTubeActive', value);
            }}
          />
        )}
        <div class="td-warnings" role="status" aria-live="polite">
          {youTubeDenied.value && <p class="td-warning">{t('settingsYouTubeDenied')}</p>}
        </div>
      </div>

      <div class="td-settings-card">
        <div class="td-settings-card-head">
          <h3 class="td-settings-group">{t('settingsDuplicates')}</h3>
          <span class="td-chip td-settings-status">{t(guardModeLabel)}</span>
        </div>
        <p class="td-field-hint">{t('settingsDuplicatesHint')}</p>
        <button
          type="button"
          class="td-action td-action-primary"
          onClick={() => {
            settingsPage.value = 'duplicates';
          }}
        >
          {t('settingsOpenDuplicates')}
        </button>
      </div>

      <div class="td-settings-card">
        <h3 class="td-settings-group">{t('settingsGroupSuggestions')}</h3>
        <NumberField
          label="settingsFieldStale"
          choices={durationChoices(STALE_DAYS, current.staleDays, IN_DAYS, language)}
          value={current.staleDays}
          onPick={(value) => {
            setSetting('staleDays', value);
          }}
        />
        <NumberField
          label="settingsFieldGrace"
          choices={durationChoices(GRACE_MS, current.graceMs, IN_MS, language)}
          value={current.graceMs}
          onPick={(value) => {
            setSetting('graceMs', value);
          }}
        />
        <CheckField
          label="settingsBookmarks"
          hint="settingsBookmarksHint"
          value={current.useBookmarks && bookmarksGranted.value}
          onPick={setUseBookmarks}
        />
        <CheckField
          label="matchIgnoreHash"
          hint="settingsIgnoreHashHint"
          value={match.ignoreHash}
          onPick={(value) => {
            setMatchOption('ignoreHash', value);
          }}
        />
        {caps.tabGroups && (
          <CheckField
            label="windowUseTabGroups"
            hint="windowUseTabGroupsHint"
            value={current.useTabGroups}
            onPick={(value) => {
              setSetting('useTabGroups', value);
              if (!value) {
                void import('@/platform/windows')
                  .then((windows) => windows.ungroupAllOpenTabs())
                  .catch(() => undefined);
              }
            }}
          />
        )}
        {caps.tabGroups && current.useTabGroups && (
          <CheckField
            label="settingsIncludeGrouped"
            hint="settingsIncludeGroupedHint"
            value={current.includeGroupedTabs}
            onPick={(value) => {
              setSetting('includeGroupedTabs', value);
            }}
          />
        )}
        {/* A refusal is the browser's answer, so the page says what became of the choice. */}
        <div class="td-warnings" role="status" aria-live="polite">
          {bookmarksDenied.value && <p class="td-warning">{t('settingsBookmarksDenied')}</p>}
        </div>
      </div>

      <div class="td-settings-card">
        <h3 class="td-settings-group">{t('settingsGroupProtected')}</h3>
        <p class="td-field-hint">{t('settingsProtectedHint')}</p>
        <ProtectedSites />
      </div>

      <div class="td-settings-card">
        <h3 class="td-settings-group">{t('settingsGroupGeneral')}</h3>
        <ChoiceField
          label="settingsFieldLanguage"
          choices={LANGUAGE_CHOICES}
          value={current.language}
          onPick={(value: LanguageSetting) => {
            setSetting('language', value);
          }}
        />
        <NumberField
          label="settingsFieldRetention"
          choices={durationChoices(RETENTION_DAYS, current.archiveRetentionDays, IN_DAYS, language)}
          value={current.archiveRetentionDays}
          onPick={(value) => {
            setSetting('archiveRetentionDays', value);
          }}
        />
        <CheckField
          label="settingsShowBadge"
          value={current.showBadge}
          onPick={(value) => {
            setSetting('showBadge', value);
          }}
        />
      </div>

      {/* §5.5: on-device AI is experimental, Chrome-only, and off by default; keep hidden unless supported or already enabled. */}
      {((caps.promptApi && availability.value !== 'unsupported') || current.useOnDeviceAi) && (
        <details class="td-advanced-details" open={current.useOnDeviceAi}>
          <summary class="td-advanced-summary">{t('settingsGroupExperimental')}</summary>
          <div class="td-advanced-body">
            <p class="td-field-hint">{t('settingsExperimentalAiHint')}</p>
            <CheckField
              label="settingsUseAi"
              value={current.useOnDeviceAi}
              onPick={(value) => {
                setSetting('useOnDeviceAi', value);
                if (!value) void saveAiProposalState(null, '').catch(() => undefined);
              }}
            />
            {current.useOnDeviceAi && (
              <CheckField
                label="organizeAiRefreshEveryTab"
                hint="organizeAiRefreshEveryTabHint"
                value={current.aiRefreshEveryTab}
                onPick={(value) => {
                  setSetting('aiRefreshEveryTab', value);
                }}
              />
            )}
            {current.useOnDeviceAi && aiState !== null && (
              <p
                class={
                  availability.value === 'unavailable' || availability.value === 'unsupported'
                    ? 'td-warning'
                    : 'td-field-hint'
                }
                role="status"
                aria-live="polite"
              >
                {t(aiState)}
              </p>
            )}
          </div>
        </details>
      )}
    </section>
  );
}

/**
 * "Siti protetti" (§4.6): one domain per line, saved when the user says so.
 *
 * The draft lives here and the stored list is what it falls back to, exactly as the whitelist
 * editor does (`components/PatternListEditor.tsx`), so a half-typed domain never protects
 * anything and the panel does not write once per keystroke.
 */
function ProtectedSites() {
  const draft = useSignal<string | null>(null);

  const stored = domainsText(protectedSites.value);
  const text = draft.value ?? stored;
  const dirty = text !== stored;

  function save(): void {
    if (!dirty) return;
    void saveProtectedSites(parseDomains(text)).then(
      () => {
        // Back to following storage, which the save has just made equal to the draft.
        draft.value = null;
      },
      (error: unknown) => {
        console.error('TabDeclutter: protected sites', error);
      },
    );
  }

  return (
    <div class="td-patterns">
      <label class="td-field-label" for="td-protected">
        {t('settingsProtectedLabel')}
      </label>
      <textarea
        id="td-protected"
        class="td-pattern-text"
        rows={4}
        spellcheck={false}
        value={text}
        onInput={(event) => {
          draft.value = event.currentTarget.value;
        }}
        onChange={save}
      />
      <div class="td-pattern-actions">
        <button type="button" class="td-action td-action-primary" disabled={!dirty} onClick={save}>
          {t('whitelistSave')}
        </button>
      </div>
    </div>
  );
}

/** A field whose stored value is a number: the `<select>` speaks strings, the setting does not. */
function NumberField({
  label,
  choices,
  value,
  onPick,
}: {
  label: MessageKey;
  choices: readonly DurationChoice[];
  value: number;
  onPick: (value: number) => void;
}) {
  return (
    // The `<label>` wraps the control, which is what associates the two without an id.
    <label class="td-field">
      <span class="td-field-label">{t(label)}</span>
      <select
        class="td-filter"
        value={String(value)}
        onChange={(event) => {
          onPick(Number(event.currentTarget.value));
        }}
      >
        {choices.map((choice) => (
          <option key={choice.value} value={String(choice.value)}>
            {choice.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ChoiceField<V extends string>({
  label,
  choices,
  value,
  onPick,
}: {
  label: MessageKey;
  choices: readonly Choice<V>[];
  value: V;
  onPick: (value: V) => void;
}) {
  return (
    <label class="td-field">
      <span class="td-field-label">{t(label)}</span>
      <select
        class="td-filter"
        value={value}
        onChange={(event) => {
          onPick(event.currentTarget.value as V);
        }}
      >
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {t(choice.label)}
          </option>
        ))}
      </select>
    </label>
  );
}

function CheckField({
  label,
  hint,
  value,
  onPick,
}: {
  label: MessageKey;
  hint?: MessageKey;
  value: boolean;
  onPick: (value: boolean) => void;
}) {
  return (
    <>
      <label class="td-check">
        <input
          type="checkbox"
          checked={value}
          onChange={(event) => {
            onPick(event.currentTarget.checked);
          }}
        />
        <span>{t(label)}</span>
      </label>
      {hint !== undefined && <p class="td-field-hint">{t(hint)}</p>}
    </>
  );
}
