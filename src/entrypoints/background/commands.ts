/**
 * The keyboard shortcuts of PLAN.md §4.1, as the background hears them.
 *
 * `build/manifest.ts` declares the two assignable commands and the browser's own
 * `_execute_action` / `_execute_sidebar_action`; only the assignable two reach a listener,
 * because opening the panel is the browser's job and never arrives as `onCommand`. Neither
 * command has a key bound by default (§4.1: the user assigns them), so this listener is
 * silent until they do.
 *
 * Both are gestures, and both are handed straight to `GuardActions` — the shortcut and the
 * icon menu item for the same thing must do the same thing, down to the queue they go
 * through (see `guard.ts`).
 */

import type { GuardActions } from './guard';
import { reportBackgroundError } from './report';

/** "Chiudi tutti i duplicati" (PLAN.md §8.7). Works in every mode, pause included. */
export const CLOSE_ALL_DUPLICATES = 'close-all-duplicates';
/** "Attiva/disattiva protezione duplicati" (PLAN.md §4.1). */
export const TOGGLE_DUPLICATE_GUARD = 'toggle-duplicate-guard';

/** The slice of `browser.commands` this file uses, so a test can hand over its own. */
export interface CommandsApi {
  readonly onCommand: {
    addListener(listener: (name: string) => void): void;
  };
}

export interface CommandsOptions {
  readonly guard: GuardActions;
  readonly api?: CommandsApi;
}

export interface Commands {
  /** One command, by name. What the tests call, and what the listener calls. */
  received(name: string): Promise<void>;
}

/**
 * Registers the shortcuts. Called at the top level of the background, before any `await`,
 * because a service worker woken by a shortcut must already be listening (invariant 6).
 */
export function registerCommands(options: CommandsOptions): Commands {
  const { guard } = options;
  const api = options.api ?? commandsApi();

  async function received(name: string): Promise<void> {
    switch (name) {
      case CLOSE_ALL_DUPLICATES:
        await guard.closeAllDuplicates();
        return;
      case TOGGLE_DUPLICATE_GUARD:
        await guard.toggle();
        return;
      // `_execute_action` and the rest never get here, and a command from a future release
      // the user still has a key bound to would.
      default:
        return;
    }
  }

  // A profile with no `commands` API keeps the rest of the extension: two shortcuts nobody
  // can press are not worth taking the background script down for.
  if (api === undefined) {
    console.error(
      'TabDeclutter: commands',
      new Error('no commands API: browser.commands is undefined'),
    );
    return { received };
  }

  api.onCommand.addListener((name) => {
    void received(name).catch(failed);
  });

  return { received };
}

/**
 * WXT's `browser`, narrowed to what this module uses, or `undefined` where the namespace is
 * missing — a top-level `undefined.onCommand` takes the whole background script down.
 */
function commandsApi(): CommandsApi | undefined {
  return (browser as unknown as { commands?: CommandsApi | undefined }).commands;
}

function failed(error: unknown): void {
  void reportBackgroundError('commands', error);
}
