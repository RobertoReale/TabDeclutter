/**
 * The background autopilot: automatic decluttering (closing tabs in the `close` bucket and
 * forgotten windows, archiving every one first) and automatic window/tab organization
 * (`Settings.autoDeclutter` and `Settings.autoOrganize`).
 *
 * Driven by events and the periodic alarm, never polling, and serialized so two bursts
 * cannot overlap. Everything lives in storage so service worker restarts lose nothing.
 */

import { compile } from '@/core/patterns';
import { scoreTabs, type ScoredTab } from '@/core/scoring';
import { DAY, HOUR } from '@/core/time';
import { STARTUP_GRACE_MS, type Settings, type TabInfo } from '@/core/types';
import { caps, type Capabilities } from '@/platform/capabilities';
import {
  activityItem,
  aiProposalItem,
  duplicateWhitelistItem,
  keepsItem,
  organizeSnoozeUntilItem,
  protectedDomainsItem,
  readGuardState,
  readKeeps,
  readSettings,
  settingsItem,
} from '@/platform/storage';
import { activateTab, closeTabs, closeWindow, queryTabs } from '@/platform/tabs';
import { organizeWindows } from '@/platform/windows';

const AUTOPILOT_DEBOUNCE_MS = 2_500;
const AUTOPILOT_PERIOD_MINUTES = 15;
const ALARM_NAME = 'autopilot-sweep';

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
      const [tabs, activity, keeps, protectedSites, whitelist] = await Promise.all([
        queryTabs(),
        activityItem.getValue(),
        readKeeps(at),
        protectedDomainsItem.getValue(),
        duplicateWhitelistItem.getValue(),
      ]);

      const scoring = scoreTabs(tabs, activity, settings, at, {
        isWhitelisted: compile(whitelist).match,
        protectedSites,
        keeps,
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
        if (scored.bucket !== 'close' || forgottenIds.has(scored.windowId)) return false;
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
      const aiProposal =
        !settings.useTabGroups && settings.autoOrganizeMode === 'topic' && settings.useOnDeviceAi
          ? ((await aiProposalItem.getValue().catch(() => null)) ?? undefined)
          : undefined;
      const winResult = await organizeWindows({
        windowMode: settings.autoWindowMode,
        clusterMode: settings.autoOrganizeMode,
        useTabGroups: settings.useTabGroups,
        focusedWindowId: focusedId,
        proposal: aiProposal,
      });
      groupedWindows = winResult.windowsCount;
    }

    return { closedTabs, closedWindows, groupedWindows };
  }

  browser.tabs.onCreated.addListener(schedule);
  browser.tabs.onUpdated.addListener((_tabId: number, change: { status?: string }) => {
    if (change.status === 'complete') schedule();
  });

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
    if (alarm.name === ALARM_NAME) void run().catch(failed);
  });

  browser.runtime.onStartup.addListener(() => {
    setTimeout(() => {
      void run().catch(failed);
    }, STARTUP_GRACE_MS + 500);
  });

  browser.runtime.onInstalled.addListener(() => {
    void run().catch(failed);
  });

  void ensureAlarm().catch(failed);
  schedule();

  return { run };
}

async function ensureAlarm(): Promise<void> {
  const alarms = api().alarms;
  if ((await alarms.get(ALARM_NAME)) !== undefined) return;
  await alarms.create(ALARM_NAME, { periodInMinutes: AUTOPILOT_PERIOD_MINUTES });
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
    create(name: string, info: { periodInMinutes: number }): Promise<void> | void;
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
  if (tab.active || tab.pinned || tab.audible || tab.hidden || tab.incognito) return false;
  const rawUrl = tab.url.trim();
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
  console.error('TabDeclutter: autopilot', error);
}

function ignore(): void {
  /* keeps the queue alive after a failed sweep */
}
