/**
 * The "Protezione duplicati" sub-page (PLAN.md §8.3).
 *
 * Three groups — behaviour, which tab stays, and what counts as the same URL — then the
 * whitelist. Which rows exist is `guard-settings.ts`'s answer and not this view's: the options
 * the running browser cannot honour are not here at all (§5.5), because a switch that does
 * nothing is worse than no switch.
 *
 * §8.6's two warnings appear only when the values earn them, and the note about Duplicate Tabs
 * Closer is always there: coexistence cannot be detected, so it can only be said.
 *
 * Every change is written as it is made — settings are a small object and `storage.local` is
 * cheap — so the page has no "Salva" of its own. The whitelist does, because a half-typed
 * pattern is not a choice yet.
 */

import { caps } from '@/platform/capabilities';
import { t, type MessageKey } from '@/platform/i18n';
import { PatternListEditor } from '../components/PatternListEditor';
import type { Choice } from '../guard-settings';
import {
  AFTER_CHOICES,
  guardWarnings,
  KEEP_CHOICES,
  MATCH_TOGGLES,
  MODE_CHOICES,
  SCOPE_CHOICES,
  visibleGuardToggles,
} from '../guard-settings';
import { guardSettings, matchOptions, setGuardOption, setMatchOption } from '../state/guard';

export function DuplicateSettingsView({ language }: { language: string }) {
  const guard = guardSettings.value;
  const match = matchOptions.value;
  const warnings = guardWarnings({ guard, match });

  return (
    <section class="td-settings">
      <h2 class="td-section-title">{t('settingsDuplicates')}</h2>

      <div class="td-settings-card">
        <h3 class="td-settings-group">{t('guardGroupBehaviour')}</h3>
        <ChoiceField
          label="guardFieldMode"
          choices={MODE_CHOICES}
          value={guard.mode}
          onPick={(value) => {
            setGuardOption('mode', value);
          }}
        />
        <ChoiceField
          label="guardFieldScope"
          choices={SCOPE_CHOICES}
          value={guard.scope}
          onPick={(value) => {
            setGuardOption('scope', value);
          }}
        />
        <ChoiceField
          label="guardFieldKeep"
          choices={KEEP_CHOICES}
          value={guard.keep}
          onPick={(value) => {
            setGuardOption('keep', value);
          }}
        />
      </div>

      {/* §8.6. A live region: a warning that appears because of the change just made. */}
      <div class="td-warnings" role="status" aria-live="polite">
        {warnings.map((warning) => (
          <p key={warning} class="td-warning">
            {t(warning)}
          </p>
        ))}
      </div>

      <div class="td-settings-card">
        <h3 class="td-settings-group">{t('guardGroupWhitelist')}</h3>
        <p class="td-field-hint">{t('guardGroupWhitelistHint')}</p>
        <PatternListEditor language={language} />
      </div>

      <details class="td-advanced-details">
        <summary class="td-advanced-summary">
          {t('guardGroupPriority')} · {t('guardGroupMatch')}
        </summary>
        <div class="td-advanced-body">
          <ChoiceField
            label="guardFieldAfter"
            choices={AFTER_CHOICES}
            value={guard.after}
            onPick={(value) => {
              setGuardOption('after', value);
            }}
          />

          <h3 class="td-settings-group">{t('guardGroupPriority')}</h3>
          <p class="td-field-hint">{t('guardGroupPriorityHint')}</p>
          {visibleGuardToggles(caps).map((row) => (
            <CheckField
              key={row.id}
              label={row.label}
              value={guard[row.id]}
              onPick={(value) => {
                setGuardOption(row.id, value);
              }}
            />
          ))}

          <h3 class="td-settings-group">{t('guardGroupMatch')}</h3>
          <p class="td-field-hint">{t('guardGroupMatchHint')}</p>
          {MATCH_TOGGLES.map((row) => (
            <CheckField
              key={row.id}
              label={row.label}
              value={match[row.id]}
              onPick={(value) => {
                setMatchOption(row.id, value);
              }}
            />
          ))}
        </div>
      </details>
    </section>
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
    // The `<label>` wraps the control, which is what associates the two without an id.
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
  value,
  onPick,
}: {
  label: MessageKey;
  value: boolean;
  onPick: (value: boolean) => void;
}) {
  return (
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
  );
}
