/**
 * Background autopilot reliability tests: static MV3 execution (no dynamic import), durable
 * startup alarms (≥ 30 s per Chrome 120+ minimum), ephemeral LanguageModel session destruction,
 * persistent cooldowns, re-checked settings after inference, and shutdown-aware error reporting.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { DEFAULT_SETTINGS, NO_GROUP_ID } from '../../src/core/types';
import { registerAutopilot } from '../../src/entrypoints/background/autopilot';
import { reportBackgroundError } from '../../src/entrypoints/background/report';
import type { Capabilities } from '../../src/platform/capabilities';
import {
  activityItem,
  aiBgCooldownUntilItem,
  preemptBackgroundAi,
  readAiProposalState,
  saveAiProposalState,
  saveSettings,
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

    // After a browser restart reusing the same tab IDs for unrelated sites, stale proposal is
    // rejected and background AI refreshes once cleanly.
    const postRestartTabs = baseTabs.map((entry) => ({
      ...entry,
      url: `https://newsite-${String(entry.id)}.example/page`,
      title: `Different page ${String(entry.id)}`,
    }));
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue(postRestartTabs as never);
    await reloadedAutopilot.run();
    await flushAsync();

    expect(createSpy).toHaveBeenCalledTimes(1);
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
