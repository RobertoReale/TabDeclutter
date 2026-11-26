/**
 * Prompt formatting and resilient JSON answer validation for on-device AI grouping (PLAN.md §7.3).
 *
 * Kept separate from `core/ai-grouping.ts` (which imports `groupByTopic` for multi-batch
 * pre-clustering and fallback) so the background service worker can build prompts and validate
 * model answers statically without pulling `groupByTopic`'s title/site tables into its bundle.
 */

import {
  foldAccents,
  STOPWORDS,
  stripSiteSuffix,
  type GroupColor,
  type GroupProposal,
  type ProposedGroup,
} from './cluster';
import type { TabInfo } from './types';
import { displayHost } from './url';

export function errorName(error: unknown): string {
  return error !== null && typeof error === 'object' && 'name' in error
    ? String((error as { name: unknown }).name)
    : '';
}

/**
 * The system prompt of PLAN.md §7.3, word for word. In English: the Prompt API officially
 * supports en/ja/es/de/fr, and Italian titles are passed in as data (PLAN.md §3.5).
 *
 * Exported rather than sent with every prompt: a session is created once and reused
 * (PLAN.md §7.3, "Performance"), so this belongs to its creation, in `platform/llm.ts`.
 */
export const SYSTEM_PROMPT =
  'Group tabs into focused topics with specific short names (1-3 words, e.g. person, course, subject). ' +
  "Group by the user's task or topic, not by website. " +
  'Be strict: never mix unrelated tabs or use vague umbrella names like "Philosophy & History" or "Culture & Society"; ignore typos, no site names. ' +
  "Tabs that fit nowhere go to 'Other'.";

/** PLAN.md §7.3: the title a tab is listed with is truncated to this many characters. */
const MAX_INPUT_TITLE_CHARS = 80;

/** How a group name says "this tab belongs nowhere", in the prompt and in the answer. */
const OTHER_NAMES: ReadonlySet<string> = new Set(
  'other others altro altri misc miscellaneous general various mixed'.split(' '),
);

/** A group being built, before the per-window limit and the ordering are applied. */
export interface AiDraft {
  readonly title: string;
  readonly windowId: number;
  readonly tabIds: readonly number[];
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
export type AiValidation =
  | {
      readonly ok: true;
      readonly drafts: readonly AiDraft[];
      readonly ungrouped: readonly number[];
      readonly failed: readonly number[];
    }
  | { readonly ok: false; readonly reason: 'unparsable' | 'no-groups' };

export interface ValidateAiOptions {
  readonly maxNameLength: number;
  readonly minClusterTabs: number;
}

const UNPARSABLE: AiValidation = { ok: false, reason: 'unparsable' };

/**
 * One tab as the model sees it (PLAN.md §7.3): `id|title|host`, the title truncated to 80
 * characters.
 *
 * `|` and every newline are replaced in the title, and runs of whitespace collapsed: a
 * title is untrusted input (TASKS.md §2.7), and the only thing keeping one line one tab is
 * that a title can neither carry the separator nor end the line.
 */
export function tabLine(tab: Pick<TabInfo, 'id' | 'title' | 'url'>): string {
  const title = stripSiteSuffix(tab.title, tab.url)
    .replace(/[|\s]+/gu, ' ')
    .trim()
    .slice(0, MAX_INPUT_TITLE_CHARS)
    .trim();
  return `${tab.id}|${title}|${displayHost(tab.url)}`;
}

/** The prompt for one batch: the tab list, and what to answer with. */
export function buildPrompt(tabs: readonly Pick<TabInfo, 'id' | 'title' | 'url'>[]): string {
  return [
    'Group tabs by topic (id|title|host):',
    tabs.map(tabLine).join('\n'),
    'JSON only: {"groups":[{"name":"Topic","tabIds":[14,27]}]}. Each id at most once.',
  ].join('\n');
}

/**
 * Extracts `{ name, tabIds }` group pairs directly from raw model text whenever Gemini Nano
 * omits `},{` between groups inside `"groups":[{...}]` (which causes `JSON.parse` to silently
 * overwrite earlier duplicate `"name"`/`"tabIds"` keys with the final `"Other"` group) or
 * truncates the final `"tabIds":[1,2,3` array before closing `]}`.
 */
function extractRegexGroups(raw: string): { name: string; tabIds: number[] }[] {
  if (!/"groups"\s*:/u.test(raw)) return [];
  const normalized = raw.replace(/\\"/gu, '"');
  const groups: { name: string; tabIds: number[] }[] = [];
  const pattern =
    /"name"\s*:\s*"([^"]+)"[^{}[\]]*?"tabIds"\s*:\s*\[([^\]{}]*)(?:\]|(?=\s*[,}])|$)/gu;
  for (const match of normalized.matchAll(pattern)) {
    const tabIds = (match[2] as string)
      .split(',')
      .flatMap((p) => (/^-?\d+$/u.test(p.trim()) ? [Number(p)] : []));
    groups.push({ name: match[1] as string, tabIds });
  }
  return groups;
}

function parseModelJson(
  answer: string,
): { ok: true; value: unknown; truncated: boolean } | { ok: false } {
  const stripped = answer
    .trim()
    .replace(/^```(?:json)?\s*|\s*```$/giu, '')
    .trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  const candidate = start !== -1 && end > start ? stripped.slice(start, end + 1) : stripped;
  const repaired = candidate
    .replace(/"\s*(\{\s*"[^{}]*\})\s*"/gu, '$1')
    .replace(/,\s*([\]}])/gu, '$1');

  for (const text of [stripped, repaired]) {
    try {
      let value: unknown = JSON.parse(text);
      if (
        value !== null &&
        typeof value === 'object' &&
        Array.isArray((value as { groups?: unknown }).groups)
      ) {
        const extracted = extractRegexGroups(stripped);
        if (extracted.length > (value as { groups: unknown[] }).groups.length) {
          value = { ...value, groups: extracted };
        }
      }
      return { ok: true, value, truncated: false };
    } catch {
      // Try next tolerant normalization stage.
    }
  }
  const groups = extractRegexGroups(stripped);
  return groups.length > 0 ? { ok: true, value: { groups }, truncated: true } : { ok: false };
}

function cleanGroupTitle(raw: string, max: number): string {
  const s = raw.replace(/\s+/gu, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp >= max >> 1 ? cut.slice(0, sp) : cut).replace(/[\s&,:;/-]+$/u, '') || cut.trim();
}

function wordTokens(text: string, minLen = 4, withDigits = false): string[] {
  return foldAccents(text.toLowerCase())
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => (w.length >= minLen || (withDigits && /\d/.test(w))) && !STOPWORDS.has(w));
}

function sharesTwo(words: ReadonlySet<string>, ref: ReadonlySet<string>): boolean {
  let hits = 0;
  for (const w of words) if (ref.has(w) && ++hits >= 2) return true;
  return false;
}

/** Broad umbrella words that signal a catch-all mega-dump when paired with low tab cohesion. */
const UMBRELLA_WORDS: ReadonlySet<string> = new Set(
  'general topics mixed various culture society knowledge media videos articles reading study resources learning entertainment information misc'.split(
    ' ',
  ),
);

function sharesWord(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const w of left) {
    if (right.has(w)) return true;
    if (w.length >= 5) {
      const prefix = w.slice(0, 5);
      for (const r of right) if (r.length >= 5 && r.startsWith(prefix)) return true;
    }
  }
  return false;
}

/**
 * Catches small-model mega-dumps where Gemini Nano dumps almost an entire mixed batch (or 14+
 * tabs under a vague umbrella label like "Philosophy & History") across unrelated hosts and
 * lexically disconnected sub-topics, routing those tabs to `failed` so local TF-IDF separates
 * them cleanly. Leaves homogeneous clusters (e.g. 18 Corrado Augias tabs) and focused groups
 * untouched.
 */
function tabWordSets(members: readonly number[], byId: ReadonlyMap<number, TabInfo>): Set<string>[] {
  return members.map((id) => {
    const tab = byId.get(id)!;
    return new Set(wordTokens(stripSiteSuffix(tab.title, tab.url)));
  });
}

function isIncoherentMegaDump(
  title: string,
  members: readonly number[],
  batchSize: number,
  byId: ReadonlyMap<number, TabInfo>,
): boolean {
  if (members.length < 10) return false;
  const swallowedBatch = batchSize >= 12 && members.length * 5 >= batchSize * 4;
  const umbrellaTitle =
    /\s(?:&|and|e)\s/iu.test(title) || wordTokens(title, 3).some((w) => UMBRELLA_WORDS.has(w));
  if (!swallowedBatch && !(members.length >= 14 && umbrellaTitle)) return false;

  const sets = tabWordSets(members, byId);
  const hosts = new Set(members.map((id) => displayHost(byId.get(id)!.url)).filter(Boolean));

  const visited = new Uint8Array(members.length);
  let largest = 0;
  let multiTabComponents = 0;
  for (let start = 0; start < members.length; start += 1) {
    if (visited[start] === 1) continue;
    visited[start] = 1;
    const queue = [start];
    for (let head = 0; head < queue.length; head += 1) {
      const i = queue[head]!;
      for (let j = 0; j < members.length; j += 1) {
        if (visited[j] === 1) continue;
        if (sharesWord(sets[i]!, sets[j]!)) {
          visited[j] = 1;
          queue.push(j);
        }
      }
    }
    if (queue.length > largest) largest = queue.length;
    if (queue.length >= 2) multiTabComponents += 1;
  }

  return (
    largest * 100 < members.length * 45 &&
    ((multiTabComponents >= 2 && hosts.size >= 2) || multiTabComponents >= 3)
  );
}

/**
 * Ejects hallucinated outliers from entity-anchored groups (>= 5 tabs where >= 50% match the
 * title, or >= 5 anchors and >= 33% to catch small-model range dumps), leaving translated or
 * generic semantic groups untouched.
 */
function pruneEntityOutliers(
  title: string,
  members: readonly number[],
  byId: ReadonlyMap<number, TabInfo>,
): readonly number[] {
  if (members.length < 5) return members;
  const needles = wordTokens(title);
  if (needles.length === 0) return members;

  const sets = tabWordSets(members, byId);
  const anchors: ReadonlySet<string>[] = [];
  const vocab = new Set<string>();
  const flags = sets.map((set) => {
    for (const w of set) {
      if (needles.some((n) => w === n || (n.length >= 5 && w.startsWith(n.slice(0, 5))))) {
        anchors.push(set);
        for (const k of set) vocab.add(k);
        return true;
      }
    }
    return false;
  });
  const n = anchors.length;
  if (n < 3 || (n * 2 < members.length && (n < 5 || n * 3 < members.length))) return members;

  return members.filter(
    (_, i) =>
      flags[i] ||
      (n >= 6 ? anchors.some((a) => sharesTwo(sets[i]!, a)) : sharesTwo(sets[i]!, vocab)),
  );
}

/** Normalizes raw model group entries (including stringified `{...}` quirks) into `{ title, tabIds }`. */
function extractNamedGroups(
  rawGroups: readonly unknown[],
  maxNameLength: number,
): { readonly title: string; readonly tabIds: readonly unknown[] }[] {
  const out: { readonly title: string; readonly tabIds: readonly unknown[] }[] = [];
  for (const rawGroup of rawGroups) {
    let group: unknown = rawGroup;
    if (typeof rawGroup === 'string') {
      const inner = parseModelJson(rawGroup);
      if (!inner.ok) continue;
      group = inner.value;
    }
    if (group === null || typeof group !== 'object') continue;
    const { name, tabIds } = group as { name?: unknown; tabIds?: unknown };
    if (typeof name !== 'string' || !Array.isArray(tabIds)) continue;
    const title = cleanGroupTitle(name, maxNameLength);
    if (title === '' || OTHER_NAMES.has(title.toLowerCase())) continue;
    out.push({ title, tabIds });
  }
  return out;
}

function decodeRawGroups(answer: string): { readonly groups: readonly unknown[]; readonly truncated: boolean } | null {
  const decoded = parseModelJson(answer);
  if (!decoded.ok || decoded.value === null || typeof decoded.value !== 'object') return null;
  const groups = (decoded.value as { groups?: unknown }).groups;
  return Array.isArray(groups) ? { groups, truncated: decoded.truncated } : null;
}

export function validateAiAnswer(
  answer: string,
  batch: readonly TabInfo[],
  options: ValidateAiOptions,
): AiValidation {
  const decoded = decodeRawGroups(answer);
  if (decoded === null) return UNPARSABLE;
  const { groups } = decoded;

  const byId = new Map(batch.map((tab) => [tab.id, tab]));
  const windowId = (batch[0] as TabInfo).windowId;
  const taken = new Set<number>();
  const pruned = new Set<number>();
  const drafts: AiDraft[] = [];

  for (const { title, tabIds } of extractNamedGroups(groups, options.maxNameLength)) {
    const seenInGroup = new Set<number>();
    const rawMembers: number[] = [];
    for (const id of tabIds) {
      // An invented id is discarded, and a repeated one belongs to the first group that
      // claimed it: a tab cannot be in two native groups anyway (PLAN.md §7.4).
      if (typeof id !== 'number' || !Number.isInteger(id)) continue;
      if (!byId.has(id) || taken.has(id) || seenInGroup.has(id)) continue;
      seenInGroup.add(id);
      rawMembers.push(id);
    }

    const members = pruneEntityOutliers(title, rawMembers, byId);
    if (members.length < rawMembers.length) {
      const kept = new Set(members);
      for (const id of rawMembers) if (!kept.has(id)) pruned.add(id);
    }
    if (isIncoherentMegaDump(title, members, batch.length, byId)) {
      for (const id of members) pruned.add(id);
      continue;
    }
    if (members.length < options.minClusterTabs) continue;
    for (const id of members) taken.add(id);
    drafts.push({ title, windowId, tabIds: members });
  }

  if (drafts.length === 0) return { ok: false, reason: 'no-groups' };
  // "Altro" is everything no group kept; tabs pruned as entity outliers or missed by a
  // truncated JSON go to `failed` so §7.2 local clustering cleanly regroups them.
  const leftover = batch.filter((tab) => !taken.has(tab.id)).map((tab) => tab.id);
  if (decoded.truncated) return { ok: true, drafts, ungrouped: [], failed: leftover };
  return {
    ok: true,
    drafts,
    ungrouped: leftover.filter((id) => !pruned.has(id)),
    failed: leftover.filter((id) => pruned.has(id)),
  };
}

/**
 * Extracts the first complete balanced top-level `{...}` JSON object containing `"groups"`
 * once all braces and strings close, allowing streaming inference to stop the instant valid
 * JSON completes instead of waiting on trailing prose or EOS loops.
 */
export function extractCompleteGroupsJson(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}' && --depth === 0) {
      const slice = raw.slice(start, i + 1);
      if (!slice.includes('"groups"')) return null;
      try {
        return Array.isArray((JSON.parse(slice) as { groups?: unknown }).groups) ? slice : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Maximum chars streamed before stopping a runaway small-model generation loop. */
const MAX_STREAM_CHARS = 4_000;

/** Detects pathological token/substring repetition loops in unconstrained small-model output. */
export function isDegenerateStream(text: string): boolean {
  if (text.length >= MAX_STREAM_CHARS) return true;
  if (text.length < 160) return false;
  return /(.{4,32}?)\1{4,}/su.test(text.slice(-160));
}

/** Whether partial streamed text already carries at least one regex-recoverable group. */
export function hasRecoverableGroupSnippet(text: string): boolean {
  return extractRegexGroups(text).some((g) => g.tabIds.length > 0);
}

/** Packs one window's pre-clustered groups and remaining tabs into batches of at most `maxBatchTabs`. */
export function packClusterBatches(
  own: readonly TabInfo[],
  clusterGroups: readonly (readonly number[])[],
  maxBatchTabs: number,
): readonly (readonly TabInfo[])[] {
  if (own.length <= maxBatchTabs) return own.length === 0 ? [] : [own];
  const byId = new Map(own.map((tab) => [tab.id, tab]));
  const grouped = new Set<number>();
  const chunks: TabInfo[][] = [];
  for (const groupIds of clusterGroups) {
    const members: TabInfo[] = [];
    for (const id of groupIds) {
      grouped.add(id);
      const tab = byId.get(id);
      if (tab !== undefined) members.push(tab);
    }
    for (let at = 0; at < members.length; at += maxBatchTabs) {
      chunks.push(members.slice(at, at + maxBatchTabs));
    }
  }
  // Singletons resemble nothing in particular, so pack them into free batch slots.
  for (const tab of own) {
    if (!grouped.has(tab.id)) chunks.push([tab]);
  }
  const batches: TabInfo[][] = [];
  for (const chunk of chunks) {
    const last = batches.at(-1);
    if (last !== undefined && last.length + chunk.length <= maxBatchTabs) last.push(...chunk);
    else batches.push(chunk);
  }
  return batches;
}

function sameTopicTitle(
  leftKey: string,
  leftTokens: readonly string[],
  rightKey: string,
  rightTokens: readonly string[],
): boolean {
  if (leftKey === rightKey) return true;
  if (leftTokens.length === 0 || rightTokens.length === 0) return false;
  const shorter = leftTokens.length <= rightTokens.length ? leftTokens : rightTokens;
  const longer = leftTokens.length <= rightTokens.length ? rightTokens : leftTokens;
  // Never merge a generic 1-word label (e.g. "History" or "Philosophy") into a compound
  // umbrella (e.g. "Philosophy & History") across batches; require either identical token
  // sets or a specific multi-word entity/topic (>= 2 tokens) contained in the longer title.
  if (shorter.length === 1 && longer.length > 1) return false;
  return shorter.every((token) => longer.includes(token));
}

/**
 * Compact prompt asking the model to assign only a handful of newly opened tabs to existing
 * topic names (or a new 2+ tab topic, or Other) instead of re-grouping a 100-tab session.
 */
export function buildIncrementalPrompt(
  existingTitles: readonly string[],
  newTabs: readonly Pick<TabInfo, 'id' | 'title' | 'url'>[],
): string {
  return [
    `Existing topics: ${existingTitles.join(', ')}`,
    'Assign each new tab to a matching existing topic (exact name), a new short topic (2+ tabs), or Other (id|title|host):',
    newTabs.map(tabLine).join('\n'),
    'JSON only: {"groups":[{"name":"Topic","tabIds":[1]}]}. Each id at most once.',
  ].join('\n');
}

export interface IncrementalAiResult {
  readonly ok: true;
  readonly groups: readonly ProposedGroup[];
  readonly ungrouped: readonly number[];
}

function findTopicMatch<T extends { readonly key: string; readonly tokens: readonly string[] }>(
  list: readonly T[],
  key: string,
  tokens: readonly string[],
): T | undefined {
  return list.find((entry) => sameTopicTitle(entry.key, entry.tokens, key, tokens));
}

/**
 * Applies a validated incremental micro-prompt answer onto `existingGroups` (which already carry
 * live real tab IDs) and `newTabs` (with compact 1..K IDs mapped via `realNewIds`). Matching an
 * existing topic accepts even 1 tab; brand-new topics require `minClusterTabs` tabs.
 */
export function applyIncrementalAiAnswer(
  answer: string,
  existingGroups: readonly ProposedGroup[],
  newTabs: readonly TabInfo[],
  realNewIds: readonly number[],
  options: ValidateAiOptions & { readonly maxGroups: number },
  colorOf: (key: string) => GroupColor = () => 'grey',
): IncrementalAiResult | { readonly ok: false } {
  const decoded = decodeRawGroups(answer);
  if (decoded === null) return { ok: false };

  const validCompact = new Map<number, number>(
    newTabs.flatMap((tab, index) => (realNewIds[index] === undefined ? [] : [[tab.id, realNewIds[index]!]])),
  );
  const merged = existingGroups.map((group) => ({
    ...group,
    tokens: wordTokens(group.title, 3, true),
    tabIds: [...group.tabIds],
  }));
  const taken = new Set<number>();

  for (const { title, tabIds } of extractNamedGroups(decoded.groups, options.maxNameLength)) {
    const realIds: number[] = [];
    for (const id of tabIds) {
      const realId = typeof id === 'number' && Number.isInteger(id) ? validCompact.get(id) : undefined;
      if (realId !== undefined && !taken.has(realId)) realIds.push(realId);
    }
    if (realIds.length === 0) continue;

    const key = title.toLowerCase();
    const tokens = wordTokens(title, 3, true);
    const match = findTopicMatch(merged, key, tokens);
    if (match !== undefined) {
      for (const realId of realIds) {
        taken.add(realId);
        match.tabIds.push(realId);
      }
      continue;
    }
    if (realIds.length < options.minClusterTabs || merged.length >= options.maxGroups) continue;
    for (const realId of realIds) taken.add(realId);
    merged.push({
      key,
      title,
      color: colorOf(key),
      windowId: existingGroups[0]?.windowId ?? 1,
      tokens,
      tabIds: realIds,
    });
  }

  const placedExisting = new Set(existingGroups.flatMap((g) => g.tabIds));
  const groups: ProposedGroup[] = merged
    .sort((a, b) => b.tabIds.length - a.tabIds.length)
    .map(({ key, title, color, windowId, tabIds }) => ({ key, title, color, windowId, tabIds }));
  return {
    ok: true,
    groups,
    ungrouped: realNewIds.filter((id) => !taken.has(id) && !placedExisting.has(id)),
  };
}

/**
 * Merges drafts with identical or equivalent/subset topic tokens per window,
 * keeps the largest `maxGroups` groups per window, and returns all remaining tabs in `ungrouped`.
 */
export function assembleAiProposal(
  drafts: readonly AiDraft[],
  ungrouped: readonly number[],
  position: ReadonlyMap<number, number>,
  windows: readonly number[],
  maxGroups: number,
  colorOf: (key: string) => GroupColor = () => 'grey',
): GroupProposal {
  const groups: ProposedGroup[] = [];
  const rest = [...ungrouped];
  const at = (id: number): number => position.get(id) ?? 0;

  for (const windowId of windows) {
    const merged: {
      key: string;
      title: string;
      tokens: readonly string[];
      tabIds: number[];
    }[] = [];
    for (const draft of drafts) {
      if (draft.windowId !== windowId || draft.tabIds.length === 0) continue;
      const key = draft.title.toLowerCase();
      const tokens = wordTokens(draft.title, 3, true);
      const found = findTopicMatch(merged, key, tokens);
      if (found === undefined) {
        merged.push({ key, title: draft.title, tokens, tabIds: [...draft.tabIds] });
      } else {
        found.tabIds.push(...draft.tabIds);
      }
    }

    for (const group of merged) group.tabIds.sort((a, b) => at(a) - at(b));
    merged.sort((a, b) => b.tabIds.length - a.tabIds.length || at(a.tabIds[0]!) - at(b.tabIds[0]!));

    merged.forEach((group, rank) => {
      if (rank >= maxGroups) rest.push(...group.tabIds);
      else groups.push({ key: group.key, title: group.title, color: colorOf(group.key), windowId, tabIds: group.tabIds });
    });
  }

  return { mode: 'topic', groups, ungrouped: rest.sort((a, b) => at(a) - at(b)) };
}
