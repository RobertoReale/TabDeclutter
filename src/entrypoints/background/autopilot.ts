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
  buildPrompt,
  extractCompleteGroupsJson,
  hasRecoverableGroupSnippet,
  isDegenerateStream,
  SYSTEM_PROMPT,
  validateAiAnswer,
} from '@/core/ai-prompt';
import { colorFor, type GroupProposal, type ProposedGroup } from '@/core/cluster';
import { compile } from '@/core/patterns';
import { scoreTabs, type ScoredTab } from '@/core/scoring';
import { DAY, HOUR, MINUTE } from '@/core/time';
import { NO_GROUP_ID, STARTUP_GRACE_MS, type Settings, type TabInfo } from '@/core/types';
import { unwrapSuspendedUrl } from '@/core/url';
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
} from '@/platform/storage';
import { activateTab, closeTabs, closeWindow, NO_WINDOW, queryTabs } from '@/platform/tabs';
import {
  aiProposalFreshForAutoRefresh,
  isMovableTab,
  movableTabsSignature,
  organizeWindows,
} from '@/platform/windows';

import { reportBackgroundError } from './report';

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
const BG_AI_MAX_BATCH_TABS = 40;
const BG_AI_MAX_GROUPS = 8;
const BG_AI_MAX_NAME_LENGTH = 24;
const SW_KEEPALIVE_MS = 20_000;

const EXPECTED_TEXT_OPTIONS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
} as const;

const GREEDY_SAMPLING = { temperature: 0, topK: 1 } as const;

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

function bareKey(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}

const WATCHED: readonly string[] = [
  settingsItem,
  keepsItem,
  protectedDomainsItem,
  duplicateWhitelistItem,
].map((item) => bareKey(item.key));

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

  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let bgAiInFlight = false;
  let lastBgAiSignature = '';

  function run(): Promise<AutopilotReport> {
    const next = chain.then(sweep, sweep);
    chain = next.then(ignore, ignore);
    return next;
  }

  function schedule(): void {
    timer ??= setTimeout(() => {
      timer = undefined;
      void run().catch(failed);
    }, debounceMs);
  }

  async function setBgCooldown(): Promise<void> {
    await aiBgCooldownUntilItem.setValue(now() + BG_AI_COOLDOWN_MS).catch(ignore);
  }

  async function refreshAiInBackground(focusedId?: number): Promise<void> {
    if (bgAiInFlight) return;
    const modelApi = capabilities.promptApi ? backgroundLanguageModel() : undefined;
    if (modelApi === undefined) return;

    const [cooldownUntil, busyUntil] = await Promise.all([
      aiBgCooldownUntilItem.getValue().catch(() => 0),
      aiBusyUntilItem.getValue().catch(() => 0),
    ]);
    if (cooldownUntil > now() || busyUntil > now()) return;

    const [allTabs, proposalState] = await Promise.all([
      queryTabs().catch(() => []),
      readAiProposalState().catch(() => ({ proposal: null, signature: '' })),
    ]);
    const movable = allTabs.filter(
      (tab) => !tab.incognito && tab.windowId !== NO_WINDOW && isMovableTab(tab),
    );
    if (movable.length < 2) return;
    const signature = movableTabsSignature(movable);
    if (
      aiProposalFreshForAutoRefresh(proposalState.proposal, movable, proposalState.signature) ||
      lastBgAiSignature === signature
    ) {
      return;
    }

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
        bgController.abort(new DOMException('preempted by side panel', 'AbortError'));
      });

      try {
        const restored = await promptBackgroundProposal(modelApi, movable, bgController.signal);
        if (bgController.signal.aborted) return;
        if (restored === null || restored.groups.length === 0) {
          await setBgCooldown();
          return;
        }
        lastBgAiSignature = signature;
        await saveAiProposalState(restored, signature);

        // Inference can take 30-90 s; re-read settings and snooze before moving any window.
        const [latest, snoozeUntil] = await Promise.all([
          readSettings(),
          organizeSnoozeUntilItem.getValue().catch(() => 0),
        ]);
        if (
          bgController.signal.aborted ||
          !latest.autoOrganize ||
          latest.useTabGroups ||
          latest.autoOrganizeMode !== 'topic' ||
          !latest.useOnDeviceAi ||
          snoozeUntil > now()
        ) {
          return;
        }
        await organizeWindows({
          windowMode: latest.autoWindowMode,
          clusterMode: latest.autoOrganizeMode,
          useTabGroups: latest.useTabGroups,
          focusedWindowId: focusedId ?? (await focusedWindow()),
          proposal: restored,
        });
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
  }

  async function sweep(): Promise<AutopilotReport> {
    const settings = await readSettings();
    if (!settings.autoDeclutter && !settings.autoOrganize) {
      return { closedTabs: 0, closedWindows: 0, groupedWindows: 0 };
    }

    const at = now();
    const guardState = await readGuardState();
    // Respect startup grace and pause so session restore is never touched automatically.
    if (
      (guardState.graceUntil !== undefined && guardState.graceUntil > at) ||
      (guardState.pausedUntil !== undefined && guardState.pausedUntil > at)
    ) {
      return { closedTabs: 0, closedWindows: 0, groupedWindows: 0 };
    }

    let closedTabs = 0;
    let closedWindows = 0;
    let groupedWindows = 0;
    const focusedId = await focusedWindow();

    if (settings.autoDeclutter) {
      const [tabs, inputs] = await Promise.all([queryTabs(), readScoringInputs(at)]);

      const scoring = scoreTabs(tabs, inputs.activity, settings, at, {
        isWhitelisted: compile(inputs.whitelist).match,
        protectedSites: inputs.protectedSites,
        keeps: inputs.keeps,
        ownOrigin: browser.runtime.getURL(''),
        focusedWindowId: focusedId,
      });

      const forgottenIds = new Set(
        scoring.windows
          .filter(
            (win) => win.forgotten && win.windowId !== focusedId && scoring.windows.length > 1,
          )
          .map((win) => win.windowId),
      );

      for (const windowId of forgottenIds) {
        const archived = await closeWindow(windowId, tabs, at, { capabilities });
        if (archived.length > 0) closedWindows += 1;
      }

      const byId = new Map(tabs.map((tab) => [tab.id, tab]));
      const staleMs = Math.max(1, settings.staleDays) * DAY;
      const closeCandidates = scoring.tabs.filter((scored) => {
        if (forgottenIds.has(scored.windowId)) return false;
        const tab = byId.get(scored.tabId);
        if (tab === undefined) return false;
        return isSafeToAutoClose(tab, scored, settings, staleMs);
      });
      const toClose = closeCandidates
        .map((scored) => byId.get(scored.tabId))
        .filter((tab) => tab !== undefined);

      if (toClose.length > 0) {
        const closingIds = new Set(toClose.map((tab) => tab.id));
        let keptToActivate: { readonly id: number; readonly windowId: number } | undefined;
        for (const scored of closeCandidates) {
          for (const reason of scored.reasons) {
            if (reason.code === 'duplicate' && !closingIds.has(reason.keptTabId)) {
              const kept = byId.get(reason.keptTabId);
              if (kept !== undefined) keptToActivate = kept;
            }
          }
        }
        const archived = await closeTabs(toClose, at, { reason: 'manual', capabilities });
        closedTabs = archived.length;
        if (keptToActivate !== undefined) {
          await activateTab(keptToActivate.id, keptToActivate.windowId).catch(ignore);
        }
      }

      if ((closedTabs > 0 || closedWindows > 0) && flash !== undefined) {
        void flash().catch(failed);
      }
    }

    if (settings.autoOrganize) {
      const snoozeUntil = await organizeSnoozeUntilItem.getValue().catch(() => 0);
      if (snoozeUntil > at) {
        return { closedTabs, closedWindows, groupedWindows };
      }
      const useAiWindows =
        !settings.useTabGroups && settings.autoOrganizeMode === 'topic' && settings.useOnDeviceAi;
      const aiState = useAiWindows
        ? await readAiProposalState().catch(() => ({ proposal: null, signature: '' }))
        : { proposal: null, signature: '' };
      const winResult = await organizeWindows({
        windowMode: settings.autoWindowMode,
        clusterMode: settings.autoOrganizeMode,
        useTabGroups: settings.useTabGroups,
        focusedWindowId: focusedId,
        proposal: aiState.proposal ?? undefined,
        proposalSignature: aiState.signature,
      });
      groupedWindows = winResult.windowsCount;
      if (useAiWindows) {
        void refreshAiInBackground(focusedId).catch(ignore);
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

  browser.storage.onChanged.addListener(
    (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => {
      if (area !== 'local') return;
      if (!WATCHED.some((key) => key in changes)) return;
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
    },
  );

  browser.alarms.onAlarm.addListener((alarm: { name: string }) => {
    if (alarm.name === ALARM_NAME || alarm.name === STARTUP_ALARM_NAME) {
      void run().catch(failed);
    }
  });

  // Use a durable alarm rather than `setTimeout` so an MV3 service worker suspended during
  // the 15 s startup grace window still runs its post-restore sweep on time (invariant 6).
  browser.runtime.onStartup.addListener(() => {
    void scheduleStartupAlarm(now() + STARTUP_ALARM_DELAY_MS).catch(() => {
      setTimeout(() => {
        void run().catch(failed);
      }, STARTUP_GRACE_MS + 500);
    });
  });

  browser.runtime.onInstalled.addListener(() => {
    void run().catch(failed);
  });

  void ensureAlarm().catch(failed);

  return { run };
}

function errorName(value: unknown): string {
  return value !== null && typeof value === 'object' && 'name' in value
    ? String((value as { name: unknown }).name)
    : '';
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

  const realByShort = new Map<number, number>();
  const compact: TabInfo[] = movable.map((tab, index) => {
    const shortId = index + 1;
    realByShort.set(shortId, tab.id);
    return { ...tab, id: shortId, windowId: 1, index, groupId: NO_GROUP_ID };
  });

  const session = await withTimeout(
    BG_AI_WARMUP_TIMEOUT_MS,
    'background AI warmup timed out',
    preemptSignal,
    async (s) => {
      try {
        return await modelApi.create({ ...EXPECTED_TEXT_OPTIONS, ...GREEDY_SAMPLING, signal: s });
      } catch (error: unknown) {
        const name = errorName(error);
        if (
          s.aborted ||
          (name !== 'NotSupportedError' && name !== 'TypeError' && name !== 'RangeError')
        ) {
          throw error;
        }
        return modelApi.create({ ...EXPECTED_TEXT_OPTIONS, signal: s });
      }
    },
  );

  const destroySession = onceDestroy(session);
  preemptSignal.addEventListener('abort', destroySession, { once: true });

  try {
    const batches: TabInfo[][] = [];
    for (let i = 0; i < compact.length; i += BG_AI_MAX_BATCH_TABS) {
      batches.push(compact.slice(i, i + BG_AI_MAX_BATCH_TABS));
    }

    const groups: ProposedGroup[] = [];
    const claimed = new Set<number>();
    let answered = 0;

    for (const batch of batches) {
      if (preemptSignal.aborted) return null;
      const promptInput = `${SYSTEM_PROMPT}\n\n${buildPrompt(batch)}`;
      const raw = await withTimeout(
        BG_AI_TIMEOUT_MS,
        'background AI prompt timed out',
        preemptSignal,
        async (s) => {
          if (batches.length > 1 && typeof session.clone === 'function') {
            const clone = await session.clone({ signal: s });
            const destroyClone = onceDestroy(clone);
            s.addEventListener('abort', destroyClone, { once: true });
            try {
              return await runBgPrompt(clone, promptInput, s, destroyClone);
            } finally {
              s.removeEventListener('abort', destroyClone);
              destroyClone();
            }
          }
          return runBgPrompt(session, promptInput, s, destroySession);
        },
      );

      const verdict = validateAiAnswer(raw, batch, {
        maxNameLength: BG_AI_MAX_NAME_LENGTH,
        minClusterTabs: 2,
      });
      if (!verdict.ok) continue;
      answered += 1;

      for (const draft of verdict.drafts) {
        if (groups.length >= BG_AI_MAX_GROUPS) break;
        const tabIds = draft.tabIds
          .map((id) => realByShort.get(id))
          .filter((id): id is number => id !== undefined && !claimed.has(id));
        if (tabIds.length < 2) continue;
        for (const id of tabIds) claimed.add(id);
        groups.push({
          key: `ai:1:${groups.length}:${draft.title.toLowerCase()}`,
          title: draft.title,
          color: colorFor(draft.title),
          windowId: 1,
          tabIds,
        });
      }
    }

    if (answered === 0 || groups.length === 0) return null;
    const ungrouped = movable.filter((tab) => !claimed.has(tab.id)).map((tab) => tab.id);
    return { mode: 'topic', groups, ungrouped };
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

async function withTimeout<T>(
  timeoutMs: number,
  message: string,
  outerSignal: AbortSignal,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onOuterAbort = (): void => {
    controller.abort(outerSignal.reason);
  };
  if (outerSignal.aborted) {
    controller.abort(outerSignal.reason);
  } else {
    outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(new DOMException(message, 'TimeoutError'));
  }, timeoutMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    return await action(controller.signal);
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener('abort', onOuterAbort);
  }
}

async function ensureAlarm(): Promise<void> {
  const alarms = api().alarms;
  if ((await alarms.get(ALARM_NAME)) !== undefined) return;
  await alarms.create(ALARM_NAME, { periodInMinutes: AUTOPILOT_PERIOD_MINUTES });
}

async function scheduleStartupAlarm(when: number): Promise<void> {
  await api().alarms.create(STARTUP_ALARM_NAME, { when });
}

async function focusedWindow(): Promise<number | undefined> {
  try {
    return (await api().windows.getLastFocused()).id;
  } catch {
    return undefined;
  }
}

interface AutopilotApi {
  readonly alarms: {
    get(name: string): Promise<{ name: string } | undefined>;
    create(name: string, info: { periodInMinutes?: number; when?: number }): Promise<void> | void;
  };
  readonly windows: {
    getLastFocused(): Promise<{ id?: number }>;
  };
}

function api(): AutopilotApi {
  return browser as unknown as AutopilotApi;
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
  if (scored.bucket === 'keep') return false;
  if (scored.bucket === 'review' && scored.idleMs < staleMs) return false;
  if (tab.active || tab.pinned || tab.audible || tab.hidden || tab.incognito) return false;
  const rawUrl = unwrapSuspendedUrl(tab.url).trim();
  if (rawUrl === '') return false;

  const lower = rawUrl.toLowerCase();
  // Never auto-close local files or extension document viewers (Office / PDF viewers).
  if (
    lower.startsWith('file:') ||
    lower.startsWith('chrome-extension:') ||
    lower.startsWith('moz-extension:')
  ) {
    return false;
  }

  // Never auto-close OAuth / sign-in pages in the background while a login might be in progress.
  if (scored.pageType === 'auth') return false;

  // Never auto-close local development servers (localhost / 127.0.0.1 / [::1]).
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '127.0.0.1' ||
      host === '[::1]'
    ) {
      return false;
    }
  } catch {
    // Non-standard URL (e.g. about:blank), handled below.
  }

  // Abandoned empty tabs (`about:blank`, `chrome://newtab`) idle for over 1 hour are safe to close.
  if (scored.primaryReason === 'blank') {
    return scored.idleMs > HOUR;
  }

  // Exact duplicates are only auto-closed when duplicate protection is set to automatic mode.
  if (scored.primaryReason === 'duplicate') {
    return settings.guard.mode === 'auto';
  }

  // Every other page (articles, videos, searches, etc.) is only auto-closed in the background
  // once it has genuinely been untouched for at least the user's configured `staleDays`.
  return scored.idleMs >= staleMs;
}

function onlyAiToggleChanged(
  change: { oldValue?: unknown; newValue?: unknown } | undefined,
): boolean {
  const oldVal = change?.oldValue as Record<string, unknown> | undefined;
  const newVal = change?.newValue as Record<string, unknown> | undefined;
  if (!oldVal || !newVal || oldVal.useOnDeviceAi === newVal.useOnDeviceAi) return false;
  return (
    JSON.stringify({ ...oldVal, useOnDeviceAi: false }) ===
    JSON.stringify({ ...newVal, useOnDeviceAi: false })
  );
}

function failed(error: unknown): void {
  void reportBackgroundError('autopilot', error);
}

function ignore(): void {
  /* keeps the queue alive after a failed sweep */
}
