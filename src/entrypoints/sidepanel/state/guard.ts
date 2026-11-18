/**
 * The duplicate guard, as the panel sees and changes it (PLAN.md §4.2, §8.3, §8.7).
 *
 * PLAN.md §5.2 again: the panel sends the background no messages. So a change of mode is a
 * write to `local:settings` — the background listens on `storage.onChanged` and drops its cache
 * — a pause is a write to `session:guardState`, and "Chiudi tutti i duplicati" is the panel's
 * own `resolveAllDuplicates` plus `closeTabs`, the same pure decision the background makes.
 *
 * The guard's state lives in `storage.session`, which `state/tabs.ts` deliberately does not
 * watch (the Declutter list does not read it), so the chip follows it here.
 */

import { computed, signal } from '@preact/signals';

import type { DuplicateSweep } from '@/core/duplicate-guard';
import { resolveAllDuplicates } from '@/core/duplicate-guard';
import { tabUrl } from '@/core/duplicates';
import { compile } from '@/core/patterns';
import type {
  GuardMode,
  GuardSettings,
  GuardState,
  MatchOptions,
  Settings,
  TabInfo,
} from '@/core/types';
import { DEFAULT_GUARD_SETTINGS, DEFAULT_GUARD_STATE, DEFAULT_MATCH_OPTIONS } from '@/core/types';
import {
  duplicateWhitelistItem,
  guardStateItem,
  pauseGuard,
  readArchive,
  readGuardState,
  readSettings,
  resumeGuard,
  updateSettings,
} from '@/platform/storage';
import { closeTabs } from '@/platform/tabs';
import type { GuardStatus } from '../guard-settings';
import { applyLocalSettings, panelData } from './tabs';
import { rememberClose } from './undo';

/** How long §4.2's counter stays on screen. */
export const NOTICE_MS = 5_000;

/** The menu's three pauses (§4.2). */
export const PAUSE_15_MIN_MS = 15 * 60_000;
export const PAUSE_1_HOUR_MS = 60 * 60_000;

/**
 * "Fino al riavvio" is a deadline a year out and no alarm: `storage.session` is emptied by the
 * restart itself, so the pause cannot outlive it (docs/DECISIONS.md M3b.2).
 */
export const PAUSE_UNTIL_RESTART_MS = 365 * 24 * 60 * 60_000;

/** `session:guardState` → `guardState`, the name `onChanged` reports it under. */
const GUARD_STATE_KEY = guardStateItem.key.slice(guardStateItem.key.indexOf(':') + 1);

/** What the background has written about the guard, or the defaults until the first read. */
const guardState = signal<GuardState>({ ...DEFAULT_GUARD_STATE, exemptions: [] });

export const guardSettings = computed<GuardSettings>(
  () => panelData.value?.settings.guard ?? DEFAULT_GUARD_SETTINGS,
);

export const matchOptions = computed<MatchOptions>(
  () => panelData.value?.settings.match ?? DEFAULT_MATCH_OPTIONS,
);

/** The whitelist as the user wrote it, which is what the editor of §8.3 shows. */
export const whitelist = computed<readonly string[]>(() => panelData.value?.whitelist ?? []);

/** What the chip reads: the mode, and the pause if there is one. */
export const guardStatus = computed<GuardStatus>(() => ({
  mode: guardSettings.value.mode,
  pausedUntil: guardState.value.pausedUntil,
}));

/**
 * Every close "Chiudi tutti i duplicati" would make, with the tab each duplicate loses to.
 *
 * The same pure function the background uses on every event, so the count in the menu and the
 * closes it performs are one definition of "duplicate" (invariant 9). `pausedUntil` and
 * `autoClosesAllowedFrom` are left out on purpose: §8.7 works in OFF and in "Solo avvisi" too,
 * because the gesture is the user's.
 *
 * `navigatedTabIds` is the background's index and the panel has no equivalent, so the only rule
 * that softens here is "keep the tab the user navigated" (docs/DECISIONS.md M3b.4).
 */
export const duplicateSweeps = computed<readonly DuplicateSweep[]>(() => {
  const data = panelData.value;
  if (data === null) return [];
  const createdAt: Record<number, number> = {};
  for (const tab of data.tabs) {
    const record = data.activity[tab.id];
    if (record !== undefined) createdAt[tab.id] = record.createdAt;
  }
  return resolveAllDuplicates(data.tabs, {
    now: data.at,
    settings: data.settings.guard,
    match: data.settings.match,
    createdAt,
    focusedWindowId: data.focusedWindowId,
    isWhitelisted: compile(data.whitelist).match,
    ownOrigin: data.ownOrigin,
    exemptions: guardState.value.exemptions,
  });
});

/** The "(N)" of the menu item and of Declutter's "Chiudi tutti". */
export const duplicateCount = computed(() => duplicateSweeps.value.length);

/**
 * How many duplicates the guard closed on its own today, while §4.2's counter is up, and `null`
 * when it is not.
 */
export const closedToday = signal<number | null>(null);

/** Changes the mode (§8.3). The background hears about it through `storage.onChanged`. */
export function setGuardMode(mode: GuardMode): void {
  run(update((settings) => ({ ...settings, guard: { ...settings.guard, mode } })));
}

export function setGuardOption<K extends keyof GuardSettings>(
  key: K,
  value: GuardSettings[K],
): void {
  run(update((settings) => ({ ...settings, guard: { ...settings.guard, [key]: value } })));
}

export function setMatchOption<K extends keyof MatchOptions>(key: K, value: MatchOptions[K]): void {
  run(update((settings) => ({ ...settings, match: { ...settings.match, [key]: value } })));
}

/** Replaces the whitelist with what the editor holds (§8.3). */
export function saveWhitelist(patterns: readonly string[]): Promise<void> {
  return duplicateWhitelistItem.setValue([...patterns]);
}

/**
 * Pauses the guard, holding the mode to come back to rather than rewriting it (§8.5).
 *
 * No `alarms.create` here: the panel cannot be trusted to be open when the pause ends, and it
 * does not need to be — every guard decision reads `pausedUntil` and compares it with the clock
 * (docs/DECISIONS.md M3b.4).
 */
export function pauseGuardFor(ms: number): void {
  run(pause(ms));
}

export function resumeGuardNow(): void {
  run(resume());
}

/** §8.7, from the chip's menu or from Declutter's "Duplicati" section. */
export function closeAllDuplicates(): void {
  const data = panelData.value;
  const sweeps = duplicateSweeps.value;
  if (data === null || sweeps.length === 0) return;

  const byId = new Map(data.tabs.map((tab) => [tab.id, tab]));
  const targets: TabInfo[] = [];
  /** For the archive's "duplicato di…", which is what makes a `duplicate-*` entry readable. */
  const duplicateOfUrl = new Map<number, string>();
  for (const sweep of sweeps) {
    const target = byId.get(sweep.closeTabId);
    const keep = byId.get(sweep.keepTabId);
    if (target === undefined || keep === undefined) continue;
    targets.push(target);
    duplicateOfUrl.set(target.id, tabUrl(keep));
  }
  if (targets.length === 0) return;

  run(sweep(targets, duplicateOfUrl));
}

export interface GuardStateOptions {
  /** The clock, injected so the tests can be exact. */
  readonly now?: () => number;
  /** How long §4.2's counter stays up. Defaults to `NOTICE_MS`. */
  readonly noticeMs?: number;
}

export interface GuardStateHandle {
  /** Reads the guard's state now. */
  refresh(): Promise<void>;
  stop(): void;
}

/**
 * Starts following the guard's state.
 *
 * The counter of §4.2 hangs off `lastAutoClosedId`, which the background rewrites on every
 * automatic close: a change of it is the one event that means "a duplicate was just closed", so
 * the archive is read once then and never polled. The first read only records where the counter
 * starts — opening the panel is not a close.
 */
export function startGuardState(options: GuardStateOptions = {}): GuardStateHandle {
  const now = options.now ?? Date.now;
  const noticeMs = options.noticeMs ?? NOTICE_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let seen: string | undefined;
  let first = true;

  async function refresh(): Promise<void> {
    const state = await readGuardState();
    guardState.value = state;
    const closed = state.lastAutoClosedId;
    if (first) {
      first = false;
      seen = closed;
      return;
    }
    if (closed === undefined || closed === seen) return;
    seen = closed;
    await notice();
  }

  /** "1 duplicato chiuso oggi", counted from the archive the close has just been added to. */
  async function notice(): Promise<void> {
    const at = now();
    const entries = await readArchive();
    const today = entries.filter(
      (entry) => entry.reason === 'duplicate-auto' && sameDay(entry.closedAt, at),
    ).length;
    // At least one: the close that woke us is in the archive, whatever the clock says.
    closedToday.value = Math.max(1, today);
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      closedToday.value = null;
    }, noticeMs);
  }

  browser.storage.onChanged.addListener((changes: Record<string, unknown>, area: string) => {
    if (area !== 'session') return;
    if (GUARD_STATE_KEY in changes) void refresh().catch(failed);
  });

  void refresh().catch(failed);

  return {
    refresh,
    stop: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** Serialized read-change-write: the panel never writes a settings snapshot it took earlier. */
async function update(change: (settings: Settings) => Settings): Promise<void> {
  const next = await updateSettings(change);
  applyLocalSettings(next);
}

async function pause(ms: number): Promise<void> {
  const settings = await readSettings();
  await pauseGuard(Date.now() + ms, settings.guard.mode);
}

async function resume(): Promise<void> {
  const state = await readGuardState();
  await resumeGuard();
  const mode = state.resumeMode;
  if (mode !== undefined)
    await update((settings) => ({ ...settings, guard: { ...settings.guard, mode } }));
}

async function sweep(
  targets: readonly TabInfo[],
  duplicateOfUrl: ReadonlyMap<number, string>,
): Promise<void> {
  const entries = await closeTabs(targets, Date.now(), {
    reason: 'duplicate-manual',
    duplicateOfUrl,
  });
  // No window can empty here: a duplicate always has the tab it duplicates left open.
  rememberClose({ entries, windows: 0 });
}

/** Local time, which is the day the user means. */
function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function run(work: Promise<unknown>): void {
  void work.catch(failed);
}

function failed(error: unknown): void {
  console.error('TabDeclutter: guard', error);
}
