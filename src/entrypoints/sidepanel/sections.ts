/**
 * From scores to the list Declutter draws (PLAN.md §4.3).
 *
 * A pure function of one snapshot: the scores say *what* each tab is, this says *where*
 * it goes and *in which order*, and nothing here knows about Preact, the browser or the
 * language. That is what makes the list testable without a panel — the view below only
 * renders what comes out of here.
 *
 * Relative imports, not `@/`: the `unit` vitest project runs without WXT's plugin and so
 * without WXT's alias, and this module is tested there.
 */

import type { PrimaryReason, ScoredTab, ScoringResult } from '../../core/scoring';
import type { TabInfo } from '../../core/types';

/** The sections of §4.3, which are the primary reasons grouped for the user. */
export type SectionId = 'duplicates' | 'transient' | 'stale-unread' | 'stale' | 'review';

/**
 * §4.3's order, "by confidence": a duplicate is a fact, an old-and-never-read tab is a
 * strong guess, "Da valutare" is an invitation to look. A section with no rows is not in
 * the list at all.
 */
const ORDER: readonly SectionId[] = ['duplicates', 'transient', 'stale-unread', 'stale', 'review'];

/** One row: what the tab is showing, and what the score made of it. */
export interface DeclutterRow {
  readonly tab: TabInfo;
  readonly scored: ScoredTab;
}

export interface DeclutterSection {
  readonly id: SectionId;
  readonly rows: readonly DeclutterRow[];
  /**
   * Whether the section starts folded. §4.3: "Da valutare" is collapsed and "Da
   * chiudere" is expanded — which are buckets, not sections, so the rule is read per
   * section: a section is folded when none of its rows is in the `close` bucket. "Da
   * valutare" can only ever hold `review` rows, so it is always folded; a section of
   * tabs the score is sure about is always open.
   */
  readonly collapsed: boolean;
}

/**
 * A window §4.3 offers to close whole ("Finestra con 12 schede non toccata da 3
 * settimane").
 */
export interface ForgottenWindow {
  readonly windowId: number;
  readonly tabCount: number;
  readonly idleMs: number;
}

export interface DeclutterList {
  readonly sections: readonly DeclutterSection[];
  /** How many rows in all, which is the "23 da rivedere" of the health bar. */
  readonly total: number;
  readonly windows: readonly ForgottenWindow[];
}

export const EMPTY_LIST: DeclutterList = { sections: [], total: 0, windows: [] };

/**
 * Which section a primary reason belongs to.
 *
 * `blank` joins `transient`: §4.3's list of sections is closed at five, and an empty tab
 * left open for an hour is the most transient page there is. `protected` has no section —
 * a protected tab scored 0 and is not on the list.
 */
function sectionOf(reason: PrimaryReason): SectionId | null {
  switch (reason) {
    case 'duplicate':
      return 'duplicates';
    case 'blank':
    case 'transient':
      return 'transient';
    case 'stale-unread':
      return 'stale-unread';
    case 'stale':
      return 'stale';
    case 'review':
      return 'review';
    case 'protected':
      return null;
  }
}

/**
 * The list, from the tabs and their scores.
 *
 * Listed: everything the score did not put in `keep`, which is exactly what the header
 * counts. Ordered: by score descending, and then by the browser's own order, so the list
 * is stable while the user reads it and two tabs that scored the same appear in the order
 * they sit in the tab strip.
 *
 * A score whose tab is no longer in the snapshot is dropped rather than guessed at: the
 * two are read together, so that can only happen if a caller mixes two moments.
 */
export function toSections(tabs: readonly TabInfo[], scoring: ScoringResult): DeclutterList {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const position = new Map(tabs.map((tab, at) => [tab.id, at]));

  const rows = new Map<SectionId, DeclutterRow[]>();
  let total = 0;

  for (const scored of scoring.tabs) {
    if (scored.bucket === 'keep') continue;
    const tab = byId.get(scored.tabId);
    const id = sectionOf(scored.primaryReason);
    if (tab === undefined || id === null) continue;

    const list = rows.get(id);
    if (list === undefined) rows.set(id, [{ tab, scored }]);
    else list.push({ tab, scored });
    total++;
  }

  const sections = ORDER.flatMap<DeclutterSection>((id) => {
    const list = rows.get(id);
    if (list === undefined || list.length === 0) return [];
    list.sort((left, right) => byScore(left, right, position));
    return [{ id, rows: list, collapsed: !list.some((row) => row.scored.bucket === 'close') }];
  });

  return { sections, total, windows: forgottenWindows(scoring) };
}

function byScore(
  left: DeclutterRow,
  right: DeclutterRow,
  position: ReadonlyMap<number, number>,
): number {
  if (left.scored.score !== right.scored.score) return right.scored.score - left.scored.score;
  return (position.get(left.tab.id) ?? 0) - (position.get(right.tab.id) ?? 0);
}

/**
 * The windows worth a card.
 *
 * `forgotten` alone is not enough: a window can be untouched for weeks and still hold
 * nothing the score would close (every tab pinned, or kept, or on a protected site), and
 * offering to close it would be the one thing PLAN.md §3 says costs most — a suggestion
 * the user has to refuse. So a card needs at least one closable tab.
 */
function forgottenWindows(scoring: ScoringResult): readonly ForgottenWindow[] {
  return scoring.windows
    .filter((window) => window.forgotten && window.closeCount > 0)
    .map((window) => ({
      windowId: window.windowId,
      tabCount: window.tabCount,
      idleMs: window.idleMs,
    }));
}
