/**
 * The time budget of PLAN.md §11 for the panel: with 300 tabs the list is on screen within
 * 150 ms (TASKS.md M2.5, and §13's M2 acceptance).
 *
 * **Why a real browser and not a harness.** What the plan promises is a document loading,
 * a module compiling, a list rendering and a frame painting. Only Chromium does all four,
 * and the one measurement that was never in doubt is the fixed half of the cost: an empty
 * panel — no rows at all — already takes about the same time as the budget allows for
 * everything. A harness rendering `DeclutterView` into jsdom would have measured jsdom.
 *
 * **Why 300 stubbed tabs and not 300 real ones.** `chrome.tabs.query` is replaced, before
 * the document exists, with the 300-tab fixture the scoring tests use
 * (`tests/fixtures/tabs-300.json`), its timestamps shifted so the ages are the ones the
 * fixture's labels describe. Opening 300 real tabs would measure Chromium opening 300 real
 * tabs — minutes of it, with 300 renderers competing for the machine the measurement is
 * reading — and the panel cannot tell the difference: it asks the same question and gets
 * the same answer. The list this produces is the real one, 200-odd rows over six windows,
 * and the test checks that before it believes a number (docs/DECISIONS.md, M2.5).
 *
 * **What is timed.** The page's own `performance.now()` at the animation frame that follows
 * the list entering the DOM — so, from the navigation that opens the panel to the frame the
 * rows are painted in. Nothing of Playwright's is inside it.
 *
 * **What the number is compared against.** Not the 150 ms alone: the budget times how slow
 * this machine is at the moment of the opening, measured by running the reference workload
 * of `tests/perf/budget.ts` inside the same page, on the same clock, right after the clock
 * has been read and before the page is closed (docs/DECISIONS.md, F.1). In the same page,
 * because a renderer of its own would be a renderer Chromium is free to deprioritise, and
 * the yardstick has to share the conditions it measures.
 *
 * **Why it cannot be satisfied by rendering less.** Every opening also reports how many
 * rows were in the document when the clock was read and how many were there once the panel
 * had settled, and the test requires the two to be equal. The panel renders its list in one
 * synchronous pass today; if it ever grew a progressive one, this stops being a measurement
 * of "the list is visible" and the test says so instead of getting quietly faster.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { chromium, type BrowserContext } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ActivityStore, TabInfo } from '../../src/core/types';
import { loadFixture } from '../fixtures/scoring-input';
import { measureWallBudget, referenceWorkloadExpression, type WallSample } from './budget';

/** PLAN.md §11: "Panel open → list visible (300 tabs): ≤ 150 ms". */
const BUDGET_MS = 150;

/** The Chrome build the `build chrome` gate produces, which runs before `pnpm perf`. */
const EXTENSION_DIR = fileURLToPath(new URL('../../.output/chrome-mv3', import.meta.url));

/**
 * Below this the list is not the list the budget is about, and the number would be
 * measuring something else. The fixture produces a little over two hundred rows; the floor
 * is loose because which rows those are is the scoring tests' business, not this one's.
 */
const LEAST_ROWS = 150;

/** How long one opening may take before the test gives up on it rather than hang. */
const OPENING_TIMEOUT_MS = 60_000;

/** What the panel page is asked for, inside the browser. */
interface PanelApi {
  tabs: {
    query: (query?: Record<string, unknown>) => Promise<readonly unknown[]>;
  };
  storage: {
    local: {
      set: (items: Record<string, unknown>) => Promise<void>;
    };
  };
}

/** One opening, as the page measured it. */
interface Opening {
  /** Milliseconds from the navigation to the frame the list was painted in. */
  readonly ms: number;
  /** Rows in the document when the clock was read. */
  readonly rows: number;
  /** Rows in the document once the panel had settled. */
  readonly settled: number;
  /** The header's "300 tabs · 6 windows", so the test can check what it measured. */
  readonly counts: string;
}

/**
 * The fixture's tabs and history, moved forward so that "11 days ago" means eleven days
 * before this run. The relative ages are untouched, so the list keeps the shape the
 * fixture's labels describe.
 */
function rebased(): { readonly tabs: readonly TabInfo[]; readonly activity: ActivityStore } {
  const fixture = loadFixture('tabs-300');
  const shift = Date.now() - fixture.now;
  const activity: ActivityStore = {};
  for (const entry of fixture.tabs) {
    activity[entry.activity.tabId] = {
      ...entry.activity,
      createdAt: entry.activity.createdAt + shift,
      lastActiveAt: entry.activity.lastActiveAt + shift,
    };
  }
  const tabs = fixture.tabs.map((entry) =>
    entry.tab.lastAccessed === undefined
      ? entry.tab
      : { ...entry.tab, lastAccessed: entry.tab.lastAccessed + shift },
  );
  return { tabs, activity };
}

const { tabs, activity } = rebased();

let context: BrowserContext;
let panelUrl: string;
/** Every opening the measurement made, for the assertions that come after the number. */
const openings: Opening[] = [];

beforeAll(async () => {
  if (!existsSync(`${EXTENSION_DIR}/manifest.json`)) {
    throw new Error(
      `No Chrome build at ${EXTENSION_DIR}. The gate list builds before it measures; on its own, run \`pnpm build\` first.`,
    );
  }

  // Its own browser, and deliberately not the `tests/e2e/` fixtures: those attach a
  // recorder to every page and every request, and a measurement must not be instrumented
  // by the suite that contains it (vitest.perf.config.ts).
  context = await chromium.launchPersistentContext('', {
    // The full Chromium: Playwright's headless shell cannot load an extension.
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });
  const [existing] = context.serviceWorkers();
  const worker = existing ?? (await context.waitForEvent('serviceworker'));
  panelUrl = `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`;

  // The history the rows' chips and the score read, written the way `tests/e2e/` writes
  // it: the raw key `activity`, from inside an extension page. `onboarded` goes with it:
  // this is a fresh profile, and what §17 shows a fresh install is the first-run screen,
  // which has no list in it to measure (TASKS.md M6.2). The budget is about the panel a
  // person uses every day, so the profile is one that has answered it.
  const seeder = await context.newPage();
  await seeder.goto(panelUrl);
  await seeder.evaluate(async (store) => {
    await (globalThis as unknown as { chrome: PanelApi }).chrome.storage.local.set({
      activity: store,
      onboarded: true,
    });
  }, activity);
  await seeder.close();
}, 120_000);

afterAll(async () => {
  await context?.close();
});

/**
 * The reference workload as source text, built once: it is the same string every time, and
 * stringifying a function per opening would be work inside the measured interval's page.
 */
const REFERENCE_EXPRESSION = referenceWorkloadExpression();

/** One opening: a fresh page, so that nothing of the previous one is still on screen. */
async function openPanel(): Promise<WallSample> {
  const page = await context.newPage();
  // Before the document exists: the panel queries the tabs as it boots, and a stub
  // installed afterwards would never be asked.
  await page.addInitScript((seeded: readonly unknown[]) => {
    (globalThis as unknown as { chrome: PanelApi }).chrome.tabs.query = () =>
      Promise.resolve(seeded);

    const measured = globalThis as unknown as { __tdOpening?: { ms: number; rows: number } };
    let taken = false;
    const observer = new MutationObserver(() => {
      if (taken) return;
      const rows = document.querySelectorAll('.td-row').length;
      if (rows === 0) return;
      // Claimed before the frame is waited for, so the mutations the same render causes
      // cannot move the mark.
      taken = true;
      observer.disconnect();
      requestAnimationFrame(() => {
        measured.__tdOpening = { ms: performance.now(), rows };
      });
    });
    observer.observe(document, { childList: true, subtree: true });
  }, tabs);

  await page.goto(panelUrl);
  const handle = await page.waitForFunction(
    () => (globalThis as unknown as { __tdOpening?: { ms: number; rows: number } }).__tdOpening,
    undefined,
    { timeout: OPENING_TIMEOUT_MS },
  );
  const mark = await handle.jsonValue();
  // `waitForFunction` resolved on it, so it is there; the types do not know that.
  if (mark === undefined) throw new Error('the panel reported no opening');
  // After the clock has been read, so none of this is inside the measurement.
  const after = await page.evaluate(() => ({
    settled: document.querySelectorAll('.td-row').length,
    counts: document.querySelector('.td-counts')?.textContent ?? '',
  }));
  // The yardstick, in this page and on this page's clock, while the machine is still in the
  // state the opening above was measured in. Handed over as source rather than as a
  // function because the page is an extension page: its CSP forbids `eval`, and so does
  // this repository's lint (TASKS.md §2, invariant 7). A string given to `page.evaluate`
  // goes through the debugging protocol instead, which is not the page evaluating anything
  // of its own.
  const referenceMs = await page.evaluate<number>(REFERENCE_EXPRESSION);
  await page.close();

  openings.push({ ...mark, ...after });
  return { ms: mark.ms, referenceMs };
}

describe('the time budget (PLAN.md §11)', () => {
  it('opens the panel on 300 tabs inside the budget', { timeout: 900_000 }, async () => {
    expect(tabs).toHaveLength(300);

    const report = await measureWallBudget(
      { what: 'opening the panel with 300 tabs', limitMs: BUDGET_MS },
      openPanel,
    );

    // What was measured, before the number measured on it is believed. These cannot be
    // checked inside `openPanel` without failing a warm-up opening as if it were a
    // budget, and every opening is kept, so they are checked on all of them at once.
    expect(openings.length).toBeGreaterThanOrEqual(3);
    for (const opening of openings) {
      expect(opening.counts, 'the panel was not showing 300 tabs').toContain('300');
      expect(opening.rows, 'too few rows for this to be the 300-tab list').toBeGreaterThanOrEqual(
        LEAST_ROWS,
      );
      expect(
        opening.rows,
        'the list was still filling in when the clock was read: the mark is no longer "list visible"',
      ).toBe(opening.settled);
    }

    // `passed`, not `withinBudget`: on battery Windows halves the clock and the budget
    // is measured and printed instead of enforced (tests/perf/budget.ts).
    expect(report.passed, report.message).toBe(true);
  });
});
