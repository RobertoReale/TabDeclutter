import { afterAll, beforeAll, expect, test } from 'vitest';

import { openPanel, panelState } from './fixtures/panel';
import type { ErrorCollector, PanelSession } from './fixtures/panel';

/**
 * The collector's own test. "No console errors" is the reason this harness can
 * claim anything at all about the panel's health, and on Firefox it is read out
 * of the browser process's output rather than from WebDriver, so it is the part
 * that most needs proving: a guard that silently never fires is worse than no
 * guard.
 */
let session: PanelSession;

beforeAll(async () => {
  session = await openPanel();
  await panelState(session.page);
});

afterAll(async () => {
  await session?.close();
});

/** The console is mirrored through the process's output, which takes a moment. */
async function collected(errors: ErrorCollector, count: number): Promise<string[]> {
  const seen: string[] = [];
  for (let attempt = 0; attempt < 40 && seen.length < count; attempt++) {
    seen.push(...errors.take());
    if (seen.length >= count) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return seen;
}

test('a freshly opened panel has logged nothing', () => {
  expect(session.errors.take()).toEqual([]);
});

test('a console error in the panel is recorded', async () => {
  await session.page.evaluate(() => {
    console.error('provoked-console-error');
  });

  expect(await collected(session.errors, 1)).toEqual([
    expect.stringContaining('provoked-console-error'),
  ]);
});

test('an uncaught exception in the panel is recorded', async () => {
  await session.page.evaluate(() => {
    setTimeout(() => {
      throw new Error('provoked-uncaught');
    }, 0);
  });

  expect(await collected(session.errors, 1)).toEqual([
    expect.stringContaining('provoked-uncaught'),
  ]);
});

test('the provoked errors left nothing behind', () => {
  expect(session.errors.take()).toEqual([]);
});
