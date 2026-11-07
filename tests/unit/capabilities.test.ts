import { describe, expect, it } from 'vitest';

import type { CapabilityEnv } from '../../src/platform/capabilities';
import { detectCapabilities } from '../../src/platform/capabilities';

/**
 * The two environments of PLAN.md §5.5, mocked. Only the presence of a member
 * matters, so an empty object stands for an available namespace.
 */

const chromeEnv: CapabilityEnv = {
  targetBrowser: 'chrome',
  chrome: { sidePanel: {} },
  extensionApi: {
    tabGroups: {},
    // Chrome has `sessions`, but not `setTabValue`.
    sessions: {},
    // Chrome's own enum of the contexts it accepts: a page, a frame, its icon — no tab.
    contextMenus: { ContextType: { ALL: 'all', PAGE: 'page', FRAME: 'frame', ACTION: 'action' } },
  },
  globals: { LanguageModel: {} },
};

const firefoxEnv: CapabilityEnv = {
  targetBrowser: 'firefox',
  // Firefox defines `chrome` as well, as the callback-style alias.
  chrome: {},
  extensionApi: {
    sidebarAction: {},
    tabGroups: {},
    contextualIdentities: {},
    sessions: { setTabValue: () => undefined },
    // `menus` and not `contextMenus`: with the `menus` permission of PLAN.md §5.4, that
    // alias does not exist on Firefox. Its enum has a tab strip entry in it.
    menus: { ContextType: { ALL: 'all', PAGE: 'page', TAB: 'tab' } },
  },
  globals: {},
};

describe('detectCapabilities on Chrome', () => {
  const caps = detectCapabilities(chromeEnv);

  it('finds the side panel and not the sidebar', () => {
    expect(caps.sidePanel).toBe(true);
    expect(caps.sidebarAction).toBe(false);
  });

  it('finds the Chrome-only features', () => {
    expect(caps.faviconApi).toBe(true);
    expect(caps.promptApi).toBe(true);
    expect(caps.duplicateCommandDetection).toBe(true);
  });

  it('finds tab groups but neither containers nor persistent tab values', () => {
    expect(caps.tabGroups).toBe(true);
    expect(caps.containers).toBe(false);
    expect(caps.sessionTabValues).toBe(false);
  });

  // Chrome rejects the whole `create` call when a context it has no name for is asked
  // for, so the three items of PLAN.md §4.1 are registered on the page only.
  it('rules out the tab context, which Chrome has no name for', () => {
    expect(caps.tabContextMenu).toBe(false);
  });
});

describe('detectCapabilities on Firefox', () => {
  const caps = detectCapabilities(firefoxEnv);

  it('finds the sidebar and not the side panel', () => {
    expect(caps.sidebarAction).toBe(true);
    expect(caps.sidePanel).toBe(false);
  });

  it('finds the Firefox-only features', () => {
    expect(caps.containers).toBe(true);
    expect(caps.sessionTabValues).toBe(true);
  });

  it('finds tab groups, which Firefox 139 added', () => {
    expect(caps.tabGroups).toBe(true);
  });

  it('finds the tab context, so a menu item is shown on the tab strip too', () => {
    expect(caps.tabContextMenu).toBe(true);
  });

  it('rules out the Chrome-only features', () => {
    expect(caps.faviconApi).toBe(false);
    expect(caps.promptApi).toBe(false);
    expect(caps.duplicateCommandDetection).toBe(false);
  });
});

describe('detectCapabilities with nothing available', () => {
  it('says no to everything rather than throwing', () => {
    expect(detectCapabilities({ targetBrowser: undefined })).toEqual({
      sidePanel: false,
      sidebarAction: false,
      faviconApi: false,
      promptApi: false,
      tabGroups: false,
      containers: false,
      sessionTabValues: false,
      duplicateCommandDetection: false,
      tabContextMenu: false,
    });
  });

  it('does not take a context enum without a tab in it for one that has one', () => {
    const env: CapabilityEnv = {
      targetBrowser: 'chrome',
      extensionApi: { contextMenus: { ContextType: { PAGE: 'page' } } },
    };
    expect(detectCapabilities(env).tabContextMenu).toBe(false);
  });

  it('does not take a non-callable sessions.setTabValue for the real thing', () => {
    const env: CapabilityEnv = {
      targetBrowser: 'firefox',
      extensionApi: { sessions: { setTabValue: 'nope' } },
    };
    expect(detectCapabilities(env).sessionTabValues).toBe(false);
  });
});
