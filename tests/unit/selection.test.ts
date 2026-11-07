import { beforeEach, describe, expect, it } from 'vitest';

import {
  allSelected,
  clearSelection,
  deselectTabs,
  hasSelection,
  isSelected,
  selectTabs,
  selectedIds,
  selectedSignal,
  toggleSelected,
} from '../../src/entrypoints/sidepanel/state/selection';

/**
 * What the user has picked (PLAN.md §4.3, §4.8).
 *
 * It is module state, so every test starts by emptying it; that is the same `Escape` the
 * panel offers, and a test that leaked a selection into the next one would be the first
 * thing to go wrong here.
 */

beforeEach(() => {
  clearSelection();
});

describe('an empty selection', () => {
  it('is what the panel starts from, so the bar is not there', () => {
    expect(selectedIds.value).toEqual([]);
    expect(hasSelection.value).toBe(false);
    expect(isSelected(1)).toBe(false);
  });
});

describe('toggleSelected', () => {
  it('picks a tab and unpicks the same tab, which is what `Space` does', () => {
    toggleSelected(7);
    expect(isSelected(7)).toBe(true);
    expect(hasSelection.value).toBe(true);

    toggleSelected(7);
    expect(isSelected(7)).toBe(false);
    expect(hasSelection.value).toBe(false);
  });

  it('leaves every other tab alone', () => {
    selectTabs([1, 2, 3]);
    toggleSelected(2);
    expect(selectedIds.value).toEqual([1, 3]);
  });
});

describe('selectTabs', () => {
  it('adds to what is already picked rather than replacing it', () => {
    selectTabs([1, 2]);
    selectTabs([3]);
    expect(selectedIds.value).toEqual([1, 2, 3]);
  });

  it('is idempotent, so "Seleziona tutti" twice is once', () => {
    selectTabs([1, 2]);
    selectTabs([1, 2]);
    expect(selectedIds.value).toEqual([1, 2]);
  });

  it('keeps the order the tabs were picked in', () => {
    selectTabs([9]);
    toggleSelected(4);
    selectTabs([6]);
    expect(selectedIds.value).toEqual([9, 4, 6]);
  });

  it('does nothing at all for an empty list, so a folded empty section is quiet', () => {
    selectTabs([]);
    expect(hasSelection.value).toBe(false);
  });
});

describe('deselectTabs', () => {
  it('drops exactly those tabs', () => {
    selectTabs([1, 2, 3, 4]);
    deselectTabs([2, 4]);
    expect(selectedIds.value).toEqual([1, 3]);
  });

  it('ignores ids that were never picked, which is how a close reports itself', () => {
    selectTabs([1]);
    deselectTabs([2, 3]);
    expect(selectedIds.value).toEqual([1]);
  });
});

describe('allSelected', () => {
  it('is what makes the header say "Seleziona tutti" or "Deseleziona tutti"', () => {
    selectTabs([1, 2]);
    expect(allSelected([1, 2])).toBe(true);
    expect(allSelected([1, 2, 3])).toBe(false);
  });

  /*
   * An empty section has nothing to deselect, so the button has to keep saying
   * "Seleziona tutti" rather than flipping on a section with no rows.
   */
  it('is false for no tabs at all', () => {
    expect(allSelected([])).toBe(false);
    selectTabs([1]);
    expect(allSelected([])).toBe(false);
  });
});

describe('selectedSignal', () => {
  it('answers for its own tab', () => {
    const one = selectedSignal(1);
    expect(one.value).toBe(false);

    toggleSelected(1);
    expect(one.value).toBe(true);
  });

  /*
   * §11: one signal per tab id is the whole reason picking a row re-renders a row and not
   * the list. Handing back a second signal for the same id would subscribe a second row to
   * a second computed, which is the leak this is here to catch.
   */
  it('is the same signal for the same tab, however often a row asks', () => {
    expect(selectedSignal(3)).toBe(selectedSignal(3));
    expect(selectedSignal(3)).not.toBe(selectedSignal(4));
  });

  it('does not notice another tab being picked', () => {
    const one = selectedSignal(1);
    selectTabs([2]);
    expect(one.value).toBe(false);
  });
});

describe('clearSelection', () => {
  it('empties it, which is what `Escape` does', () => {
    selectTabs([1, 2, 3]);
    clearSelection();
    expect(selectedIds.value).toEqual([]);
    expect(hasSelection.value).toBe(false);
  });
});

/*
 * Nothing here prunes: an id whose tab has gone is dropped by every reader, because a
 * reader always starts from the open tabs (`src/core/actions.ts`). This is the contract
 * the bar and the keys lean on, so it is checked rather than assumed.
 */
describe('a selection that outlived its tabs', () => {
  it('keeps the id, and leaves the dropping to whoever reads it', () => {
    selectTabs([404]);
    expect(isSelected(404)).toBe(true);
    expect(selectedIds.value).toEqual([404]);
  });
});
