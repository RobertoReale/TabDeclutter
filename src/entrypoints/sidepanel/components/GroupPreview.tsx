/**
 * The preview of PLAN.md §4.4.3: the proposed groups, each one editable in place.
 *
 * It draws a draft and calls `state/organize.ts`; what an edit *means* is
 * `sidepanel/organize.ts`'s, so this file holds no rule of its own and the edits are
 * tested without a renderer. Every control is a native one — a text box, a `<select>`, a
 * checkbox — because §4.4.3 asks for "no drag & drop in v1" and a native control is the
 * one that is already keyboard-reachable, labelled and themed (§4.8).
 *
 * A tab is shown by its title, as text: a title is untrusted (invariant 7), and JSX
 * children are text by construction. The colour is a `data-color` the stylesheet answers,
 * never an inline colour, so the palette stays in `styles/tokens.css` (§4.7).
 *
 * "Altro" is below the groups and has no controls at all: §7.2.4 says those tabs are not
 * grouped, and nothing is ever applied to them.
 */

import { t, type MessageKey } from '@/platform/i18n';
import { GROUP_COLORS, type GroupColor } from '@/core/cluster';
import { formatCount } from '../format';
import type { Draft, DraftGroup } from '../organize';
import { mergeTargets, moveTargets, windowOrder } from '../organize';
import { merge, move, recolor, rename, toggle } from '../state/organize';

/** Chrome's nine group colours, each with the name the user reads (§4.4.3). */
const COLOR_LABEL: Readonly<Record<GroupColor, MessageKey>> = {
  grey: 'colorGrey',
  blue: 'colorBlue',
  red: 'colorRed',
  yellow: 'colorYellow',
  green: 'colorGreen',
  pink: 'colorPink',
  purple: 'colorPurple',
  cyan: 'colorCyan',
  orange: 'colorOrange',
};

/**
 * A menu's own two values. Neither can collide with a group's key: a site group's key is
 * the host it needs to exist (`groupBySite` leaves a tab with no host ungrouped) and a
 * topic group's is its title in lower case, built from tokens of letters and digits.
 */
const PROMPT = '?';
/** "Sposta in… Altro": out of every group. */
const OUT = '';

export interface GroupPreviewProps {
  readonly draft: Draft;
  /** The open tabs by id, so a row can say which tab it is. */
  readonly titles: ReadonlyMap<number, string>;
  readonly language: string;
}

export function GroupPreview({ draft, titles, language }: GroupPreviewProps) {
  const windows = windowOrder(draft);

  function titleOf(tabId: number): string {
    return titles.get(tabId) ?? '';
  }

  return (
    <>
      <ul class="td-groups" aria-label={t('organizePreview')}>
        {draft.groups.map((group) => (
          <li key={group.key} class="td-group" aria-current={group.selected ? 'true' : undefined}>
            <div class="td-group-head">
              <input
                type="checkbox"
                class="td-group-check"
                checked={group.selected}
                aria-label={t('organizeGroupInclude')}
                onChange={() => {
                  toggle(group.key);
                }}
              />
              {/* Decorative: the colour is also the `<select>`'s value, in words. */}
              <span class="td-group-swatch" data-color={group.color} aria-hidden="true" />
              <input
                type="text"
                class="td-group-name"
                value={group.title}
                aria-label={t('organizeGroupName')}
                onInput={(event) => {
                  rename(group.key, event.currentTarget.value);
                }}
              />
              <select
                class="td-filter td-group-color"
                value={group.color}
                aria-label={t('organizeGroupColor')}
                onChange={(event) => {
                  recolor(group.key, event.currentTarget.value as GroupColor);
                }}
              >
                {GROUP_COLORS.map((color) => (
                  <option key={color} value={color}>
                    {t(COLOR_LABEL[color])}
                  </option>
                ))}
              </select>
            </div>

            {windows.length > 1 && (
              <p class="td-group-where">
                {t('organizeWindow', formatCount(windows.indexOf(group.windowId) + 1, language))}
              </p>
            )}

            <ul class="td-group-tabs">
              {group.tabIds.map((tabId) => (
                <li key={tabId} class="td-group-tab">
                  <span class="td-group-tab-title">{titleOf(tabId)}</span>
                  <MoveMenu draft={draft} tabId={tabId} />
                </li>
              ))}
            </ul>

            <MergeMenu draft={draft} group={group} />
          </li>
        ))}
      </ul>

      {draft.ungrouped.length > 0 && (
        <section class="td-group-other" aria-label={t('organizeOther')}>
          <h2 class="td-group-other-title">{t('organizeOther')}</h2>
          <p class="td-group-where">{t('organizeOtherHint')}</p>
          <ul class="td-group-tabs">
            {draft.ungrouped.map((tabId) => (
              <li key={tabId} class="td-group-tab">
                <span class="td-group-tab-title">{titleOf(tabId)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/**
 * §4.4.3's "Sposta in…": the other groups of the tab's window, and "Altro" to take it out
 * of every group. It is a menu and not a state, so it always reads "Sposta in…": the draft
 * has already changed by the time the next render happens, and the tab is somewhere else.
 */
function MoveMenu({ draft, tabId }: { draft: Draft; tabId: number }) {
  const targets = moveTargets(draft, tabId);

  return (
    <select
      class="td-filter td-group-move"
      value={PROMPT}
      aria-label={t('organizeMoveTo')}
      onChange={(event) => {
        const chosen = event.currentTarget.value;
        if (chosen === PROMPT) return;
        move(tabId, chosen === OUT ? null : chosen);
      }}
    >
      {/* The prompt, and never a destination: a group's key is never `?`. */}
      <option value={PROMPT}>{t('organizeMoveTo')}</option>
      {targets.map((target) => (
        <option key={target.key} value={target.key}>
          {target.title}
        </option>
      ))}
      {/* Out of every group, which §7.2.4 calls "Altro". */}
      <option value={OUT}>{t('organizeOther')}</option>
    </select>
  );
}

/** §4.4.3's merge, offered on the group that disappears into the one chosen. */
function MergeMenu({ draft, group }: { draft: Draft; group: DraftGroup }) {
  const targets = mergeTargets(draft, group.key);
  if (targets.length === 0) return null;

  return (
    <select
      class="td-filter td-group-merge"
      value={PROMPT}
      aria-label={t('organizeMerge')}
      onChange={(event) => {
        const chosen = event.currentTarget.value;
        if (chosen === PROMPT) return;
        merge(group.key, chosen);
      }}
    >
      <option value={PROMPT}>{t('organizeMerge')}</option>
      {targets.map((target) => (
        <option key={target.key} value={target.key}>
          {target.title}
        </option>
      ))}
    </select>
  );
}
