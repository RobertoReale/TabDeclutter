/**
 * Topical grouping with an on-device model (PLAN.md §7.3).
 *
 * The model is **injected**: everything here is pure TypeScript (TASKS.md §2.4), so the
 * whole logic — the prompt, the schema, the batching, the validation, the fallback — is
 * tested against a fake model, and `src/platform/llm.ts` (M5.2) only has to adapt Chrome's
 * Prompt API to the `Llm` interface below.
 *
 * What comes out is the same `GroupProposal` as `cluster.ts`: a proposal the Organize view
 * shows and the user edits, never an action. **The AI never decides what to close**
 * (PLAN.md §7.3, §3.1): it is asked for names and for which tabs belong together, and the
 * answer is checked against the tabs we sent before anything is shown. Every eligible tab
 * ends up in exactly one group or in "Altro" — the model can neither invent a tab nor make
 * one disappear.
 *
 * When the model cannot answer — a malformed answer, no usable group, the 20 s timeout,
 * "Annulla", a context the prompt does not fit in — the tabs it was asked about are grouped
 * by §7.2 instead. That proposal is computed first anyway: it is both the fallback and,
 * above `maxBatchTabs` tabs, the pre-clustering the batches are built from.
 */

import {
  assembleAiProposal,
  buildPrompt,
  errorName,
  packClusterBatches,
  SYSTEM_PROMPT,
  tabLine,
  validateAiAnswer,
} from './ai-prompt';
import type { AiDraft } from './ai-prompt';
import type { ClusterOptions, GroupProposal } from './cluster';
import { colorFor, DEFAULT_CLUSTER_OPTIONS, groupByTopic } from './cluster';
import type { TabInfo } from './types';

export { buildPrompt, SYSTEM_PROMPT, tabLine };

/** What `Llm.prompt` is given besides the input (PLAN.md §7.3). */
export interface LlmPromptOptions {
  /** The JSON Schema the answer must match (`responseConstraintFor`). */
  readonly responseConstraint?: unknown;
  /** Aborted on "Annulla" and when the timeout fires. */
  readonly signal?: AbortSignal;
  /** Optional live sub-stage diagnostic callback (e.g. `clone`, `prefill`, `streaming`). */
  readonly onStage?: (stage: string) => void;
}

/**
 * The model, as this module needs it: one session, already created with `SYSTEM_PROMPT`,
 * that answers a prompt with a string.
 *
 * `contextWindow`/`contextUsage` and `measureInputUsage` are the Prompt API's own, and all
 * three are optional: a model that does not report its context is simply asked, and a
 * `QuotaExceededError` is then handled the same way a context that does not fit is.
 */
export interface Llm {
  /** Tokens the session can hold in total, when the model reports it. */
  readonly contextWindow?: number;
  /** Tokens the session has already spent, when the model reports it. */
  readonly contextUsage?: number;
  /** Compact diagnostic trace of the most recent `prompt()` sub-stages (for fallback telemetry). */
  readonly lastTrace?: string;
  /** Warms/initialises the underlying session ahead of prompting, when supported. */
  open?(options?: { readonly signal?: AbortSignal }): Promise<void>;
  /** Registers a one-shot callback invoked when an in-flight background warmup completes. */
  onWarm?(listener: () => void): () => void;
  prompt(input: string, options?: LlmPromptOptions): Promise<string>;
  /** Tokens `input` would cost, when the model can measure it. */
  measureInputUsage?(input: string, options?: { signal?: AbortSignal }): Promise<number>;
}

/** Roughly how many characters of English a token is worth, when nobody can measure it. */
const CHARS_PER_TOKEN = 4;

/** Tokens left free for the answer when checking that a prompt fits the context. */
const OUTPUT_RESERVE_TOKENS = 300;

/** The numbers of PLAN.md §7.3, on top of the thresholds §7.2 already takes. */
export interface AiGroupingOptions extends ClusterOptions {
  /** PLAN.md §7.3: at most this many tabs in one prompt. */
  readonly maxBatchTabs?: number;
  /** The schema's `maxLength` for a group name. */
  readonly maxNameLength?: number;
  /** PLAN.md §7.3: the whole run has this long, then §7.2 answers instead. */
  readonly timeoutMs?: number;
  /** "Annulla" in the spinner (PLAN.md §7.3). */
  readonly signal?: AbortSignal;
  /** Optional live sub-stage diagnostic callback forwarded to `llm.prompt`. */
  readonly onStage?: (stage: string) => void;
  /** Injected clock (TASKS.md §2.4), which is what makes the timeout testable. */
  readonly now?: () => number;
}

export const DEFAULT_AI_GROUPING_OPTIONS = {
  maxBatchTabs: 40,
  maxNameLength: 24,
  timeoutMs: 20_000,
} as const;

/** Why §7.2 answered for a batch instead of the model. */
export type AiFallbackReason =
  /** There was nothing to group at all. */
  | 'empty'
  /** The 20 s budget ran out. */
  | 'timeout'
  /** "Annulla", or the caller's signal. */
  | 'aborted'
  /** Quota was exceeded, or a single tab did not fit the remaining context. */
  | 'quota'
  /** Not JSON, or JSON that is not the schema's shape. */
  | 'unparsable'
  /** Parsed, but not one usable group came out of it. */
  | 'no-groups'
  /** The model threw something else. */
  | 'error';

export interface AiGroupingResult {
  /** The same shape `cluster.ts` returns, so the Organize view does not care who made it. */
  readonly proposal: GroupProposal;
  /** `'ai'` when at least one prompt was answered usably, `'fallback'` when none was. */
  readonly source: 'ai' | 'fallback';
  /** How many prompts the run needed. */
  readonly prompts: number;
  /** How many of them the model answered usably. */
  readonly answered: number;
  /** The first failure, when there was one. */
  readonly fallbackReason?: AiFallbackReason;
  /** Short technical detail for the first failure (e.g. error name/message), when available. */
  readonly fallbackDetail?: string;
}

/**
 * The constrained output of PLAN.md §7.3: `{ groups: [{ name, tabIds }] }`, at most
 * `maxGroups` groups and `maxNameLength` characters per name.
 *
 * Built from the options rather than written out once, because the same two numbers bound
 * the validation below: a schema and a check that disagreed would be a bug nobody notices
 * until a model obeys the schema.
 */
export function responseConstraintFor(maxGroups: number, maxNameLength: number): unknown {
  return {
    type: 'object',
    properties: {
      groups: {
        type: 'array',
        maxItems: maxGroups,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: maxNameLength },
            tabIds: { type: 'array', items: { type: 'integer' } },
          },
          required: ['name', 'tabIds'],
        },
      },
    },
    required: ['groups'],
  };
}

/** Everything one run needs, resolved once: the numbers, the clock and its deadline. */
interface Settings {
  readonly maxBatchTabs: number;
  readonly maxNameLength: number;
  readonly maxGroups: number;
  readonly minClusterTabs: number;
  readonly signal: AbortSignal | undefined;
  readonly onStage: ((stage: string) => void) | undefined;
  readonly now: () => number;
  /** ms epoch at which §7.2 takes over, whatever the model is doing (PLAN.md §7.3). */
  readonly deadline: number;
  readonly constraint: unknown;
}

function resolve(options: AiGroupingOptions): Settings {
  const maxGroups = options.maxGroups ?? DEFAULT_CLUSTER_OPTIONS.maxGroups;
  const maxNameLength = options.maxNameLength ?? DEFAULT_AI_GROUPING_OPTIONS.maxNameLength;
  const now = options.now ?? Date.now;
  return {
    // A batch of nothing would never stop splitting, so one tab is the floor.
    maxBatchTabs: Math.max(1, options.maxBatchTabs ?? DEFAULT_AI_GROUPING_OPTIONS.maxBatchTabs),
    maxNameLength,
    maxGroups,
    minClusterTabs: options.minClusterTabs ?? DEFAULT_CLUSTER_OPTIONS.minClusterTabs,
    signal: options.signal,
    onStage: options.onStage,
    now,
    deadline: now() + (options.timeoutMs ?? DEFAULT_AI_GROUPING_OPTIONS.timeoutMs),
    constraint: responseConstraintFor(maxGroups, maxNameLength),
  };
}

/** What one prompt — or one batch that had to be split — came back with. */
interface Outcome {
  readonly drafts: readonly AiDraft[];
  /** Tabs the model itself put in "Other". */
  readonly ungrouped: readonly number[];
  /** Tabs no answer covered: §7.2 groups these. */
  readonly failed: readonly number[];
  readonly prompts: number;
  readonly answered: number;
  /** The first failure of this outcome, when there was one. */
  readonly reason: AiFallbackReason | undefined;
  /** Short diagnostic detail for `reason`, when available. */
  readonly detail: string | undefined;
}

function merged(left: Outcome, right: Outcome): Outcome {
  return {
    drafts: [...left.drafts, ...right.drafts],
    ungrouped: [...left.ungrouped, ...right.ungrouped],
    failed: [...left.failed, ...right.failed],
    prompts: left.prompts + right.prompts,
    answered: left.answered + right.answered,
    reason: left.reason ?? right.reason,
    detail: left.detail ?? right.detail,
  };
}

function failed(
  tabs: readonly TabInfo[],
  reason: AiFallbackReason,
  prompts: number,
  detail?: string,
): Outcome {
  return {
    drafts: [],
    ungrouped: [],
    failed: tabs.map((tab) => tab.id),
    prompts,
    answered: 0,
    reason,
    detail,
  };
}

/** The timer of PLAN.md §7.3 fired: told apart from the model's own errors by its type. */
class PromptTimeout extends Error {}

/** The name Chrome's Prompt API throws when the input does not fit the session. */
const QUOTA_ERROR = 'QuotaExceededError';

function errorDetail(error: unknown): string | undefined {
  if (error === null || error === undefined) return undefined;
  if (typeof error === 'object') {
    const name = errorName(error);
    const message =
      'message' in error && typeof (error as { message: unknown }).message === 'string'
        ? (error as { message: string }).message.trim()
        : '';
    if (name !== '' && message !== '') return `${name}: ${message}`.slice(0, 140);
    if (name !== '') return name.slice(0, 140);
    if (message !== '') return message.slice(0, 140);
  }
  return String(error).slice(0, 140);
}

/**
 * The model's answer, aborted when the run's deadline passes or the caller cancels.
 *
 * `setTimeout` and `AbortController` are language-level, not browser APIs, so using them
 * keeps this module pure (docs/DECISIONS.md, M5.1). The model is given an internal
 * controller: both the timeout and the caller's "Annulla" have to reach it, and the
 * caller's own signal is never aborted by us.
 */
async function promptWithin(llm: Llm, input: string, settings: Settings): Promise<string> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  settings.signal?.addEventListener('abort', onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((keep, reject) => {
      timer = setTimeout(
        () => {
          controller.abort();
          reject(new PromptTimeout('the model did not answer in time'));
        },
        Math.max(0, settings.deadline - settings.now()),
      );
      llm
        .prompt(input, {
          responseConstraint: settings.constraint,
          signal: controller.signal,
          ...(settings.onStage === undefined ? {} : { onStage: settings.onStage }),
        })
        .then(keep, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    settings.signal?.removeEventListener('abort', onAbort);
  }
}

/** What a prompt would cost in tokens, measured by the model or estimated from its length. */
async function inputCost(llm: Llm, input: string, signal?: AbortSignal): Promise<number> {
  const estimate = Math.ceil(input.length / CHARS_PER_TOKEN);
  if (llm.measureInputUsage === undefined) return estimate;
  try {
    return await llm.measureInputUsage(input, signal === undefined ? undefined : { signal });
  } catch {
    // Measuring is an optimisation; if it fails the estimate still answers the question.
    return estimate;
  }
}

/**
 * Whether the prompt fits what is left of the session's context (PLAN.md §7.3). A model
 * that reports no `contextWindow` is simply asked: `QuotaExceededError` says the same
 * thing one prompt later.
 */
async function fitsContext(llm: Llm, input: string, signal?: AbortSignal): Promise<boolean> {
  const window = llm.contextWindow;
  if (window === undefined || window <= 0) return true;
  const used = llm.contextUsage ?? 0;
  return used + (await inputCost(llm, input, signal)) + OUTPUT_RESERVE_TOKENS <= window;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * One batch, asked and validated, splitting in half while the prompt does not fit the
 * context or the model answers `QuotaExceededError` (PLAN.md §7.3). A single tab that
 * still does not fit gives up and lets §7.2 group it.
 */
async function askBatch(llm: Llm, batch: readonly TabInfo[], settings: Settings): Promise<Outcome> {
  if (isAborted(settings.signal)) return failed(batch, 'aborted', 0);
  if (settings.now() >= settings.deadline) {
    return failed(batch, 'timeout', 0, `deadline reached before batch (${batch.length} tabs)`);
  }

  const input = buildPrompt(batch);
  settings.onStage?.(`measure (${batch.length} tabs, ${input.length} chars)`);
  if (!(await fitsContext(llm, input, settings.signal))) {
    return split(llm, batch, settings, 'quota', 0);
  }
  if (isAborted(settings.signal)) return failed(batch, 'aborted', 0);

  let answer: string;
  try {
    answer = await promptWithin(llm, input, settings);
  } catch (error) {
    const name = errorName(error);
    const trace = llm.lastTrace !== undefined && llm.lastTrace !== '' ? ` · ${llm.lastTrace}` : '';
    if (error instanceof PromptTimeout || name === 'TimeoutError') {
      return failed(
        batch,
        'timeout',
        1,
        `prompt (${batch.length} tabs, ${input.length} chars)${trace}`,
      );
    }
    if (name === QUOTA_ERROR) return split(llm, batch, settings, 'quota', 1);
    if (name === 'AbortError') return failed(batch, 'aborted', 1);
    const detail = errorDetail(error);
    return failed(batch, 'error', 1, detail === undefined ? trace.slice(3) : `${detail}${trace}`);
  }

  const checked = validateAiAnswer(answer, batch, settings);
  if (!checked.ok) {
    const compact = answer.replace(/\s+/gu, ' ').trim();
    const preview =
      compact.length <= 140 ? compact : `${compact.slice(0, 80)} … ${compact.slice(-55)}`;
    return failed(
      batch,
      checked.reason,
      1,
      `batch (${batch.length} tabs) raw=${JSON.stringify(preview)}`,
    );
  }
  return {
    drafts: checked.drafts,
    ungrouped: checked.ungrouped,
    failed: checked.failed,
    prompts: 1,
    answered: 1,
    reason: undefined,
    detail: undefined,
  };
}

/** The batch halved and asked again, or given up on when there is nothing left to halve. */
async function split(
  llm: Llm,
  batch: readonly TabInfo[],
  settings: Settings,
  reason: AiFallbackReason,
  prompts: number,
): Promise<Outcome> {
  if (batch.length < 2) return failed(batch, reason, prompts);
  const half = Math.ceil(batch.length / 2);
  const first = await askBatch(llm, batch.slice(0, half), settings);
  const second = await askBatch(llm, batch.slice(half), settings);
  const outcome = merged(first, second);
  return { ...outcome, prompts: outcome.prompts + prompts };
}

/** One window's tabs, in the order they were given. */
function byWindow(tabs: readonly TabInfo[]): readonly { windowId: number; tabs: TabInfo[] }[] {
  const windows = new Map<number, TabInfo[]>();
  for (const tab of tabs) {
    const found = windows.get(tab.windowId);
    if (found === undefined) windows.set(tab.windowId, [tab]);
    else found.push(tab);
  }
  return [...windows].map(([windowId, own]) => ({ windowId, tabs: own }));
}

function planBatches(
  eligible: readonly TabInfo[],
  fallback: GroupProposal,
  settings: Settings,
): readonly (readonly TabInfo[])[] {
  const batches: (readonly TabInfo[])[] = [];
  for (const { windowId, tabs: own } of byWindow(eligible)) {
    const windowGroups = fallback.groups
      .filter((group) => group.windowId === windowId)
      .map((group) => group.tabIds);
    batches.push(...packClusterBatches(own, windowGroups, settings.maxBatchTabs));
  }
  return batches;
}

/** §7.2's groups for the tabs the model could not answer about, with their own names. */
function fallbackDrafts(
  fallback: GroupProposal,
  failedIds: ReadonlySet<number>,
  settings: Settings,
): { drafts: readonly AiDraft[]; ungrouped: readonly number[] } {
  const drafts: AiDraft[] = [];
  const claimed = new Set<number>();
  for (const group of fallback.groups) {
    const members = group.tabIds.filter((id) => failedIds.has(id));
    if (members.length < settings.minClusterTabs) continue;
    for (const id of members) claimed.add(id);
    drafts.push({ title: group.title, windowId: group.windowId, tabIds: members });
  }
  return { drafts, ungrouped: [...failedIds].filter((id) => !claimed.has(id)) };
}

/**
 * By topic, with the model (PLAN.md §7.3). `tabs` is the whole scope the user chose; the
 * options are §7.2's, plus the batch size, the timeout and the signal.
 *
 * Never throws and never leaves a tab out: whatever the model does, the proposal covers
 * exactly the tabs §7.2 would have considered, and `source` says who grouped them.
 */
export async function groupByAi(
  tabs: readonly TabInfo[],
  llm: Llm,
  options: AiGroupingOptions = {},
): Promise<AiGroupingResult> {
  const settings = resolve(options);
  const fallback = groupByTopic(tabs, options);

  // §7.2 decided which tabs are eligible — pinned, grouped, hidden — and that is the
  // whole set it mentions, so there is no second copy of those rules here.
  const mentioned = new Set<number>([
    ...fallback.groups.flatMap((group) => [...group.tabIds]),
    ...fallback.ungrouped,
  ]);
  const eligible = tabs.filter((tab) => mentioned.has(tab.id));
  if (eligible.length === 0) {
    return {
      proposal: fallback,
      source: 'fallback',
      prompts: 0,
      answered: 0,
      fallbackReason: 'empty',
    };
  }

  let outcome: Outcome = {
    drafts: [],
    ungrouped: [],
    failed: [],
    prompts: 0,
    answered: 0,
    reason: undefined,
    detail: undefined,
  };
  for (const batch of planBatches(eligible, fallback, settings)) {
    outcome = merged(outcome, await askBatch(llm, batch, settings));
  }

  if (outcome.answered === 0) {
    // Nothing of the model survived: §7.2's own proposal, untouched, is the answer.
    return {
      proposal: fallback,
      source: 'fallback',
      prompts: outcome.prompts,
      answered: 0,
      fallbackReason: outcome.reason,
      ...(outcome.detail === undefined ? {} : { fallbackDetail: outcome.detail }),
    };
  }

  const recovered = fallbackDrafts(fallback, new Set(outcome.failed), settings);
  const position = new Map(eligible.map((tab, at) => [tab.id, at]));
  const proposal = assembleAiProposal(
    [...outcome.drafts, ...recovered.drafts],
    [...outcome.ungrouped, ...recovered.ungrouped],
    position,
    byWindow(eligible).map((window) => window.windowId),
    settings.maxGroups,
    colorFor,
  );
  return {
    proposal,
    source: 'ai',
    prompts: outcome.prompts,
    answered: outcome.answered,
    ...(outcome.reason === undefined ? {} : { fallbackReason: outcome.reason }),
    ...(outcome.detail === undefined ? {} : { fallbackDetail: outcome.detail }),
  };
}
