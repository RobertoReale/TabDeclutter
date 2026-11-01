import { describe, expect, it } from 'vitest';

import type { ReconcileTab } from '../../src/core/reconcile';
import {
  bootstrapActivity,
  bootstrapRecord,
  isTabActivity,
  reconcileActivity,
} from '../../src/core/reconcile';
import { HOUR, MINUTE } from '../../src/core/time';
import type { ActivityStore, TabActivity } from '../../src/core/types';

/** A fixed clock: reconciliation is pure, so nothing here reads the real one. */
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

function record(tabId: number, url: string, overrides: Partial<TabActivity> = {}): TabActivity {
  return {
    tabId,
    url,
    createdAt: NOW - 2 * HOUR,
    lastActiveAt: NOW - HOUR,
    activations: 3,
    foregroundMs: 5 * MINUTE,
    ...overrides,
  };
}

function store(...records: TabActivity[]): ActivityStore {
  return Object.fromEntries(records.map((entry) => [entry.tabId, entry]));
}

function tab(id: number, url: string, overrides: Partial<ReconcileTab> = {}): ReconcileTab {
  return { id, windowId: 1, index: id, url, ...overrides };
}

describe('recognising a stored record', () => {
  it('accepts one the tracker wrote', () => {
    expect(isTabActivity(record(1, 'https://example.com/'))).toBe(true);
  });

  it('accepts the bootstrapped marker', () => {
    expect(isTabActivity(record(1, 'https://example.com/', { bootstrappedAt: NOW }))).toBe(true);
  });

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['a string', 'activity'],
    ['a number', 7],
    ['an array', []],
  ])('refuses %s', (_name, value) => {
    expect(isTabActivity(value)).toBe(false);
  });

  it.each([
    ['tabId', { tabId: '1' }],
    ['url', { url: 42 }],
    ['createdAt', { createdAt: '2026' }],
    ['lastActiveAt', { lastActiveAt: undefined }],
    ['activations', { activations: null }],
    ['foregroundMs', { foregroundMs: Number.NaN }],
    ['bootstrappedAt', { bootstrappedAt: Number.POSITIVE_INFINITY }],
  ])('refuses one whose %s is the wrong shape', (_name, broken) => {
    expect(isTabActivity({ ...record(1, 'https://example.com/'), ...broken })).toBe(false);
  });

  it('refuses an array even though it is an object', () => {
    expect(isTabActivity([record(1, 'https://example.com/')])).toBe(false);
  });
});

describe('inventing a record', () => {
  it('dates the tab from what the browser still remembers', () => {
    const invented = bootstrapRecord(
      tab(1, 'https://example.com/', { lastAccessed: NOW - HOUR }),
      NOW,
    );

    expect(invented).toEqual({
      tabId: 1,
      url: 'https://example.com/',
      createdAt: NOW - HOUR,
      lastActiveAt: NOW - HOUR,
      activations: 0,
      foregroundMs: 0,
      bootstrappedAt: NOW,
    });
  });

  it('falls back to now when the browser remembers nothing', () => {
    const invented = bootstrapRecord(tab(1, 'https://example.com/'), NOW);

    expect(invented.createdAt).toBe(NOW);
    expect(invented.lastActiveAt).toBe(NOW);
    expect(invented.bootstrappedAt).toBe(NOW);
  });

  it.each([
    ['a zero', 0],
    ['a time in the future', NOW + HOUR],
  ])('does not trust %s', (_name, lastAccessed) => {
    expect(bootstrapRecord(tab(1, 'https://example.com/', { lastAccessed }), NOW).createdAt).toBe(
      NOW,
    );
  });
});

describe('reconciliation after a restart', () => {
  it('gives a tab its record back under the id it has now', () => {
    const saved = store(record(11, 'https://example.com/a'), record(12, 'https://example.com/b'));

    const result = reconcileActivity(
      saved,
      [tab(2, 'https://example.com/b'), tab(1, 'https://example.com/a')],
      {
        now: NOW,
      },
    );

    expect(result).toMatchObject({ matched: 2, invented: 0, dropped: 0 });
    expect(result.activity[1]).toEqual({ ...record(11, 'https://example.com/a'), tabId: 1 });
    expect(result.activity[2]).toEqual({ ...record(12, 'https://example.com/b'), tabId: 2 });
  });

  it('pairs tabs that share a URL in the order the user sees them', () => {
    const saved = store(
      record(11, 'https://example.com/', { createdAt: NOW - 3 * HOUR, activations: 1 }),
      record(12, 'https://example.com/', { createdAt: NOW - HOUR, activations: 2 }),
    );

    const result = reconcileActivity(
      saved,
      [tab(7, 'https://example.com/', { index: 5 }), tab(8, 'https://example.com/', { index: 1 })],
      { now: NOW },
    );

    // The oldest record goes to the leftmost tab, so two tabs on the same page cannot
    // swap histories from one restart to the next.
    expect(result.activity[8]?.activations).toBe(1);
    expect(result.activity[7]?.activations).toBe(2);
    expect(result).toMatchObject({ matched: 2, invented: 0, dropped: 0 });
  });

  it('orders by window before position, and by id when even that ties', () => {
    const saved = store(
      record(11, 'https://example.com/', { createdAt: NOW - 3 * HOUR, activations: 1 }),
      record(12, 'https://example.com/', { createdAt: NOW - 2 * HOUR, activations: 2 }),
      record(13, 'https://example.com/', { createdAt: NOW - HOUR, activations: 3 }),
    );

    const result = reconcileActivity(
      saved,
      [
        tab(30, 'https://example.com/', { windowId: 2, index: 0 }),
        tab(20, 'https://example.com/', { windowId: 1, index: 4 }),
        tab(10, 'https://example.com/', { windowId: 1, index: 4 }),
      ],
      { now: NOW },
    );

    expect(result.activity[10]?.activations).toBe(1);
    expect(result.activity[20]?.activations).toBe(2);
    expect(result.activity[30]?.activations).toBe(3);
  });

  it('forgets the records no tab came back for', () => {
    const saved = store(
      record(11, 'https://example.com/a'),
      record(12, 'https://example.com/gone'),
    );

    const result = reconcileActivity(saved, [tab(1, 'https://example.com/a')], { now: NOW });

    expect(Object.keys(result.activity)).toEqual(['1']);
    expect(result).toMatchObject({ matched: 1, invented: 0, dropped: 1 });
  });

  it('invents a record for a tab it knows nothing about', () => {
    const result = reconcileActivity(
      {},
      [tab(1, 'https://example.com/new', { lastAccessed: NOW - MINUTE })],
      {
        now: NOW,
      },
    );

    expect(result).toMatchObject({ matched: 0, invented: 1, dropped: 0 });
    expect(result.activity[1]).toMatchObject({ createdAt: NOW - MINUTE, bootstrappedAt: NOW });
  });

  it('never treats two tabs with no URL as the same page', () => {
    const saved = store(record(11, ''));

    const result = reconcileActivity(saved, [tab(1, ''), tab(2, '')], { now: NOW });

    expect(result).toMatchObject({ matched: 0, invented: 2, dropped: 1 });
    expect(result.activity[1]?.bootstrappedAt).toBe(NOW);
    expect(result.activity[2]?.bootstrappedAt).toBe(NOW);
  });

  it('ignores a stored value that is not a record', () => {
    const saved = {
      11: 'rubbish',
      12: record(12, 'https://example.com/b'),
    } as unknown as ActivityStore;

    const result = reconcileActivity(saved, [tab(1, 'https://example.com/b')], { now: NOW });

    expect(result.activity[1]?.activations).toBe(3);
    expect(result).toMatchObject({ matched: 1, dropped: 1 });
  });

  it('starts from nothing when there is nothing saved and no tab open', () => {
    expect(reconcileActivity({}, [], { now: NOW })).toEqual({
      activity: {},
      matched: 0,
      invented: 0,
      dropped: 0,
    });
  });

  describe('on Firefox, where the session store gives the record back with the tab', () => {
    it('prefers the session value over matching by URL', () => {
      const saved = store(record(11, 'https://example.com/a', { activations: 1 }));
      const fromSession = store(record(99, 'https://example.com/a', { activations: 42 }));

      const result = reconcileActivity(saved, [tab(99, 'https://example.com/a')], {
        now: NOW,
        fromSession,
      });

      expect(result.activity[99]).toMatchObject({ tabId: 99, activations: 42 });
      expect(result).toMatchObject({ matched: 1, invented: 0, dropped: 0 });
    });

    it('updates the URL to the one the tab has now', () => {
      const fromSession = store(record(5, 'https://example.com/old'));

      const result = reconcileActivity({}, [tab(5, 'https://example.com/new')], {
        now: NOW,
        fromSession,
      });

      expect(result.activity[5]?.url).toBe('https://example.com/new');
    });

    it('leaves the other tabs the records it did not use', () => {
      const saved = store(
        record(11, 'https://example.com/', { createdAt: NOW - 3 * HOUR, activations: 1 }),
        record(12, 'https://example.com/', { createdAt: NOW - HOUR, activations: 2 }),
      );
      const fromSession = store(record(1, 'https://example.com/', { activations: 42 }));

      const result = reconcileActivity(
        saved,
        [
          tab(1, 'https://example.com/', { index: 0 }),
          tab(2, 'https://example.com/', { index: 1 }),
        ],
        { now: NOW, fromSession },
      );

      expect(result.activity[1]?.activations).toBe(42);
      // The saved copy of tab 1 is spent, so tab 2 gets the other record and not the
      // history of the tab in front of it.
      expect(result.activity[2]?.activations).toBe(2);
      expect(result).toMatchObject({ matched: 2, dropped: 0 });
    });

    it('falls back to the URL when the session value is rubbish', () => {
      const saved = store(record(11, 'https://example.com/a', { activations: 7 }));
      const fromSession = { 1: { tabId: 1 } } as unknown as ActivityStore;

      const result = reconcileActivity(saved, [tab(1, 'https://example.com/a')], {
        now: NOW,
        fromSession,
      });

      expect(result.activity[1]?.activations).toBe(7);
      expect(result).toMatchObject({ matched: 1, dropped: 0 });
    });
  });
});

describe('bootstrapping on install and update', () => {
  it('invents a record for every tab that is already open', () => {
    const result = bootstrapActivity(
      {},
      [
        tab(1, 'https://example.com/a', { lastAccessed: NOW - HOUR }),
        tab(2, 'https://example.com/b'),
      ],
      NOW,
    );

    expect(result).toMatchObject({ matched: 0, invented: 2, dropped: 0 });
    expect(result.activity[1]).toMatchObject({ createdAt: NOW - HOUR, bootstrappedAt: NOW });
    expect(result.activity[2]).toMatchObject({ createdAt: NOW, bootstrappedAt: NOW });
  });

  it('keeps what the previous version had already observed', () => {
    const saved = store(record(1, 'https://example.com/a', { activations: 9 }));

    const result = bootstrapActivity(saved, [tab(1, 'https://example.com/a')], NOW);

    expect(result.activity[1]).toMatchObject({ activations: 9 });
    expect(result.activity[1]).not.toHaveProperty('bootstrappedAt');
    expect(result).toMatchObject({ matched: 1, invented: 0, dropped: 0 });
  });

  it('refreshes the URL of a tab that navigated while the extension was reloading', () => {
    const saved = store(record(1, 'https://example.com/old'));

    const result = bootstrapActivity(saved, [tab(1, 'https://example.com/new')], NOW);

    expect(result.activity[1]?.url).toBe('https://example.com/new');
  });

  it('drops the records of tabs that are no longer open', () => {
    const saved = store(record(1, 'https://example.com/a'), record(2, 'https://example.com/gone'));

    const result = bootstrapActivity(saved, [tab(1, 'https://example.com/a')], NOW);

    expect(Object.keys(result.activity)).toEqual(['1']);
    expect(result).toMatchObject({ matched: 1, dropped: 1 });
  });

  it('replaces a stored value that is not a record', () => {
    const saved = { 1: { nonsense: true } } as unknown as ActivityStore;

    const result = bootstrapActivity(saved, [tab(1, 'https://example.com/a')], NOW);

    expect(result.activity[1]?.bootstrappedAt).toBe(NOW);
    expect(result).toMatchObject({ matched: 0, invented: 1, dropped: 1 });
  });
});
