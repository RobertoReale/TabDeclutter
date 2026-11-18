/**
 * The background autopilot: automatic decluttering (closing tabs in the `close` bucket and
 * forgotten windows, archiving every one first) and automatic window/tab organization
 * (`Settings.autoDeclutter` and `Settings.autoOrganize`).
 *
 * Driven by events and the periodic alarm, never polling, and serialized so two bursts
 * cannot overlap. Everything lives in storage so service worker restarts lose nothing.
 */

import { proposeGroups } from '@/core/cluster';
import { compile } from '@/core/patterns';
import { scoreTabs } from '@/core/scoring';
import { STARTUP_GRACE_MS } from '@/core/types';
import { caps, type Capabilities } from '@/platform/capabilities';
import { applyGroups } from '@/platform/groups';
import {
  activityItem,
  duplicateWhitelistItem,
  keepsItem,
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
      const closeCandidates = scoring.tabs.filter(
        (scored) => scored.bucket === 'close' && !forgottenIds.has(scored.windowId),
      );
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
      const winResult = await organizeWindows({
        windowMode: settings.autoWindowMode,
        clusterMode: settings.autoOrganizeMode,
        useTabGroups: settings.useTabGroups,
        focusedWindowId: focusedId,
      });
      groupedWindows = winResult.windowsCount;

      if (settings.useTabGroups && capabilities.tabGroups) {
        const openTabs = await queryTabs();
        const proposal = proposeGroups(openTabs, settings.autoOrganizeMode, {
          includePinned: false,
          includeGrouped: false,
        });
        if (proposal.groups.length > 0) {
          await applyGroups(proposal, {
            capabilities,
            sortByGroup: true,
            collapse: false,
            includePinned: false,
            includeGrouped: false,
          });
        }
      }
    }

    return { closedTabs, closedWindows, groupedWindows };
  }

  browser.tabs.onCreated.addListener(schedule);
  browser.tabs.onUpdated.addListener(
    (_tabId: number, change: { status?: string; url?: string }) => {
      if (change.status === 'complete' || change.url !== undefined) schedule();
    },
  );
  browser.tabs.onActivated.addListener(schedule);
  browser.windows.onFocusChanged.addListener(schedule);

  browser.storage.onChanged.addListener((changes: Record<string, unknown>, area: string) => {
    if (area !== 'local') return;
    if (WATCHED.some((key) => key in changes)) schedule();
  });

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

function failed(error: unknown): void {
  console.error('TabDeclutter: autopilot', error);
}

function ignore(): void {
  /* keeps the queue alive after a failed sweep */
}
