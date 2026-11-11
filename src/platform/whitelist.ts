/**
 * Which pre-filled duplicate whitelist this browser gets (PLAN.md §8.3).
 *
 * `core/patterns.ts` holds both lists and deliberately does not choose between them: the core
 * may not ask what browser it is running on (TASKS.md §2.4, §2.5), so the choice lives here.
 *
 * The key is `sidebarAction`, not `containers`: `browser.sidebarAction` exists on Firefox and
 * nowhere else and needs no permission, while `browser.contextualIdentities` needs the
 * `contextualIdentities` permission that PLAN.md §5.4 does not grant — asking for containers
 * would hand Firefox the Chrome list.
 *
 * Relative imports, not `@/`: this module is tested in the `unit` vitest project, which runs
 * without WXT's plugin and so without WXT's alias.
 */
import { DEFAULT_WHITELIST_CHROME, DEFAULT_WHITELIST_FIREFOX } from '../core/patterns';
import type { Capabilities } from './capabilities';

export function defaultWhitelist(capabilities: Capabilities): readonly string[] {
  return capabilities.sidebarAction ? DEFAULT_WHITELIST_FIREFOX : DEFAULT_WHITELIST_CHROME;
}
