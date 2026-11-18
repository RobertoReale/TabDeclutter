/**
 * The duplicate whitelist's editor (PLAN.md §8.3).
 *
 * One pattern per line, in Duplicate Tabs Closer's syntax, so the list the user already has can
 * be pasted in as it is. Under the textarea, a line for every pattern: either why it was ignored
 * or how many open tabs it matches, which is what tells the user whether the pattern is right
 * before it is ever relied on. Both come from `compile` of that one line (`pattern-lines.ts`), so
 * the preview can never disagree with the matching the guard actually does (invariant 9).
 *
 * The textarea is not written to storage on every keystroke: the draft lives here, and leaving
 * the field or pressing "Salva" is what saves. So validation is live while the stored list stays
 * a thing the user chose, and the panel does not write `local:` once per typed character.
 */

import { useSignal } from '@preact/signals';

import { tabUrl } from '@/core/duplicates';
import { caps } from '@/platform/capabilities';
import { t } from '@/platform/i18n';
import { defaultWhitelist } from '@/platform/whitelist';
import { matchesText, patternErrorText } from '../guard-settings';
import { editorText, reviewPatterns, storedPatterns } from '../pattern-lines';
import { saveWhitelist, whitelist } from '../state/guard';
import { tabs } from '../state/tabs';

export function PatternListEditor({ language }: { language: string }) {
  /** `null` while the editor is simply showing what is stored. */
  const draft = useSignal<string | null>(null);

  const stored = editorText(whitelist.value);
  const text = draft.value ?? stored;
  const dirty = text !== stored;
  const urls = tabs.value.map((tab) => tabUrl(tab));
  const lines = reviewPatterns(text, urls).filter((line) => !line.blank);

  function save(): void {
    if (!dirty) return;
    void saveWhitelist(storedPatterns(text)).then(
      () => {
        // Back to following storage, which the save has just made equal to the draft.
        draft.value = null;
      },
      (error: unknown) => {
        console.error('TabDeclutter: whitelist', error);
      },
    );
  }

  return (
    <div class="td-patterns">
      <label class="td-field-label" for="td-whitelist">
        {t('whitelistLabel')}
      </label>
      <p class="td-field-hint" id="td-whitelist-hint">
        {t('whitelistHint')}
      </p>
      <textarea
        id="td-whitelist"
        class="td-pattern-text"
        rows={6}
        spellcheck={false}
        aria-describedby="td-whitelist-hint"
        value={text}
        onInput={(event) => {
          draft.value = event.currentTarget.value;
        }}
        // Fires on blur after a change, which is the gesture that means "done typing".
        onChange={save}
      />

      <div class="td-pattern-actions">
        <button type="button" class="td-action td-action-primary" disabled={!dirty} onClick={save}>
          {t('whitelistSave')}
        </button>
        <button
          type="button"
          class="td-action"
          onClick={() => {
            draft.value = editorText([...defaultWhitelist(caps)]);
          }}
        >
          {t('whitelistDefaults')}
        </button>
      </div>

      {/* The validation and the preview, live as the lines are typed. */}
      <ul class="td-pattern-lines" aria-live="polite">
        {lines.map((line) => (
          <li
            key={line.number}
            class={line.error === undefined ? 'td-pattern-line' : 'td-pattern-line td-pattern-bad'}
          >
            <span class="td-pattern-line-number">{t('whitelistLine', String(line.number))}</span>{' '}
            <span class="td-pattern-line-note">
              {line.error === undefined
                ? matchesText(line.matches, t, language)
                : t('whitelistIgnored', patternErrorText(line.error.code, t))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
