/**
 * Background autopilot reliability tests: static MV3 execution (no dynamic import), durable
 * startup alarms (≥ 30 s per Chrome 120+ minimum), ephemeral LanguageModel session destruction,
 * persistent cooldowns, re-checked settings after inference, and shutdown-aware error reporting.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { DEFAULT_SETTINGS, NO_GROUP_ID, type TabInfo } from '../../src/core/types';
import { registerAutopilot } from '../../src/entrypoints/background/autopilot';
import { reportBackgroundError } from '../../src/entrypoints/background/report';
import type { Capabilities } from '../../src/platform/capabilities';
import {
  activityItem,
  aiBgCooldownUntilItem,
  pauseGuard,
  preemptBackgroundAi,
  readAiProposalState,
  readSettings,
  saveAiProposalState,
  saveSettings,
  startGuardGrace,
} from '../../src/platform/storage';
import { movableTabsSignature } from '../../src/platform/windows';

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);

const CHROME_CAPS: Capabilities = {
  sidePanel: true,
  sidebarAction: false,
  faviconApi: true,
  promptApi: true,
  tabGroups: true,
  containers: false,
  sessionTabValues: false,
  duplicateCommandDetection: true,
  tabContextMenu: false,
};

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('background/autopilot reliability', () => {
  it('schedules a durable startup alarm (>= 30 s) on runtime.onStartup instead of relying on setTimeout', async () => {
    const created: { name: string; info: { when?: number; periodInMinutes?: number } }[] = [];
    vi.spyOn(fakeBrowser.alarms, 'get').mockResolvedValue(undefined);
    vi.spyOn(fakeBrowser.alarms, 'create').mockImplementation(
      (name: string, info: { when?: number; periodInMinutes?: number }) => {
        created.push({ name, info });
      },
    );

    registerAutopilot({ now: () => NOW, capabilities: CHROME_CAPS });
    await flushAsync();

    await fakeBrowser.runtime.onStartup.trigger();
    await flushAsync();

    const startupAlarm = created.find((entry) => entry.name === 'autopilot-startup');
    expect(startupAlarm).toBeDefined();
    expect((startupAlarm?.info.when ?? 0) - NOW).toBeGreaterThanOrEqual(30_000);
  });

  it('destroys the ephemeral LanguageModel session in finally and persists the AI proposal + signature', async () => {
    let destroyed = 0;
    const fakeLm = {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async () => ({
        prompt: vi.fn(async () =>
          JSON.stringify({
            groups: [{ name: 'Algebra', tabIds: [1, 2] }],
          }),
        ),
        destroy: () => {
          destroyed += 1;
        },
      })),
    };
    vi.stubGlobal('LanguageModel', fakeLm);

    vi.spyOn(fakeBrowser.windows, 'getLastFocused').mockResolvedValue({ id: 1 } as never);
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([
      {
        id: 101,
        windowId: 1,
        index: 0,
        url: 'https://gemini.google.com/app/aaa',
        title: 'Linear algebra basis',
        pinned: false,
        audible: false,
        active: true,
        discarded: false,
        incognito: false,
        groupId: NO_GROUP_ID,
      },
      {
        id: 102,
        windowId: 1,
        index: 1,
        url: 'https://www.youtube.com/watch?v=bbb',
        title: 'Eigenvalues lecture',
        pinned: false,
        audible: false,
        active: false,
        discarded: false,
        incognito: false,
        groupId: NO_GROUP_ID,
      },
    ] as never);
    vi.spyOn(fakeBrowser.tabs, 'move').mockResolvedValue({} as never);

    await saveSettings({
      ...DEFAULT_SETTINGS,
      autoOrganize: true,
      useTabGroups: false,
      autoOrganizeMode: 'topic',
      autoWindowMode: 'merge-windows',
      useOnDeviceAi: true,
    });

    const autopilot = registerAutopilot({ now: () => NOW, capabilities: CHROME_CAPS });
    await autopilot.run();
    await flushAsync();

    expect(fakeLm.create).toHaveBeenCalledTimes(1);
    expect(destroyed).toBe(1);

    const saved = await readAiProposalState();
    expect(saved.proposal?.groups).toHaveLength(1);
    expect(saved.proposal?.groups[0]?.title).toBe('Algebra');
    expect(saved.proposal?.groups[0]?.tabIds).toEqual([101, 102]);
    expect(saved.signature).not.toBe('');
  });

  it('persists background AI cooldown in storage.session on failure and destroys the session', async () => {
    let destroyed = 0;
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async () => ({
        prompt: vi.fn(async () => {
          throw new Error('GPU busy');
        }),
        destroy: () => {
          destroyed += 1;
        },
      })),
    });
    vi.spyOn(fakeBrowser.windows, 'getLastFocused').mockResolvedValue({ id: 1 } as never);
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([
      {
        id: 10,
        windowId: 1,
        index: 0,
        url: 'https://example.com/a',
        title: 'Alpha',
        pinned: false,
        audible: false,
        active: true,
        discarded: false,
        incognito: false,
        groupId: NO_GROUP_ID,
      },
      {
        id: 11,
        windowId: 1,
        index: 1,
        url: 'https://example.org/b',
        title: 'Beta',
        pinned: false,
        audible: false,
        active: false,
        discarded: false,
        incognito: false,
        groupId: NO_GROUP_ID,
      },
    ] as never);
    vi.spyOn(fakeBrowser.tabs, 'move').mockResolvedValue({} as never);

    await saveSettings({
      ...DEFAULT_SETTINGS,
      autoOrganize: true,
      useTabGroups: false,
      autoOrganizeMode: 'topic',
      autoWindowMode: 'merge-windows',
      useOnDeviceAi: true,
    });

    const autopilot = registerAutopilot({ now: () => NOW, capabilities: CHROME_CAPS });
    await autopilot.run();
    await flushAsync();

    expect(destroyed).toBe(1);
    expect(await aiBgCooldownUntilItem.getValue()).toBeGreaterThan(NOW);
  });

  it('re-reads settings after inference and skips moving windows if autoOrganize was turned off mid-run', async () => {
    let finishPrompt: (value: string) => void = () => undefined;
    const moveSpy = vi.spyOn(fakeBrowser.tabs, 'move').mockResolvedValue({} as never);
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async () => ({
        prompt: () =>
          new Promise<string>((resolve) => {
            finishPrompt = resolve;
          }),
        destroy: vi.fn(),
      })),
    });
    vi.spyOn(fakeBrowser.windows, 'getLastFocused').mockResolvedValue({ id: 1 } as never);
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([
      {
        id: 1,
        windowId: 1,
        index: 0,
        url: 'https://alpha.example/1',
        title: 'Alpha one',
        pinned: false,
        audible: false,
        active: true,
        discarded: false,
        incognito: false,
        groupId: NO_GROUP_ID,
      },
      {
        id: 2,
        windowId: 2,
        index: 0,
        url: 'https://beta.example/2',
        title: 'Beta two',
        pinned: false,
        audible: false,
        active: false,
        discarded: false,
        incognito: false,
        groupId: NO_GROUP_ID,
      },
    ] as never);

    await saveSettings({
      ...DEFAULT_SETTINGS,
      autoOrganize: true,
      useTabGroups: false,
      autoOrganizeMode: 'topic',
      autoWindowMode: 'merge-windows',
      useOnDeviceAi: true,
    });

    const autopilot = registerAutopilot({ now: () => NOW, capabilities: CHROME_CAPS });
    await autopilot.run();
    await flushAsync();
    const movesBeforeAi = moveSpy.mock.calls.length;

    // User turns autoOrganize off while background AI inference is still running.
    await saveSettings({ ...DEFAULT_SETTINGS, autoOrganize: false });
    finishPrompt(JSON.stringify({ groups: [{ name: 'Mix', tabIds: [1, 2] }] }));
    await flushAsync();

    expect(moveSpy.mock.calls.length).toBe(movesBeforeAi);
  });

  it('aborts and destroys background AI immediately on preemptBackgroundAi() without triggering cooldown', async () => {
    let destroyed = 0;
    let signalSeen: AbortSignal | undefined;
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async () => ({
        prompt: (_input: string, opts?: { signal?: AbortSignal }) => {
          signalSeen = opts?.signal;
          return new Promise<string>((_resolve, reject) => {
            opts?.signal?.addEventListener('abort', () => reject(opts.signal?.reason), {
              once: true,
            });
          });
        },
        destroy: () => {
          destroyed += 1;
        },
      })),
    });
    vi.spyOn(fakeBrowser.windows, 'getLastFocused').mockResolvedValue({ id: 1 } as never);
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([
      {
        id: 1,
        windowId: 1,
        index: 0,
        url: 'https://alpha.example/1',
        title: 'Alpha one',
        pinned: false,
        audible: false,
        active: true,
        discarded: false,
        incognito: false,
        groupId: NO_GROUP_ID,
      },
      {
        id: 2,
        windowId: 1,
        index: 1,
        url: 'https://beta.example/2',
        title: 'Beta two',
        pinned: false,
        audible: false,
        active: false,
        discarded: false,
        incognito: false,
        groupId: NO_GROUP_ID,
      },
    ] as never);

    await saveSettings({
      ...DEFAULT_SETTINGS,
      autoOrganize: true,
      useTabGroups: false,
      autoOrganizeMode: 'topic',
      autoWindowMode: 'merge-windows',
      useOnDeviceAi: true,
    });

    const autopilot = registerAutopilot({ now: () => NOW, capabilities: CHROME_CAPS });
    await autopilot.run();
    await flushAsync();

    expect(signalSeen?.aborted).toBe(false);
    preemptBackgroundAi();
    await flushAsync();

    expect(signalSeen?.aborted).toBe(true);
    expect(destroyed).toBe(1);
    expect(await aiBgCooldownUntilItem.getValue()).toBe(0);
  });

  it('uses greedy decoding (temperature=0, topK=1) and stops promptStreaming() early once JSON closes', async () => {
    let cancelled = false;
    let createOpts: Record<string, unknown> | undefined;
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async (opts: Record<string, unknown>) => {
        createOpts = opts;
        return {
          prompt: vi.fn(async () => {
            throw new Error('should prefer promptStreaming');
          }),
          promptStreaming: () =>
            new ReadableStream<string>({
              start(controller) {
                controller.enqueue('{"groups":[{"name":"Math","tabIds":[1,2]}]}');
              },
              cancel() {
                cancelled = true;
              },
            }),
          destroy: vi.fn(),
        };
      }),
    });
    vi.spyOn(fakeBrowser.windows, 'getLastFocused').mockResolvedValue({ id: 1 } as never);
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([
      {
        id: 50,
        windowId: 1,
        index: 0,
        url: 'https://gemini.google.com/app/x',
        title: 'Linear algebra',
        pinned: false,
        audible: false,
        active: true,
        discarded: false,
        incognito: false,
        groupId: NO_GROUP_ID,
      },
      {
        id: 51,
        windowId: 1,
        index: 1,
        url: 'https://www.youtube.com/watch?v=y',
        title: 'Calculus',
        pinned: false,
        audible: false,
        active: false,
        discarded: false,
        incognito: false,
        groupId: NO_GROUP_ID,
      },
    ] as never);
    vi.spyOn(fakeBrowser.tabs, 'move').mockResolvedValue({} as never);

    await saveSettings({
      ...DEFAULT_SETTINGS,
      autoOrganize: true,
      useTabGroups: false,
      autoOrganizeMode: 'topic',
      autoWindowMode: 'merge-windows',
      useOnDeviceAi: true,
    });

    const autopilot = registerAutopilot({ now: () => NOW, capabilities: CHROME_CAPS });
    await autopilot.run();
    await flushAsync();

    expect(createOpts).toMatchObject({ temperature: 0, topK: 1 });
    expect(cancelled).toBe(true);
    const saved = await readAiProposalState();
    expect(saved.proposal?.groups[0]?.title).toBe('Math');
    expect(saved.proposal?.groups[0]?.tabIds).toEqual([50, 51]);
  });

  it('reuses a persisted local AI proposal across reloads and minor tab drift without calling LanguageModel.create()', async () => {
    const createSpy = vi.fn(async () => ({
      prompt: vi.fn(async () => JSON.stringify({ groups: [{ name: 'Fresh', tabIds: [1, 2] }] })),
      destroy: vi.fn(),
    }));
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn(async () => 'available'),
      create: createSpy,
    });

    const baseTabs = Array.from({ length: 8 }, (_, idx) => ({
      id: 200 + idx,
      windowId: 1,
      index: idx,
      url:
        idx < 4 ? `https://math.example/${String(idx)}` : `https://history.example/${String(idx)}`,
      title: idx < 4 ? `Algebra ${String(idx)}` : `Rome ${String(idx)}`,
      pinned: false,
      audible: false,
      active: idx === 0,
      discarded: false,
      hidden: false,
      incognito: false,
      groupId: NO_GROUP_ID,
    }));
    const sig = movableTabsSignature(baseTabs);
    await saveAiProposalState(
      {
        mode: 'topic',
        groups: [
          { key: 'math', title: 'Math', color: 'blue', windowId: 1, tabIds: [200, 201, 202, 203] },
          {
            key: 'history',
            title: 'History',
            color: 'green',
            windowId: 1,
            tabIds: [204, 205, 206, 207],
          },
        ],
        ungrouped: [],
      },
      sig,
    );

    // Simulate reload + 1 closed tab + 1 newly opened tab (1/8 = 12.5% drift < 20% and < 4).
    const afterReload = [
      ...baseTabs.filter((entry) => entry.id !== 203),
      {
        id: 299,
        windowId: 1,
        index: 7,
        url: 'https://news.example/today',
        title: 'Daily brief',
        pinned: false,
        audible: false,
        active: false,
        discarded: false,
        hidden: false,
        incognito: false,
        groupId: NO_GROUP_ID,
      },
    ];
    vi.spyOn(fakeBrowser.windows, 'getLastFocused').mockResolvedValue({ id: 1 } as never);
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue(afterReload as never);
    vi.spyOn(fakeBrowser.tabs, 'move').mockResolvedValue({} as never);

    await saveSettings({
      ...DEFAULT_SETTINGS,
      autoOrganize: true,
      useTabGroups: false,
      autoOrganizeMode: 'topic',
      autoWindowMode: 'merge-windows',
      useOnDeviceAi: true,
    });

    const reloadedAutopilot = registerAutopilot({ now: () => NOW, capabilities: CHROME_CAPS });
    await reloadedAutopilot.run();
    await flushAsync();

    expect(createSpy).not.toHaveBeenCalled();

    // Turning on `aiRefreshEveryTab` forces an immediate AI refresh even for that 1 single new tab.
    await saveSettings({
      ...DEFAULT_SETTINGS,
      autoOrganize: true,
      useTabGroups: false,
      autoOrganizeMode: 'topic',
      autoWindowMode: 'merge-windows',
      useOnDeviceAi: true,
      aiRefreshEveryTab: true,
    });
    await reloadedAutopilot.run();
    await flushAsync();
    expect(createSpy).toHaveBeenCalledTimes(1);

    // After a browser restart reusing the same tab IDs for unrelated sites, stale proposal is
    // rejected and background AI refreshes once cleanly even with `aiRefreshEveryTab: false`.
    await saveSettings({
      ...DEFAULT_SETTINGS,
      autoOrganize: true,
      useTabGroups: false,
      autoOrganizeMode: 'topic',
      autoWindowMode: 'merge-windows',
      useOnDeviceAi: true,
      aiRefreshEveryTab: false,
    });
    const postRestartTabs = baseTabs.map((entry) => ({
      ...entry,
      url: `https://newsite-${String(entry.id)}.example/page`,
      title: `Different page ${String(entry.id)}`,
    }));
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue(postRestartTabs as never);
    await reloadedAutopilot.run();
    await flushAsync();

    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  it('defaults to non-destructive mode before onboarding and ignores runtime.onInstalled install events', async () => {
    expect(DEFAULT_SETTINGS.autoDeclutter).toBe(false);
    expect(DEFAULT_SETTINGS.autoOrganize).toBe(false);
    expect(await readSettings()).toMatchObject({ autoDeclutter: false, autoOrganize: false });

    const tabs: TabInfo[] = [
      {
        id: 1,
        windowId: 1,
        index: 0,
        url: 'about:blank',
        title: 'Blank',
        pinned: false,
        audible: false,
        active: false,
        discarded: false,
        hidden: false,
        incognito: false,
        groupId: NO_GROUP_ID,
      },
      {
        id: 2,
        windowId: 2,
        index: 0,
        url: 'https://docs.example/a',
        title: 'Docs A',
        pinned: false,
        audible: false,
        active: true,
        discarded: false,
        hidden: false,
        incognito: false,
        groupId: NO_GROUP_ID,
      },
    ];
    const removeSpy = vi.spyOn(fakeBrowser.tabs, 'remove').mockResolvedValue(undefined as never);
    const moveSpy = vi.spyOn(fakeBrowser.tabs, 'move').mockResolvedValue({} as never);
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue(tabs as never);
    vi.spyOn(fakeBrowser.windows, 'getLastFocused').mockResolvedValue({ id: 2 } as never);
    await activityItem.setValue({
      1: {
        tabId: 1,
        url: 'about:blank',
        createdAt: NOW - 3 * 3_600_000,
        lastActiveAt: NOW - 2 * 3_600_000,
        activations: 0,
        foregroundMs: 0,
      },
    });

    registerAutopilot({ now: () => NOW, debounceMs: 5, capabilities: CHROME_CAPS });
    await fakeBrowser.runtime.onInstalled.trigger({
      reason: 'install',
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(removeSpy).not.toHaveBeenCalled();
    expect(moveSpy).not.toHaveBeenCalled();

    // Updating an already-configured profile with autopilot enabled still schedules a sweep.
    await saveSettings({ ...DEFAULT_SETTINGS, autoDeclutter: true, autoOrganize: false });
    await fakeBrowser.runtime.onInstalled.trigger({
      reason: 'update',
      previousVersion: '0.1.0',
    });
    await new Promise((resolve) => setTimeout(resolve, 35));

    expect(removeSpy).toHaveBeenCalledWith([1]);
    expect(moveSpy).not.toHaveBeenCalled();
  });

  it('merges equivalent topics, splits QuotaExceededError batches, and keeps overflow tabs in ungrouped', async () => {
    const fakeTabs: TabInfo[] = Array.from({ length: 40 }, (_, i) => ({
      id: 100 + i,
      windowId: 1,
      index: i,
      url: `https://topic${String(Math.floor(i / 4))}.example/${String(i)}`,
      title:
        i < 4
          ? `Corrado Augias part ${String(i)}`
          : i >= 36
            ? `Augias Corrado extra ${String(i)}`
            : `Topic ${String(Math.floor(i / 4))} item ${String(i)}`,
      pinned: false,
      audible: false,
      active: i === 0,
      discarded: false,
      hidden: false,
      incognito: false,
      groupId: NO_GROUP_ID,
    }));

    let callIndex = 0;
    const batchLengths: number[] = [];
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async () => ({
        prompt: vi.fn(async (input: string) => {
          const lines = input
            .split('\n')
            .slice(1)
            .filter((line) => /^\d+\|/.test(line));
          batchLengths.push(lines.length);
          const idx = callIndex++;
          if (idx === 0) {
            throw new DOMException('Context full', 'QuotaExceededError');
          }
          const ids = lines.map((line) => Number(line.split('|')[0]));
          if (ids.length > 25) {
            return JSON.stringify({
              groups: [
                { name: 'Topic Alpha', tabIds: ids.slice(0, 4) },
                { name: 'Topic Beta', tabIds: ids.slice(4, 8) },
                { name: 'Topic Gamma', tabIds: ids.slice(8, 12) },
                { name: 'Topic Delta', tabIds: ids.slice(12, 16) },
                { name: 'Topic Epsilon', tabIds: ids.slice(16, 20) },
                { name: 'Topic Zeta', tabIds: ids.slice(20, 24) },
                { name: 'Corrado Augias', tabIds: ids.slice(24) },
              ],
            });
          }
          // Remaining halved batches return tiny/subset groups plus an overflow 9th group.
          return JSON.stringify({
            groups: [
              { name: 'Augias Corrado', tabIds: ids.slice(0, 3) },
              { name: 'SmallOverflowGroup', tabIds: ids.slice(3, 5) },
              { name: 'Topic Omega', tabIds: ids.slice(5) },
            ],
          });
        }),
        destroy: vi.fn(),
      })),
    });

    vi.spyOn(fakeBrowser.windows, 'getLastFocused').mockResolvedValue({ id: 1 } as never);
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue(fakeTabs as never);
    vi.spyOn(fakeBrowser.tabs, 'move').mockResolvedValue({} as never);
    await saveSettings({
      ...DEFAULT_SETTINGS,
      autoOrganize: true,
      useTabGroups: false,
      autoOrganizeMode: 'topic',
      autoWindowMode: 'merge-windows',
      useOnDeviceAi: true,
    });

    const autopilot = registerAutopilot({ now: () => NOW, capabilities: CHROME_CAPS });
    await autopilot.run();
    await flushAsync();

    // QuotaExceededError halved the first batch instead of triggering failure cooldown.
    expect(batchLengths.length).toBeGreaterThanOrEqual(3);
    expect(await aiBgCooldownUntilItem.getValue()).toBe(0);

    const saved = await readAiProposalState();
    const proposal = saved.proposal!;
    expect(proposal.groups.length).toBeLessThanOrEqual(8);
    // Equivalent names ("Corrado Augias" and "Augias Corrado") merged rather than splitting.
    const augiasGroups = proposal.groups.filter((g) => /augias/i.test(g.title));
    expect(augiasGroups).toHaveLength(1);
    // Zero movable tabs are dropped: grouped + ungrouped covers every one of the 40 tabs.
    const covered = new Set([
      ...proposal.groups.flatMap((g) => [...g.tabIds]),
      ...proposal.ungrouped,
    ]);
    expect(covered.size).toBe(fakeTabs.length);
  });

  it('serializes post-AI window moves with fresh focus and skips organizing if paused mid-inference', async () => {
    let releasePrompt!: (value: string) => void;
    let promptCount = 0;
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn(async () => 'available'),
      create: vi.fn(async () => ({
        prompt: vi.fn(
          () =>
            new Promise<string>((resolve) => {
              promptCount += 1;
              releasePrompt = resolve;
            }),
        ),
        destroy: vi.fn(),
      })),
    });

    const tabs: TabInfo[] = [
      {
        id: 1,
        windowId: 1,
        index: 0,
        url: 'https://rust-lang.org/a',
        title: 'Rust book',
        pinned: false,
        audible: false,
        active: false,
        discarded: false,
        hidden: false,
        incognito: false,
        groupId: NO_GROUP_ID,
      },
      {
        id: 2,
        windowId: 2,
        index: 0,
        url: 'https://rust-lang.org/b',
        title: 'Rust traits',
        pinned: false,
        audible: false,
        active: true,
        discarded: false,
        hidden: false,
        incognito: false,
        groupId: NO_GROUP_ID,
      },
      {
        id: 3,
        windowId: 1,
        index: 1,
        url: 'https://cooking.example/soup',
        title: 'Soup recipe',
        pinned: false,
        audible: false,
        active: true,
        discarded: false,
        hidden: false,
        incognito: false,
        groupId: NO_GROUP_ID,
      },
    ];
    let focusedWin = 1;
    vi.spyOn(fakeBrowser.windows, 'getLastFocused').mockImplementation(
      async () => ({ id: focusedWin }) as never,
    );
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue(tabs as never);
    const moveSpy = vi.spyOn(fakeBrowser.tabs, 'move').mockResolvedValue({} as never);
    const createWinSpy = vi
      .spyOn(fakeBrowser.windows, 'create')
      .mockResolvedValue({ id: 99 } as never);

    await saveSettings({
      ...DEFAULT_SETTINGS,
      autoOrganize: true,
      useTabGroups: false,
      autoOrganizeMode: 'topic',
      autoWindowMode: 'split-windows',
      useOnDeviceAi: true,
    });

    const autopilot = registerAutopilot({ now: () => NOW, capabilities: CHROME_CAPS });
    await autopilot.run();
    await flushAsync();
    expect(promptCount).toBe(1);

    // While inference was running, user paused duplicate guard & moved focus to window 2.
    focusedWin = 2;
    await pauseGuard(NOW + 60_000, 'auto');
    moveSpy.mockClear();
    createWinSpy.mockClear();
    releasePrompt(JSON.stringify({ groups: [{ name: 'Rust', tabIds: [1, 2] }] }));
    await flushAsync();
    // Paused mid-inference -> post-AI enqueue skips organizing windows.
    expect(moveSpy).not.toHaveBeenCalled();

    // Clear pause + startup grace -> next fresh run uses updated focused window 2 on apply.
    await pauseGuard(NOW - 1, 'auto');
    await startGuardGrace(NOW - 1);
    await saveAiProposalState(null, '');
    focusedWin = 1;
    await autopilot.run();
    await flushAsync();
    focusedWin = 2;
    releasePrompt(JSON.stringify({ groups: [{ name: 'Rust', tabIds: [1, 2] }] }));
    await flushAsync();
    // Rust bucket keeps window 2 (where its active focused tab 2 sits) and pulls tab 1 into win 2.
    expect(moveSpy).toHaveBeenCalledWith(1, expect.objectContaining({ windowId: 2 }));
  });
});

describe('background/report shutdown-aware logging', () => {
  it('suppresses console.error when storage no longer answers during browser shutdown', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(activityItem, 'getValue').mockRejectedValue(
      new Error('The browser is shutting down.'),
    );

    await reportBackgroundError('autopilot', new Error('The browser is shutting down.'));

    expect(errors).not.toHaveBeenCalled();
  });

  it('logs console.error when storage still answers (a real extension failure)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await reportBackgroundError('autopilot', new Error('unexpected'));

    expect(errors).toHaveBeenCalledWith('TabDeclutter: autopilot', expect.any(Error));
  });
});
