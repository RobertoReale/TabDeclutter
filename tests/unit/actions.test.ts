import { describe, expect, it } from 'vitest';

import {
  archiveEntries,
  BULK_CONFIRM_LIMIT,
  planRestores,
  safeguardsFor,
} from '../../src/core/actions';
import type { ArchivedTab, TabInfo } from '../../src/core/types';
import { NO_GROUP_ID } from '../../src/core/types';

/**
 * The pure half of PLAN.md §9: what a close writes to the archive, what the user is asked
 * before it happens, and how a restore is paired with the browser's recently closed tabs.
 *
 * The safeguards are the part that stands between the user and a tab they wanted, so they
 * are checked here in full, with no browser anywhere near them (invariant 4).
 */

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** A tab that is nothing in particular, so a test only states what it is testing. */
function tab(id: number, overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id,
    windowId: 1,
    index: id,
    url: `https://example.com/${String(id)}`,
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

function archived(overrides: Partial<ArchivedTab> = {}): ArchivedTab {
  return {
    id: 'e1',
    url: 'https://example.com/1',
    title: 'Tab 1',
    closedAt: NOW,
    reason: 'manual',
    windowId: 1,
    index: 0,
    ...overrides,
  };
}

describe('archiveEntries', () => {
  it('keeps everything a restore needs: the URL, the window and the index', () => {
    const entries = archiveEntries([tab(7, { windowId: 3, index: 4 })], NOW);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      url: 'https://example.com/7',
      title: 'Tab 7',
      closedAt: NOW,
      reason: 'manual',
      windowId: 3,
      index: 4,
    });
  });

  it('keeps the order it was given, which is the order the archive shows', () => {
    const entries = archiveEntries([tab(5), tab(2), tab(9)], NOW);

    expect(entries.map((entry) => entry.url)).toEqual([
      'https://example.com/5',
      'https://example.com/2',
      'https://example.com/9',
    ]);
  });

  it('gives each entry an id of its own, not the browser’s reusable tab id', () => {
    const entries = archiveEntries([tab(1), tab(2)], NOW);
    const ids = entries.map((entry) => entry.id);

    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain('1');
  });

  it('falls back to the URL a loading tab is on its way to', () => {
    const entries = archiveEntries(
      [tab(1, { url: '', pendingUrl: 'https://late.example/x' })],
      NOW,
    );

    expect(entries[0]?.url).toBe('https://late.example/x');
  });

  /* PLAN.md §5.5: a remote favicon in the archive would be a network request (invariant 1). */
  it('drops a remote favicon and keeps an inline one', () => {
    const remote = archiveEntries([tab(1, { favIconUrl: 'https://example.com/icon.png' })], NOW);
    const inline = archiveEntries([tab(2, { favIconUrl: 'data:image/png;base64,AAA' })], NOW);

    expect(remote[0]?.favIconUrl).toBeUndefined();
    expect(inline[0]?.favIconUrl).toBe('data:image/png;base64,AAA');
  });

  it('records the reason, so the Archive view can filter on it', () => {
    const entries = archiveEntries([tab(1)], NOW, { reason: 'duplicate-auto' });

    expect(entries[0]?.reason).toBe('duplicate-auto');
  });

  it('records which tab was kept instead, for a duplicate close', () => {
    const entries = archiveEntries([tab(1), tab(2)], NOW, {
      reason: 'duplicate-manual',
      duplicateOfUrl: new Map([[2, 'https://example.com/kept']]),
    });

    expect(entries[0]?.duplicateOfUrl).toBeUndefined();
    expect(entries[1]?.duplicateOfUrl).toBe('https://example.com/kept');
  });

  /* PLAN.md §5.5: group ids do not survive a restart, so the title is the only handle. */
  it('records the title of the group the tab was in', () => {
    const entries = archiveEntries([tab(1, { groupId: 12 })], NOW, {
      groupTitles: new Map([[12, 'Work']]),
    });

    expect(entries[0]?.groupTitle).toBe('Work');
  });

  it('records no group for an ungrouped tab, an unknown group or an untitled one', () => {
    const titles = new Map([[12, '']]);
    const entries = archiveEntries(
      [tab(1), tab(2, { groupId: 99 }), tab(3, { groupId: 12 })],
      NOW,
      { groupTitles: titles },
    );

    expect(entries.map((entry) => entry.groupTitle)).toEqual([undefined, undefined, undefined]);
  });

  it('archives nothing for no tabs', () => {
    expect(archiveEntries([], NOW)).toEqual([]);
  });
});

describe('safeguardsFor', () => {
  it('ignores a selected id that is no longer open', () => {
    const safeguards = safeguardsFor({ selectedIds: [1, 404], tabs: [tab(1), tab(2)] });

    expect(safeguards.tabs.map((found) => found.id)).toEqual([1]);
  });

  it('lists the selected tabs in the order the tab list gave them', () => {
    const safeguards = safeguardsFor({
      selectedIds: [9, 2, 5],
      tabs: [tab(5), tab(2), tab(9)],
    });

    expect(safeguards.tabs.map((found) => found.id)).toEqual([5, 2, 9]);
  });

  /* PLAN.md §9: "Chiudi N schede e la finestra" — the wording changes, nothing is asked. */
  it('reports the window a selection empties', () => {
    const tabs = [tab(1, { windowId: 1 }), tab(2, { windowId: 1 }), tab(3, { windowId: 2 })];
    const safeguards = safeguardsFor({ selectedIds: [1, 2], tabs });

    expect(safeguards.wholeWindowIds).toEqual([1]);
    expect(safeguards.needsConfirmation).toBe(false);
  });

  it('reports every window the selection empties, in order', () => {
    const tabs = [tab(1, { windowId: 3 }), tab(2, { windowId: 1 }), tab(3, { windowId: 2 })];
    const safeguards = safeguardsFor({ selectedIds: [1, 2, 3], tabs });

    expect(safeguards.wholeWindowIds).toEqual([1, 2, 3]);
  });

  it('reports no window when one tab of it stays open', () => {
    const tabs = [tab(1, { windowId: 1 }), tab(2, { windowId: 1 })];
    const safeguards = safeguardsFor({ selectedIds: [1], tabs });

    expect(safeguards.wholeWindowIds).toEqual([]);
  });

  /* PLAN.md §9: never close the active tab of the current window without asking. */
  it('asks before closing the active tab of the focused window', () => {
    const tabs = [tab(1, { active: true }), tab(2)];
    const safeguards = safeguardsFor({ selectedIds: [1, 2], tabs, focusedWindowId: 1 });

    expect(safeguards.activeTab?.id).toBe(1);
    expect(safeguards.needsConfirmation).toBe(true);
  });

  it('does not ask for the active tab of a window nobody is looking at', () => {
    const tabs = [tab(1, { windowId: 2, active: true }), tab(2, { windowId: 2 })];
    const safeguards = safeguardsFor({ selectedIds: [1], tabs, focusedWindowId: 1 });

    expect(safeguards.activeTab).toBeUndefined();
    expect(safeguards.needsConfirmation).toBe(false);
  });

  it('does not ask when no window has focus', () => {
    const safeguards = safeguardsFor({ selectedIds: [1], tabs: [tab(1, { active: true })] });

    expect(safeguards.activeTab).toBeUndefined();
    expect(safeguards.needsConfirmation).toBe(false);
  });

  /* PLAN.md §9: "Chiudi 42 schede? [Conferma] [Annulla]". */
  it(`asks above ${String(BULK_CONFIRM_LIMIT)} tabs and not at it`, () => {
    const many = Array.from({ length: BULK_CONFIRM_LIMIT + 1 }, (_, at) => tab(at + 1));
    const atLimit = many.slice(0, BULK_CONFIRM_LIMIT);

    const over = safeguardsFor({ selectedIds: many.map((found) => found.id), tabs: many });
    const under = safeguardsFor({ selectedIds: atLimit.map((found) => found.id), tabs: many });

    expect(over.bulk).toBe(true);
    expect(over.needsConfirmation).toBe(true);
    expect(under.bulk).toBe(false);
    expect(under.needsConfirmation).toBe(false);
  });

  it('says nothing about an empty selection', () => {
    const safeguards = safeguardsFor({ selectedIds: [], tabs: [tab(1)], focusedWindowId: 1 });

    expect(safeguards).toMatchObject({
      tabs: [],
      wholeWindowIds: [],
      bulk: false,
      needsConfirmation: false,
    });
  });
});

describe('planRestores', () => {
  it('pairs an entry with the session the browser still remembers', () => {
    const steps = planRestores(
      [archived({ url: 'https://example.com/a' })],
      [{ sessionId: 's1', url: 'https://example.com/a' }],
    );

    expect(steps[0]?.sessionId).toBe('s1');
  });

  /* PLAN.md §9: past the browser's 25, a restore falls back to `tabs.create`. */
  it('leaves an entry the browser no longer remembers without a session', () => {
    const steps = planRestores([archived({ url: 'https://example.com/a' })], []);

    expect(steps).toHaveLength(1);
    expect(steps[0]?.sessionId).toBeUndefined();
  });

  it('compares URLs the way every other store keyed by URL does', () => {
    const steps = planRestores(
      [archived({ url: 'https://example.com/a?utm_source=news' })],
      [{ sessionId: 's1', url: 'https://example.com/a' }],
    );

    expect(steps[0]?.sessionId).toBe('s1');
  });

  it('never hands the same session to two entries', () => {
    const steps = planRestores(
      [
        archived({ id: 'e1', url: 'https://example.com/a' }),
        archived({ id: 'e2', url: 'https://example.com/a' }),
      ],
      [{ sessionId: 's1', url: 'https://example.com/a' }],
    );

    expect(steps.map((step) => step.sessionId)).toEqual(['s1', undefined]);
  });

  it('gives the freshest session to the first entry that wants it', () => {
    const steps = planRestores(
      [
        archived({ id: 'e1', url: 'https://example.com/a' }),
        archived({ id: 'e2', url: 'https://example.com/a' }),
      ],
      [
        { sessionId: 'new', url: 'https://example.com/a' },
        { sessionId: 'old', url: 'https://example.com/a' },
      ],
    );

    expect(steps.map((step) => step.sessionId)).toEqual(['new', 'old']);
  });

  it('ignores a session with no id and one with no URL', () => {
    const steps = planRestores(
      [archived({ url: 'https://example.com/a' })],
      [{ url: 'https://example.com/a' }, { sessionId: 's2' }],
    );

    expect(steps[0]?.sessionId).toBeUndefined();
  });

  it('keeps the entries it was given, in order', () => {
    const steps = planRestores([archived({ id: 'e1' }), archived({ id: 'e2' })], []);

    expect(steps.map((step) => step.entry.id)).toEqual(['e1', 'e2']);
  });
});
