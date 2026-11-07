import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ArchivedTab } from '../../src/core/types';
import {
  UNDO_MS,
  forgetClose,
  holdUndo,
  lastClose,
  releaseUndo,
  rememberClose,
  takeClose,
} from '../../src/entrypoints/sidepanel/state/undo';

/**
 * The 8 s in which a close can still be undone (PLAN.md §4.3, §9).
 *
 * The clock is faked, because the one thing worth being exact about is the 8 s itself: a
 * toast that went at 7 s would take an Annulla with it, and one that never went would sit
 * over the last rows for the rest of the session.
 */

function entry(at: number): ArchivedTab {
  return {
    id: `archived-${String(at)}`,
    url: `https://example.com/${String(at)}`,
    title: `Tab ${String(at)}`,
    closedAt: 1_000,
    reason: 'manual',
    windowId: 1,
    index: at,
  };
}

function batch(count: number, windows = 0): { entries: ArchivedTab[]; windows: number } {
  return { entries: Array.from({ length: count }, (_, at) => entry(at + 1)), windows };
}

beforeEach(() => {
  vi.useFakeTimers();
  forgetClose();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('rememberClose', () => {
  it('puts the close where the toast and `Ctrl+Z` look for it', () => {
    rememberClose(batch(3));
    expect(lastClose.value?.entries).toHaveLength(3);
    expect(lastClose.value?.windows).toBe(0);
  });

  it("keeps it for §4.3's 8 s and not a moment less", () => {
    rememberClose(batch(1));

    vi.advanceTimersByTime(UNDO_MS - 1);
    expect(lastClose.value).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(lastClose.value).toBeNull();
  });

  it('is 8 s, so the toast is as long as the spec says', () => {
    expect(UNDO_MS).toBe(8_000);
  });

  /*
   * One toast, one Annulla, and it is always the last thing the user did: a queue would
   * offer to undo a close the user has stopped thinking about.
   */
  it('replaces the close before it, and gives the new one its full span', () => {
    rememberClose(batch(1));
    vi.advanceTimersByTime(UNDO_MS - 100);

    rememberClose(batch(5));
    expect(lastClose.value?.entries).toHaveLength(5);

    vi.advanceTimersByTime(UNDO_MS - 1);
    expect(lastClose.value?.entries).toHaveLength(5);

    vi.advanceTimersByTime(1);
    expect(lastClose.value).toBeNull();
  });

  it('carries how many windows went, so the toast agrees with the button', () => {
    rememberClose(batch(3, 1));
    expect(lastClose.value?.windows).toBe(1);
  });
});

describe('holdUndo', () => {
  it('stops the clock, which is §4.3\'s "does not disappear while hovered"', () => {
    rememberClose(batch(2));
    holdUndo();

    vi.advanceTimersByTime(10 * UNDO_MS);
    expect(lastClose.value).not.toBeNull();
  });

  it('starts the 8 s again from the top when it lets go', () => {
    rememberClose(batch(2));
    vi.advanceTimersByTime(UNDO_MS - 100);

    holdUndo();
    vi.advanceTimersByTime(UNDO_MS);
    releaseUndo();

    // What was read stays readable: the span is the whole 8 s again, not the 100 ms left.
    vi.advanceTimersByTime(UNDO_MS - 1);
    expect(lastClose.value).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(lastClose.value).toBeNull();
  });

  it('holds a close that arrives while the pointer is already there', () => {
    holdUndo();
    rememberClose(batch(1));

    // The close resets the hold: the toast under the pointer is a new one, with new text,
    // and `onPointerEnter` will not fire again for a pointer that never left.
    vi.advanceTimersByTime(UNDO_MS);
    expect(lastClose.value).toBeNull();
  });

  it('is harmless with nothing to hold', () => {
    holdUndo();
    releaseUndo();
    expect(lastClose.value).toBeNull();
  });
});

describe('takeClose', () => {
  it('hands the entries over for the restore', () => {
    rememberClose(batch(4));
    expect(takeClose()?.entries).toHaveLength(4);
  });

  /*
   * A click on Annulla and a `Ctrl+Z` on top of it would otherwise restore the same tabs
   * twice, and the user would be looking at four copies of two tabs.
   */
  it('empties the toast at once, so the same close cannot be undone twice', () => {
    rememberClose(batch(4));

    expect(takeClose()).not.toBeNull();
    expect(takeClose()).toBeNull();
    expect(lastClose.value).toBeNull();
  });

  it('stops the clock with it, so nothing fires over an empty toast', () => {
    rememberClose(batch(1));
    takeClose();

    rememberClose(batch(2));
    vi.advanceTimersByTime(UNDO_MS - 1);
    // The first close's timer would have expired by now and cleared the second's toast.
    expect(lastClose.value?.entries).toHaveLength(2);
  });

  it('answers with nothing when there is nothing to undo', () => {
    expect(takeClose()).toBeNull();
  });
});

describe('forgetClose', () => {
  it('drops the close without undoing it, and releases any hold with it', () => {
    rememberClose(batch(3));
    holdUndo();
    forgetClose();

    expect(lastClose.value).toBeNull();

    rememberClose(batch(1));
    vi.advanceTimersByTime(UNDO_MS);
    expect(lastClose.value).toBeNull();
  });
});
