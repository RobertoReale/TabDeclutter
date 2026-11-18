/**
 * The Organize view's state (PLAN.md §4.4): what the preview proposes for the chosen
 * scope, when it follows the browser and when it stops.
 *
 * The edits themselves are pure and are covered in `tests/unit/organize.test.ts`; what is
 * here is the part that is signals — §4.3's "Raggruppa" handing a selection over, the
 * draft following `state/tabs.ts` until the first edit, and a new question clearing the
 * edits made to the previous one.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { TabInfo } from '../../src/core/types';
import { DEFAULT_SETTINGS, NO_GROUP_ID } from '../../src/core/types';
import {
  draft,
  mode,
  options,
  organizeSelection,
  plannedTabs,
  rename,
  scope,
  setMode,
  setOptions,
  setScope,
} from '../../src/entrypoints/sidepanel/state/organize';
import { brought, clearModeOverride } from '../../src/entrypoints/sidepanel/state/organize-request';
import { panelData, type PanelData } from '../../src/entrypoints/sidepanel/state/tabs';
import { view } from '../../src/entrypoints/sidepanel/state/view';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

function tab(id: number, url: string, overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id,
    windowId: 1,
    index: id,
    url,
    title: `Tab ${String(id)}`,
    pinned: false,
    audible: false,
    active: false,
    discarded: false,
    hidden: false,
    groupId: NO_GROUP_ID,
    incognito: false,
    ...overrides,
  };
}

/** Three tabs on one site in window 1 and three on another in window 2. */
function tabs(): TabInfo[] {
  return [
    tab(1, 'https://github.com/one'),
    tab(2, 'https://github.com/two'),
    tab(3, 'https://github.com/three'),
    tab(4, 'https://figma.com/one', { windowId: 2 }),
    tab(5, 'https://figma.com/two', { windowId: 2 }),
    tab(6, 'https://figma.com/three', { windowId: 2 }),
  ];
}

function data(open: readonly TabInfo[]): PanelData {
  return {
    tabs: open,
    activity: {},
    settings: DEFAULT_SETTINGS,
    keeps: {},
    protectedSites: [],
    whitelist: [],
    bookmarks: new Set<string>(),
    focusedWindowId: 1,
    ownOrigin: 'chrome-extension://test',
    at: NOW,
  };
}

/** The signals are module state, shared by every test in the file. */
beforeEach(() => {
  panelData.value = data(tabs());
  setScope('window');
  setMode('site');
  setOptions({ sortByGroup: false, collapse: false, leavePinnedOut: true, includeGrouped: false });
  brought.value = null;
  view.value = 'declutter';
});

describe('the proposal the preview starts from', () => {
  it('is the focused window for "Finestra corrente"', () => {
    expect(draft.value.groups.map((group) => group.key)).toEqual(['github.com']);
    expect(plannedTabs.value).toBe(3);
  });

  it('is every window for "Tutte le finestre"', () => {
    setScope('all');

    expect(draft.value.groups.map((group) => group.key)).toEqual(['github.com', 'figma.com']);
    expect(plannedTabs.value).toBe(6);
  });

  it('is empty before the first read comes back', () => {
    panelData.value = null;

    expect(draft.value.groups).toEqual([]);
    expect(plannedTabs.value).toBe(0);
  });

  it('follows the browser while nothing has been edited', () => {
    setScope('all');
    panelData.value = data([...tabs(), tab(7, 'https://github.com/four')]);

    expect(draft.value.groups[0]?.tabIds).toEqual([1, 2, 3, 7]);
  });
});

describe('§4.3\'s "Raggruppa"', () => {
  it('brings the selection over and opens the view', () => {
    organizeSelection([1, 2, 3, 4]);

    expect(view.value).toBe('organize');
    expect(scope.value).toBe('selection');
    expect(brought.value).toEqual([1, 2, 3, 4]);
    // Four tabs, but only three of one site: the thresholds of §7.1 still apply.
    expect(draft.value.groups.map((group) => group.key)).toEqual(['github.com']);
    expect(draft.value.ungrouped).toEqual([4]);
  });

  it('proposes nothing when the selection is too small to group', () => {
    organizeSelection([1, 2]);

    expect(draft.value.groups).toEqual([]);
  });
});

describe('the first edit', () => {
  it('pins the draft, so a tab opening elsewhere cannot move the rows', () => {
    rename('github.com', 'Codice');
    panelData.value = data([...tabs(), tab(7, 'https://github.com/four')]);

    expect(draft.value.groups[0]?.title).toBe('Codice');
    expect(draft.value.groups[0]?.tabIds).toEqual([1, 2, 3]);
  });

  it('is cleared by a new scope, mode or option, which are new questions', () => {
    rename('github.com', 'Codice');
    setScope('all');
    expect(draft.value.groups[0]?.title).toBe('GitHub');

    rename('github.com', 'Codice');
    setMode('topic');
    expect(mode.value).toBe('topic');
    expect(draft.value.groups.every((group) => group.title !== 'Codice')).toBe(true);

    setMode('site');
    rename('github.com', 'Codice');
    setOptions({ collapse: true });
    expect(options.value.collapse).toBe(true);
    expect(draft.value.groups[0]?.title).toBe('GitHub');
  });

  it('restores the persisted autoOrganizeMode ("topic") when reopening the panel', () => {
    panelData.value = {
      ...data(tabs()),
      settings: { ...DEFAULT_SETTINGS, autoOrganizeMode: 'topic' },
    };
    clearModeOverride();

    expect(mode.value).toBe('topic');
  });
});
