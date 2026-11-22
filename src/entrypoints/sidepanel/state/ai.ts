/**
 * The on-device model as the panel sees it (PLAN.md §7.3): whether there is one, whether
 * the user wants it, and the one session it groups with.
 *
 * Nothing here imports `platform/llm.ts` for real. The module — and `core/ai-grouping.ts`
 * behind it — is reached with `await import()` (PLAN.md §11), so a panel that never opens
 * Organize, and the Firefox build, which can never have a model at all, do not load it.
 * The imports below are type-only, which TypeScript erases.
 *
 * `capabilities` and the module itself are parameters with defaults, as everywhere else in
 * the panel (TASKS.md §2.4): a test hands in `promptApi: false` or a `LanguageModel` of its
 * own instead of pretending to be Chrome.
 *
 * The AI only ever proposes groups. Settings, closes and the guard do not consult it
 * (PLAN.md §7.3: "The AI never decides what to close").
 */

import { computed, signal } from '@preact/signals';

import { DEFAULT_SETTINGS } from '@/core/types';
import type { Llm } from '@/core/ai-grouping';
import { caps, type Capabilities } from '@/platform/capabilities';
import type { AiAvailability, LlmModule } from '@/platform/llm';
import { updateSettings } from '@/platform/storage';
import { applyLocalSettings, panelData } from './tabs';

export type { AiAvailability } from '@/platform/llm';

/** What the panel may be told (TASKS.md §2.4). Both have real defaults. */
export interface AiDeps {
  readonly capabilities?: Capabilities;
  readonly llm?: LlmModule;
}

/** Where the browser stands, and `null` until someone has asked (PLAN.md §7.3). */
export const availability = signal<AiAvailability | null>(null);

/** `downloadprogress`'s `loaded` while the model is coming down, `null` otherwise. */
export const downloadProgress = signal<number | null>(null);

/** The setting of §4.6, which only matters where there is a model to use. */
export const useAi = computed(
  () => panelData.value?.settings.useOnDeviceAi ?? DEFAULT_SETTINGS.useOnDeviceAi,
);

/**
 * Whether the AI row is shown at all (PLAN.md §7.3, §5.5): a browser with no model, or one
 * that will not give it, is not told about a feature it cannot have.
 */
export const aiOffered = computed(
  () =>
    availability.value === 'downloadable' ||
    availability.value === 'downloading' ||
    availability.value === 'available',
);

/** Whether the next grouping by topic goes to the model: there is one, and it is wanted. */
export const aiActive = computed(() => availability.value === 'available' && useAi.value);

/**
 * Asks the browser where it stands, once per panel (PLAN.md §7.3, "Detection and state").
 *
 * `promptApi` answers first, so nothing downstream has to know about capabilities: on
 * Firefox this settles to `'unsupported'` without the module ever being fetched.
 */
export async function checkAi(deps: AiDeps = {}): Promise<AiAvailability> {
  const capabilities = deps.capabilities ?? caps;
  if (!capabilities.promptApi) {
    availability.value = 'unsupported';
    return 'unsupported';
  }
  const module = await llmModule(deps);
  const state = await module.checkAvailability();
  availability.value = state;
  if (state !== 'downloading') downloadProgress.value = null;
  // When the model is already downloaded and the user opted in, begin warming the session
  // in the background immediately so weights and D3D12 shaders load before Organize is clicked.
  if (state === 'available' && useAi.value) {
    void module
      .panelSession({ timeoutMs: PANEL_AI_TIMEOUT_MS })
      .open?.()
      .catch(() => undefined);
  }
  return state;
}

/**
 * "Attiva AI on-device" (PLAN.md §7.3): the only place the download can start, because it
 * is the only one with the user's click behind it.
 *
 * Turning it on is also saying yes to using it, so the setting of §4.6 goes with it — a
 * user who waited for a multi-gigabyte download did not mean "and now leave it idle".
 */
export async function enableAi(deps: AiDeps = {}): Promise<AiAvailability> {
  const capabilities = deps.capabilities ?? caps;
  if (!capabilities.promptApi) return 'unsupported';
  const module = await llmModule(deps);

  availability.value = 'downloading';
  downloadProgress.value = 0;
  await setUseAi(true);
  const state = await module.downloadModel({
    onProgress: (loaded) => {
      downloadProgress.value = loaded;
    },
  });
  availability.value = state;
  downloadProgress.value = null;
  return state;
}

/** The checkbox of §4.6 and §4.4.2. Serialized read-change-write so rapid toggles never race. */
export async function setUseAi(next: boolean): Promise<void> {
  const updated = await updateSettings((current) =>
    current.useOnDeviceAi === next ? current : { ...current, useOnDeviceAi: next },
  );
  applyLocalSettings(updated);
}

/**
 * Warmup budget for loading Gemini Nano into memory once per side-panel session, kept separate
 * from the grouping prompt budget so cold-start latency (including Windows D3D12 background
 * compute shader compilation at Idle thread priority on 4 GB VRAM GPUs) never eats into
 * inference time.
 */
export const PANEL_AI_WARMUP_TIMEOUT_MS = 600_000;

/**
 * Prompt budget for interactive on-device AI grouping in the side panel: enough for cold-start
 * prefill and JSON generation on medium-class GPUs while remaining interruptible at any
 * millisecond via Cancel.
 */
export const PANEL_AI_TIMEOUT_MS = 90_000;

/** The panel's session, created on the first prompt and reused (PLAN.md §7.3). */
export async function aiModel(deps: AiDeps = {}): Promise<Llm> {
  return (await llmModule(deps)).panelSession({ timeoutMs: PANEL_AI_TIMEOUT_MS });
}

/**
 * The panel is closing: the session goes with it (PLAN.md §7.3, "Performance").
 *
 * Only if the module was ever loaded — a panel that never grouped by topic has no session
 * to destroy, and fetching the module in order to find that out would be absurd.
 */
export function closeAi(): void {
  loaded?.closeSession();
}

/** Forgets the state between tests, which is all a module singleton needs. */
export function resetAi(): void {
  availability.value = null;
  downloadProgress.value = null;
  loaded = null;
  loading = null;
}

/** The module once it has arrived, which is also what `closeAi` needs to see. */
let loaded: LlmModule | null = null;
/** The `import()` while it is in flight, so two callers share one fetch. */
let loading: Promise<LlmModule> | null = null;

async function llmModule(deps: AiDeps): Promise<LlmModule> {
  if (deps.llm !== undefined) {
    loaded = deps.llm;
    return deps.llm;
  }
  if (loaded !== null) return loaded;
  loading ??= import('@/platform/llm').then((module) => {
    loaded = module;
    loading = null;
    return module;
  });
  return loading;
}
