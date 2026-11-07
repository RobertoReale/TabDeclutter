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
import { useEffect, useRef } from 'preact/hooks';

import { t } from '@/platform/i18n';
import { activateTab } from '@/platform/tabs';
import type { TabInfo } from '@/core/types';
import { EmptyState } from '../components/EmptyState';
import { HealthBar } from '../components/HealthBar';
import { Section } from '../components/Section';
import { SelectionBar } from '../components/SelectionBar';
import { Toast } from '../components/Toast';
import { activeStop, nextStop, stopsOf, type OpenSection, type Stop } from '../keyboard';
import { forgottenWindowText } from '../reasons';
import type { ForgottenWindow, SectionId } from '../sections';
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
import { declutter, tabCount } from '../state/tabs';

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
  const sections: readonly OpenSection[] = list.sections.map((section) => ({
    section,
    open: byHand.value[section.id] ?? !section.collapsed,
  }));
  const stops = stopsOf(sections);
  const active = activeStop(stops, chosen.value);

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
      {list.total === 0 ? (
        <EmptyState text={t('declutterEmpty')} />
      ) : (
        <>
          <HealthBar review={list.total} total={tabCount.value} language={language} />

          {list.windows.map((window) => (
            <WindowCard key={window.windowId} window={window} language={language} />
          ))}

          {/*
           * `grid` and not `listbox`: a row holds a checkbox and three buttons, and an
           * `option` may hold no interactive element at all (docs/DECISIONS.md).
           */}
          <div
            ref={grid}
            class="td-list"
            role="grid"
            aria-label={t('declutterList')}
            onKeyDown={onKeyDown}
            onFocusIn={onFocusIn}
          >
            {sections.map(({ section, open }) => (
              <Section
                key={section.id}
                section={section}
                open={open}
                activeStop={active?.id ?? null}
                language={language}
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
