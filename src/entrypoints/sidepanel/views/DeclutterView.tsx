/**
 * The "Riordina" view (PLAN.md §4.3, §4.8): what to close, grouped by reason, and the
 * keyboard that walks it.
 *
 * It renders `declutter`, the grouped list `state/tabs.ts` computes, and decides nothing
 * itself — which section a tab is in and in which order the rows go is `sections.ts`'s
 * answer, the wording is `reasons.ts`'s, and what a close means is `state/commands.ts`'s.
 *
 * The list is one ARIA grid and holds one tab stop (the roving tabindex of §4.8): the two
 * state pieces that needs — which sections the user has folded, and which stop has the tab
 * stop — live here rather than in `Section`, because ↑ and ↓ cross section boundaries and
 * so the keys can only be answered by whoever sees the whole list. The sequence itself is
 * `keyboard.ts`'s, and the keys are handled on the grid, where every row's event bubbles
 * to.
 *
 * §4.8's keys are the ones that need to know where the keyboard is, so they are here too:
 * `Space` picks, `Del`/`Backspace` closes, `K` keeps, `Ctrl/Cmd+A` picks the section. The
 * two that are about the panel and not about one row — `Ctrl/Cmd+Z`, which undoes the last
 * close, and `Escape`, which drops the selection — are on the document, because the toast
 * and the bar can be answered while the focus is anywhere.
 *
 * The bar and the toast are below the list and outside its empty state: closing the last
 * suggestion leaves an empty list, and that is exactly the moment an "Annulla" matters.
 */

import { useSignal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';

import { t } from '@/platform/i18n';
import { activateTab } from '@/platform/tabs';
import type { TabInfo } from '@/core/types';
import { EmptyState } from '../components/EmptyState';
import { HealthBar } from '../components/HealthBar';
import { Section } from '../components/Section';
import { SelectionBar } from '../components/SelectionBar';
import { Toast } from '../components/Toast';
import { formatCount } from '../format';
import { activeStop, nextStop, stopsOf, type OpenSection, type Stop } from '../keyboard';
import { forgottenWindowText } from '../reasons';
import {
  ORDER,
  type DeclutterSection,
  type ExitingRow,
  type ForgottenWindow,
  type SectionId,
} from '../sections';
import {
  asking,
  cancelClose,
  keepTabs,
  requestClose,
  requestCloseWindow,
  selectionSafeguards,
  undoClose,
} from '../state/commands';
import {
  allSelected,
  clearSelection,
  deselectTabs,
  selectTabs,
  toggleSelected,
} from '../state/selection';
import { setSetting, settings } from '../state/settings';
import { declutter, scoring, tabCount } from '../state/tabs';

/**
 * §4.7's "height collapse on close" plays on a row that is no longer in `declutter.value`
 * at all, so it has to outlive the data by this long before it is dropped from local state.
 * Longer than `--td-duration` (150 ms) by a safety margin: under reduced motion the CSS
 * collapses instantly and the extra time is simply invisible, never a delay the user waits
 * through.
 */
const EXIT_MS = 200;

export function DeclutterView({ language }: { language: string }) {
  /**
   * The sections the user has folded or unfolded by hand. A section not in here is drawn
   * the way the list asks for it (§4.3: "Da valutare" folded, "Da chiudere" open); once
   * the user has said otherwise, their choice stands for as long as the panel is open.
   */
  const byHand = useSignal<Readonly<Partial<Record<SectionId, boolean>>>>({});
  /** Where the user last left the keyboard, by stop id. */
  const chosen = useSignal<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);

  const list = declutter.value;
  const closeTabIds = scoring.value.tabs
    .filter((scored) => scored.bucket === 'close')
    .map((scored) => scored.tabId);
  const sections: readonly OpenSection[] = list.sections.map((section) => ({
    section,
    open: byHand.value[section.id] ?? !section.collapsed,
  }));
  const stops = stopsOf(sections);
  const active = activeStop(stops, chosen.value);

  /**
   * The last real shape of every section still in `list.sections`, kept one render past the
   * point where a section's own last row leaves and it drops out of `list.sections` entirely
   * (`sections.ts` never returns an empty one) — `ghostOnly` below renders that section again,
   * rows emptied, from this cache, rather than switching to a different component for it.
   */
  const sectionTemplates = useRef<Map<SectionId, DeclutterSection>>(new Map());
  for (const section of list.sections) sectionTemplates.current.set(section.id, section);

  /*
   * §4.7's "height collapse on close" plays on a row that is no longer in `declutter.value`
   * at all. Tracked here rather than inside `Section`, because a section whose last row
   * leaves drops out of `list.sections` entirely (`sections.ts` never returns an empty one,
   * and this view's own empty state takes over the moment `list.total` reaches zero) — in
   * either case the row's own `<Section>` would already be gone before a transition could
   * play on it.
   */
  const [exiting, setExiting] = useState<
    Readonly<Partial<Record<SectionId, readonly ExitingRow[]>>>
  >({});
  const previousSections = useRef<readonly DeclutterSection[]>(list.sections);
  /**
   * One timer per row, outliving whatever re-render happens in between — `list.sections` is
   * a new array on every `declutter` recompute, including ones that touch nothing a row
   * left over, and an effect cleanup tied to that reference would cancel and lose a row's
   * own clear timer before it had a reason to.
   */
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
    },
    [],
  );

  useEffect(() => {
    const previous = previousSections.current;
    previousSections.current = list.sections;
    // Globally, not per section: a row reclassified into another section (the seeded
    // history landing, a score recomputed) is still in the list and never a ghost — only
    // one that `list.sections` drops altogether (closed, kept) is.
    const stillThere = new Set(
      list.sections.flatMap((section) => section.rows.map((row) => row.tab.id)),
    );
    const gone = new Map<SectionId, readonly ExitingRow[]>();
    for (const section of previous) {
      // Rows still in this same section (if it still has any) are the only valid anchors —
      // a gone row is spliced back in front of the nearest one of these that follows it in
      // the old order, so it collapses in place instead of jumping to the end of the list
      // (§4.7's "height collapse on close" is about where, not only whether).
      const currentIds = new Set(
        list.sections.find((current) => current.id === section.id)?.rows.map((row) => row.tab.id),
      );
      const left: ExitingRow[] = [];
      for (const [at, row] of section.rows.entries()) {
        if (stillThere.has(row.tab.id)) continue;
        const after = section.rows
          .slice(at + 1)
          .find((candidate) => currentIds.has(candidate.tab.id));
        left.push({ row, beforeId: after?.tab.id ?? null });
      }
      if (left.length > 0) gone.set(section.id, left);
    }
    if (gone.size === 0) return;

    setExiting((current) => {
      const next = { ...current };
      for (const [id, rows] of gone) {
        const goneIds = new Set(rows.map((item) => item.row.tab.id));
        next[id] = [...(next[id] ?? []).filter((item) => !goneIds.has(item.row.tab.id)), ...rows];
      }
      return next;
    });

    for (const [id, rows] of gone) {
      for (const { row } of rows) {
        const tabId = row.tab.id;
        const existing = timers.current.get(tabId);
        if (existing !== undefined) clearTimeout(existing);
        timers.current.set(
          tabId,
          setTimeout(() => {
            timers.current.delete(tabId);
            setExiting((current) => {
              const remaining = (current[id] ?? []).filter((item) => item.row.tab.id !== tabId);
              const next = { ...current };
              if (remaining.length === 0) delete next[id];
              else next[id] = remaining;
              return next;
            });
          }, EXIT_MS),
        );
      }
    }
  }, [list.sections]);

  /**
   * A section whose rows are gone entirely still has ghosts to show until they time out —
   * rendered through the same `<Section>` key as before, rows emptied, so the row inside it
   * keeps its own DOM node too (`Section`'s own comment on `ghostOnly`).
   */
  const ghostOnly: readonly OpenSection[] = Object.keys(exiting)
    .filter((id) => !list.sections.some((section) => section.id === id))
    .map((id) => sectionTemplates.current.get(id as SectionId))
    .filter((section): section is DeclutterSection => section !== undefined)
    .map((section) => ({
      section: { ...section, rows: [] },
      open: byHand.value[section.id] ?? !section.collapsed,
    }));
  const hasGhosts =
    ghostOnly.length > 0 || sections.some(({ section }) => exiting[section.id] !== undefined);
  // §4.3's fixed order, not append-after-the-live-ones: a section that just emptied out
  // keeps its own slot in the list rather than jumping to the bottom while its ghost row
  // finishes closing.
  const renderedSections = [...sections, ...ghostOnly].sort(
    (left, right) => ORDER.indexOf(left.section.id) - ORDER.indexOf(right.section.id),
  );

  function toggle(id: SectionId, open: boolean): void {
    byHand.value = { ...byHand.value, [id]: !open };
  }

  /** Moves the tab stop, and the focus with it. */
  function move(step: number): void {
    const to = nextStop(stops, active?.id ?? null, step);
    if (to === null) return;
    chosen.value = to.id;
    // The element is already in the document — only its `tabindex` is about to change —
    // so it can be focused before Preact has re-rendered. `focus()` also scrolls it into
    // view, which is what makes `content-visibility: auto` rows reachable.
    grid.current?.querySelector<HTMLElement>(`[data-stop="${to.id}"]`)?.focus();
  }

  function act(stop: Stop): void {
    if (stop.kind === 'section') {
      const open = sections.find(({ section }) => section.id === stop.section)?.open ?? false;
      toggle(stop.section, open);
      return;
    }
    void activateTab(stop.tab.id, stop.tab.windowId).catch(failed);
  }

  /** The tabs of the section a stop is in: what `Ctrl+A` picks and `Space` on a header does. */
  function sectionOf(stop: Stop): readonly TabInfo[] {
    const found =
      stop.kind === 'section'
        ? list.sections.find((section) => section.id === stop.section)
        : list.sections.find((section) => section.rows.some((row) => row.tab.id === stop.tab.id));
    return found?.rows.map((row) => row.tab) ?? [];
  }

  /**
   * What a key acts on: the selection when there is one, and otherwise where the keyboard
   * is — a row, or every row of the section whose header it is on. Which is the same rule
   * the bar follows, so `Del` never closes something the bar would not have.
   */
  function targetOf(stop: Stop | null): readonly TabInfo[] {
    const picked = selectionSafeguards.value.tabs;
    if (picked.length > 0) return picked;
    if (stop === null) return [];
    return stop.kind === 'row' ? [stop.tab] : sectionOf(stop);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // The arrows belong to the list: they move the tab stop and never scroll the panel
      // underneath it, including at the two ends where nothing moves.
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }

    if (active === null) return;
    // Whether the stop itself has the focus, or something inside it: a row holds a
    // checkbox and three buttons, and `Enter` or `Space` on one of those is its own.
    const onStop = event.target instanceof HTMLElement && event.target.dataset.stop === active.id;

    if ((event.ctrlKey || event.metaKey) && (event.key === 'a' || event.key === 'A')) {
      // §4.8: the section the keyboard is in, not the document the browser would select.
      event.preventDefault();
      selectTabs(sectionOf(active).map((tab) => tab.id));
      return;
    }

    if ((event.key === 'Delete' || event.key === 'Backspace') && !event.altKey) {
      event.preventDefault();
      requestClose(targetOf(active).map((tab) => tab.id));
      return;
    }

    if (event.key === 'k' || event.key === 'K') {
      event.preventDefault();
      keepTabs(targetOf(active));
      return;
    }

    if (event.key === ' ' && onStop) {
      event.preventDefault();
      if (active.kind === 'row') {
        toggleSelected(active.tab.id);
        return;
      }
      // On a header it is the section, which is what the header's own button does.
      const tabIds = sectionOf(active).map((tab) => tab.id);
      if (allSelected(tabIds)) deselectTabs(tabIds);
      else selectTabs(tabIds);
      return;
    }

    // `Enter` only when the stop itself has the focus: on the "Vai" button inside a row it
    // is that button's own, and would otherwise activate the tab twice.
    if (event.key !== 'Enter' || !onStop) return;
    event.preventDefault();
    act(active);
  }

  /**
   * Keeps the tab stop where the focus actually is, so a row reached with the mouse, or
   * with `Tab` from the header, is where ↑/↓ carry on from. `focusin` bubbles; `focus`
   * does not.
   */
  function onFocusIn(event: FocusEvent): void {
    if (!(event.target instanceof HTMLElement)) return;
    const stop = event.target.closest<HTMLElement>('[data-stop]');
    if (stop !== null) chosen.value = stop.dataset.stop ?? null;
  }

  /**
   * The two keys of §4.8 that are about the panel rather than about a row, on the document
   * so they answer from wherever the focus is — including the toast itself, and including
   * the moment the list has gone empty because the close emptied it.
   */
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if ((event.ctrlKey || event.metaKey) && (event.key === 'z' || event.key === 'Z')) {
        event.preventDefault();
        undoClose();
        return;
      }
      if (event.key !== 'Escape') return;
      // A question first: the user is backing out of it, not out of the selection it
      // picked out for them (docs/DECISIONS.md).
      if (asking.value !== null) {
        cancelClose();
        return;
      }
      clearSelection();
    }

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <>
      {list.total === 0 && !hasGhosts ? (
        <EmptyState text={t('declutterEmpty')} />
      ) : (
        <>
          <p class="td-view-intro">{t('declutterIntro')}</p>

          <div class="td-autopilot-card">
            <label class="td-check">
              <input
                type="checkbox"
                checked={settings.value.autoDeclutter}
                onChange={(event) => {
                  setSetting('autoDeclutter', event.currentTarget.checked);
                }}
              />
              <span>{t('autopilotDeclutter')}</span>
            </label>
            {closeTabIds.length > 0 && (
              <button
                type="button"
                class="td-action td-action-primary"
                onClick={() => {
                  requestClose(closeTabIds);
                }}
              >
                {t('declutterCloseRecommended', formatCount(closeTabIds.length, language))}
              </button>
            )}
          </div>

          <HealthBar review={list.total} total={tabCount.value} language={language} />

          {list.windows.map((window) => (
            <WindowCard key={window.windowId} window={window} language={language} />
          ))}

          {/*
           * A grid and not a `listbox`: a row holds a checkbox and three buttons, and an
           * `option` may hold no interactive element at all (docs/DECISIONS.md).
           * `treegrid` — ARIA's grid with collapsible rows — rather than plain `grid`,
           * because `Section`'s header is a row carrying `aria-expanded`, which ARIA only
           * allows on a row inside a `treegrid` (axe's `aria-conditional-attr`, M6.4).
           */}
          <div
            ref={grid}
            class="td-list"
            role="treegrid"
            aria-label={t('declutterList')}
            onKeyDown={onKeyDown}
            onFocusIn={onFocusIn}
          >
            {renderedSections.map(({ section, open }) => (
              <Section
                key={section.id}
                section={section}
                open={open}
                activeStop={active?.id ?? null}
                language={language}
                exiting={exiting[section.id] ?? []}
                onToggle={() => {
                  toggle(section.id, open);
                }}
              />
            ))}
          </div>
        </>
      )}

      {/*
       * Below the list and outside its empty state, because the close that empties the
       * list is exactly the one whose "Annulla" matters.
       */}
      <div class="td-footer">
        <Toast language={language} />
        <SelectionBar language={language} />
      </div>
    </>
  );
}

/**
 * §4.3's whole-window suggestion: "Finestra con 12 schede non toccata da 3 settimane",
 * with the button that takes the whole window at once. That close goes through
 * `requestCloseWindow` and not through the selection, so the archive records a window and
 * §4.5 can offer it back as one.
 */
function WindowCard({ window, language }: { window: ForgottenWindow; language: string }) {
  return (
    <p class="td-window-card">
      <span class="td-window-text">
        {forgottenWindowText(window.tabCount, window.idleMs, t, language)}
      </span>
      <button
        type="button"
        class="td-action td-window-action"
        onClick={() => {
          requestCloseWindow(window.windowId);
        }}
      >
        {t('windowClose')}
      </button>
    </p>
  );
}

function failed(error: unknown): void {
  console.error('TabDeclutter: go to tab', error);
}
