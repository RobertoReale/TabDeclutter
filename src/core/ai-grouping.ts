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

import type { ClusterOptions, GroupProposal, ProposedGroup } from './cluster';
import { colorFor, DEFAULT_CLUSTER_OPTIONS, groupByTopic } from './cluster';
import type { TabInfo } from './types';
import { displayHost } from './url';

/** What `Llm.prompt` is given besides the input (PLAN.md §7.3). */
export interface LlmPromptOptions {
  /** The JSON Schema the answer must match (`responseConstraintFor`). */
  readonly responseConstraint?: unknown;
  /** Aborted on "Annulla" and when the timeout fires. */
  readonly signal?: AbortSignal;
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
  prompt(input: string, options?: LlmPromptOptions): Promise<string>;
  /** Tokens `input` would cost, when the model can measure it. */
  measureInputUsage?(input: string, options?: { signal?: AbortSignal }): Promise<number>;
}

/**
 * The system prompt of PLAN.md §7.3, word for word. In English: the Prompt API officially
 * supports en/ja/es/de/fr, and Italian titles are passed in as data (PLAN.md §3.5).
 *
 * Exported rather than sent with every prompt: a session is created once and reused
 * (PLAN.md §7.3, "Performance"), so this belongs to its creation, in `platform/llm.ts`.
 */
export const SYSTEM_PROMPT =
  'You organize browser tabs into a small number of topical groups. ' +
  "Group by the user's task or topic, not by website. " +
  'Use short group names (1-3 words). Prefer 3-8 groups. ' +
  "Tabs that fit nowhere go to 'Other'.";

/** PLAN.md §7.3: the title a tab is listed with is truncated to this many characters. */
const MAX_INPUT_TITLE_CHARS = 80;

/** How a group name says "this tab belongs nowhere", in the prompt and in the answer. */
const OTHER_NAMES: ReadonlySet<string> = new Set(['other', 'others', 'altro', 'altri']);

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

/**
 * One tab as the model sees it (PLAN.md §7.3): `id|title|host`, the title truncated to 80
 * characters.
 *
 * `|` and every newline are replaced in the title, and runs of whitespace collapsed: a
 * title is untrusted input (TASKS.md §2.7), and the only thing keeping one line one tab is
 * that a title can neither carry the separator nor end the line.
 */
export function tabLine(tab: Pick<TabInfo, 'id' | 'title' | 'url'>): string {
  const title = tab.title
    .replace(/[|\s]+/gu, ' ')
    .trim()
    .slice(0, MAX_INPUT_TITLE_CHARS)
    .trim();
  return `${tab.id}|${title}|${displayHost(tab.url)}`;
}

/** The prompt for one batch: the tab list, and what to answer with. */
export function buildPrompt(tabs: readonly Pick<TabInfo, 'id' | 'title' | 'url'>[]): string {
  return [
    'Group these tabs. One tab per line, as id|title|host:',
    tabs.map((tab) => tabLine(tab)).join('\n'),
    'Answer with JSON only. Use each id at most once, and no id that is not listed.',
  ].join('\n');
}

/** Everything one run needs, resolved once: the numbers, the clock and its deadline. */
interface Settings {
  readonly maxBatchTabs: number;
  readonly maxNameLength: number;
  readonly maxGroups: number;
  readonly minClusterTabs: number;
  readonly signal: AbortSignal | undefined;
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
    now,
    deadline: now() + (options.timeoutMs ?? DEFAULT_AI_GROUPING_OPTIONS.timeoutMs),
    constraint: responseConstraintFor(maxGroups, maxNameLength),
  };
}

/** A group being built, before the per-window limit and the ordering are applied. */
interface Draft {
  readonly title: string;
  readonly windowId: number;
  readonly tabIds: readonly number[];
}

/** What one prompt — or one batch that had to be split — came back with. */
interface Outcome {
  readonly drafts: readonly Draft[];
  /** Tabs the model itself put in "Other". */
  readonly ungrouped: readonly number[];
  /** Tabs no answer covered: §7.2 groups these. */
  readonly failed: readonly number[];
  readonly prompts: number;
  readonly answered: number;
  /** The first failure of this outcome, when there was one. */
  readonly reason: AiFallbackReason | undefined;
}

function merged(left: Outcome, right: Outcome): Outcome {
  return {
    drafts: [...left.drafts, ...right.drafts],
    ungrouped: [...left.ungrouped, ...right.ungrouped],
    failed: [...left.failed, ...right.failed],
    prompts: left.prompts + right.prompts,
    answered: left.answered + right.answered,
    reason: left.reason ?? right.reason,
  };
}

function failed(tabs: readonly TabInfo[], reason: AiFallbackReason, prompts: number): Outcome {
  return {
    drafts: [],
    ungrouped: [],
    failed: tabs.map((tab) => tab.id),
    prompts,
    answered: 0,
    reason,
  };
}

/** The timer of PLAN.md §7.3 fired: told apart from the model's own errors by its type. */
class PromptTimeout extends Error {}

/** The name Chrome's Prompt API throws when the input does not fit the session. */
const QUOTA_ERROR = 'QuotaExceededError';

function errorName(error: unknown): string {
  return error !== null && typeof error === 'object' && 'name' in error
    ? String((error as { name: unknown }).name)
    : '';
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
        .prompt(input, { responseConstraint: settings.constraint, signal: controller.signal })
        .then(keep, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    settings.signal?.removeEventListener('abort', onAbort);
  }
}

/** What a prompt would cost in tokens, measured by the model or estimated from its length. */
async function inputCost(llm: Llm, input: string): Promise<number> {
  const estimate = Math.ceil(input.length / CHARS_PER_TOKEN);
  if (llm.measureInputUsage === undefined) return estimate;
  try {
    return await llm.measureInputUsage(input);
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
async function fitsContext(llm: Llm, input: string): Promise<boolean> {
  const window = llm.contextWindow;
  if (window === undefined || window <= 0) return true;
  const used = llm.contextUsage ?? 0;
  return used + (await inputCost(llm, input)) + OUTPUT_RESERVE_TOKENS <= window;
}

/**
 * The answer, validated against the tabs it was asked about (PLAN.md §7.3).
 *
 * It fails when the answer cannot be used at all, and says which of the two ways it was:
 * `unparsable` (not JSON, or JSON that is not the schema's shape) or `no-groups` (JSON the
 * schema would accept, with not one usable group left in it after the checks). Otherwise
 * every id the model invented is discarded, every id it repeated counts once, and every
 * tab of the batch it did not mention is in `ungrouped` — which is exactly "missing IDs go
 * to Other".
 */
type Validation =
  | { readonly ok: true; readonly drafts: readonly Draft[]; readonly ungrouped: readonly number[] }
  | { readonly ok: false; readonly reason: 'unparsable' | 'no-groups' };

const UNPARSABLE: Validation = { ok: false, reason: 'unparsable' };

function validate(answer: string, batch: readonly TabInfo[], settings: Settings): Validation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return UNPARSABLE;
  }
  if (parsed === null || typeof parsed !== 'object') return UNPARSABLE;
  const groups = (parsed as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return UNPARSABLE;

  const allowed = new Set(batch.map((tab) => tab.id));
  const windowId = (batch[0] as TabInfo).windowId;
  const taken = new Set<number>();
  const drafts: Draft[] = [];

  for (const group of groups) {
    if (group === null || typeof group !== 'object') continue;
    const { name, tabIds } = group as { name?: unknown; tabIds?: unknown };
    if (typeof name !== 'string' || !Array.isArray(tabIds)) continue;

    const members: number[] = [];
    for (const id of tabIds) {
      // An invented id is discarded, and a repeated one belongs to the first group that
      // claimed it: a tab cannot be in two native groups anyway (PLAN.md §7.4).
      if (typeof id !== 'number' || !Number.isInteger(id)) continue;
      if (!allowed.has(id) || taken.has(id)) continue;
      taken.add(id);
      members.push(id);
    }

    const title = name.replace(/\s+/gu, ' ').trim().slice(0, settings.maxNameLength).trim();
    // "Other" is the model's way of saying "nowhere", and PLAN.md §7.2.4 does not group
    // it; an unnamed group could not be applied either, and a group below
    // `minClusterTabs` is not worth one. Their tabs fall through to "Altro" below.
    if (title === '' || OTHER_NAMES.has(title.toLowerCase())) continue;
    if (members.length < settings.minClusterTabs) continue;
    drafts.push({ title, windowId, tabIds: members });
  }

  if (drafts.length === 0) return { ok: false, reason: 'no-groups' };
  // "Altro" is everything no group kept: the tabs the model forgot, and the ones it put
  // in a group that was then dropped. A claimed id stays claimed even so, because the
  // first group to ask for it is the only one allowed to have it.
  const grouped = new Set(drafts.flatMap((draft) => draft.tabIds));
  const ungrouped = batch.filter((tab) => !grouped.has(tab.id)).map((tab) => tab.id);
  return { ok: true, drafts, ungrouped };
}

/**
 * One batch, asked and validated, splitting in half while the prompt does not fit the
 * context or the model answers `QuotaExceededError` (PLAN.md §7.3). A single tab that
 * still does not fit gives up and lets §7.2 group it.
 */
async function askBatch(llm: Llm, batch: readonly TabInfo[], settings: Settings): Promise<Outcome> {
  if (settings.signal?.aborted === true) return failed(batch, 'aborted', 0);
  if (settings.now() >= settings.deadline) return failed(batch, 'timeout', 0);

  const input = buildPrompt(batch);
  if (!(await fitsContext(llm, input))) return split(llm, batch, settings, 'quota', 0);

  let answer: string;
  try {
    answer = await promptWithin(llm, input, settings);
  } catch (error) {
    if (error instanceof PromptTimeout) return failed(batch, 'timeout', 1);
    const name = errorName(error);
    if (name === QUOTA_ERROR) return split(llm, batch, settings, 'quota', 1);
    if (name === 'AbortError') return failed(batch, 'aborted', 1);
    return failed(batch, 'error', 1);
  }

  const checked = validate(answer, batch, settings);
  if (!checked.ok) return failed(batch, checked.reason, 1);
  return {
    drafts: checked.drafts,
    ungrouped: checked.ungrouped,
    failed: [],
    prompts: 1,
    answered: 1,
    reason: undefined,
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

/**
 * The macro-clusters of one window, biggest first: §7.2's groups, then its "Altro" tabs
 * one by one, with anything longer than a batch cut into batch-sized pieces.
 */
function macroClusters(
  own: readonly TabInfo[],
  fallback: GroupProposal,
  windowId: number,
  settings: Settings,
): readonly TabInfo[][] {
  const byId = new Map(own.map((tab) => [tab.id, tab]));
  const clusters: TabInfo[][] = [];
  const grouped = new Set<number>();
  for (const group of fallback.groups) {
    if (group.windowId !== windowId) continue;
    const members = group.tabIds.map((id) => byId.get(id)).filter((tab) => tab !== undefined);
    for (const id of group.tabIds) grouped.add(id);
    for (let at = 0; at < members.length; at += settings.maxBatchTabs) {
      clusters.push(members.slice(at, at + settings.maxBatchTabs));
    }
  }
  // "Altro" is not one cluster: those tabs resemble nothing in particular, so each is free
  // to be packed with whatever comes next, and the model may still find a topic in them.
  for (const tab of own) {
    if (!grouped.has(tab.id)) clusters.push([tab]);
  }
  return clusters;
}

/**
 * The prompts the run will make (PLAN.md §7.3): one per window while the window fits in a
 * batch, otherwise §7.2's macro-clusters packed into batches of at most `maxBatchTabs`.
 *
 * Packing rather than one prompt per macro-cluster: with 300 tabs the clusters are mostly
 * pairs, and 150 prompts would never finish inside the 20 s budget. A macro-cluster is
 * never spread over two prompts unless it is larger than a whole batch
 * (docs/DECISIONS.md, M5.1).
 */
function planBatches(
  eligible: readonly TabInfo[],
  fallback: GroupProposal,
  settings: Settings,
): readonly TabInfo[][] {
  const batches: TabInfo[][] = [];
  for (const { windowId, tabs: own } of byWindow(eligible)) {
    if (own.length <= settings.maxBatchTabs) {
      batches.push(own);
      continue;
    }
    let current: TabInfo[] = [];
    for (const cluster of macroClusters(own, fallback, windowId, settings)) {
      if (current.length > 0 && current.length + cluster.length > settings.maxBatchTabs) {
        batches.push(current);
        current = [];
      }
      current.push(...cluster);
    }
    if (current.length > 0) batches.push(current);
  }
  return batches;
}

/** §7.2's groups for the tabs the model could not answer about, with their own names. */
function fallbackDrafts(
  fallback: GroupProposal,
  failedIds: ReadonlySet<number>,
  settings: Settings,
): { drafts: readonly Draft[]; ungrouped: readonly number[] } {
  const drafts: Draft[] = [];
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
 * The drafts turned into a proposal: merged by name inside a window, biggest group first,
 * at most `maxGroups` per window, the rest in "Altro" (PLAN.md §7.2.4, §7.2.6).
 *
 * Two drafts with the same name in the same window are one group: the name is what the
 * user sees, and two prompts about one window have no way of agreeing not to collide. The
 * key, and so the colour, is the lower-case name, exactly as in §7.2 (docs/DECISIONS.md,
 * M4.1).
 */
function assemble(
  drafts: readonly Draft[],
  ungrouped: readonly number[],
  position: ReadonlyMap<number, number>,
  windows: readonly number[],
  settings: Settings,
): GroupProposal {
  const groups: ProposedGroup[] = [];
  const rest = [...ungrouped];
  /** Where a tab sits in the scope, which is every tie-break below. */
  const at = (id: number): number => position.get(id) ?? 0;

  for (const windowId of windows) {
    // Keyed by the lower-case name, holding the first spelling of it: the group is called
    // what the model called it, and only the case is lost on the way.
    const byKey = new Map<string, { title: string; tabIds: number[] }>();
    for (const draft of drafts) {
      if (draft.windowId !== windowId) continue;
      const key = draft.title.toLowerCase();
      const found = byKey.get(key);
      if (found === undefined) byKey.set(key, { title: draft.title, tabIds: [...draft.tabIds] });
      else found.tabIds.push(...draft.tabIds);
    }

    const ordered = [...byKey]
      .map(([key, group]) => ({
        ...group,
        key,
        tabIds: group.tabIds.sort((a, b) => at(a) - at(b)),
      }))
      .sort((a, b) =>
        a.tabIds.length !== b.tabIds.length
          ? b.tabIds.length - a.tabIds.length
          : at(a.tabIds[0] as number) - at(b.tabIds[0] as number),
      );

    for (const [rank, group] of ordered.entries()) {
      if (rank >= settings.maxGroups) {
        rest.push(...group.tabIds);
        continue;
      }
      groups.push({
        key: group.key,
        title: group.title,
        color: colorFor(group.key),
        windowId,
        tabIds: group.tabIds,
      });
    }
  }

  return { mode: 'topic', groups, ungrouped: rest.sort((a, b) => at(a) - at(b)) };
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
    };
  }

  const recovered = fallbackDrafts(fallback, new Set(outcome.failed), settings);
  const position = new Map(eligible.map((tab, at) => [tab.id, at]));
  const proposal = assemble(
    [...outcome.drafts, ...recovered.drafts],
    [...outcome.ungrouped, ...recovered.ungrouped],
    position,
    byWindow(eligible).map((window) => window.windowId),
    settings,
  );
  return {
    proposal,
    source: 'ai',
    prompts: outcome.prompts,
    answered: outcome.answered,
    ...(outcome.reason === undefined ? {} : { fallbackReason: outcome.reason }),
  };
}
