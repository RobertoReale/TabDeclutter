/**
 * Chrome/Firefox feature detection, PLAN.md §5.5.
 *
 * Invariant 5 (TASKS.md §2): application code asks `caps` what is available and
 * never checks the browser name. This module and `panel.ts` are the only places
 * a browser name appears at runtime, and only where no feature detection
 * exists (`import.meta.env.BROWSER`, inlined at build time).
 */

/** Everything capability detection looks at, so that a test can supply it. */
export interface CapabilityEnv {
  /** WXT's build target, from `import.meta.env.BROWSER`. */
  readonly targetBrowser: string | undefined;
  /** The `chrome` global. Firefox defines it too, without `sidePanel`. */
  readonly chrome?: { readonly sidePanel?: unknown } | undefined;
  /** The `browser` namespace. WXT polyfills it on Chrome. */
  readonly extensionApi?: ExtensionApiProbe | undefined;
  /** The global object, for APIs exposed as bare globals (`LanguageModel`). */
  readonly globals?: object | undefined;
}

/** The members of the `browser` namespace whose presence is a capability. */
interface ExtensionApiProbe {
  readonly sidebarAction?: unknown;
  readonly tabGroups?: unknown;
  readonly contextualIdentities?: unknown;
  readonly sessions?: { readonly setTabValue?: unknown } | undefined;
}

export interface Capabilities {
  /** Chrome: `side_panel` + `sidePanel`. */
  readonly sidePanel: boolean;
  /** Firefox: `sidebar_action` + `sidebarAction`. */
  readonly sidebarAction: boolean;
  /** Chrome: `/_favicon/?pageUrl=…`, the local cache, no network request. */
  readonly faviconApi: boolean;
  /** Chrome: the Prompt API (Gemini Nano), for optional grouping by topic. */
  readonly promptApi: boolean;
  /** Native tab groups: Chrome, and Firefox 139+. */
  readonly tabGroups: boolean;
  /** Firefox: Multi-Account Containers. Two containers are two sessions. */
  readonly containers: boolean;
  /** Firefox: `sessions.setTabValue`, which survives a restart. */
  readonly sessionTabValues: boolean;
  /** Chrome: telling an intentional "Duplicate tab" apart (PLAN.md §8.6). */
  readonly duplicateCommandDetection: boolean;
}

export function detectCapabilities(env: CapabilityEnv): Capabilities {
  const api = env.extensionApi;
  return {
    sidePanel: Boolean(env.chrome?.sidePanel),
    sidebarAction: Boolean(api?.sidebarAction),
    faviconApi: env.targetBrowser === 'chrome',
    promptApi: env.globals !== undefined && 'LanguageModel' in env.globals,
    tabGroups: Boolean(api?.tabGroups),
    containers: Boolean(api?.contextualIdentities),
    sessionTabValues: typeof api?.sessions?.setTabValue === 'function',
    duplicateCommandDetection: env.targetBrowser === 'chrome',
  };
}

/** Read off `globalThis`, so that a browser without it just gives `undefined`. */
interface GlobalsWithChrome {
  readonly chrome?: CapabilityEnv['chrome'];
}

/**
 * WXT's `browser`: Firefox's own namespace, and `chrome` on Chrome, which does
 * not define `browser` at all. Under the unit tests the auto-import does not
 * exist, hence the `typeof` guard.
 */
function extensionApi(): ExtensionApiProbe | undefined {
  return typeof browser === 'undefined' ? undefined : (browser as unknown as ExtensionApiProbe);
}

export function currentEnv(): CapabilityEnv {
  return {
    targetBrowser: import.meta.env.BROWSER,
    chrome: (globalThis as GlobalsWithChrome).chrome,
    extensionApi: extensionApi(),
    globals: globalThis,
  };
}

/** Evaluated once when each context starts (PLAN.md §5.5). */
export const caps: Capabilities = detectCapabilities(currentEnv());
