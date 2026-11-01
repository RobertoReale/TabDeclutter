/**
 * The shape of `tests/fixtures/tabs-*.json`, and the one validator both the generator
 * and the schema test are held to (TASKS.md M1.5, PLAN.md §6.5).
 *
 * This module is imported by `scripts/generate-fixtures.ts`, which runs under plain
 * `node --experimental-strip-types`. Type stripping does not resolve extensionless
 * imports, so everything this file takes from `src/core/` is a **type**; the three
 * runtime constants `src/core/` also defines are mirrored below and tied back to the
 * originals by `tests/unit/fixtures.test.ts` (docs/DECISIONS.md).
 */

import type { TabActivity, TabInfo } from '../../src/core/types.ts';

/** Mirrors `NO_GROUP_ID` in `src/core/types.ts`. */
export const UNGROUPED = -1;

/** Mirrors `DAY` in `src/core/time.ts`. */
export const DAY_MS = 86_400_000;

/** Mirrors `DEFAULT_SETTINGS.staleDays`: the `staleDays` the labels assume. */
export const FIXTURE_STALE_DAYS = 7;

/** The tab group colours Chrome accepts (`chrome.tabGroups.ColorEnum`). */
export const GROUP_COLORS: readonly string[] = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
];

/** Would a careful user close this tab? Written by hand, never computed (PLAN.md §6.5). */
export type FixtureLabel = 'suggest' | 'keep';

/** The language of the page title. `neutral` is a title that is neither, like a file name. */
export type FixtureLang = 'it' | 'en' | 'neutral';

export interface FixtureTab {
  tab: TabInfo;
  activity: TabActivity;
  /** The curated template this tab came from, so a label can be read in context. */
  template: string;
  lang: FixtureLang;
  /** Present exactly when the fixture is `labelled`. */
  expected?: FixtureLabel;
  /** Why, in one line. Present exactly when `expected` is. */
  rationale?: string;
}

export interface FixtureGroup {
  id: number;
  windowId: number;
  title: string;
  color: string;
}

export interface FixtureWindow {
  id: number;
  focused: boolean;
  /** Every one of its tabs is older than `staleDays`: the forgotten window of PLAN.md §6.4. */
  forgotten: boolean;
}

export interface TabsFixture {
  /** The file name without its extension. */
  name: string;
  /** The PRNG seed: regenerating with it reproduces this file byte for byte. */
  seed: number;
  /** The injected clock. Every timestamp in the file is behind it (PLAN.md §6.4). */
  now: number;
  staleDays: number;
  /** Whether every tab carries `expected` and `rationale`. */
  labelled: boolean;
  windows: FixtureWindow[];
  groups: FixtureGroup[];
  tabs: FixtureTab[];
}

/**
 * The field tables below drive the validation. `'number'` means a safe integer: every
 * number in this schema is an id, an index, a count or a millisecond timestamp.
 */
type FieldKind = 'string' | 'number' | 'boolean' | 'array' | 'object';

const FIXTURE_FIELDS = {
  name: 'string',
  seed: 'number',
  now: 'number',
  staleDays: 'number',
  labelled: 'boolean',
  windows: 'array',
  groups: 'array',
  tabs: 'array',
} as const satisfies Record<string, FieldKind>;

const WINDOW_FIELDS = {
  id: 'number',
  focused: 'boolean',
  forgotten: 'boolean',
} as const satisfies Record<string, FieldKind>;

const GROUP_FIELDS = {
  id: 'number',
  windowId: 'number',
  title: 'string',
  color: 'string',
} as const satisfies Record<string, FieldKind>;

const ENTRY_FIELDS = {
  tab: 'object',
  activity: 'object',
  template: 'string',
  lang: 'string',
} as const satisfies Record<string, FieldKind>;

const ENTRY_OPTIONAL_FIELDS = {
  expected: 'string',
  rationale: 'string',
} as const satisfies Record<string, FieldKind>;

const TAB_FIELDS = {
  id: 'number',
  windowId: 'number',
  index: 'number',
  url: 'string',
  title: 'string',
  pinned: 'boolean',
  audible: 'boolean',
  active: 'boolean',
  discarded: 'boolean',
  hidden: 'boolean',
  groupId: 'number',
  incognito: 'boolean',
} as const satisfies Record<string, FieldKind>;

const TAB_OPTIONAL_FIELDS = {
  pendingUrl: 'string',
  favIconUrl: 'string',
  cookieStoreId: 'string',
  openerTabId: 'number',
  lastAccessed: 'number',
} as const satisfies Record<string, FieldKind>;

const ACTIVITY_FIELDS = {
  tabId: 'number',
  url: 'string',
  createdAt: 'number',
  lastActiveAt: 'number',
  activations: 'number',
  foregroundMs: 'number',
} as const satisfies Record<string, FieldKind>;

const ACTIVITY_OPTIONAL_FIELDS = {
  bootstrappedAt: 'number',
} as const satisfies Record<string, FieldKind>;

/**
 * Compile-time assertion: the two tables above describe exactly `TabInfo`. A field added
 * to `src/core/types.ts` has to be decided on here too, instead of silently going
 * missing from every fixture.
 */
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : never
  : never;

const _tabFieldsAreComplete: SameKeys<TabInfo, typeof TAB_FIELDS & typeof TAB_OPTIONAL_FIELDS> =
  true;
const _activityFieldsAreComplete: SameKeys<
  TabActivity,
  typeof ACTIVITY_FIELDS & typeof ACTIVITY_OPTIONAL_FIELDS
> = true;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

function matches(value: unknown, kind: FieldKind): boolean {
  switch (kind) {
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isRecord(value);
    case 'number':
      return Number.isSafeInteger(value);
    default:
      return typeof value === kind;
  }
}

function checkFields(
  problems: string[],
  path: string,
  value: Record<string, unknown>,
  required: Record<string, FieldKind>,
  optional: Record<string, FieldKind> = {},
): void {
  for (const [key, kind] of Object.entries(required)) {
    if (!matches(value[key], kind)) {
      problems.push(`${path}.${key}: expected ${kind}, got ${describe(value[key])}`);
    }
  }
  for (const [key, kind] of Object.entries(optional)) {
    if (value[key] !== undefined && !matches(value[key], kind)) {
      problems.push(`${path}.${key}: expected ${kind}, got ${describe(value[key])}`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!(key in required) && !(key in optional)) {
      problems.push(`${path}.${key}: unknown field`);
    }
  }
}

/** The shape pass: every field of every record, and no field nobody declared. */
function checkShape(problems: string[], fixture: Record<string, unknown>): void {
  checkFields(problems, 'fixture', fixture, FIXTURE_FIELDS);
  if (problems.length > 0) return;

  for (const [i, window] of (fixture.windows as unknown[]).entries()) {
    if (!isRecord(window)) {
      problems.push(`windows[${i}]: expected object, got ${describe(window)}`);
      continue;
    }
    checkFields(problems, `windows[${i}]`, window, WINDOW_FIELDS);
  }

  for (const [i, group] of (fixture.groups as unknown[]).entries()) {
    if (!isRecord(group)) {
      problems.push(`groups[${i}]: expected object, got ${describe(group)}`);
      continue;
    }
    checkFields(problems, `groups[${i}]`, group, GROUP_FIELDS);
  }

  for (const [i, entry] of (fixture.tabs as unknown[]).entries()) {
    if (!isRecord(entry)) {
      problems.push(`tabs[${i}]: expected object, got ${describe(entry)}`);
      continue;
    }
    checkFields(problems, `tabs[${i}]`, entry, ENTRY_FIELDS, ENTRY_OPTIONAL_FIELDS);
    if (isRecord(entry.tab)) {
      checkFields(problems, `tabs[${i}].tab`, entry.tab, TAB_FIELDS, TAB_OPTIONAL_FIELDS);
    }
    if (isRecord(entry.activity)) {
      checkFields(
        problems,
        `tabs[${i}].activity`,
        entry.activity,
        ACTIVITY_FIELDS,
        ACTIVITY_OPTIONAL_FIELDS,
      );
    }
  }
}

function checkWindowsAndGroups(problems: string[], fixture: TabsFixture): void {
  const windowIds = new Set<number>();
  for (const window of fixture.windows) {
    if (windowIds.has(window.id)) problems.push(`windows: duplicate id ${window.id}`);
    windowIds.add(window.id);
  }
  if (fixture.windows.length === 0) problems.push('windows: a fixture needs at least one window');
  const focused = fixture.windows.filter((w) => w.focused).length;
  if (focused !== 1)
    problems.push(`windows: expected exactly one focused window, found ${focused}`);

  const groupIds = new Set<number>();
  for (const group of fixture.groups) {
    if (groupIds.has(group.id)) problems.push(`groups: duplicate id ${group.id}`);
    groupIds.add(group.id);
    if (group.id <= 0) problems.push(`groups[${group.id}]: a group id must be positive`);
    if (!windowIds.has(group.windowId)) {
      problems.push(
        `groups[${group.id}]: windowId ${group.windowId} is not a window of this fixture`,
      );
    }
    if (group.title.length === 0) problems.push(`groups[${group.id}]: empty title`);
    if (!GROUP_COLORS.includes(group.color)) {
      problems.push(`groups[${group.id}]: ${group.color} is not a tab group colour`);
    }
  }
}

function checkTab(problems: string[], fixture: TabsFixture, entry: FixtureTab): void {
  const { tab, activity } = entry;
  const at = `tabs[id=${tab.id}]`;

  if (tab.url.length === 0) problems.push(`${at}: empty url`);
  if (entry.template.length === 0) problems.push(`${at}: empty template`);
  if (entry.lang !== 'it' && entry.lang !== 'en' && entry.lang !== 'neutral') {
    problems.push(`${at}: lang ${entry.lang} is not it, en or neutral`);
  }

  if (activity.tabId !== tab.id) problems.push(`${at}: activity.tabId is ${activity.tabId}`);
  if (activity.url !== tab.url) problems.push(`${at}: activity.url does not match tab.url`);
  if (activity.createdAt > activity.lastActiveAt) {
    problems.push(`${at}: createdAt is after lastActiveAt`);
  }
  if (activity.lastActiveAt > fixture.now) problems.push(`${at}: lastActiveAt is in the future`);
  if (activity.createdAt <= 0) problems.push(`${at}: createdAt is not a timestamp`);
  if (activity.activations < 0) problems.push(`${at}: negative activations`);
  if (activity.foregroundMs < 0) problems.push(`${at}: negative foregroundMs`);
  if (activity.bootstrappedAt !== undefined && activity.bootstrappedAt > fixture.now) {
    problems.push(`${at}: bootstrappedAt is in the future`);
  }

  // PLAN.md §6.1: the browser drops `lastAccessed` when it discards a tab, which is the
  // whole reason the tracker exists. A fixture that forgot this would hide the bug.
  if (tab.discarded && tab.lastAccessed !== undefined) {
    problems.push(`${at}: a discarded tab must not carry lastAccessed`);
  }
  if (!tab.discarded && tab.lastAccessed === undefined) {
    problems.push(`${at}: a tab that was never discarded should carry lastAccessed`);
  }
  if (tab.lastAccessed !== undefined && tab.lastAccessed > fixture.now) {
    problems.push(`${at}: lastAccessed is in the future`);
  }

  if (tab.groupId !== UNGROUPED) {
    const group = fixture.groups.find((g) => g.id === tab.groupId);
    if (group === undefined) problems.push(`${at}: groupId ${tab.groupId} has no group`);
    else if (group.windowId !== tab.windowId) {
      problems.push(`${at}: its group lives in window ${group.windowId}`);
    }
  }

  const labelled = entry.expected !== undefined;
  if (labelled !== fixture.labelled) {
    problems.push(
      `${at}: ${labelled ? 'is labelled' : 'has no label'} but the fixture says labelled=${fixture.labelled}`,
    );
  }
  if (labelled) {
    if (entry.expected !== 'suggest' && entry.expected !== 'keep') {
      problems.push(`${at}: expected is ${String(entry.expected)}`);
    }
    if (entry.rationale === undefined || entry.rationale.length < 10) {
      problems.push(`${at}: a label needs a rationale`);
    } else if (entry.rationale.length > 200) {
      problems.push(`${at}: the rationale is a line, not a paragraph`);
    }
  } else if (entry.rationale !== undefined) {
    problems.push(`${at}: a rationale without a label`);
  }
}

function checkWindowOrder(problems: string[], fixture: TabsFixture, windowId: number): void {
  const tabs = fixture.tabs.filter((t) => t.tab.windowId === windowId);
  const at = `window ${windowId}`;
  if (tabs.length === 0) {
    problems.push(`${at}: has no tabs`);
    return;
  }

  const indices = tabs.map((t) => t.tab.index).sort((a, b) => a - b);
  for (const [i, index] of indices.entries()) {
    if (index !== i) {
      problems.push(`${at}: the indices are not 0..${tabs.length - 1} (found ${index} at ${i})`);
      break;
    }
  }

  const active = tabs.filter((t) => t.tab.active).length;
  if (active !== 1) problems.push(`${at}: expected exactly one active tab, found ${active}`);

  // Both browsers keep the pinned tabs at the start of the strip.
  const lastPinned = Math.max(-1, ...tabs.filter((t) => t.tab.pinned).map((t) => t.tab.index));
  const firstLoose = Math.min(
    Number.POSITIVE_INFINITY,
    ...tabs.filter((t) => !t.tab.pinned).map((t) => t.tab.index),
  );
  if (lastPinned > firstLoose) problems.push(`${at}: a pinned tab sits after an unpinned one`);

  const window = fixture.windows.find((w) => w.id === windowId);
  if (window === undefined) return;
  const staleBefore = fixture.now - fixture.staleDays * DAY_MS;
  const fresh = tabs.filter((t) => t.activity.lastActiveAt > staleBefore).length;
  if (window.forgotten && fresh > 0) {
    problems.push(`${at}: marked forgotten but ${fresh} of its tabs are younger than staleDays`);
  }
  if (!window.forgotten && fresh === 0) {
    problems.push(`${at}: every one of its tabs is stale, so it is a forgotten window`);
  }
}

/**
 * Everything the fixtures promise, in one place. Returns the problems it found: an empty
 * array is a valid fixture.
 */
export function validateFixture(
  value: unknown,
  expect: { name?: string; count?: number } = {},
): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return [`fixture: expected an object, got ${describe(value)}`];

  checkShape(problems, value);
  if (problems.length > 0) return problems;

  const fixture = value as unknown as TabsFixture;
  if (expect.name !== undefined && fixture.name !== expect.name) {
    problems.push(`fixture.name: expected ${expect.name}, got ${fixture.name}`);
  }
  if (expect.count !== undefined && fixture.tabs.length !== expect.count) {
    problems.push(`fixture.tabs: expected ${expect.count} tabs, got ${fixture.tabs.length}`);
  }
  if (fixture.seed <= 0) problems.push('fixture.seed: expected a positive seed');
  if (fixture.now <= 0) problems.push('fixture.now: expected a timestamp');
  if (fixture.staleDays <= 0)
    problems.push('fixture.staleDays: expected a positive number of days');

  checkWindowsAndGroups(problems, fixture);

  const tabIds = new Set<number>();
  const windowIds = new Set(fixture.windows.map((w) => w.id));
  for (const entry of fixture.tabs) {
    if (tabIds.has(entry.tab.id)) problems.push(`tabs: duplicate id ${entry.tab.id}`);
    tabIds.add(entry.tab.id);
    if (!windowIds.has(entry.tab.windowId)) {
      problems.push(`tabs[id=${entry.tab.id}]: window ${entry.tab.windowId} does not exist`);
    }
    checkTab(problems, fixture, entry);
  }
  for (const entry of fixture.tabs) {
    const opener = entry.tab.openerTabId;
    if (opener !== undefined && !tabIds.has(opener)) {
      problems.push(`tabs[id=${entry.tab.id}]: openerTabId ${opener} is not a tab of this fixture`);
    }
  }
  for (const id of windowIds) checkWindowOrder(problems, fixture, id);

  // What makes these fixtures realistic rather than merely valid (TASKS.md M1.5).
  const urlCounts = new Map<string, number>();
  for (const entry of fixture.tabs) {
    urlCounts.set(entry.tab.url, (urlCounts.get(entry.tab.url) ?? 0) + 1);
  }
  const duplicateSets = [...urlCounts.values()].filter((n) => n > 1).length;
  if (duplicateSets < 2)
    problems.push(`fixture: expected duplicate URLs, found ${duplicateSets} sets`);

  const templates = new Set(fixture.tabs.map((t) => t.template));
  if (templates.size < 10)
    problems.push(`fixture: only ${templates.size} templates are represented`);

  for (const lang of ['it', 'en'] as const) {
    const count = fixture.tabs.filter((t) => t.lang === lang).length;
    if (count < 5) problems.push(`fixture: only ${count} ${lang} titles`);
  }

  const pinned = fixture.tabs.filter((t) => t.tab.pinned).length;
  if (pinned === 0) problems.push('fixture: no pinned tab');
  const audible = fixture.tabs.filter((t) => t.tab.audible).length;
  if (audible === 0) problems.push('fixture: no tab playing audio');
  const grouped = fixture.tabs.filter((t) => t.tab.groupId !== UNGROUPED).length;
  if (grouped === 0) problems.push('fixture: no tab in a group');

  return problems;
}
