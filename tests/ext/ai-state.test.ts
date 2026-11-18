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
import { beforeEach, describe, expect, it } from 'vitest';
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
  aiWorking,
  cancelAiGrouping,
  draft,
  resetAiGrouping,
  setMode,
  setOptions,
  setScope,
  startAiGrouping,
} from '../../src/entrypoints/sidepanel/state/organize';
import { brought } from '../../src/entrypoints/sidepanel/state/organize-request';
import { panelData, type PanelData } from '../../src/entrypoints/sidepanel/state/tabs';
import type { Capabilities } from '../../src/platform/capabilities';
import type { AiAvailability, DownloadOptions, LlmModule } from '../../src/platform/llm';
import { readSettings } from '../../src/platform/storage';

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
