import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { keepKey } from '../../src/core/scoring';
import { DAY, HOUR, MINUTE } from '../../src/core/time';
import type { ArchivedTab, TabActivity } from '../../src/core/types';
import {
  ARCHIVE_CAP,
  DEFAULT_GUARD_SETTINGS,
  DEFAULT_KEEP_MS,
  DEFAULT_MATCH_OPTIONS,
  DEFAULT_SETTINGS,
  EXEMPTION_TTL_MS,
} from '../../src/core/types';
import {
  activityItem,
  addExemption,
  addKeep,
  addToArchive,
  archiveItem,
  duplicateWhitelistItem,
  emptyArchive,
  guardStateItem,
  isExempt,
  isKept,
  keepsItem,
  protectedDomainsItem,
  pruneActivity,
  pruneArchive,
  pruneKeeps,
  readArchive,
  readExemptions,
  readKeeps,
  readSettings,
  removeFromArchive,
  removeKeep,
  saveSettings,
  settingsItem,
} from '../../src/platform/storage';

/** A fixed clock: every helper takes `now`, so no test depends on the real one. */
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
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

function activity(tabId: number, overrides: Partial<TabActivity> = {}): TabActivity {
  return {
    tabId,
    url: `https://example.com/${String(tabId)}`,
    createdAt: NOW - DAY,
    lastActiveAt: NOW - HOUR,
    activations: 3,
    foregroundMs: 42,
    ...overrides,
  };
}

/** The archive's ids, in the order they are stored. */
async function archivedIds(): Promise<string[]> {
  return (await archiveItem.getValue()).map((entry) => entry.id);
}

/** Counts the writes a single action makes to one storage area (PLAN.md §10). */
function countWrites(area: 'local' | 'session') {
  return vi.spyOn(fakeBrowser.storage[area], 'set');
}

describe('the keys of PLAN.md §10', () => {
  it('are spelled exactly as the spec lists them', () => {
    expect([
      activityItem.key,
      keepsItem.key,
      protectedDomainsItem.key,
      archiveItem.key,
      settingsItem.key,
      duplicateWhitelistItem.key,
      guardStateItem.key,
    ]).toEqual([
      'local:activity',
      'local:keeps',
      'local:protectedDomains',
      'local:archive',
      'local:settings',
      'local:duplicateWhitelist',
      'session:guardState',
    ]);
  });

  it('puts the guard state in the session area, which a restart clears', async () => {
    await guardStateItem.setValue({ exemptions: [], lastAutoClosedId: 'a1' });

    expect(await fakeBrowser.storage.session.get('guardState')).toEqual({
      guardState: { exemptions: [], lastAutoClosedId: 'a1' },
    });
    expect(await fakeBrowser.storage.local.get(null)).toEqual({});
  });

  it('stores a local item under its bare key, without the area prefix', async () => {
    await protectedDomainsItem.setValue(['atlassian.net']);

    expect(await fakeBrowser.storage.local.get(null)).toEqual({
      protectedDomains: ['atlassian.net'],
    });
  });
});

describe('the defaults', () => {
  it('gives every key its documented default when nothing is stored', async () => {
    expect(await activityItem.getValue()).toEqual({});
    expect(await keepsItem.getValue()).toEqual({});
    expect(await protectedDomainsItem.getValue()).toEqual([]);
    expect(await archiveItem.getValue()).toEqual([]);
    expect(await duplicateWhitelistItem.getValue()).toEqual([]);
    expect(await settingsItem.getValue()).toEqual(DEFAULT_SETTINGS);
    expect(await guardStateItem.getValue()).toEqual({ exemptions: [] });
  });

  it('reads no default as a stored value: an untouched key stays empty', async () => {
    await activityItem.getValue();
    await settingsItem.getValue();
    await guardStateItem.getValue();

    expect(await fakeBrowser.storage.local.get(null)).toEqual({});
    expect(await fakeBrowser.storage.session.get(null)).toEqual({});
  });

  it('fills in a setting an older release never stored', async () => {
    // What a build that did not know about `useOnDeviceAi` and `guard.keepActive` left
    // behind. The release that adds a field must not read it as `undefined`.
    await fakeBrowser.storage.local.set({
      settings: { staleDays: 3, guard: { mode: 'auto' }, match: { ignoreCase: true } },
    });

    const settings = await readSettings();

    expect(settings.staleDays).toBe(3);
    expect(settings.useOnDeviceAi).toBe(DEFAULT_SETTINGS.useOnDeviceAi);
    expect(settings.guard).toEqual({ ...DEFAULT_GUARD_SETTINGS, mode: 'auto' });
    expect(settings.match).toEqual({ ...DEFAULT_MATCH_OPTIONS, ignoreCase: true });
  });

  it('hands out a settings object the caller may edit, not the defaults themselves', async () => {
    const settings = await readSettings();
    settings.staleDays = 30;
    settings.guard.mode = 'off';

    expect(DEFAULT_SETTINGS.staleDays).toBe(7);
    expect(DEFAULT_GUARD_SETTINGS.mode).toBe('warn');
    expect((await readSettings()).staleDays).toBe(7);
  });
});

describe('reading and writing', () => {
  it('round-trips the settings through one value', async () => {
    const next = { ...DEFAULT_SETTINGS, staleDays: 14, showBadge: false };

    await saveSettings(next);

    expect(await readSettings()).toEqual(next);
  });

  it('round-trips the activity records, keyed by tab id', async () => {
    const record: TabActivity = {
      tabId: 7,
      url: 'https://example.com/',
      createdAt: NOW - DAY,
      lastActiveAt: NOW - HOUR,
      activations: 3,
      foregroundMs: 42,
    };

    await activityItem.setValue({ 7: record });

    expect((await activityItem.getValue())[7]).toEqual(record);
  });

  it('round-trips the duplicate whitelist as the user wrote it', async () => {
    const patterns = ['*://mail.google.com/*', '# a comment'];

    await duplicateWhitelistItem.setValue(patterns);

    expect(await duplicateWhitelistItem.getValue()).toEqual(patterns);
  });
});

describe('the archive', () => {
  it('writes a whole action once, newest first', async () => {
    const writes = countWrites('local');

    await addToArchive([archived('a'), archived('b'), archived('c')]);

    expect(writes).toHaveBeenCalledTimes(1);
    expect(await archivedIds()).toEqual(['a', 'b', 'c']);
  });

  it('puts a later action in front of an earlier one', async () => {
    await addToArchive([archived('old')]);
    await addToArchive([archived('new1'), archived('new2')]);

    expect(await archivedIds()).toEqual(['new1', 'new2', 'old']);
  });

  it('writes nothing at all for an empty action', async () => {
    const writes = countWrites('local');

    await addToArchive([]);

    expect(writes).not.toHaveBeenCalled();
    expect(await fakeBrowser.storage.local.get(null)).toEqual({});
  });

  it('keeps at most ARCHIVE_CAP entries and drops the oldest', async () => {
    const full = Array.from({ length: ARCHIVE_CAP }, (_, i) => archived(`old-${String(i)}`));
    await addToArchive(full);

    await addToArchive([archived('newest')]);

    const ids = await archivedIds();
    expect(ids).toHaveLength(ARCHIVE_CAP);
    expect(ids[0]).toBe('newest');
    // The one that fell off the end is the oldest entry, not a recent one.
    expect(ids).not.toContain(`old-${String(ARCHIVE_CAP - 1)}`);
    expect(ids[1]).toBe('old-0');
  });

  it('caps a single action that is bigger than the archive itself', async () => {
    const tooMany = Array.from({ length: ARCHIVE_CAP + 5 }, (_, i) => archived(`t-${String(i)}`));

    await addToArchive(tooMany);

    const ids = await archivedIds();
    expect(ids).toHaveLength(ARCHIVE_CAP);
    expect(ids[0]).toBe('t-0');
  });

  it('loses nothing when two actions archive at the same moment', async () => {
    // Two closes a few milliseconds apart: both read the archive, and the second write
    // must not overwrite the first one's entries.
    await Promise.all([addToArchive([archived('first')]), addToArchive([archived('second')])]);

    expect((await archivedIds()).toSorted()).toEqual(['first', 'second']);
  });

  it('removes the entries a restore used, in one write', async () => {
    await addToArchive([archived('a'), archived('b'), archived('c')]);
    const writes = countWrites('local');

    await removeFromArchive(['a', 'c']);

    expect(writes).toHaveBeenCalledTimes(1);
    expect(await archivedIds()).toEqual(['b']);
  });

  it('does not rewrite the archive when no id matches', async () => {
    await addToArchive([archived('a')]);
    const writes = countWrites('local');

    await removeFromArchive(['nope']);
    await removeFromArchive([]);

    expect(writes).not.toHaveBeenCalled();
    expect(await archivedIds()).toEqual(['a']);
  });

  it('reads back what was archived, newest first', async () => {
    await addToArchive([archived('old')]);
    await addToArchive([archived('new')]);

    expect((await readArchive()).map((entry) => entry.id)).toEqual(['new', 'old']);
  });

  it('reads an empty archive as an empty list, not as nothing', async () => {
    expect(await readArchive()).toEqual([]);
  });

  it('empties the archive in one write', async () => {
    await addToArchive([archived('a'), archived('b')]);
    const writes = countWrites('local');

    await emptyArchive();

    expect(writes).toHaveBeenCalledTimes(1);
    expect(await archivedIds()).toEqual([]);
  });

  it('writes even when the archive was already empty, so the panel hears the answer', async () => {
    const writes = countWrites('local');

    await emptyArchive();

    expect(writes).toHaveBeenCalledTimes(1);
  });
});

describe('the 6 h cleanup of PLAN.md §10', () => {
  it('drops the archive entries past retention, in one write, and counts them', async () => {
    await addToArchive([
      archived('fresh', { closedAt: NOW - DAY }),
      archived('stale', { closedAt: NOW - 31 * DAY }),
      archived('ancient', { closedAt: NOW - 90 * DAY }),
    ]);
    const writes = countWrites('local');

    expect(await pruneArchive(NOW, DEFAULT_SETTINGS.archiveRetentionDays)).toBe(2);

    expect(writes).toHaveBeenCalledTimes(1);
    expect(await archivedIds()).toEqual(['fresh']);
  });

  it('does not write when every entry is still within retention', async () => {
    await addToArchive([archived('fresh', { closedAt: NOW - DAY })]);
    const writes = countWrites('local');

    expect(await pruneArchive(NOW, 30)).toBe(0);

    expect(writes).not.toHaveBeenCalled();
  });

  it('answers to the moment it is given and not to the clock', async () => {
    await addToArchive([archived('a', { closedAt: NOW })]);

    expect(await pruneArchive(NOW + 31 * DAY, 30)).toBe(1);
    expect(await archivedIds()).toEqual([]);
  });

  it('drops the activity records of tabs that are gone, in one write', async () => {
    await activityItem.setValue({ 1: activity(1), 2: activity(2), 3: activity(3) });
    const writes = countWrites('local');

    expect(await pruneActivity([2])).toBe(2);

    expect(writes).toHaveBeenCalledTimes(1);
    expect(Object.keys(await activityItem.getValue())).toEqual(['2']);
  });

  it('does not write when every record still has its tab', async () => {
    await activityItem.setValue({ 1: activity(1) });
    const writes = countWrites('local');

    expect(await pruneActivity([1])).toBe(0);

    expect(writes).not.toHaveBeenCalled();
  });
});

describe('keeps', () => {
  it('expires in seven days by default', async () => {
    await addKeep('https://example.com/a', NOW);

    expect(await keepsItem.getValue()).toEqual({
      [keepKey('https://example.com/a')]: NOW + DEFAULT_KEEP_MS,
    });
    expect(DEFAULT_KEEP_MS).toBe(7 * DAY);
  });

  it('stores "Sempre" as null', async () => {
    await addKeep('https://example.com/a', NOW, null);

    expect(await keepsItem.getValue()).toEqual({ [keepKey('https://example.com/a')]: null });
  });

  it('keys the URL the way the scoring looks it up', async () => {
    // The tracking parameter, the `www.` and the fragment are not what makes this page
    // another page (DECISIONS, M1.6 `keepKey`).
    await addKeep('https://www.example.com/a?utm_source=x#top', NOW);
    await addKeep('https://example.com/a', NOW, null);

    expect(Object.keys(await keepsItem.getValue())).toEqual([keepKey('https://example.com/a')]);
    expect(await isKept('https://www.example.com/a', NOW + 10 * DAY)).toBe(true);
  });

  it('reads the keeps that still stand, and leaves out the ones that ran out', async () => {
    await addKeep('https://example.com/expired', NOW - 8 * DAY);
    await addKeep('https://example.com/standing', NOW);
    await addKeep('https://example.com/forever', NOW, null);

    expect(await readKeeps(NOW)).toEqual({
      [keepKey('https://example.com/standing')]: NOW + DEFAULT_KEEP_MS,
      [keepKey('https://example.com/forever')]: null,
    });
  });

  it('reading never writes, so an expired keep is still there to be collected', async () => {
    await addKeep('https://example.com/a', NOW - 8 * DAY);
    const writes = countWrites('local');

    await readKeeps(NOW);
    await isKept('https://example.com/a', NOW);

    expect(writes).not.toHaveBeenCalled();
    expect(Object.keys(await keepsItem.getValue())).toHaveLength(1);
  });

  it('holds until the last millisecond and not one more', async () => {
    await addKeep('https://example.com/a', NOW, HOUR);

    expect(await isKept('https://example.com/a', NOW + HOUR - 1)).toBe(true);
    expect(await isKept('https://example.com/a', NOW + HOUR)).toBe(false);
    expect(await isKept('https://example.com/a', NOW + HOUR + MINUTE)).toBe(false);
  });

  it('says nothing is kept for a URL nobody kept', async () => {
    expect(await isKept('https://example.com/a', NOW)).toBe(false);
  });

  it('forgets a keep on demand, expired or not', async () => {
    await addKeep('https://example.com/a', NOW, null);

    await removeKeep('https://www.example.com/a');

    expect(await keepsItem.getValue()).toEqual({});
  });

  it('does not write when there is no keep to forget', async () => {
    const writes = countWrites('local');

    await removeKeep('https://example.com/a');

    expect(writes).not.toHaveBeenCalled();
  });

  it('collects the expired keeps in one write and says how many went', async () => {
    await addKeep('https://example.com/one', NOW - 8 * DAY);
    await addKeep('https://example.com/two', NOW - 9 * DAY);
    await addKeep('https://example.com/standing', NOW);
    await addKeep('https://example.com/forever', NOW, null);
    const writes = countWrites('local');

    expect(await pruneKeeps(NOW)).toBe(2);

    expect(writes).toHaveBeenCalledTimes(1);
    expect(Object.keys(await keepsItem.getValue()).toSorted()).toEqual(
      [keepKey('https://example.com/forever'), keepKey('https://example.com/standing')].toSorted(),
    );
  });

  it('does not write when nothing has expired', async () => {
    await addKeep('https://example.com/a', NOW);
    const writes = countWrites('local');

    expect(await pruneKeeps(NOW)).toBe(0);

    expect(writes).not.toHaveBeenCalled();
  });
});

describe("the guard's exemptions", () => {
  it('lasts ten seconds by default, and not a millisecond more', async () => {
    await addExemption({ tabId: 5 }, NOW);

    expect(EXEMPTION_TTL_MS).toBe(10_000);
    expect(await isExempt({ tabId: 5 }, NOW + EXEMPTION_TTL_MS - 1)).toBe(true);
    expect(await isExempt({ tabId: 5 }, NOW + EXEMPTION_TTL_MS)).toBe(false);
  });

  it('honours a TTL the caller chose', async () => {
    await addExemption({ tabId: 5 }, NOW, MINUTE);

    expect(await isExempt({ tabId: 5 }, NOW + 30_000)).toBe(true);
    expect(await isExempt({ tabId: 5 }, NOW + 2 * MINUTE)).toBe(false);
  });

  it('recognises a restored tab by URL, since it comes back with another id', async () => {
    await addExemption({ tabId: 5, url: 'https://www.example.com/a?utm_source=x' }, NOW);

    expect(await isExempt({ tabId: 99, url: 'https://example.com/a' }, NOW)).toBe(true);
    expect(await isExempt({ tabId: 99, url: 'https://example.com/other' }, NOW)).toBe(false);
  });

  it('leaves alone a tab nobody exempted', async () => {
    await addExemption({ tabId: 5, url: 'https://example.com/a' }, NOW);

    expect(await isExempt({ tabId: 6, url: 'https://example.com/b' }, NOW)).toBe(false);
    expect(await isExempt({}, NOW)).toBe(false);
  });

  it('matches nothing when the exemption names neither a tab nor a URL', async () => {
    await addExemption({}, NOW);

    expect(await isExempt({ tabId: 5, url: 'https://example.com/a' }, NOW)).toBe(false);
  });

  it('reads the exemptions that still stand', async () => {
    await addExemption({ tabId: 1 }, NOW - MINUTE);
    await addExemption({ tabId: 2 }, NOW);

    expect(await readExemptions(NOW)).toEqual([{ tabId: 2, until: NOW + EXEMPTION_TTL_MS }]);
  });

  it('drops the ones that ran out as it adds a new one, so the set cannot grow', async () => {
    await addExemption({ tabId: 1 }, NOW - MINUTE);
    await addExemption({ tabId: 2 }, NOW - MINUTE);

    await addExemption({ tabId: 3 }, NOW);

    expect((await guardStateItem.getValue()).exemptions).toEqual([
      { tabId: 3, until: NOW + EXEMPTION_TTL_MS },
    ]);
  });

  it('keeps the rest of the guard state as it was', async () => {
    await guardStateItem.setValue({
      exemptions: [],
      pausedUntil: NOW + HOUR,
      resumeMode: 'auto',
      lastAutoClosedId: 'a1',
    });

    await addExemption({ tabId: 5 }, NOW);

    expect(await guardStateItem.getValue()).toEqual({
      exemptions: [{ tabId: 5, until: NOW + EXEMPTION_TTL_MS }],
      pausedUntil: NOW + HOUR,
      resumeMode: 'auto',
      lastAutoClosedId: 'a1',
    });
  });

  it('loses no exemption when two tabs are restored at the same moment', async () => {
    await Promise.all([addExemption({ tabId: 1 }, NOW), addExemption({ tabId: 2 }, NOW)]);

    expect(await readExemptions(NOW)).toHaveLength(2);
  });
});
