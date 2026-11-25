/**
 * The on-device model as the panel uses it (PLAN.md §7.3): what it knows about it, what
 * the user may turn on, and what the Organize view does with the answer.
 *
 * `platform/llm.ts` is covered on its own in `tests/unit/llm.test.ts`; what is in question
 * here is the wiring — that a browser without the Prompt API never even loads the module
 * (invariant 10), that "Usa l'AI on-device" is a setting and not a variable, and that the
 * model's proposal reaches the preview without ever being the only thing that can.
 *
 * Both seams are parameters with defaults (TASKS.md §2.4): `capabilities` and the module
 * itself, so nothing here pretends to be Chrome.
 */

import { effect } from '@preact/signals';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import type { AiGroupingResult, Llm } from '../../src/core/ai-grouping';
import type { GroupProposal } from '../../src/core/cluster';
import type { TabInfo } from '../../src/core/types';
import { DEFAULT_SETTINGS, NO_GROUP_ID } from '../../src/core/types';
import {
  aiActive,
  aiOffered,
  availability,
  checkAi,
  closeAi,
  downloadProgress,
  enableAi,
  resetAi,
  setUseAi,
  useAi,
} from '../../src/entrypoints/sidepanel/state/ai';
import {
  aiBadge,
  aiFallbackNotice,
  aiProposalCoversMovable,
  aiProposalFreshForAutoRefresh,
  aiWorking,
  cancelAiGrouping,
  clearSavedAiProposal,
  draft,
  isAiAutoCoolingDown,
  loadSavedAiProposal,
  organizeWindowsWithAi,
  resetAiGrouping,
  savedAiProposal,
  setMode,
  setOptions,
  setScope,
  startAiGrouping,
  undoWindowOrganize,
  windowOrganized,
  windowPlan,
} from '../../src/entrypoints/sidepanel/state/organize';
import { brought } from '../../src/entrypoints/sidepanel/state/organize-request';
import { setSetting } from '../../src/entrypoints/sidepanel/state/settings';
import { panelData, type PanelData } from '../../src/entrypoints/sidepanel/state/tabs';
import type { Capabilities } from '../../src/platform/capabilities';
import type { AiAvailability, DownloadOptions, LlmModule } from '../../src/platform/llm';
import {
  aiProposalItem,
  organizeSnoozeUntilItem,
  readSettings,
  saveAiProposalState,
  saveSettings,
} from '../../src/platform/storage';
import {
  movableTabsSignature,
  type OrganizeWindowsOptions,
  type OrganizeWindowsSnapshot,
} from '../../src/platform/windows';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** Chrome, as far as anything here cares. */
const CHROME: Capabilities = {
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

/** Firefox: no Prompt API, and nothing that follows from having one. */
const FIREFOX: Capabilities = {
  ...CHROME,
  sidePanel: false,
  sidebarAction: true,
  faviconApi: false,
  promptApi: false,
  duplicateCommandDetection: false,
  tabContextMenu: true,
};

/** `platform/llm.ts` without a browser: it answers what the test told it to. */
class FakeLlm implements LlmModule {
  state: AiAvailability = 'available';
  /** What `downloadprogress` reports before the download ends. */
  steps: readonly number[] = [0.25, 1];
  checks = 0;
  downloads = 0;
  closes = 0;
  /** The session `panelSession()` hands out, which is what `groupByAi` would be given. */
  readonly session: Llm = {
    prompt: async () => '{"groups":[]}',
  };

  checkAvailability = async (): Promise<AiAvailability> => {
    this.checks += 1;
    return this.state;
  };

  downloadModel = async (options: DownloadOptions = {}): Promise<AiAvailability> => {
    this.downloads += 1;
    for (const loaded of this.steps) options.onProgress?.(loaded);
    this.state = 'available';
    return this.state;
  };

  panelSession = (): Llm => this.session;

  closeSession = (): void => {
    this.closes += 1;
  };
}

function tab(id: number, url: string, overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id,
    windowId: 1,
    index: id,
    url,
    title: `Tab ${String(id)}`,
    pinned: false,
    audible: false,
    active: false,
    discarded: false,
    hidden: false,
    groupId: NO_GROUP_ID,
    incognito: false,
    ...overrides,
  };
}

/** Six tabs the heuristic of §7.2 groups by itself, so there is always something to show. */
function tabs(): TabInfo[] {
  return [
    tab(1, 'https://github.com/preact/one'),
    tab(2, 'https://github.com/preact/two'),
    tab(3, 'https://github.com/preact/three'),
    tab(4, 'https://figma.com/design/one'),
    tab(5, 'https://figma.com/design/two'),
    tab(6, 'https://figma.com/design/three'),
  ];
}

function data(open: readonly TabInfo[] = tabs()): PanelData {
  return {
    tabs: open,
    activity: {},
    settings: DEFAULT_SETTINGS,
    keeps: {},
    protectedSites: [],
    whitelist: [],
    bookmarks: new Set<string>(),
    focusedWindowId: 1,
    ownOrigin: 'chrome-extension://test',
    at: NOW,
  };
}

/** What the model "answered": two groups of three, which is nothing §7.2 would say. */
function aiProposal(): GroupProposal {
  return {
    mode: 'topic',
    groups: [
      { key: 'reading', title: 'Reading', color: 'blue', windowId: 1, tabIds: [1, 4] },
      { key: 'work', title: 'Work', color: 'green', windowId: 1, tabIds: [2, 3, 5, 6] },
    ],
    ungrouped: [],
  };
}

function answered(source: 'ai' | 'fallback' = 'ai'): AiGroupingResult {
  return { proposal: aiProposal(), source, prompts: 1, answered: source === 'ai' ? 1 : 0 };
}

let llm: FakeLlm;

beforeEach(async () => {
  fakeBrowser.reset();
  llm = new FakeLlm();
  resetAi();
  resetAiGrouping();
  panelData.value = data();
  setScope('window');
  setMode('topic');
  setOptions({ sortByGroup: false, collapse: false, leavePinnedOut: true, includeGrouped: false });
  brought.value = null;
  await Promise.resolve();
});

describe('what the browser can do (§7.3, §5.5)', () => {
  it('is unsupported on Firefox, and the module is never even loaded', async () => {
    await expect(checkAi({ capabilities: FIREFOX, llm })).resolves.toBe('unsupported');

    expect(availability.value).toBe('unsupported');
    expect(llm.checks).toBe(0);
    expect(aiOffered.value).toBe(false);
    expect(aiActive.value).toBe(false);
  });

  it.each(['unavailable', 'downloadable', 'downloading', 'available'] as const)(
    'reports %s as the browser does',
    async (state) => {
      llm.state = state;

      await expect(checkAi({ capabilities: CHROME, llm })).resolves.toBe(state);
      expect(availability.value).toBe(state);
    },
  );

  it('offers the AI only where there is one to offer', async () => {
    llm.state = 'unavailable';
    await checkAi({ capabilities: CHROME, llm });
    expect(aiOffered.value).toBe(false);

    llm.state = 'downloadable';
    await checkAi({ capabilities: CHROME, llm });
    expect(aiOffered.value).toBe(true);
  });

  it('is active only when there is a model and the user wants it', async () => {
    await checkAi({ capabilities: CHROME, llm });
    expect(useAi.value).toBe(false);
    expect(aiActive.value).toBe(false);

    panelData.value = {
      ...data(),
      settings: { ...DEFAULT_SETTINGS, useOnDeviceAi: true },
    };
    expect(useAi.value).toBe(true);
    expect(aiActive.value).toBe(true);
  });
});

describe('turning the AI on (§4.4.2, §7.3)', () => {
  it('downloads only when asked, reporting where it has got to', async () => {
    llm.state = 'downloadable';
    await checkAi({ capabilities: CHROME, llm });
    expect(llm.downloads).toBe(0);

    // Every value the "Scaricamento del modello… 50%" line and the row itself would
    // have shown, in order: a progress nobody can see is no progress (§7.3).
    const seen: (number | null)[] = [];
    const states: (AiAvailability | null)[] = [];
    const watching = [
      effect(() => {
        seen.push(downloadProgress.value);
      }),
      effect(() => {
        states.push(availability.value);
      }),
    ];
    llm.steps = [0.25, 0.5, 1];

    await enableAi({ capabilities: CHROME, llm });
    for (const stop of watching) stop();

    expect(llm.downloads).toBe(1);
    expect(seen).toEqual([null, 0, 0.25, 0.5, 1, null]);
    // The row says "downloading" while it comes down, and never looks idle in between.
    expect(states).toEqual(['downloadable', 'downloading', 'available']);
    expect(downloadProgress.value).toBeNull();
  });

  it('is also the user saying yes to using it', async () => {
    await setUseAi(false);
    llm.state = 'downloadable';

    await enableAi({ capabilities: CHROME, llm });

    await expect(readSettings()).resolves.toMatchObject({ useOnDeviceAi: true });
  });

  it('does nothing at all on a browser that has no Prompt API', async () => {
    await expect(enableAi({ capabilities: FIREFOX, llm })).resolves.toBe('unsupported');
    expect(llm.downloads).toBe(0);
  });

  it('writes the checkbox of §4.6 to the settings, not to a variable', async () => {
    await setUseAi(false);
    await expect(readSettings()).resolves.toMatchObject({ useOnDeviceAi: false });

    await setUseAi(true);
    await expect(readSettings()).resolves.toMatchObject({ useOnDeviceAi: true });
  });

  it('destroys the session when the panel closes, and only if there was one', async () => {
    closeAi();
    expect(llm.closes).toBe(0);

    await checkAi({ capabilities: CHROME, llm });
    closeAi();
    expect(llm.closes).toBe(1);
  });
});

describe('grouping by topic with the model (§7.3)', () => {
  /**
   * §7.2's own answer to the question being asked, read off the preview before the model
   * is involved. Taken and not written out, because what the heuristic calls its groups is
   * `core/cluster.ts`'s business and is covered there: what matters here is only whether
   * the preview is still showing it or has been replaced.
   */
  let heuristic: readonly string[];

  beforeEach(async () => {
    panelData.value = {
      ...data(),
      settings: { ...DEFAULT_SETTINGS, useOnDeviceAi: true },
    };
    await checkAi({ capabilities: CHROME, llm });
    heuristic = draft.value.groups.map((group) => group.key);
    expect(heuristic.length).toBeGreaterThan(0);
  });

  it('replaces the heuristic with what the model answered, and says so', async () => {
    await startAiGrouping({ groupBy: async () => answered() });

    expect(draft.value.groups.map((group) => group.title)).toEqual(['Reading', 'Work']);
    expect(aiBadge.value).toBe(true);
    expect(aiWorking.value).toBe(false);
  });

  it('asks the panel session, with the options of §7.2 and a signal', async () => {
    const given: { model: Llm; options: Record<string, unknown> }[] = [];
    await startAiGrouping({
      groupBy: async (_tabs, model, options = {}) => {
        given.push({ model, options: options as Record<string, unknown> });
        return answered();
      },
    });

    expect(given).toHaveLength(1);
    // The session is the panel's one, reached through `aiModel()`: this test hands in no
    // model of its own, so what arrives is whatever `state/ai.ts` loaded.
    expect(given[0]?.model).toBe(llm.session);
    expect(given[0]?.options.signal).toBeInstanceOf(AbortSignal);
    // "Lascia fuori i tab fissati" is on, "Includi i tab già raggruppati" is not (§4.4.4):
    // the model is asked about the same tabs the heuristic would have grouped.
    expect(given[0]?.options).toMatchObject({ includePinned: false, includeGrouped: false });
  });

  it('is not asked at all when grouping by site', async () => {
    setMode('site');
    const bySite = draft.value.groups.map((group) => group.key);
    let asked = 0;

    await startAiGrouping({
      groupBy: async () => {
        asked += 1;
        return answered();
      },
    });

    expect(asked).toBe(0);
    expect(bySite).toEqual(['github.com', 'figma.com']);
    expect(draft.value.groups.map((group) => group.key)).toEqual(bySite);
  });

  it('is not asked when the user turned it off', async () => {
    panelData.value = { ...data(), settings: { ...DEFAULT_SETTINGS, useOnDeviceAi: false } };
    let asked = 0;

    await startAiGrouping({
      groupBy: async () => {
        asked += 1;
        return answered();
      },
    });

    expect(asked).toBe(0);
    expect(aiBadge.value).toBe(false);
  });

  it('keeps §7.2 on screen when the model did not answer', async () => {
    await startAiGrouping({ groupBy: async () => answered('fallback') });

    expect(draft.value.groups.map((group) => group.key)).toEqual(heuristic);
    expect(aiBadge.value).toBe(false);
  });

  it('keeps §7.2 on screen when the model could not even be reached', async () => {
    await startAiGrouping({
      groupBy: () => Promise.reject(new Error('the session is gone')),
    });

    expect(draft.value.groups.map((group) => group.key)).toEqual(heuristic);
    expect(aiBadge.value).toBe(false);
    expect(aiWorking.value).toBe(false);
  });

  it('is interruptible: "Annulla" aborts the run it is waiting for', async () => {
    let aborted = false;
    let started: () => void = () => undefined;
    const running = new Promise<void>((begun) => {
      started = begun;
    });
    const pending = startAiGrouping({
      groupBy: async (_tabs, _model, options = {}) =>
        new Promise<AiGroupingResult>((keep) => {
          started();
          options.signal?.addEventListener('abort', () => {
            aborted = true;
            // What `groupByAi` does on an abort: §7.2's proposal, with no model in it.
            keep(answered('fallback'));
          });
        }),
    });

    expect(aiWorking.value).toBe(true);
    // The run reaches the model through an `import()` and the session: the cancel has to
    // be the user's, after it has started, not a race with the module loading.
    await running;
    cancelAiGrouping();
    await pending;

    expect(aborted).toBe(true);
    expect(aiWorking.value).toBe(false);
    expect(aiBadge.value).toBe(false);
  });

  it('spends one prompt per question, not one per visit to the view', async () => {
    let asked = 0;
    const groupBy = async (): Promise<AiGroupingResult> => {
      asked += 1;
      return answered();
    };

    await startAiGrouping({ groupBy });
    await startAiGrouping({ groupBy });

    expect(asked).toBe(1);
  });

  it('drops the answer when the question changes', async () => {
    await startAiGrouping({ groupBy: async () => answered() });
    expect(aiBadge.value).toBe(true);

    setScope('all');

    expect(aiBadge.value).toBe(false);
    expect(draft.value.groups.map((group) => group.title)).not.toContain('Reading');
  });
});

describe('persisting topic + AI preferences without resets or races', () => {
  it('preserves every rapid setting change made back to back without overwriting any', async () => {
    setSetting('autoOrganizeMode', 'topic');
    void setUseAi(true);
    setSetting('autoWindowMode', 'split-windows');

    // Wait for the serialized local:settings queue to drain.
    await setUseAi(true);
    const stored = await readSettings();
    expect(stored.autoOrganizeMode).toBe('topic');
    expect(stored.useOnDeviceAi).toBe(true);
    expect(stored.autoWindowMode).toBe('split-windows');
  });

  it('uses the on-device AI proposal for window organization and saves it for autopilot', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, autoOrganizeMode: 'topic', useOnDeviceAi: true });
    await checkAi({ capabilities: CHROME, llm });
    const received: OrganizeWindowsOptions[] = [];

    await organizeWindowsWithAi({
      windowMode: 'split-windows',
      clusterMode: 'topic',
      useTabGroups: false,
      useAi: true,
      focusedWindowId: 1,
      deps: {
        groupBy: async () => answered('ai'),
        organize: async (opts) => {
          received.push(opts);
          return { movedTabs: 4, ungroupedTabs: 0, windowsCount: 2 };
        },
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.proposal?.groups.map((g) => g.title)).toEqual(['Reading', 'Work']);
    expect(aiFallbackNotice.value).toBe(false);
    expect((await aiProposalItem.getValue())?.groups.map((g) => g.title)).toEqual([
      'Reading',
      'Work',
    ]);
  });

  it('warns on AI failure and never flips useOnDeviceAi or autoOrganizeMode', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, autoOrganizeMode: 'topic', useOnDeviceAi: true });
    await checkAi({ capabilities: CHROME, llm });
    const received: OrganizeWindowsOptions[] = [];

    await organizeWindowsWithAi({
      windowMode: 'split-windows',
      clusterMode: 'topic',
      useTabGroups: false,
      useAi: true,
      deps: {
        groupBy: async () => ({
          ...answered('fallback'),
          fallbackReason: 'timeout',
        }),
        organize: async (opts) => {
          received.push(opts);
          return { movedTabs: 2, ungroupedTabs: 0, windowsCount: 2 };
        },
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.proposal).toBeUndefined();
    expect(aiFallbackNotice.value).toBe(true);
    const stored = await readSettings();
    expect(stored.autoOrganizeMode).toBe('topic');
    expect(stored.useOnDeviceAi).toBe(true);
  });

  it('falls back without changing settings when the model reports unavailable', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, autoOrganizeMode: 'topic', useOnDeviceAi: true });
    llm.state = 'unavailable';
    await checkAi({ capabilities: CHROME, llm });
    const received: OrganizeWindowsOptions[] = [];

    await organizeWindowsWithAi({
      windowMode: 'split-windows',
      clusterMode: 'topic',
      useTabGroups: false,
      useAi: true,
      deps: {
        organize: async (opts) => {
          received.push(opts);
          return { movedTabs: 1, ungroupedTabs: 0, windowsCount: 2 };
        },
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.proposal).toBeUndefined();
    const stored = await readSettings();
    expect(stored.autoOrganizeMode).toBe('topic');
    expect(stored.useOnDeviceAi).toBe(true);
  });

  it('stops cleanly on Cancel without scrambling windows or raising a warning', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, autoOrganizeMode: 'topic', useOnDeviceAi: true });
    await checkAi({ capabilities: CHROME, llm });
    let organized = 0;
    let started: () => void = () => undefined;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });

    const pending = organizeWindowsWithAi({
      windowMode: 'split-windows',
      clusterMode: 'topic',
      useTabGroups: false,
      useAi: true,
      deps: {
        groupBy: async (_tabs, _model, options = {}) =>
          new Promise<AiGroupingResult>((resolve) => {
            started();
            options.signal?.addEventListener('abort', () => {
              resolve({ ...answered('fallback'), fallbackReason: 'aborted' });
            });
          }),
        organize: async () => {
          organized += 1;
          return { movedTabs: 0, ungroupedTabs: 0, windowsCount: 1 };
        },
      },
    });

    await begun;
    cancelAiGrouping();
    await pending;

    expect(organized).toBe(0);
    expect(aiWorking.value).toBe(false);
    expect(aiFallbackNotice.value).toBe(false);
    const stored = await readSettings();
    expect(stored.autoOrganizeMode).toBe('topic');
    expect(stored.useOnDeviceAi).toBe(true);
  });

  it('remaps 10-digit Chrome tab IDs to compact 1..N IDs for the model and restores real IDs', async () => {
    const bigTabs: TabInfo[] = [
      tab(1_396_528_417, 'https://gemini.google.com/app/1', { title: 'Basi ortogonali' }),
      tab(1_396_528_429, 'https://gemini.google.com/app/2', { title: 'Dubbi su derivate' }),
      tab(1_396_528_501, 'https://youtube.com/watch?v=1', { title: 'Live #30', windowId: 2 }),
      tab(1_396_528_512, 'https://youtube.com/watch?v=2', { title: 'Live #33', windowId: 2 }),
    ];
    panelData.value = {
      ...data(bigTabs),
      settings: { ...DEFAULT_SETTINGS, autoOrganizeMode: 'topic', useOnDeviceAi: true },
    };
    await checkAi({ capabilities: CHROME, llm });
    let seenIds: number[] = [];
    const received: OrganizeWindowsOptions[] = [];

    await organizeWindowsWithAi({
      windowMode: 'split-windows',
      clusterMode: 'topic',
      useTabGroups: false,
      useAi: true,
      deps: {
        groupBy: async (inputTabs) => {
          seenIds = inputTabs.map((t) => t.id);
          return {
            source: 'ai',
            prompts: 1,
            answered: 1,
            proposal: {
              mode: 'topic',
              groups: [
                { key: 'math', title: 'Math', color: 'blue', windowId: 1, tabIds: [1, 2] },
                { key: 'videos', title: 'Videos', color: 'red', windowId: 1, tabIds: [3, 4] },
              ],
              ungrouped: [],
            },
          };
        },
        organize: async (opts) => {
          received.push(opts);
          return { movedTabs: 4, ungroupedTabs: 0, windowsCount: 2 };
        },
      },
    });

    // The model only ever saw compact 1..4 IDs, never 10-digit Chrome IDs.
    expect(seenIds).toEqual([1, 2, 3, 4]);
    // `organizeWindows` received the exact original 10-digit Chrome tab IDs back.
    expect(received[0]?.proposal?.groups).toEqual([
      {
        key: 'math',
        title: 'Math',
        color: 'blue',
        windowId: 1,
        tabIds: [1_396_528_417, 1_396_528_429],
      },
      {
        key: 'videos',
        title: 'Videos',
        color: 'red',
        windowId: 1,
        tabIds: [1_396_528_501, 1_396_528_512],
      },
    ]);
  });

  it('captures undo snapshot after window organization and snoozes background autoOrganize on Undo', async () => {
    const snapshot: OrganizeWindowsSnapshot = {
      tabs: [{ tabId: 1, windowId: 1, index: 0, active: true }],
      focusedWindowId: 1,
    };

    await organizeWindowsWithAi({
      windowMode: 'split-windows',
      clusterMode: 'site',
      useTabGroups: false,
      useAi: false,
      deps: {
        organize: async () => ({
          movedTabs: 2,
          ungroupedTabs: 0,
          windowsCount: 2,
          undo: snapshot,
        }),
      },
    });

    expect(windowOrganized.value).toEqual({
      movedTabs: 2,
      windowsCount: 2,
      undo: snapshot,
    });

    const undone: OrganizeWindowsSnapshot[] = [];
    await undoWindowOrganize(async (snap) => {
      undone.push(snap);
      return 2;
    });

    expect(undone).toEqual([snapshot]);
    expect(windowOrganized.value).toBeNull();
    expect(await organizeSnoozeUntilItem.getValue()).toBeGreaterThan(Date.now());
  });

  it('hydrates savedAiProposal for windowPlan, clusters newly opened tabs, and clears on fallback or toggle-off', async () => {
    const initial = tabs();
    panelData.value = {
      ...data(initial),
      settings: { ...DEFAULT_SETTINGS, autoOrganizeMode: 'topic', useOnDeviceAi: true },
    };
    setMode('topic');

    expect(windowPlan.value.source).toBe('local');
    expect(aiProposalCoversMovable(null, initial)).toBe(false);

    await aiProposalItem.setValue(aiProposal());
    await loadSavedAiProposal();
    expect(savedAiProposal.value?.groups.map((g) => g.title)).toEqual(['Reading', 'Work']);
    expect(aiProposalCoversMovable(savedAiProposal.value, initial)).toBe(true);
    expect(windowPlan.value.source).toBe('ai');
    expect(windowPlan.value.groups.map((g) => g.title)).toEqual(['Reading', 'Work']);

    // Opening 2 new tabs not in the cached AI proposal: coverage becomes false (triggering
    // refresh in OrganizeView), while windowPlan still clusters the new pair cleanly.
    const withNew = [
      ...initial,
      tab(7, 'https://cooking.example/pasta-1', { title: 'Pasta ricetta facile' }),
      tab(8, 'https://cooking.example/pasta-2', { title: 'Pasta ricetta veloce' }),
    ];
    panelData.value = {
      ...data(withNew),
      settings: { ...DEFAULT_SETTINGS, autoOrganizeMode: 'topic', useOnDeviceAi: true },
    };
    expect(aiProposalCoversMovable(savedAiProposal.value, withNew)).toBe(false);
    expect(windowPlan.value.source).toBe('ai');
    expect(windowPlan.value.groups.length).toBe(3);

    clearSavedAiProposal();
    expect(savedAiProposal.value).toBeNull();
    expect(windowPlan.value.source).toBe('local');
    expect(await aiProposalItem.getValue()).toBeNull();
  });

  it('warms model.open() before groupBy, logs console.info on fallback, and cools down automatic retries only', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await saveSettings({ ...DEFAULT_SETTINGS, autoOrganizeMode: 'topic', useOnDeviceAi: true });
    await checkAi({ capabilities: CHROME, llm });

    const order: string[] = [];
    const warmableModel: Llm = {
      open: async () => {
        order.push('open');
      },
      prompt: async () => '{"groups":[]}',
    };

    let organizeCalls = 0;
    // First automatic run fails with timeout -> enters cooldown and does not emit console.warn.
    await organizeWindowsWithAi({
      windowMode: 'split-windows',
      clusterMode: 'topic',
      useTabGroups: false,
      useAi: true,
      automatic: true,
      deps: {
        model: warmableModel,
        groupBy: async () => {
          order.push('groupBy');
          return { ...answered('fallback'), fallbackReason: 'timeout' };
        },
        organize: async () => {
          organizeCalls += 1;
          return { movedTabs: 1, ungroupedTabs: 0, windowsCount: 2 };
        },
      },
    });

    expect(order).toEqual(['open', 'groupBy']);
    expect(isAiAutoCoolingDown()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalled();
    expect(organizeCalls).toBe(1);

    // A second automatic run during cooldown is skipped without running AI or moving windows.
    await organizeWindowsWithAi({
      windowMode: 'split-windows',
      clusterMode: 'topic',
      useTabGroups: false,
      useAi: true,
      automatic: true,
      deps: {
        model: warmableModel,
        groupBy: async () => {
          order.push('should-not-run');
          return answered('ai');
        },
        organize: async () => {
          organizeCalls += 1;
          return { movedTabs: 1, ungroupedTabs: 0, windowsCount: 2 };
        },
      },
    });
    expect(order).toEqual(['open', 'groupBy']);
    expect(organizeCalls).toBe(1);

    // An explicit manual click clears cooldown and succeeds immediately.
    await organizeWindowsWithAi({
      windowMode: 'split-windows',
      clusterMode: 'topic',
      useTabGroups: false,
      useAi: true,
      deps: {
        model: warmableModel,
        groupBy: async () => {
          order.push('manual-groupBy');
          return answered('ai');
        },
        organize: async () => {
          organizeCalls += 1;
          return { movedTabs: 2, ungroupedTabs: 0, windowsCount: 2 };
        },
      },
    });
    expect(order).toEqual(['open', 'groupBy', 'open', 'manual-groupBy']);
    expect(isAiAutoCoolingDown()).toBe(false);
    expect(organizeCalls).toBe(2);

    info.mockRestore();
    warn.mockRestore();
  });

  it('uses a single incremental micro-prompt on automatic refreshes when a cached AI proposal covers >= 80% of live tabs', async () => {
    const initialTabs: TabInfo[] = [
      tab(10, 'https://gemini.google.com/app/1', { title: 'Prodotto scalare' }),
      tab(11, 'https://gemini.google.com/app/2', { title: 'Derivate funzioni' }),
      tab(12, 'https://youtube.com/watch?v=1', { title: 'Corrado Augias 1' }),
      tab(13, 'https://youtube.com/watch?v=2', { title: 'Corrado Augias 2' }),
      tab(14, 'https://youtube.com/watch?v=3', { title: 'Corrado Augias 3' }),
      tab(15, 'https://youtube.com/watch?v=4', { title: 'Corrado Augias 4' }),
    ];
    const cachedProposal: GroupProposal = {
      mode: 'topic',
      groups: [
        { key: 'math', title: 'Mathematics', color: 'cyan', windowId: 1, tabIds: [10, 11] },
        {
          key: 'augias',
          title: 'Corrado Augias',
          color: 'blue',
          windowId: 1,
          tabIds: [12, 13, 14, 15],
        },
      ],
      ungrouped: [],
    };
    const sig = movableTabsSignature(initialTabs);
    await saveAiProposalState(cachedProposal, sig);
    await loadSavedAiProposal();

    // User opens 1 new math tab (6/7 = 85.7% covered -> incremental micro-prompt eligible).
    const withOneNew: TabInfo[] = [
      ...initialTabs,
      tab(16, 'https://youtube.com/watch?v=int', { title: 'Integrali doppi spiegazione' }),
    ];
    panelData.value = {
      ...data(withOneNew),
      settings: { ...DEFAULT_SETTINGS, autoOrganizeMode: 'topic', useOnDeviceAi: true },
    };
    await checkAi({ capabilities: CHROME, llm });

    const promptsSeen: string[] = [];
    const incrementalModel: Llm = {
      prompt: async (input) => {
        promptsSeen.push(input);
        return JSON.stringify({ groups: [{ name: 'Mathematics', tabIds: [1] }] });
      },
    };
    const organized: OrganizeWindowsOptions[] = [];

    await organizeWindowsWithAi({
      windowMode: 'split-windows',
      clusterMode: 'topic',
      useTabGroups: false,
      useAi: true,
      automatic: true,
      deps: {
        model: incrementalModel,
        organize: async (opts) => {
          organized.push(opts);
          return { movedTabs: 1, ungroupedTabs: 0, windowsCount: 2 };
        },
      },
    });

    // Only the 1 new tab was sent to the model, and it joined Mathematics without disturbing Augias.
    expect(promptsSeen).toHaveLength(1);
    expect(promptsSeen[0]).toContain('Existing topics: Mathematics, Corrado Augias');
    expect(promptsSeen[0]).toContain('1|Integrali doppi spiegazione|youtube.com');
    expect(promptsSeen[0]).not.toContain('Corrado Augias 1');
    expect(
      organized[0]?.proposal?.groups.map((g) => ({ title: g.title, tabIds: g.tabIds })),
    ).toEqual([
      { title: 'Corrado Augias', tabIds: [12, 13, 14, 15] },
      { title: 'Mathematics', tabIds: [10, 11, 16] },
    ]);
  });

  it('keeps checkAi() read-only without eagerly invoking panelSession().open()', async () => {
    let opened = 0;
    const probingLlm: LlmModule = {
      checkAvailability: async () => 'available',
      downloadModel: async () => 'available',
      panelSession: () => ({
        open: async () => {
          opened += 1;
        },
        prompt: async () => '{"groups":[]}',
      }),
      closeSession: () => undefined,
    };
    panelData.value = {
      ...data(),
      settings: { ...DEFAULT_SETTINGS, useOnDeviceAi: true },
    };

    await expect(checkAi({ capabilities: CHROME, llm: probingLlm })).resolves.toBe('available');
    expect(opened).toBe(0);
  });

  it('persists local AI proposals across reloads, tolerates closed tabs and small drift, and rejects post-restart ID collisions', async () => {
    const initial = [
      ...tabs(),
      tab(7, 'https://docs.python.org/3/library/math.html', { title: 'Math module' }),
      tab(8, 'https://docs.python.org/3/library/json.html', { title: 'JSON module' }),
    ];
    const proposal: GroupProposal = {
      mode: 'topic',
      groups: [
        { key: 'code', title: 'Code', color: 'blue', windowId: 1, tabIds: [1, 2, 3] },
        { key: 'design', title: 'Design', color: 'green', windowId: 1, tabIds: [4, 5, 6] },
        { key: 'python', title: 'Python', color: 'yellow', windowId: 1, tabIds: [7, 8] },
      ],
      ungrouped: [],
    };
    const sig = movableTabsSignature(initial);
    await saveAiProposalState(proposal, sig);

    // Simulate extension/panel reload: in-memory state resets, storage.local keeps the plan.
    resetAiGrouping();
    panelData.value = {
      ...data(initial),
      settings: { ...DEFAULT_SETTINGS, autoOrganizeMode: 'topic', useOnDeviceAi: true },
    };
    setMode('topic');
    await loadSavedAiProposal();
    expect(windowPlan.value.source).toBe('ai');
    expect(aiProposalCoversMovable(savedAiProposal.value, initial, sig)).toBe(true);
    expect(aiProposalFreshForAutoRefresh(savedAiProposal.value, initial, sig)).toBe(true);

    // Closing a tab or updating an unread "(2) " title badge keeps both exact coverage and freshness true.
    const afterCloseAndBadge = initial
      .filter((entry) => entry.id !== 3)
      .map((entry) => (entry.id === 1 ? { ...entry, title: '(2) Tab 1' } : entry));
    expect(aiProposalCoversMovable(savedAiProposal.value, afterCloseAndBadge, sig)).toBe(true);
    expect(aiProposalFreshForAutoRefresh(savedAiProposal.value, afterCloseAndBadge, sig)).toBe(
      true,
    );
    expect(
      aiProposalFreshForAutoRefresh(savedAiProposal.value, afterCloseAndBadge, sig, true),
    ).toBe(true);

    // Opening 1 new tab out of 9 (11% drift, < 4 tabs): default stays fresh, exact mode triggers refresh.
    const withOneNew = [...initial, tab(9, 'https://news.example/story', { title: 'Daily news' })];
    expect(aiProposalCoversMovable(savedAiProposal.value, withOneNew, sig)).toBe(false);
    expect(aiProposalFreshForAutoRefresh(savedAiProposal.value, withOneNew, sig)).toBe(true);
    expect(aiProposalFreshForAutoRefresh(savedAiProposal.value, withOneNew, sig, true)).toBe(false);

    // Opening 4 new tabs crosses the drift threshold and triggers an automatic AI refresh.
    const withFourNew = [
      ...initial,
      tab(9, 'https://news.example/1', { title: 'News 1' }),
      tab(10, 'https://news.example/2', { title: 'News 2' }),
      tab(11, 'https://news.example/3', { title: 'News 3' }),
      tab(12, 'https://news.example/4', { title: 'News 4' }),
    ];
    expect(aiProposalFreshForAutoRefresh(savedAiProposal.value, withFourNew, sig)).toBe(false);

    // Browser restart reusing the same tab IDs 1..8 for completely different websites:
    // signature validation rejects the stale plan so windowPlan cleanly falls back to local.
    const collidedAfterRestart = initial.map((entry) =>
      tab(entry.id, `https://unrelated-${String(entry.id)}.example/page`, {
        title: `Fresh session ${String(entry.id)}`,
      }),
    );
    panelData.value = {
      ...data(collidedAfterRestart),
      settings: { ...DEFAULT_SETTINGS, autoOrganizeMode: 'topic', useOnDeviceAi: true },
    };
    expect(aiProposalFreshForAutoRefresh(savedAiProposal.value, collidedAfterRestart, sig)).toBe(
      false,
    );
    expect(windowPlan.value.source).toBe('local');
  });
});
