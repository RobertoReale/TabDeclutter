/**
 * The "Riordina" view (PLAN.md §4.3, §4.8): what to close, grouped by reason, and the
 * keyboard that walks it.
 *
 * It renders `declutter`, the grouped list `state/tabs.ts` computes, and decides nothing
 * itself — which section a tab is in and in which order the rows go is `sections.ts`'s
 * answer, and the wording is `reasons.ts`'s. The selection, the bulk actions and the
 * sticky bar §4.3 also draws are the actions task; what is here is the list, its reasons
 * and "Vai".
 *
 * The list is one ARIA grid and holds one tab stop (the roving tabindex of §4.8): the two
 * state pieces that needs — which sections the user has folded, and which stop has the tab
 * stop — live here rather than in `Section`, because ↑ and ↓ cross section boundaries and
 * so the keys can only be answered by whoever sees the whole list. The sequence itself is
 * `keyboard.ts`'s, and the keys are handled on the grid, where every row's event bubbles
 * to.
 *
 * `Space`, `Del`, `K`, `Ctrl+A` and `Ctrl+Z` are the actions task (TASKS.md M3.2): they
 * select, close and undo, and there is nothing yet for them to do.
 */

import { useSignal } from '@preact/signals';
import { useRef } from 'preact/hooks';

import { t } from '@/platform/i18n';
import { activateTab } from '@/platform/tabs';
import { EmptyState } from '../components/EmptyState';
import { HealthBar } from '../components/HealthBar';
import { Section } from '../components/Section';
import { activeStop, nextStop, stopsOf, type OpenSection, type Stop } from '../keyboard';
import { forgottenWindowText } from '../reasons';
import type { ForgottenWindow, SectionId } from '../sections';
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

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // The arrows belong to the list: they move the tab stop and never scroll the panel
      // underneath it, including at the two ends where nothing moves.
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }

    if (event.key !== 'Enter' || active === null) return;
    // Only when the stop itself has the focus: `Enter` on the "Vai" button inside a row
    // is that button's own, and would otherwise activate the tab twice.
    if (!(event.target instanceof HTMLElement) || event.target.dataset.stop !== active.id) return;
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

  if (list.total === 0) return <EmptyState text={t('declutterEmpty')} />;

  return (
    <>
      <HealthBar review={list.total} total={tabCount.value} language={language} />

      {list.windows.map((window) => (
        <WindowCard key={window.windowId} window={window} language={language} />
      ))}

      {/*
       * `grid` and not `listbox`: a row holds a button now and a checkbox with three
       * more in M3.2, and an `option` may hold no interactive element at all
       * (docs/DECISIONS.md).
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
  );
}

/**
 * §4.3's whole-window suggestion: "Finestra con 12 schede non toccata da 3 settimane".
 * The button that closes it belongs to the actions task, so for now the card is the
 * sentence — the tabs themselves are in the sections below it either way.
 */
function WindowCard({ window, language }: { window: ForgottenWindow; language: string }) {
  return (
    <p class="td-window-card">{forgottenWindowText(window.tabCount, window.idleMs, t, language)}</p>
  );
}

function failed(error: unknown): void {
  console.error('TabDeclutter: go to tab', error);
}
