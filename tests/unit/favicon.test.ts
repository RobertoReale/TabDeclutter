import { describe, expect, it } from 'vitest';

import type { Capabilities } from '../../src/platform/capabilities';
import { faviconOf } from '../../src/platform/favicon';

/**
 * PLAN.md §5.5 and invariant 1: a row shows an icon without the extension ever making a
 * network request. Which of the three cases applies is decided by `capabilities`, never
 * by asking which browser this is, so both are testable here with a literal.
 */

const NOTHING: Capabilities = {
  sidePanel: false,
  sidebarAction: false,
  faviconApi: false,
  promptApi: false,
  tabGroups: false,
  containers: false,
  sessionTabValues: false,
  duplicateCommandDetection: false,
};

/** Chrome: the favicon cache is there, on the extension's own origin. */
const CHROME = {
  capabilities: { ...NOTHING, faviconApi: true },
  getURL: (path: string): string => `chrome-extension://abcdef${path}`,
};

/** Firefox: no cache to read, and `getURL` would not help if there were. */
const FIREFOX = {
  capabilities: NOTHING,
  getURL: (path: string): string => `moz-extension://1b2c-3d${path}`,
};

describe('faviconOf with a data: favicon', () => {
  it('uses it as it is, on either browser: there is nothing to fetch', () => {
    const tab = { url: 'https://example.com/a', favIconUrl: 'data:image/png;base64,AAA' };
    for (const options of [CHROME, FIREFOX]) {
      expect(faviconOf(tab, options)).toEqual({
        kind: 'image',
        src: 'data:image/png;base64,AAA',
      });
    }
  });
});

describe('faviconOf on Chrome', () => {
  it("asks the browser's own favicon cache, at 16 px for a 2x screen", () => {
    expect(faviconOf({ url: 'https://example.com/a?id=7' }, CHROME)).toEqual({
      kind: 'image',
      src: 'chrome-extension://abcdef/_favicon/?pageUrl=https%3A%2F%2Fexample.com%2Fa%3Fid%3D7&size=32',
    });
  });

  it('prefers the cache to a remote favIconUrl, which it may not load', () => {
    const favicon = faviconOf(
      { url: 'https://example.com/a', favIconUrl: 'https://example.com/icon.png' },
      CHROME,
    );
    expect(favicon).toEqual({
      kind: 'image',
      src: 'chrome-extension://abcdef/_favicon/?pageUrl=https%3A%2F%2Fexample.com%2Fa&size=32',
    });
  });

  it.each(['about:blank', 'chrome://settings/', 'file:///C:/tmp/report.pdf', 'not a url', ''])(
    '%j has no icon in the cache, so it gets an avatar',
    (url) => {
      expect(faviconOf({ url }, CHROME).kind).toBe('initial');
    },
  );

  it('falls back to an avatar outside an extension context, where there is no origin', () => {
    const favicon = faviconOf(
      { url: 'https://example.com/a' },
      {
        ...CHROME,
        getURL: () => '',
      },
    );
    expect(favicon).toEqual({ kind: 'initial', initial: 'E', hue: expect.any(Number) });
  });
});

describe('faviconOf on Firefox', () => {
  it('never uses a remote favIconUrl: that would be a network request (invariant 1)', () => {
    const favicon = faviconOf(
      { url: 'https://example.com/a', favIconUrl: 'https://example.com/icon.png' },
      FIREFOX,
    );
    expect(favicon.kind).toBe('initial');
    expect(JSON.stringify(favicon)).not.toContain('icon.png');
  });

  it("draws the domain's initial, upper-cased", () => {
    expect(faviconOf({ url: 'https://www.github.com/a' }, FIREFOX)).toMatchObject({
      kind: 'initial',
      initial: 'G',
    });
    expect(faviconOf({ url: 'https://9gag.com/' }, FIREFOX)).toMatchObject({ initial: '9' });
  });

  it('draws a plain square for a URL with no host, rather than inventing a letter', () => {
    expect(faviconOf({ url: 'about:blank' }, FIREFOX)).toEqual({
      kind: 'initial',
      initial: '',
      hue: expect.any(Number),
    });
  });
});

describe("the avatar's colour", () => {
  /** `faviconOf` on Firefox always avatars, which is where the hue comes from. */
  function hueOf(url: string): number {
    const favicon = faviconOf({ url }, FIREFOX);
    if (favicon.kind !== 'initial') throw new Error(`${url} did not get an avatar`);
    return favicon.hue;
  }

  it('is a hue CSS can use: a whole number of degrees', () => {
    for (const url of ['https://example.com/', 'https://github.com/', 'about:blank']) {
      const hue = hueOf(url);
      expect(Number.isInteger(hue)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it('is the same every time, so a site always looks the same', () => {
    expect(hueOf('https://example.com/a')).toBe(hueOf('https://example.com/a'));
    // The same site, two pages, with and without the `www.`: one colour.
    expect(hueOf('https://www.example.com/b?id=7')).toBe(hueOf('https://example.com/a'));
  });

  it('spreads the domains out, so neighbours are not one colour', () => {
    const hues = ['a.com', 'b.com', 'c.com', 'example.com', 'example.org', 'docs.example.com'].map(
      (host) => hueOf(`https://${host}/`),
    );
    expect(new Set(hues).size).toBe(hues.length);
  });
});
