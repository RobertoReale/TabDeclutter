import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildManifest } from '../../build/manifest';

/**
 * PLAN.md §5.4 is quoted here key by key, not sampled: invariant 8 says the
 * permissions are exactly those of the spec, and an extra one is a reason for
 * rejection in review on both stores.
 */

const ASSIGNABLE_COMMANDS = {
  'close-all-duplicates': { description: '__MSG_cmdCloseDuplicates__' },
  'toggle-duplicate-guard': { description: '__MSG_cmdToggleGuard__' },
};

describe('the Chrome manifest', () => {
  const manifest = buildManifest('chrome');

  it('is exactly what PLAN.md §5.4 asks for', () => {
    expect(manifest).toEqual({
      name: '__MSG_extName__',
      description: '__MSG_extDescription__',
      default_locale: 'en',
      minimum_chrome_version: '121',
      permissions: [
        'tabs',
        'tabGroups',
        'storage',
        'sidePanel',
        'alarms',
        'favicon',
        'sessions',
        'contextMenus',
      ],
      optional_permissions: ['bookmarks'],
      incognito: 'not_allowed',
      action: { default_title: '__MSG_actionTitle__' },
      side_panel: { default_path: 'sidepanel.html' },
      commands: {
        _execute_action: { suggested_key: { default: 'Alt+Shift+D' } },
        ...ASSIGNABLE_COMMANDS,
      },
    });
  });

  it('declares Firefox nothing', () => {
    expect(manifest.browser_specific_settings).toBeUndefined();
    expect(manifest.sidebar_action).toBeUndefined();
  });
});

describe('the Firefox manifest', () => {
  const manifest = buildManifest('firefox');

  it('is exactly what PLAN.md §5.4 asks for', () => {
    expect(manifest).toEqual({
      name: '__MSG_extName__',
      description: '__MSG_extDescription__',
      default_locale: 'en',
      browser_specific_settings: {
        gecko: {
          id: 'tabdeclutter@robertoreale',
          strict_min_version: '140.0',
          data_collection_permissions: { required: ['none'] },
        },
      },
      permissions: ['tabs', 'tabGroups', 'storage', 'alarms', 'sessions', 'menus'],
      optional_permissions: ['bookmarks'],
      incognito: 'not_allowed',
      action: { default_title: '__MSG_actionTitle__' },
      sidebar_action: {
        default_panel: 'sidepanel.html',
        default_title: '__MSG_extName__',
        open_at_install: false,
      },
      commands: {
        _execute_sidebar_action: { suggested_key: { default: 'Alt+Shift+D' } },
        ...ASSIGNABLE_COMMANDS,
      },
    });
  });

  it('asks for neither sidePanel nor favicon, which do not exist on Firefox', () => {
    expect(manifest.permissions).not.toContain('sidePanel');
    expect(manifest.permissions).not.toContain('favicon');
    expect(manifest.minimum_chrome_version).toBeUndefined();
    expect(manifest.side_panel).toBeUndefined();
  });
});

describe('both manifests', () => {
  const browsers = ['chrome', 'firefox'] as const;

  it.each(browsers)('%s: asks for no host permission and injects no script', (browser) => {
    const manifest = buildManifest(browser);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.permissions).not.toContain('<all_urls>');
    expect(manifest.permissions).not.toContain('webNavigation');
  });

  it.each(browsers)('%s: keeps bookmarks optional, never required', (browser) => {
    const manifest = buildManifest(browser);
    expect(manifest.permissions).not.toContain('bookmarks');
    expect(manifest.optional_permissions).toEqual(['bookmarks']);
  });

  it.each(browsers)('%s: binds Alt+Shift+D to opening the panel', (browser) => {
    const commands = buildManifest(browser).commands ?? {};
    const panelCommand = browser === 'firefox' ? '_execute_sidebar_action' : '_execute_action';
    expect(commands[panelCommand]?.suggested_key).toEqual({ default: 'Alt+Shift+D' });
  });

  it.each(browsers)('%s: leaves the two extra commands without a default key', (browser) => {
    const commands = buildManifest(browser).commands ?? {};
    for (const name of Object.keys(ASSIGNABLE_COMMANDS)) {
      expect(commands[name]?.suggested_key).toBeUndefined();
    }
  });

  it('treats an unknown target as Chrome, which is what WXT defaults to', () => {
    expect(buildManifest('edge')).toEqual(buildManifest('chrome'));
  });
});

/**
 * WXT builds `sidebar_action` from the sidepanel entrypoint and overwrites the
 * one in build/manifest.ts. `default_title` and `open_at_install` therefore
 * only reach the Firefox manifest if the HTML says the same thing.
 */
describe('the sidepanel entrypoint, which WXT builds sidebar_action from', () => {
  const html = readFileSync(
    new URL('../../src/entrypoints/sidepanel/index.html', import.meta.url),
    'utf8',
  );
  const sidebar = buildManifest('firefox').sidebar_action;

  it('carries the sidebar title in <title>', () => {
    expect(/<title>([^<]*)<\/title>/.exec(html)?.[1]).toBe(sidebar?.default_title);
  });

  it('carries open_at_install in a meta tag', () => {
    expect(html).toContain(
      `<meta name="manifest.open_at_install" content="${String(sidebar?.open_at_install)}" />`,
    );
  });
});
