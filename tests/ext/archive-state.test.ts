import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { DAY } from '../../src/core/time';
import type { ArchivedTab } from '../../src/core/types';
import type { ArchiveStateHandle } from '../../src/entrypoints/sidepanel/state/archive';
import {
  allArchiveSelected,
  archiveData,
  archiveEntries,
  archiveFilter,
  archiveLoaded,
  archivePickedSignal,
  clearArchiveSelection,
  copyArchived,
  emptyArchived,
  forgetArchived,
  hasArchiveSelection,
  pickedArchive,
  setArchiveOrigin,
  setArchiveQuery,
  setArchiveWhen,
  shownArchive,
  startArchiveState,
  toggleArchiveAll,
  toggleArchivePicked,
} from '../../src/entrypoints/sidepanel/state/archive';
import { ANY_ARCHIVE } from '../../src/core/archive';
import { archiveItem } from '../../src/platform/storage';

/**
 * What the Archive view knows (PLAN.md §4.5): that it reads the archive when it opens,
 * follows `storage.onChanged` with §5.2's debounce, stops following when the view goes,
 * and that its selection only ever covers rows the filter left on screen.
 *
 * The clock is injected, so "Oggi" is an assignment and not a wait.
 */

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
let clock = NOW;

/** Short and recognizable, so a test that waits for the debounce says so. */
const DEBOUNCE = 150;

let handle: ArchiveStateHandle | undefined;

beforeEach(() => {
  fakeBrowser.reset();
  clock = NOW;
  // The signals are module state, shared by every test in the file.
  archiveData.value = null;
  archiveFilter.value = ANY_ARCHIVE;
  clearArchiveSelection();
  vi.useFakeTimers();
});

afterEach(() => {
  handle?.stop();
  handle = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function archived(id: string, overrides: Partial<ArchivedTab> = {}): ArchivedTab {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `Tab ${id}`,
    closedAt: NOW,
    reason: 'manual',
    windowId: 1,
    index: 0,
    ...overrides,
  };
}

/** Writes the archive as the background would have, before the view opens. */
function store(...entries: ArchivedTab[]): Promise<void> {
  return archiveItem.setValue(entries);
}

/** The view opening: the state with the injected clock, read once. */
async function open(): Promise<ArchiveStateHandle> {
  handle = startArchiveState({ now: () => clock, debounceMs: DEBOUNCE });
  await handle.refresh();
  return handle;
}

function ids(entries: readonly ArchivedTab[]): readonly string[] {
  return entries.map((entry) => entry.id);
}

/** A clipboard the browser gives us, and the texts it was handed. */
function clipboard(): string[] {
  const written: string[] = [];
  vi.stubGlobal('navigator', {
    clipboard: {
      writeText: (text: string) => {
        written.push(text);
        return Promise.resolve();
      },
    },
  });
  return written;
}

describe('the first read', () => {
  it('has nothing until it comes back', () => {
    handle = startArchiveState({ now: () => clock, debounceMs: DEBOUNCE });

    expect(archiveData.value).toBeNull();
    expect(archiveLoaded.value).toBe(false);
    expect(shownArchive.value).toEqual([]);
  });

  it('loads the archive with the moment it was read', async () => {
    await store(archived('a'), archived('b'));

    await open();

    expect(ids(archiveEntries.value)).toEqual(['a', 'b']);
    expect(archiveData.value?.at).toBe(NOW);
    expect(archiveLoaded.value).toBe(true);
  });

  it('loads an empty archive as loaded, not as pending', async () => {
    await open();

    expect(archiveLoaded.value).toBe(true);
    expect(archiveEntries.value).toEqual([]);
  });
});

describe('following the background', () => {
  it('reads again when the archive changes, once for a burst', async () => {
    await store(archived('a'));
    await open();
    const reads = vi.spyOn(fakeBrowser.storage.local, 'get');

    await archiveItem.setValue([archived('a'), archived('b')]);
    await archiveItem.setValue([archived('a'), archived('b'), archived('c')]);
    expect(reads).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(reads).toHaveBeenCalledTimes(1);
    expect(ids(archiveEntries.value)).toEqual(['a', 'b', 'c']);
  });

  it('ignores a change to something the archive does not hold', async () => {
    await open();
    const reads = vi.spyOn(fakeBrowser.storage.local, 'get');

    await fakeBrowser.storage.local.set({ settings: { staleDays: 3 } });
    await vi.advanceTimersByTimeAsync(DEBOUNCE);

    expect(reads).not.toHaveBeenCalled();
  });

  it('stops following when the view goes away', async () => {
    await store(archived('a'));
    const opened = await open();
    const reads = vi.spyOn(fakeBrowser.storage.local, 'get');

    opened.stop();
    handle = undefined;
    await archiveItem.setValue([archived('a'), archived('b')]);
    await vi.advanceTimersByTimeAsync(10 * DEBOUNCE);

    expect(reads).not.toHaveBeenCalled();
    expect(ids(archiveEntries.value)).toEqual(['a']);
  });

  it('drops a read that was still waiting when the view went away', async () => {
    await store(archived('a'));
    const opened = await open();
    const reads = vi.spyOn(fakeBrowser.storage.local, 'get');

    await archiveItem.setValue([archived('a'), archived('b')]);
    opened.stop();
    handle = undefined;
    await vi.advanceTimersByTimeAsync(10 * DEBOUNCE);

    expect(reads).not.toHaveBeenCalled();
  });
});

describe('what the list shows', () => {
  it('applies the search to the snapshot', async () => {
    await store(
      archived('a', { title: 'Quarterly report' }),
      archived('b', { title: 'Shopping list' }),
    );
    await open();

    setArchiveQuery('report');

    expect(ids(shownArchive.value)).toEqual(['a']);
  });

  it('applies the date filter against the moment it was read, not the clock', async () => {
    await store(archived('today'), archived('last-month', { closedAt: NOW - 30 * DAY }));
    await open();
    clock = NOW + 40 * DAY;

    setArchiveWhen('today');

    expect(ids(shownArchive.value)).toEqual(['today']);
  });

  it('applies the origin filter', async () => {
    await store(archived('mine'), archived('guard', { reason: 'duplicate-auto' }));
    await open();

    setArchiveOrigin('duplicates');

    expect(ids(shownArchive.value)).toEqual(['guard']);
  });
});

describe('the selection', () => {
  it('ticks and unticks one row, and only that row re-reads', async () => {
    await store(archived('a'), archived('b'));
    await open();
    const first = archivePickedSignal('a');
    const second = archivePickedSignal('b');

    toggleArchivePicked('a');

    expect(first.value).toBe(true);
    expect(second.value).toBe(false);
    expect(hasArchiveSelection.value).toBe(true);

    toggleArchivePicked('a');

    expect(first.value).toBe(false);
    expect(hasArchiveSelection.value).toBe(false);
  });

  it('gives a row the same signal every time, so its render is stable', async () => {
    await open();

    expect(archivePickedSignal('a')).toBe(archivePickedSignal('a'));
  });

  it('ticks every shown row, then unticks them all', async () => {
    await store(archived('a'), archived('b'));
    await open();

    toggleArchiveAll();
    expect(allArchiveSelected.value).toBe(true);
    expect(ids(pickedArchive.value)).toEqual(['a', 'b']);

    toggleArchiveAll();
    expect(allArchiveSelected.value).toBe(false);
    expect(pickedArchive.value).toEqual([]);
  });

  it('ticks only what the filter left', async () => {
    await store(archived('a', { title: 'Report' }), archived('b', { title: 'Other' }));
    await open();
    setArchiveQuery('report');

    toggleArchiveAll();

    expect(ids(pickedArchive.value)).toEqual(['a']);
    setArchiveQuery('');
    expect(ids(pickedArchive.value)).toEqual(['a']);
  });

  it('does not act on a row the search has hidden', async () => {
    await store(archived('a', { title: 'Report' }), archived('b', { title: 'Other' }));
    await open();
    toggleArchiveAll();

    setArchiveQuery('report');

    expect(ids(pickedArchive.value)).toEqual(['a']);
    expect(allArchiveSelected.value).toBe(true);
  });

  it('is empty, not complete, when the filter leaves nothing', async () => {
    await store(archived('a'));
    await open();
    toggleArchiveAll();

    setArchiveQuery('nothing matches this');

    expect(allArchiveSelected.value).toBe(false);
    expect(hasArchiveSelection.value).toBe(false);
  });
});

describe('the actions', () => {
  it('deletes the entries it was given and forgets the selection', async () => {
    await store(archived('a'), archived('b'));
    const opened = await open();
    toggleArchivePicked('a');

    forgetArchived([archived('a')]);
    await vi.advanceTimersByTimeAsync(0);
    await opened.refresh();

    expect(ids(archiveEntries.value)).toEqual(['b']);
    expect(hasArchiveSelection.value).toBe(false);
  });

  it('empties the whole archive', async () => {
    await store(archived('a'), archived('b'));
    const opened = await open();

    emptyArchived();
    await vi.advanceTimersByTimeAsync(0);
    await opened.refresh();

    expect(archiveEntries.value).toEqual([]);
  });

  it('writes nothing for an empty action', async () => {
    await store(archived('a'));
    await open();
    const writes = vi.spyOn(fakeBrowser.storage.local, 'set');

    forgetArchived([]);
    await vi.advanceTimersByTimeAsync(0);

    expect(writes).not.toHaveBeenCalled();
  });

  it('exports the rows on screen as a Markdown list', async () => {
    await store(
      archived('a', { title: 'Report', url: 'https://example.com/report' }),
      archived('b', { title: 'Other', url: 'https://example.com/other' }),
    );
    await open();
    const written = clipboard();

    setArchiveQuery('report');
    expect(await copyArchived(shownArchive.value)).toBe(true);

    expect(written).toEqual(['- [Report](https://example.com/report)']);
  });

  it('refuses to export nothing', async () => {
    const written = clipboard();

    expect(await copyArchived([])).toBe(false);

    expect(written).toEqual([]);
  });

  it('says so when the browser will not give us the clipboard', async () => {
    const failed = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('navigator', {
      clipboard: { writeText: () => Promise.reject(new Error('not allowed')) },
    });

    expect(await copyArchived([archived('a')])).toBe(false);

    expect(failed).toHaveBeenCalled();
  });
});
