/**
 * `tests/fixtures/tabs-*.json` as `scoreTabs()` takes it.
 *
 * Shared by the precision assertions (`tests/unit/scoring.fixtures.test.ts`) and the time
 * budget (`tests/perf/scoring.perf.test.ts`), which run in two different Vitest
 * configurations and must still score exactly the same input.
 */

import { readFileSync } from 'node:fs';

import { fixturePath } from '../../scripts/generate-fixtures';
import { scoreTabs, type ScoringContext, type ScoringResult } from '../../src/core/scoring';
import {
  DEFAULT_SETTINGS,
  type ActivityStore,
  type Settings,
  type TabInfo,
} from '../../src/core/types';
import type { TabsFixture } from './schema';

export interface ScoringInput {
  readonly tabs: readonly TabInfo[];
  readonly activity: ActivityStore;
  readonly settings: Settings;
  readonly now: number;
  readonly context: ScoringContext;
}

export function loadFixture(name: string): TabsFixture {
  return JSON.parse(readFileSync(fixturePath(name), 'utf8')) as TabsFixture;
}

/**
 * The fixture as the function takes it. No whitelist, no protected sites, no bookmarks
 * and no keeps: the fixture does not carry any, and the labels were written without them.
 */
export function inputOf(fixture: TabsFixture): ScoringInput {
  const activity: ActivityStore = {};
  for (const entry of fixture.tabs) activity[entry.activity.tabId] = entry.activity;
  return {
    tabs: fixture.tabs.map((entry) => entry.tab),
    activity,
    settings: { ...DEFAULT_SETTINGS, staleDays: fixture.staleDays },
    now: fixture.now,
    context: { focusedWindowId: fixture.windows.find((window) => window.focused)?.id },
  };
}

export function score(input: ScoringInput): ScoringResult {
  return scoreTabs(input.tabs, input.activity, input.settings, input.now, input.context);
}
