/**
 * What the Archive view knows, and what its buttons do (PLAN.md §4.5).
 *
 * The same shape as `state/tabs.ts`, for the same reasons: one snapshot with the moment
 * it was taken inside it, so the date filter and the "chiusa 2 giorni fa" of every row
 * can never describe two different moments; `storage.onChanged` to follow the background;
 * a 150 ms debounce, because one restore writes the archive once but Chrome may report it
 * more than once.
 *
 * **Read when the view is open, not when the panel is.** Unlike the Declutter list, which
 * the panel opens on, the archive is up to 1000 entries nobody has asked for — so
 * `startArchiveState` is called by the view's `useEffect` and its `stop()` takes the
 * listener away again (PLAN.md §11, docs/DECISIONS.md).
 *
 * **The actions live here and not in `commands.ts`.** That module is about closing tabs,
 * which has safeguards, a confirmation and an undo; these four are the archive's own, and
 * three of them cannot touch a tab at all. The one that can — a restore — is
 * `platform/tabs.ts`'s `restoreTabs`, the very function "Annulla" uses, so §9 has one
 * definition of what bringing a tab back means.
 */

import { computed, signal } from '@preact/signals';

import type { ArchiveFilter, ArchiveOrigin, ArchiveWhen } from '@/core/archive';
import { ANY_ARCHIVE, exportArchive, filterArchive } from '@/core/archive';
import type { ArchivedTab } from '@/core/types';
import { archiveItem, emptyArchive, readArchive, removeFromArchive } from '@/platform/storage';
import { restoreTabs } from '@/platform/tabs';

/** PLAN.md §5.2's debounce, the same the Declutter list uses. */
const RELOAD_DEBOUNCE_MS = 150;

/** `local:archive` → `archive`: the key the browser reports a change under. */
const ARCHIVE_KEY = archiveItem.key.slice(archiveItem.key.indexOf(':') + 1);

/** The stored archive and the moment it was read. */
export interface ArchiveData {
  readonly entries: readonly ArchivedTab[];
  readonly at: number;
}

/** The snapshot, or `null` until the first read comes back. */
export const archiveData = signal<ArchiveData | null>(null);

/** §4.5's search box and its two filters, as the view has them set. */
export const archiveFilter = signal<ArchiveFilter>(ANY_ARCHIVE);

/** Which entries are ticked, by `ArchivedTab.id` — a string, unlike a tab's id. */
const picked = signal<ReadonlySet<string>>(new Set());

export const archiveEntries = computed<readonly ArchivedTab[]>(
  () => archiveData.value?.entries ?? [],
);

/** Whether the archive has ever been read: before that the view shows nothing at all. */
export const archiveLoaded = computed(() => archiveData.value !== null);

/** What the list draws: the filter and the search, over the snapshot's own moment. */
export const shownArchive = computed<readonly ArchivedTab[]>(() => {
  const data = archiveData.value;
  if (data === null) return [];
  return filterArchive(data.entries, archiveFilter.value, data.at);
});

/**
 * The ticked entries that are still in the list, in the list's order.
 *
 * Filtered by what is shown, so a narrowing search cannot leave a "Ripristina 12" that
 * acts on rows the user can no longer see.
 */
export const pickedArchive = computed<readonly ArchivedTab[]>(() =>
  shownArchive.value.filter((entry) => picked.value.has(entry.id)),
);

export const hasArchiveSelection = computed(() => pickedArchive.value.length > 0);

/** Whether every shown row is ticked: what the "Seleziona tutti" button answers. */
export const allArchiveSelected = computed(
  () => shownArchive.value.length > 0 && pickedArchive.value.length === shownArchive.value.length,
);

/**
 * One computed per entry, so ticking a row re-renders that row (PLAN.md §11). The cache
 * lives for the panel's lifetime, which is at most the 1000 entries of the cap.
 */
const pickedSignals = new Map<string, ReturnType<typeof computed<boolean>>>();

export function archivePickedSignal(id: string) {
  const existing = pickedSignals.get(id);
  if (existing !== undefined) return existing;
  const created = computed(() => picked.value.has(id));
  pickedSignals.set(id, created);
  return created;
}

export function toggleArchivePicked(id: string): void {
  const next = new Set(picked.value);
  if (!next.delete(id)) next.add(id);
  picked.value = next;
}

/** Ticks every shown row, or unticks them when they are all ticked already. */
export function toggleArchiveAll(): void {
  if (allArchiveSelected.value) {
    clearArchiveSelection();
    return;
  }
  picked.value = new Set(shownArchive.value.map((entry) => entry.id));
}

export function clearArchiveSelection(): void {
  if (picked.value.size === 0) return;
  picked.value = new Set();
}

export function setArchiveQuery(query: string): void {
  archiveFilter.value = { ...archiveFilter.value, query };
}

export function setArchiveWhen(when: ArchiveWhen): void {
  archiveFilter.value = { ...archiveFilter.value, when };
}

export function setArchiveOrigin(origin: ArchiveOrigin): void {
  archiveFilter.value = { ...archiveFilter.value, origin };
}

/**
 * §4.5's "Ripristina": the tabs come back and their entries leave the archive, which
 * `restoreTabs` does itself, so the list updates through `onChanged` like everything else.
 */
export function restoreArchived(entries: readonly ArchivedTab[]): void {
  if (entries.length === 0) return;
  clearArchiveSelection();
  run(restoreTabs(entries, Date.now()));
}

/**
 * §4.5's "Elimina dall'archivio": the entry goes and the tab does not come back. The one
 * thing in the product that cannot be undone, which is what `--td-danger` marks (§4.7).
 */
export function forgetArchived(entries: readonly ArchivedTab[]): void {
  if (entries.length === 0) return;
  clearArchiveSelection();
  run(removeFromArchive(entries.map((entry) => entry.id)));
}

/** §4.5's "Svuota archivio", after the inline confirmation the view asks. */
export function emptyArchived(): void {
  clearArchiveSelection();
  run(emptyArchive());
}

/**
 * §4.5's "Esporta": the rows the user is looking at, as a Markdown list of links, on the
 * clipboard.
 *
 * Asynchronous and reported back, because this is the one action that can fail for a
 * reason the user can do something about — a clipboard the browser would not give us
 * without a gesture (docs/DECISIONS.md). It copies what the filter left, not the whole
 * archive: a search is how §4.5 lets the user choose what to export.
 */
export async function copyArchived(entries: readonly ArchivedTab[]): Promise<boolean> {
  if (entries.length === 0) return false;
  try {
    await navigator.clipboard.writeText(exportArchive(entries));
    return true;
  } catch (error: unknown) {
    console.error('TabDeclutter: archive export', error);
    return false;
  }
}

export interface ArchiveStateOptions {
  /** The clock, injected so the tests can be exact about the date filter. */
  readonly now?: () => number;
  /** How long `onChanged` is coalesced. Defaults to `RELOAD_DEBOUNCE_MS`. */
  readonly debounceMs?: number;
}

export interface ArchiveStateHandle {
  /** Reads the archive now, without waiting for the debounce. */
  refresh(): Promise<void>;
  /** Stops following the archive: the view calls it when it unmounts. */
  stop(): void;
}

/** Starts following `local:archive` and asks for the first read. */
export function startArchiveState(options: ArchiveStateOptions = {}): ArchiveStateHandle {
  const now = options.now ?? Date.now;
  const debounceMs = options.debounceMs ?? RELOAD_DEBOUNCE_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  /** One read at a time, so a late answer cannot overwrite a newer snapshot. */
  let chain: Promise<unknown> = Promise.resolve();

  function refresh(): Promise<void> {
    const next = chain.then(reload, reload);
    chain = next.then(ignore, ignore);
    return next;
  }

  async function reload(): Promise<void> {
    const at = now();
    archiveData.value = { entries: await readArchive(), at };
  }

  function schedule(): void {
    timer ??= setTimeout(() => {
      timer = undefined;
      void refresh().catch(failed);
    }, debounceMs);
  }

  function onChanged(changes: Record<string, unknown>, area: string): void {
    if (area !== 'local') return;
    if (ARCHIVE_KEY in changes) schedule();
  }

  browser.storage.onChanged.addListener(onChanged);
  void refresh().catch(failed);

  return {
    refresh,
    stop: () => {
      browser.storage.onChanged.removeListener(onChanged);
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** The one place an archive action's failure is reported, as in `state/commands.ts`. */
function run(work: Promise<unknown>): void {
  void work.catch((error: unknown) => {
    console.error('TabDeclutter: archive action', error);
  });
}

function failed(error: unknown): void {
  console.error('TabDeclutter: archive state', error);
}

function ignore(): void {
  /* keeps the queue alive after a failed read */
}
