import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import type { ArchivedTab } from '../../src/core/types';
import {
  CLOSE_ALL_DUPLICATES,
  TOGGLE_DUPLICATE_GUARD,
  registerCommands,
} from '../../src/entrypoints/background/commands';
import type { CommandsApi } from '../../src/entrypoints/background/commands';
import type { GuardActions } from '../../src/entrypoints/background/guard';

/**
 * The two keyboard shortcuts of PLAN.md §4.1: that each one reaches the guard gesture it
 * stands for, that the listener is registered the moment the background is, and that a
 * command nobody here knows is let through in silence.
 *
 * `fakeBrowser` leaves `commands` unimplemented — `onCommand.addListener` throws — so the
 * listener is captured with a spy, the way `guard.test.ts` captures `tabs.onAttached`. What
 * the guard then does to the tabs is `guard.test.ts`'s business; here it only records what
 * it was asked for.
 */

/** The guard as a shortcut sees it: every gesture asked for, in order. */
interface RecordingGuard extends GuardActions {
  readonly asked: string[];
}

function guardRecorder(): RecordingGuard {
  const asked: string[] = [];
  return {
    asked,
    pause(durationMs) {
      asked.push(`pause:${durationMs === null ? 'restart' : String(durationMs)}`);
      return Promise.resolve();
    },
    toggle() {
      asked.push('toggle');
      return Promise.resolve();
    },
    closeAllDuplicates(): Promise<readonly ArchivedTab[]> {
      asked.push('closeAllDuplicates');
      return Promise.resolve([]);
    },
    reopenLastDuplicate(): Promise<ArchivedTab | null> {
      asked.push('reopenLastDuplicate');
      return Promise.resolve(null);
    },
  };
}

/** The listeners `registerCommands` handed to the browser, so a test can fire one. */
let pressed: ((name: string) => void)[] = [];

beforeEach(() => {
  fakeBrowser.reset();
  pressed = [];
  // `fakeBrowser.commands.onCommand.addListener` throws `MockNotImplementedError`.
  vi.spyOn(fakeBrowser.commands.onCommand, 'addListener').mockImplementation(
    (listener: unknown) => {
      pressed.push(listener as (name: string) => void);
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

function start() {
  const guard = guardRecorder();
  const commands = registerCommands({ guard });
  return { commands, guard };
}

/** Long enough for the listener's own promise, which nothing hands back to the caller. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('“Chiudi tutti i duplicati”', () => {
  it('sweeps every duplicate away', async () => {
    const { commands, guard } = start();

    await commands.received(CLOSE_ALL_DUPLICATES);

    expect(guard.asked).toEqual(['closeAllDuplicates']);
  });
});

describe('“Attiva/disattiva protezione duplicati”', () => {
  it('toggles the guard, which is the only thing one key can do', async () => {
    const { commands, guard } = start();

    await commands.received(TOGGLE_DUPLICATE_GUARD);

    // Not `pause` and not `resume`: a shortcut has no duration to offer, so the guard
    // itself decides which way the toggle goes (PLAN.md §8.1).
    expect(guard.asked).toEqual(['toggle']);
  });
});

describe('the command listener', () => {
  it('is registered at once, so a woken worker is already listening', async () => {
    // No `await` before the listener goes in: a service worker wakes up *because* of the
    // shortcut, and a listener added later never hears it (invariant 6).
    const { guard } = start();
    expect(pressed).toHaveLength(1);

    pressed[0]?.(CLOSE_ALL_DUPLICATES);
    await settle();

    expect(guard.asked).toEqual(['closeAllDuplicates']);
  });

  it('keeps the browser out of an unhandled rejection when a gesture fails', async () => {
    const complained = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const guard = guardRecorder();
    const failing: GuardActions = {
      ...guard,
      closeAllDuplicates: () => Promise.reject(new Error('no tabs API')),
    };
    registerCommands({ guard: failing });

    pressed[0]?.(CLOSE_ALL_DUPLICATES);
    await settle();

    expect(complained).toHaveBeenCalledOnce();
  });

  it('ignores a command it has no name for', async () => {
    const { commands, guard } = start();

    // `_execute_action` never arrives here — opening the panel is the browser's own job —
    // and a key the user still has bound to a command from an older release would.
    await commands.received('_execute_action');
    await commands.received('organize-everything');

    expect(guard.asked).toEqual([]);
  });
});

describe('a browser with no commands API', () => {
  it('keeps the rest of the background running', async () => {
    const complained = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const removed = (fakeBrowser as unknown as { commands?: unknown }).commands;
    delete (fakeBrowser as unknown as { commands?: unknown }).commands;
    try {
      // No throw: two shortcuts nobody can press are not worth the background script,
      // which also runs the tracker, the badge, the cleanup and the guard itself.
      const { commands, guard } = start();
      await commands.received(TOGGLE_DUPLICATE_GUARD);

      expect(complained).toHaveBeenCalledOnce();
      // The gesture still works: only the shortcut could not be listened for.
      expect(guard.asked).toEqual(['toggle']);
    } finally {
      (fakeBrowser as unknown as { commands?: unknown }).commands = removed;
    }
  });

  it('can be handed an API of its own instead', async () => {
    const given: string[] = [];
    const api: CommandsApi = {
      onCommand: {
        addListener(listener) {
          given.push('addListener');
          listener(TOGGLE_DUPLICATE_GUARD);
        },
      },
    };
    const guard = guardRecorder();

    registerCommands({ guard, api });
    await settle();

    expect(given).toEqual(['addListener']);
    expect(guard.asked).toEqual(['toggle']);
  });
});
