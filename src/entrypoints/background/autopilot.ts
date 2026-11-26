/**
 * The background autopilot: automatic decluttering (closing tabs in the `close` bucket and
 * forgotten windows, archiving every one first) and automatic window/tab organization
 * (`Settings.autoDeclutter` and `Settings.autoOrganize`).
 *
 * Driven by events and alarms, never polling, and serialized so two bursts cannot overlap.
 * Everything lives in storage so service worker restarts lose nothing, and every import is
 * static so the MV3 service worker never calls dynamic `import()` (disallowed in
 * `ServiceWorkerGlobalScope` by the HTML spec).
 */

import {
  type AiDraft,
  assembleAiProposal,
  buildPrompt,
  errorName,
  extractCompleteGroupsJson,
  hasRecoverableGroupSnippet,
  isDegenerateStream,
  packClusterBatches,
  SYSTEM_PROMPT,
  validateAiAnswer,
} from '@/core/ai-prompt';
import { clusterTabIds, type GroupProposal } from '@/core/cluster';
import { tabUrl } from '@/core/duplicates';
import { compileMatcher } from '@/core/patterns';
import { scoreTabs, type ScoredTab } from '@/core/scoring';
import { DAY, HOUR, MINUTE } from '@/core/time';
import { NO_GROUP_ID, STARTUP_GRACE_MS, type Settings, type TabInfo } from '@/core/types';
import { parseUrl, unwrapSuspendedUrl } from '@/core/url';
import { eligibleLikedYouTubeTabs, extractYouTubeVideoId } from '@/core/youtube';
import { caps, type Capabilities } from '@/platform/capabilities';
import {
  aiBgCooldownUntilItem,
  aiBusyUntilItem,
  duplicateWhitelistItem,
  keepsItem,
  onBackgroundAiPreempt,
  organizeSnoozeUntilItem,
  protectedDomainsItem,
  readAiProposalState,
  readGuardState,
  readScoringInputs,
  readSettings,
  saveAiProposalState,
  settingsItem,
  withAiLock,
  ytLikedCheckedAtItem,
} from '@/platform/storage';
import { activateTab, closeTabs, closeWindow, NO_WINDOW, queryTabs } from '@/platform/tabs';
import {
  aiProposalFreshForAutoRefresh,
  isMovableTab,
  movableTabsSignature,
  ORGANIZE_CLUSTER_OPTIONS,
  organizeWindows,
  type YouTubeSortOptions,
} from '@/platform/windows';
import {
  resolveLikedYouTubeVideos,
  resolveYouTubeDurations,
  withAbortTimeout,
} from '@/platform/youtube';

import {
  alarmsApi,
  backgroundError,
  createDebouncer,
  createSerialQueue,
  ensurePeriodicAlarm,
  focusedWindow,
  ignore,
  watchLocalKeys,
} from './report';

const AUTOPILOT_DEBOUNCE_MS = 1_200;
const AUTOPILOT_PERIOD_MINUTES = 15;
const ALARM_NAME = 'autopilot-sweep';
const STARTUP_ALARM_NAME = 'autopilot-startup';
/** Chrome 120+ enforces a 30 s minimum alarm delay; using 30 s avoids dev console warnings while clearing the 15 s startup grace window. */
const STARTUP_ALARM_DELAY_MS = Math.max(STARTUP_GRACE_MS + 500, 30_000);
/** Cold-loading Gemini Nano + D3D12 shaders on 4 GB VRAM laptops can take 3-5 min once per boot. */
const BG_AI_WARMUP_TIMEOUT_MS = 300_000;
const BG_AI_TIMEOUT_MS = 90_000;
const BG_AI_COOLDOWN_MS = 2 * MINUTE;
const BG_AI_MAX_BATCH_TABS = 20;
const BG_AI_MAX_GROUPS = 10;
const BG_AI_MAX_NAME_LENGTH = 24;
const SW_KEEPALIVE_MS = 20_000;

const TEXT_EN = [{ type: 'text', languages: ['en'] }] as const;
const EXPECTED_TEXT_OPTIONS = {
  expectedInputs: TEXT_EN,
  expectedOutputs: TEXT_EN,
} as const;

interface BackgroundLanguageModelSession {
  prompt(input: string, options?: { readonly signal?: AbortSignal }): Promise<string>;
  promptStreaming?(
    input: string,
    options?: { readonly signal?: AbortSignal },
  ):
    | ReadableStream<string>
    | AsyncIterable<string>
    | Promise<ReadableStream<string> | AsyncIterable<string>>;
  clone?(options?: { readonly signal?: AbortSignal }): Promise<BackgroundLanguageModelSession>;
  destroy?(): void;
}

interface BackgroundLanguageModelApi {
  availability(options?: typeof EXPECTED_TEXT_OPTIONS): Promise<string>;
  create(
    options?: typeof EXPECTED_TEXT_OPTIONS & {
      readonly temperature?: number;
      readonly topK?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<BackgroundLanguageModelSession>;
}

function backgroundLanguageModel(): BackgroundLanguageModelApi | undefined {
  const found = (globalThis as { LanguageModel?: BackgroundLanguageModelApi }).LanguageModel;
  return typeof found?.availability === 'function' && typeof found.create === 'function'
    ? found
    : undefined;
}

const EMPTY_AI = { proposal: null, signature: '' } as const;
const EMPTY_REPORT: AutopilotReport = { closedTabs: 0, closedWindows: 0, groupedWindows: 0 };
const readZero = (item: { getValue(): Promise<number> }): Promise<number> =>
  item.getValue().catch(() => 0);
const isBlocked = (
  state: { readonly graceUntil?: number; readonly pausedUntil?: number },
  at: number,
): boolean => (state.graceUntil ?? 0) > at || (state.pausedUntil ?? 0) > at;
const isTopicAiWindows = (s: Settings): boolean =>
  !s.useTabGroups && s.autoOrganizeMode === 'topic' && s.useOnDeviceAi;
const runOrganize = async (
  s: Settings,
  focusedWindowId: number | undefined,
  at: number,
  proposal?: GroupProposal,
  proposalSignature?: string,
  knownTabs?: readonly TabInfo[],
) => {
  let youTubeSort: YouTubeSortOptions | undefined;
  if (s.sortYouTubeByDuration) {
    const open = knownTabs ?? (await queryTabs().catch(() => []));
    const durations = await resolveYouTubeDurations(open, { now: at }).catch(
      () => new Map<string, number | null>(),
    );
    if (durations.size > 0) youTubeSort = { durations, order: s.youTubeDurationOrder };
  }
  return organizeWindows({
    windowMode: s.autoWindowMode,
    clusterMode: s.autoOrganizeMode,
    useTabGroups: s.useTabGroups,
    focusedWindowId,
    proposal,
    proposalSignature,
    youTubeSort,
  });
};

const WATCHED_ITEMS = [settingsItem, keepsItem, protectedDomainsItem, duplicateWhitelistItem];

export interface AutopilotOptions {
  readonly now?: () => number;
  readonly debounceMs?: number;
  readonly capabilities?: Capabilities;
  readonly flash?: () => Promise<void>;
}

export interface AutopilotReport {
  readonly closedTabs: number;
  readonly closedWindows: number;
  readonly groupedWindows: number;
}

export interface Autopilot {
  run(): Promise<AutopilotReport>;
}

export function registerAutopilot(options: AutopilotOptions = {}): Autopilot {
  const now = options.now ?? Date.now;
  const debounceMs = options.debounceMs ?? AUTOPILOT_DEBOUNCE_MS;
  const capabilities = options.capabilities ?? caps;
  const flash = options.flash;

  const enqueue = createSerialQueue();
  let bgAiInFlight = false;
  let lastBgAiSignature = '';

  function run(): Promise<AutopilotReport> {
    return enqueue(sweep);
  }

  const schedule = createDebouncer(debounceMs, () => {
    void run().catch(failed);
  });

  async function setBgCooldown(): Promise<void> {
    await aiBgCooldownUntilItem.setValue(now() + BG_AI_COOLDOWN_MS).catch(ignore);
  }

  async function refreshAiInBackground(focusedId?: number, refreshEveryTab = false): Promise<void> {
    if (bgAiInFlight) return;
    const modelApi = capabilities.promptApi ? backgroundLanguageModel() : undefined;
    if (modelApi === undefined) return;

    const [cooldownUntil, busyUntil] = await Promise.all([
      readZero(aiBgCooldownUntilItem),
      readZero(aiBusyUntilItem),
    ]);
    if (cooldownUntil > now() || busyUntil > now()) return;

    const [allTabs, proposalState] = await Promise.all([
      queryTabs().catch(() => []),
      readAiProposalState().catch(() => EMPTY_AI),
    ]);
    const movable = allTabs.filter(
      (tab) => !tab.incognito && tab.windowId !== NO_WINDOW && isMovableTab(tab),
    );
    if (movable.length < 2) return;
    const signature = movableTabsSignature(movable);
    if (
      aiProposalFreshForAutoRefresh(
        proposalState.proposal,
        movable,
        proposalState.signature,
        refreshEveryTab,
      ) ||
      lastBgAiSignature === signature
    ) {
      return;
    }

    let restored: GroupProposal | null = null;
    await withAiLock(true, async () => {
      if (bgAiInFlight) return;
      bgAiInFlight = true;
      void aiBusyUntilItem
        .setValue(now() + BG_AI_WARMUP_TIMEOUT_MS + BG_AI_TIMEOUT_MS)
        .catch(ignore);
      // Keep the MV3 service worker alive while on-device GPU inference runs.
      const heartbeat = setInterval(() => {
        void (browser.runtime as unknown as { getPlatformInfo?: () => Promise<unknown> })
          .getPlatformInfo?.()
          .catch(ignore);
      }, SW_KEEPALIVE_MS);
      (heartbeat as unknown as { unref?: () => void }).unref?.();

      const bgController = new AbortController();
      const unsubPreempt = onBackgroundAiPreempt(() => {
        bgController.abort();
      });

      try {
        const result = await promptBackgroundProposal(modelApi, movable, bgController.signal);
        if (bgController.signal.aborted) return;
        if (result === null || result.groups.length === 0) {
          await setBgCooldown();
          return;
        }
        lastBgAiSignature = signature;
        await saveAiProposalState(result, signature);
        restored = result;
      } catch {
        // Yielding to the foreground side panel is normal, not a failure cooldown.
        if (!bgController.signal.aborted) {
          await setBgCooldown();
        }
      } finally {
        unsubPreempt();
        clearInterval(heartbeat);
        bgAiInFlight = false;
        void aiBusyUntilItem.setValue(0).catch(ignore);
      }
    });

    if (restored === null) return;
    // Queue window moves inside `enqueue` so they never overlap another sweep; re-read settings,
    // guard state, snooze, and the live focused window now that inference has finished.
    const proposal = restored;
    await enqueue(async () => {
      const [latest, guardState, snoozeUntil, liveFocusedId] = await Promise.all([
        readSettings(),
        readGuardState(),
        readZero(organizeSnoozeUntilItem),
        focusedWindow(),
      ]);
      if (
        isBlocked(guardState, now()) ||
        !latest.autoOrganize ||
        !isTopicAiWindows(latest) ||
        snoozeUntil > now()
      ) {
        return;
      }
      await runOrganize(latest, liveFocusedId ?? focusedId, now(), proposal, signature);
    });
  }

  async function sweep(): Promise<AutopilotReport> {
    const settings = await readSettings();
    if (!settings.autoDeclutter && !settings.autoOrganize) return EMPTY_REPORT;

    const at = now();
    // Respect startup grace and pause so session restore is never touched automatically.
    if (isBlocked(await readGuardState(), at)) return EMPTY_REPORT;

    let closedTabs = 0;
    let closedWindows = 0;
    let groupedWindows = 0;
    const focusedId = await focusedWindow();
    let queriedTabs: readonly TabInfo[] | undefined;

    if (settings.autoDeclutter) {
      const [tabs, inputs] = await Promise.all([queryTabs(), readScoringInputs(at)]);
      queriedTabs = tabs;

      const scoring = scoreTabs(tabs, inputs.activity, settings, at, {
        isWhitelisted: compileMatcher(inputs.whitelist),
        protectedSites: inputs.protectedSites,
        keeps: inputs.keeps,
        ownOrigin: browser.runtime.getURL(''),
        focusedWindowId: focusedId,
      });

      const forgottenIds = new Set<number>();
      if (scoring.windows.length > 1) {
        for (const win of scoring.windows) {
          if (win.forgotten && win.windowId !== focusedId) forgottenIds.add(win.windowId);
        }
      }

      for (const windowId of forgottenIds) {
        const archived = await closeWindow(windowId, tabs, at, { capabilities });
        if (archived.length > 0) closedWindows += 1;
      }

      const byId = new Map(tabs.map((tab) => [tab.id, tab]));
      const staleMs = Math.max(1, settings.staleDays) * DAY;
      const closePairs = scoring.tabs.flatMap((scored) => {
        if (forgottenIds.has(scored.windowId)) return [];
        const tab = byId.get(scored.tabId);
        return tab !== undefined && isSafeToAutoClose(tab, scored, settings, staleMs)
          ? [[tab, scored] as const]
          : [];
      });
      const toClose = closePairs.map(([tab]) => tab);

      if (toClose.length > 0) {
        const closingIds = new Set(toClose.map((tab) => tab.id));
        let keptToActivate: TabInfo | undefined;
        for (const [, scored] of closePairs) {
          for (const r of scored.reasons) {
            if (r.code === 'duplicate' && !closingIds.has(r.keptTabId)) {
              keptToActivate = byId.get(r.keptTabId) ?? keptToActivate;
            }
          }
        }
        closedTabs = (await closeTabs(toClose, at, { reason: 'manual', capabilities })).length;
        if (keptToActivate !== undefined) {
          await activateTab(keptToActivate.id, keptToActivate.windowId).catch(ignore);
        }
      }

      // Optional periodic check for liked YouTube videos (at most once per 15-minute period).
      if (settings.closeLikedYouTube) {
        const lastChecked = await readZero(ytLikedCheckedAtItem);
        if (at - lastChecked >= AUTOPILOT_PERIOD_MINUTES * MINUTE) {
          const candidates = eligibleLikedYouTubeTabs(tabs, {
            includeActiveOrAudible: settings.closeLikedYouTubeActive,
            protectedSites: inputs.protectedSites,
            keeps: inputs.keeps,
            now: at,
            excludeTabIds: new Set(toClose.map((tab) => tab.id)),
            excludeWindowIds: forgottenIds,
          });
          if (candidates.length > 0) {
            await ytLikedCheckedAtItem.setValue(at).catch(ignore);
            const liked = await resolveLikedYouTubeVideos(candidates).catch(() => null);
            const likedTabs =
              liked?.status === 'ok' && liked.likedVideoIds.size > 0
                ? candidates.filter((tab) =>
                    liked.likedVideoIds.has(extractYouTubeVideoId(tabUrl(tab))!),
                  )
                : [];
            if (likedTabs.length > 0) {
              closedTabs += (await closeTabs(likedTabs, at, { reason: 'manual', capabilities }))
                .length;
            }
          }
        }
      }

      if ((closedTabs > 0 || closedWindows > 0) && flash !== undefined) {
        void flash().catch(failed);
      }
    }

    if (settings.autoOrganize) {
      if ((await readZero(organizeSnoozeUntilItem)) > at) {
        return { closedTabs, closedWindows, groupedWindows };
      }
      const useAiWindows = isTopicAiWindows(settings);
      const aiState = useAiWindows ? await readAiProposalState().catch(() => EMPTY_AI) : EMPTY_AI;
      const winResult = await runOrganize(
        settings,
        focusedId,
        at,
        aiState.proposal ?? undefined,
        aiState.signature,
        closedTabs === 0 && closedWindows === 0 ? queriedTabs : undefined,
      );
      groupedWindows = winResult.windowsCount;
      if (useAiWindows) {
        void refreshAiInBackground(focusedId, settings.aiRefreshEveryTab).catch(ignore);
      }
    }

    return { closedTabs, closedWindows, groupedWindows };
  }

  browser.tabs.onCreated.addListener(schedule);
  browser.tabs.onUpdated.addListener(
    (_tabId: number, change: { status?: string; title?: string }) => {
      if (change.status === 'complete' || change.title !== undefined) schedule();
    },
  );

  watchLocalKeys(WATCHED_ITEMS, (changes) => {
    // When only `useOnDeviceAi` changed, the side panel handles running the on-device model
    // directly; avoid firing a competing heuristic sweep on top of it.
    if (
      Object.keys(changes).length === 1 &&
      'settings' in changes &&
      onlyAiToggleChanged(changes.settings)
    ) {
      return;
    }
    schedule();
  });

  browser.alarms.onAlarm.addListener((alarm: { name: string }) => {
    if (alarm.name === ALARM_NAME || alarm.name === STARTUP_ALARM_NAME) {
      void run().catch(failed);
    }
  });

  // Use a durable alarm rather than `setTimeout` so an MV3 service worker suspended during
  // the 15 s startup grace window still runs its post-restore sweep on time (invariant 6).
  browser.runtime.onStartup.addListener(() => {
    void alarmsApi()
      .create(STARTUP_ALARM_NAME, { when: now() + STARTUP_ALARM_DELAY_MS })
      ?.catch(() => {
        setTimeout(() => {
          void run().catch(failed);
        }, STARTUP_GRACE_MS + 500);
      });
  });

  browser.runtime.onInstalled.addListener((details?: { reason?: string }) => {
    if (details?.reason !== 'install') schedule();
  });

  void ensurePeriodicAlarm(ALARM_NAME, AUTOPILOT_PERIOD_MINUTES).catch(failed);

  return { run };
}

function onceDestroy(target: BackgroundLanguageModelSession): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    target.destroy?.();
  };
}

/**
 * Prompts Chrome's on-device `LanguageModel` directly in the service worker and always destroys
 * the ephemeral session in `finally` so the worker never retains ~4 GiB of VRAM or keep-alive
 * intervals after finishing.
 */
async function promptBackgroundProposal(
  modelApi: BackgroundLanguageModelApi,
  movable: readonly TabInfo[],
  preemptSignal: AbortSignal,
): Promise<GroupProposal | null> {
  if (preemptSignal.aborted) return null;
  const availability = await modelApi.availability(EXPECTED_TEXT_OPTIONS);
  if (availability !== 'available' || preemptSignal.aborted) return null;

  const compact: TabInfo[] = movable.map((tab, index) => ({
    ...tab,
    id: index + 1,
    windowId: 1,
    index,
    groupId: NO_GROUP_ID,
  }));

  const session = await withAbortTimeout(BG_AI_WARMUP_TIMEOUT_MS, preemptSignal, async (s) => {
    const base = { ...EXPECTED_TEXT_OPTIONS, signal: s };
    try {
      return await modelApi.create({ ...base, temperature: 0, topK: 1 });
    } catch (error: unknown) {
      if (s.aborted || !/^(?:NotSupported|Type|Range)Error$/.test(errorName(error))) {
        throw error;
      }
      return modelApi.create(base);
    }
  });

  const destroySession = onceDestroy(session);
  preemptSignal.addEventListener('abort', destroySession, { once: true });

  const canClone = typeof session.clone === 'function';
  const runOnSession = (input: string, clone: boolean): Promise<string> =>
    withAbortTimeout(BG_AI_TIMEOUT_MS, preemptSignal, async (s) => {
      const cloned = clone && canClone ? await session.clone!({ signal: s }) : undefined;
      const stop = cloned === undefined ? destroySession : onceDestroy(cloned);
      if (cloned !== undefined) s.addEventListener('abort', stop, { once: true });
      try {
        return await runBgPrompt(cloned ?? session, input, s, stop);
      } finally {
        if (cloned !== undefined) {
          s.removeEventListener('abort', stop);
          stop();
        }
      }
    });

  try {
    const localClusters =
      compact.length > BG_AI_MAX_BATCH_TABS
        ? clusterTabIds(compact, 'topic', { ...ORGANIZE_CLUSTER_OPTIONS, maxGroups: 64 }).groups
        : [];
    const batches = packClusterBatches(compact, localClusters, BG_AI_MAX_BATCH_TABS);
    const useClone = batches.length > 1;
    const drafts: AiDraft[] = [];
    const claimed = new Set<number>();
    let answered = 0;

    const askBatch = async (batch: readonly TabInfo[]): Promise<void> => {
      if (preemptSignal.aborted || batch.length === 0) return;
      const promptInput = `${SYSTEM_PROMPT}\n\n${buildPrompt(batch)}`;
      let raw: string;
      try {
        raw = await runOnSession(promptInput, useClone);
      } catch (error: unknown) {
        if (
          !preemptSignal.aborted &&
          errorName(error) === 'QuotaExceededError' &&
          batch.length >= 2
        ) {
          const half = Math.ceil(batch.length / 2);
          await askBatch(batch.slice(0, half));
          await askBatch(batch.slice(half));
          return;
        }
        throw error;
      }

      const verdict = validateAiAnswer(raw, batch, {
        maxNameLength: BG_AI_MAX_NAME_LENGTH,
        minClusterTabs: 2,
      });
      if (!verdict.ok) return;
      answered += 1;

      for (const draft of verdict.drafts) {
        const tabIds = draft.tabIds
          .map((id) => movable[id - 1]?.id)
          .filter((id): id is number => id !== undefined && !claimed.has(id));
        if (tabIds.length < 2) continue;
        for (const id of tabIds) claimed.add(id);
        drafts.push({ title: draft.title, windowId: 1, tabIds });
      }
    };

    for (const batch of batches) {
      await askBatch(batch);
      if (preemptSignal.aborted) return null;
    }

    if (answered === 0 || drafts.length === 0) return null;
    const position = new Map(movable.map((tab, at) => [tab.id, at]));
    const ungrouped = movable.filter((tab) => !claimed.has(tab.id)).map((tab) => tab.id);
    const assembled = assembleAiProposal(drafts, ungrouped, position, [1], BG_AI_MAX_GROUPS);
    return assembled.groups.length === 0 ? null : assembled;
  } finally {
    preemptSignal.removeEventListener('abort', destroySession);
    destroySession();
  }
}

async function runBgPrompt(
  target: BackgroundLanguageModelSession,
  input: string,
  signal: AbortSignal,
  stopSession: () => void,
): Promise<string> {
  if (typeof target.promptStreaming !== 'function') {
    return target.prompt(input, { signal });
  }
  const stream = await target.promptStreaming(input, { signal });
  let acc = '';
  try {
    // Both `ReadableStream` (WHATWG Streams) and `AsyncIterable` support `for await`; returning
    // early automatically cancels the underlying stream reader and releases its lock.
    for await (const chunk of stream as AsyncIterable<string>) {
      if (typeof chunk !== 'string' || chunk === '') continue;
      acc = acc.length > 0 && chunk.startsWith(acc) ? chunk : acc + chunk;
      const early = extractCompleteGroupsJson(acc) ?? (isDegenerateStream(acc) ? acc : null);
      if (early !== null) {
        stopSession();
        return early;
      }
    }
    return acc;
  } catch (error: unknown) {
    if (
      signal.aborted &&
      errorName(signal.reason) === 'TimeoutError' &&
      hasRecoverableGroupSnippet(acc)
    ) {
      return acc;
    }
    throw error;
  }
}

/**
 * Guardrails for background automatic tab closing (`autoDeclutter`):
 * ensures Autopilot never closes a tab the user may still be working on.
 */
export function isSafeToAutoClose(
  tab: TabInfo,
  scored: ScoredTab,
  settings: Settings,
  staleMs: number,
): boolean {
  if (
    scored.bucket === 'keep' ||
    (scored.bucket === 'review' && scored.idleMs < staleMs) ||
    tab.active ||
    tab.pinned ||
    tab.audible ||
    tab.hidden ||
    tab.incognito ||
    scored.pageType === 'auth'
  ) {
    return false;
  }
  const rawUrl = unwrapSuspendedUrl(tab.url).trim();
  if (rawUrl === '' || /^(?:file|chrome-extension|moz-extension):/i.test(rawUrl)) return false;

  // Never auto-close local development servers (localhost / 127.0.0.1 / [::1]).
  if (/^(?:(?:.+\.)?localhost|127\.0\.0\.1|\[::1\])$/i.test(parseUrl(rawUrl)?.hostname ?? '')) {
    return false;
  }

  if (scored.primaryReason === 'blank') return scored.idleMs > HOUR;
  if (scored.primaryReason === 'duplicate') return settings.guard.mode === 'auto';
  return scored.idleMs >= staleMs;
}

function onlyAiToggleChanged(
  change: { oldValue?: unknown; newValue?: unknown } | undefined,
): boolean {
  const a = change?.oldValue as Record<string, unknown> | undefined;
  const b = change?.newValue as Record<string, unknown> | undefined;
  const norm = (o: Record<string, unknown>) => JSON.stringify({ ...o, useOnDeviceAi: false });
  return !!a && !!b && a.useOnDeviceAi !== b.useOnDeviceAi && norm(a) === norm(b);
}

const failed = backgroundError('autopilot');
