/**
 * Prompt formatting and resilient JSON answer validation for on-device AI grouping (PLAN.md §7.3).
 *
 * Kept separate from `core/ai-grouping.ts` (which imports `groupByTopic` for multi-batch
 * pre-clustering and fallback) so the background service worker can build prompts and validate
 * model answers statically without pulling `groupByTopic`'s title/site tables into its bundle.
 */

import { foldAccents, stripSiteSuffix } from './cluster';
import type { TabInfo } from './types';
import { displayHost } from './url';

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
  "Ignore typos; include only matching tabs and don't name groups after sites. " +
  "Short English names (1-3 words), 3-8 groups. Tabs that fit nowhere go to 'Other'.";

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
    'Group these tabs by topic. One tab per line, as id|title|host:',
    tabs.map((tab) => tabLine(tab)).join('\n'),
    'Answer with JSON only: {"groups":[{"name":"Topic","tabIds":[14,27]}]}. Use each listed id at most once.',
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
      .map((p) => p.trim())
      .filter((p) => /^-?\d+$/u.test(p))
      .map(Number);
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

function titleWords(text: string): string[] {
  return foldAccents(text.toLowerCase())
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4);
}

/**
 * Ejects hallucinated outliers from large entity-anchored groups (>= 5 tabs where >= 60% match a
 * word from the group title), leaving small or translated semantic groups untouched.
 */
function pruneEntityOutliers(
  title: string,
  members: readonly number[],
  byId: ReadonlyMap<number, TabInfo>,
): readonly number[] {
  if (members.length < 5) return members;
  const needles = titleWords(title);
  if (needles.length === 0) return members;

  const wordsList = members.map((id) => {
    const tab = byId.get(id)!;
    return titleWords(stripSiteSuffix(tab.title, tab.url));
  });
  let anchorCount = 0;
  const anchorVocab = new Set<string>();
  for (const words of wordsList) {
    if (
      needles.some((n) =>
        words.some((w) => w === n || (n.length >= 5 && w.startsWith(n.slice(0, 5)))),
      )
    ) {
      anchorCount += 1;
      for (const w of words) anchorVocab.add(w);
    }
  }
  return anchorCount * 5 < members.length * 3
    ? members
    : members.filter((_id, idx) => wordsList[idx]!.some((w) => anchorVocab.has(w)));
}

export function validateAiAnswer(
  answer: string,
  batch: readonly TabInfo[],
  options: ValidateAiOptions,
): AiValidation {
  const decoded = parseModelJson(answer);
  if (!decoded.ok) return UNPARSABLE;
  const parsed = decoded.value;
  if (parsed === null || typeof parsed !== 'object') return UNPARSABLE;
  const groups = (parsed as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return UNPARSABLE;

  const byId = new Map(batch.map((tab) => [tab.id, tab]));
  const windowId = (batch[0] as TabInfo).windowId;
  const taken = new Set<number>();
  const drafts: AiDraft[] = [];

  for (const rawGroup of groups) {
    let group: unknown = rawGroup;
    if (typeof rawGroup === 'string') {
      const inner = parseModelJson(rawGroup);
      if (!inner.ok) continue;
      group = inner.value;
    }
    if (group === null || typeof group !== 'object') continue;
    const { name, tabIds } = group as { name?: unknown; tabIds?: unknown };
    if (typeof name !== 'string' || !Array.isArray(tabIds)) continue;

    const title = cleanGroupTitle(name, options.maxNameLength);
    // "Other" is the model's way of saying "nowhere", and PLAN.md §7.2.4 does not group
    // it; an unnamed group could not be applied either, and a group below
    // `minClusterTabs` is not worth one. Their tabs fall through to "Altro" below.
    if (title === '' || OTHER_NAMES.has(title.toLowerCase())) continue;

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
    if (members.length < options.minClusterTabs) continue;
    for (const id of members) taken.add(id);
    drafts.push({ title, windowId, tabIds: members });
  }

  if (drafts.length === 0) return { ok: false, reason: 'no-groups' };
  // "Altro" is everything no group kept: the tabs the model forgot, and the ones it put
  // in a group that was then dropped. When the model's output was truncated mid-JSON, tabs
  // it never reached go to `failed` so §7.2 local clustering still groups the unreached tail.
  const leftover = batch.filter((tab) => !taken.has(tab.id)).map((tab) => tab.id);
  return decoded.truncated
    ? { ok: true, drafts, ungrouped: [], failed: leftover }
    : { ok: true, drafts, ungrouped: leftover, failed: [] };
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
