/**
 * Everything the extension persists, PLAN.md §10.
 *
 * One module, one item per key, each typed, versioned and with a default, so that no
 * caller invents a key or a shape. `storage.local` for what must survive a restart,
 * `storage.session` for the guard's volatile state, which PLAN.md §10 wants lost on
 * restart. The 10 MB `local` quota is enough: no `unlimitedStorage`.
 *
 * **Adding a migration.** Every item starts at `version: 1`. When a stored shape changes,
 * bump that item's version and add the function that turns the old value into the new one:
 *
 * ```ts
 * defineVersioned<Settings>('local:settings', DEFAULT_SETTINGS, {
 *   version: 2,
 *   migrations: { 2: (old) => ({ ...(old as SettingsV1), newField: 0 }) },
 * });
 * ```
 *
 * WXT records the stored version in the item's metadata and runs the missing migrations
 * in order when the extension updates, so a user who skips a release is migrated step by
 * step.
 *
 * **The value you read is not yours to mutate.** The fallbacks are shared objects, so
 * every write goes through the helpers below, which build a new value instead of editing
 * the one they read.
 */

import { storage } from 'wxt/utils/storage';
import type { StorageItemKey } from 'wxt/utils/storage';

import { pruneArchiveEntries, sweepActivity } from '../core/archive';
import type { GroupProposal } from '../core/cluster';
import { keepKey } from '../core/scoring';
import type {
  ActivityStore,
  ArchivedTab,
  ForegroundPeriod,
  GuardExemption,
  GuardMode,
  GuardState,
  Keeps,
  Settings,
} from '../core/types';
import {
  ARCHIVE_CAP,
  DEFAULT_GUARD_SETTINGS,
  DEFAULT_GUARD_STATE,
  DEFAULT_KEEP_MS,
  DEFAULT_MATCH_OPTIONS,
  DEFAULT_SETTINGS,
  EXEMPTION_TTL_MS,
} from '../core/types';

/** How an item declares a shape change. See the module comment. */
interface VersionedOptions {
  readonly version: number;
  readonly migrations: Record<number, (oldValue: unknown) => unknown>;
}

function defineVersioned<T>(key: StorageItemKey, fallback: T, options?: VersionedOptions) {
  return storage.defineItem<T>(key, {
    fallback,
    version: options?.version ?? 1,
    // Migrations make WXT read the item as soon as it is defined, to compare the stored
    // version with this one. At version 1 there is nothing it could migrate from, so
    // there are none and the panel starts without seven extra reads. WXT reads an item
    // with no recorded version as version 1, which is the value the first migration
    // added here will be handed.
    migrations: options?.migrations,
  });
}

/** `Record<tabId, TabActivity>`, what the tracker remembers (PLAN.md §6.1). */
export const activityItem = defineVersioned<ActivityStore>('local:activity', {});

/** Normalized URL → when the keep runs out, `null` for "Sempre". */
export const keepsItem = defineVersioned<Keeps>('local:keeps', {});

/** "Siti protetti" (PLAN.md §4.6): domain patterns such as `*.atlassian.net`. */
export const protectedDomainsItem = defineVersioned<string[]>('local:protectedDomains', []);

/** The closed tabs, newest first, capped at `ARCHIVE_CAP`. Write with `addToArchive`. */
export const archiveItem = defineVersioned<ArchivedTab[]>('local:archive', []);

/** Read with `readSettings`, which fills in the keys an older release did not store. */
export const settingsItem = defineVersioned<Settings>('local:settings', DEFAULT_SETTINGS);

/** The duplicate whitelist, as raw patterns, exactly as the user wrote them. */
export const duplicateWhitelistItem = defineVersioned<string[]>('local:duplicateWhitelist', []);

/**
 * Whether the first-run screen of PLAN.md §17 has been answered.
 *
 * An item of its own and not a setting: it is not something §4.6 offers to change, and keeping it
 * out of `Settings` leaves "the stored settings are the user's choices" true (docs/DECISIONS.md
 * M6.2). `false` for a profile that has never seen it, which is what a fresh install reads.
 */
export const onboardedItem = defineVersioned<boolean>('local:onboarded', false);

/**
 * Which tab the foreground clock is running for, `null` when no window has focus.
 *
 * `storage.session`, because a period belongs to this run of the browser: it must outlive
 * the service worker (invariant 6) and must not outlive the browser, or a restart would
 * charge a tab for the night.
 */
export const foregroundItem = defineVersioned<ForegroundPeriod | null>('session:foreground', null);

/** The guard's volatile state. `storage.session` is cleared when the browser restarts. */
export const guardStateItem = defineVersioned<GuardState>('session:guardState', {
  ...DEFAULT_GUARD_STATE,
  exemptions: [],
});

/**
 * The most recent on-device AI window proposal from the side panel or background autopilot,
 * kept for this browser session so background autopilot preserves AI topic windows instead of
 * overwriting them with the deterministic heuristic.
 */
export const aiProposalItem = defineVersioned<GroupProposal | null>('session:aiProposal', null);

/** Content signature (tab IDs + hosts + titles) that `aiProposalItem` was generated for. */
export const aiProposalSignatureItem = defineVersioned<string>('session:aiProposalSignature', '');

/**
 * Timestamp (ms epoch) until which an on-device AI prompt is currently running in either the
 * side panel or background service worker, preventing both contexts from competing on the GPU.
 */
export const aiBusyUntilItem = defineVersioned<number>('session:aiBusyUntil', 0);

/**
 * Timestamp (ms epoch) until which background `autoOrganize` pauses after the user clicks
 * Undo on a window organization, so autopilot does not immediately re-organize the tabs
 * without touching the user's persisted `autoOrganize` setting.
 */
export const organizeSnoozeUntilItem = defineVersioned<number>('session:organizeSnoozeUntil', 0);

/**
 * One read-modify-write at a time per key.
 *
 * Two closes a few milliseconds apart would otherwise both read the same archive and the
 * second write would lose the first one's entries. The extension runs in several contexts
 * (PLAN.md §5.2), so this only orders the writes made by one of them; it is what makes
 * "one write per action" safe for the actions a single context can start at once.
 */
const queues = new Map<string, Promise<unknown>>();

function serialize<T>(key: StorageItemKey, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  // `action` runs whether the operation before it resolved or rejected: one failed write
  // must not block the key forever.
  const next = previous.then(action, action);
  queues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * The whole settings object, with every default filled in.
 *
 * A release that adds a setting finds the objects older releases stored without it, so
 * the defaults are merged in on every read rather than through a migration per field.
 * The result is a fresh object: the caller may edit it and hand it back to `saveSettings`.
 */
export async function readSettings(): Promise<Settings> {
  const stored = await settingsItem.getValue();
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    guard: { ...DEFAULT_GUARD_SETTINGS, ...stored.guard },
    match: { ...DEFAULT_MATCH_OPTIONS, ...stored.match },
  };
}

/** Stores the settings as one value, serialized so rapid updates never clobber each other. */
export function saveSettings(next: Settings): Promise<void> {
  return serialize(settingsItem.key, async () => {
    await settingsItem.setValue(next);
  });
}

/**
 * Serialized read-modify-write for `local:settings`: two toggles clicked back to back
 * (e.g. "By topic" and "Use the on-device AI") always observe each other's write.
 */
export function updateSettings(change: (current: Settings) => Settings): Promise<Settings> {
  return serialize(settingsItem.key, async () => {
    const current = await readSettings();
    const next = change(current);
    if (next !== current) await settingsItem.setValue(next);
    return next;
  });
}

/**
 * Archives a whole action's tabs in **one** write (PLAN.md §10), newest first.
 *
 * The batch keeps the order it was given and goes in front of everything older. Over
 * `ARCHIVE_CAP` the oldest entries are dropped, which is the FIFO cap of §10.
 */
export function addToArchive(entries: readonly ArchivedTab[]): Promise<void> {
  return serialize(archiveItem.key, async () => {
    if (entries.length === 0) return;
    const stored = await archiveItem.getValue();
    await archiveItem.setValue([...entries, ...stored].slice(0, ARCHIVE_CAP));
  });
}

/** The whole archive, newest first: what the Archive view lists (PLAN.md §4.5). */
export function readArchive(): Promise<readonly ArchivedTab[]> {
  return archiveItem.getValue();
}

/** Removes entries by `ArchivedTab.id`, in one write: a restore ends here (PLAN.md §9). */
export function removeFromArchive(ids: readonly string[]): Promise<void> {
  return serialize(archiveItem.key, async () => {
    if (ids.length === 0) return;
    const wanted = new Set(ids);
    const stored = await archiveItem.getValue();
    const kept = stored.filter((entry) => !wanted.has(entry.id));
    // Nothing matched: do not rewrite the same array.
    if (kept.length === stored.length) return;
    await archiveItem.setValue(kept);
  });
}

/**
 * "Svuota archivio" (PLAN.md §4.5), in one write.
 *
 * It writes even when the archive is already empty, unlike the helpers above: the view
 * asked a question and got an answer, and the `onChanged` that follows is what tells the
 * panel the answer was carried out.
 */
export function emptyArchive(): Promise<void> {
  return serialize(archiveItem.key, async () => {
    await archiveItem.setValue([]);
  });
}

/**
 * Drops the archive entries past retention or past the cap, in one write, and says how
 * many went.
 *
 * The `archive` third of the 6 h cleanup of PLAN.md §10. What to keep is
 * `pruneArchiveEntries`' answer: this only reads, writes and counts.
 */
export function pruneArchive(now: number, retentionDays: number): Promise<number> {
  return serialize(archiveItem.key, async () => {
    const stored = await archiveItem.getValue();
    const { kept, dropped } = pruneArchiveEntries(stored, { now, retentionDays });
    if (dropped > 0) await archiveItem.setValue([...kept]);
    return dropped;
  });
}

/**
 * Drops the activity records of tabs that are no longer open, in one write, and says how
 * many went.
 *
 * The `activity` third of the 6 h cleanup of PLAN.md §10. `openTabIds` comes from the
 * caller rather than from `tabs.query` here, so this stays one read and one write of one
 * key, and the caller decides the moment both halves describe.
 */
export function pruneActivity(openTabIds: readonly number[]): Promise<number> {
  return serialize(activityItem.key, async () => {
    const stored = await activityItem.getValue();
    const { kept, dropped } = sweepActivity(stored, openTabIds);
    if (dropped > 0) await activityItem.setValue(kept);
    return dropped;
  });
}

/** A keep is over when its moment has come: the scoring reads it the same way. */
function isExpired(until: number | null, now: number): boolean {
  return until !== null && until <= now;
}

/**
 * "Mantieni" (PLAN.md §9): `durationMs` defaults to the 7 days of §6.4, `null` is "Sempre".
 *
 * The URL is keyed with `keepKey`, never with the user's comparison options, so changing
 * one of those settings cannot silently forget a keep (DECISIONS, M1.6).
 */
export function addKeep(
  url: string,
  now: number,
  durationMs: number | null = DEFAULT_KEEP_MS,
): Promise<void> {
  return serialize(keepsItem.key, async () => {
    const stored = await keepsItem.getValue();
    const until = durationMs === null ? null : now + durationMs;
    await keepsItem.setValue({ ...stored, [keepKey(url)]: until });
  });
}

/** Forgets a keep, whether it had expired or not. */
export function removeKeep(url: string): Promise<void> {
  return serialize(keepsItem.key, async () => {
    const key = keepKey(url);
    const stored = await keepsItem.getValue();
    if (!(key in stored)) return;
    const next = { ...stored };
    delete next[key];
    await keepsItem.setValue(next);
  });
}

/** The keeps still standing at `now`. A read never writes: `pruneKeeps` does that. */
export async function readKeeps(now: number): Promise<Keeps> {
  const stored = await keepsItem.getValue();
  const active: Keeps = {};
  for (const [key, until] of Object.entries(stored)) {
    if (!isExpired(until, now)) active[key] = until;
  }
  return active;
}

export async function isKept(url: string, now: number): Promise<boolean> {
  const stored = await keepsItem.getValue();
  const key = keepKey(url);
  return key in stored && !isExpired(stored[key] ?? null, now);
}

/**
 * Drops the expired keeps in one write and says how many went.
 *
 * The `keeps` third of the 6 h cleanup of PLAN.md §10, called — with `pruneArchive` and
 * `pruneActivity` — from `entrypoints/background/cleanup.ts`.
 */
export function pruneKeeps(now: number): Promise<number> {
  return serialize(keepsItem.key, async () => {
    const stored = await keepsItem.getValue();
    const next: Keeps = {};
    for (const [key, until] of Object.entries(stored)) {
      if (!isExpired(until, now)) next[key] = until;
    }
    const dropped = Object.keys(stored).length - Object.keys(next).length;
    if (dropped > 0) await keepsItem.setValue(next);
    return dropped;
  });
}

/** A tab the guard must leave alone, by id or by URL (PLAN.md §8.6). */
export type ExemptionTarget = Pick<GuardExemption, 'tabId' | 'url'>;

/**
 * Exempts a whole action's tabs in **one** write, for `EXEMPTION_TTL_MS` by default
 * (PLAN.md §8.6).
 *
 * An undo of twenty tabs is one action and must cost one write, like the archive's
 * (PLAN.md §10). The same write drops the exemptions that have already run out, so the
 * set cannot grow without an alarm to collect it.
 */
export function addExemptions(
  targets: readonly ExemptionTarget[],
  now: number,
  ttlMs: number = EXEMPTION_TTL_MS,
): Promise<void> {
  return serialize(guardStateItem.key, async () => {
    if (targets.length === 0) return;
    const state = await guardStateItem.getValue();
    await guardStateItem.setValue({
      ...state,
      exemptions: [
        ...activeOf(state.exemptions, now),
        ...targets.map((target) => ({ ...target, until: now + ttlMs })),
      ],
    });
  });
}

/** Exempts one tab the extension itself opened or restored (PLAN.md §8.6). */
export function addExemption(
  target: ExemptionTarget,
  now: number,
  ttlMs: number = EXEMPTION_TTL_MS,
): Promise<void> {
  return addExemptions([target], now, ttlMs);
}

/**
 * "Protect site" (PLAN.md §9): the domain joins "Siti protetti", once.
 *
 * Stored trimmed and lower-cased, which is how `core/scoring.ts` compares the list
 * against a host; a domain already in it is not written again, so pressing the row's menu
 * item twice costs one write.
 */
export function addProtectedDomain(domain: string): Promise<void> {
  return serialize(protectedDomainsItem.key, async () => {
    const wanted = domain.trim().toLowerCase();
    if (wanted === '') return;
    const stored = await protectedDomainsItem.getValue();
    if (stored.some((entry) => entry.trim().toLowerCase() === wanted)) return;
    await protectedDomainsItem.setValue([...stored, wanted]);
  });
}

/**
 * "Consenti duplicati per questo sito" (PLAN.md §4.1): one pattern joins the duplicate
 * whitelist, once.
 *
 * Stored **exactly as it was given**, unlike a protected domain: a whitelist line is
 * matched case-sensitively and may be a regular expression (`core/patterns.ts`), so
 * lower-casing it here would change what it matches. Only the surrounding spaces go, and
 * a pattern already in the list is not written again — pressing the menu item twice on
 * the same site costs one write.
 */
export function addDuplicateWhitelistPattern(pattern: string): Promise<void> {
  return serialize(duplicateWhitelistItem.key, async () => {
    const wanted = pattern.trim();
    if (wanted === '') return;
    const stored = await duplicateWhitelistItem.getValue();
    if (stored.some((entry) => entry.trim() === wanted)) return;
    await duplicateWhitelistItem.setValue([...stored, wanted]);
  });
}

function activeOf(exemptions: readonly GuardExemption[], now: number): GuardExemption[] {
  return exemptions.filter((exemption) => exemption.until > now);
}

/**
 * The guard's whole volatile state: the pause, the grace period, the exemptions and the
 * last automatic close, in one read.
 *
 * The live guard needs all four on every event it evaluates (PLAN.md §8.2), and they are
 * one stored object, so asking for them separately would be four reads for one answer.
 */
export function readGuardState(): Promise<GuardState> {
  return guardStateItem.getValue();
}

/**
 * "In pausa" (PLAN.md §8.1): nothing closes until `until`, and the mode the user was in is
 * written down next to it.
 *
 * **The stored mode is not touched.** Writing `off` into the settings and putting the old
 * value back later would be a pause that outlives the browser: `storage.session` is cleared
 * by a restart while `storage.local` is not, so a restart during a pause would leave the
 * guard off for good, with nothing left to say why. The pause is therefore a deadline the
 * guard reads, and `resumeMode` is only what the icon menu shows ("torna a: …").
 */
export function pauseGuard(until: number, resumeMode: GuardMode): Promise<void> {
  return serialize(guardStateItem.key, async () => {
    const state = await guardStateItem.getValue();
    await guardStateItem.setValue({ ...state, pausedUntil: until, resumeMode });
  });
}

/** The end of a pause, whether the alarm brought it or the user did (PLAN.md §8.1). */
export function resumeGuard(): Promise<void> {
  return serialize(guardStateItem.key, async () => {
    const state = await guardStateItem.getValue();
    const next = { ...state };
    delete next.pausedUntil;
    delete next.resumeMode;
    await guardStateItem.setValue(next);
  });
}

/** The start-up grace period of PLAN.md §8.6 begins: no automatic close before `until`. */
export function startGuardGrace(until: number): Promise<void> {
  return serialize(guardStateItem.key, async () => {
    const state = await guardStateItem.getValue();
    await guardStateItem.setValue({ ...state, graceUntil: until });
  });
}

/**
 * Which archive entry the last automatic close wrote, for "Riapri l'ultimo duplicato
 * chiuso" (PLAN.md §8.5).
 *
 * Only the guard knows which of the entries in the archive was its own, and only the one
 * most recent matters: the menu item reopens the last tab, not a history.
 */
export function rememberAutoClosed(archiveId: string): Promise<void> {
  return serialize(guardStateItem.key, async () => {
    const state = await guardStateItem.getValue();
    await guardStateItem.setValue({ ...state, lastAutoClosedId: archiveId });
  });
}

/** The exemptions still standing at `now`. */
export async function readExemptions(now: number): Promise<GuardExemption[]> {
  const state = await guardStateItem.getValue();
  return activeOf(state.exemptions, now);
}

/**
 * Whether the guard must leave this tab alone.
 *
 * The id and the URL are two ways of recognising the same tab, so either is enough: a
 * restored tab gets a new id, and a tab that navigated keeps its id. URLs are compared
 * with `keepKey`, like every other store keyed by URL.
 */
export async function isExempt(target: ExemptionTarget, now: number): Promise<boolean> {
  const exemptions = await readExemptions(now);
  const url = target.url === undefined ? undefined : keepKey(target.url);
  return exemptions.some(
    (exemption) =>
      (exemption.tabId !== undefined && exemption.tabId === target.tabId) ||
      (exemption.url !== undefined && url !== undefined && keepKey(exemption.url) === url),
  );
}
