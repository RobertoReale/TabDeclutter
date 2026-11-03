import { describe, expect, it } from 'vitest';

import { DEFAULT_MATCH_OPTIONS } from '../../src/core/types';
import type { MatchOptions } from '../../src/core/types';
import { displayHost, isTrackingParam, normalizeUrl, registrableDomain } from '../../src/core/url';

/** The defaults with one switch flipped, so each case says what it is testing. */
function withOptions(overrides: Partial<MatchOptions>): MatchOptions {
  return { ...DEFAULT_MATCH_OPTIONS, ...overrides };
}

/**
 * `[input, expected]` under the default options (PLAN.md §8.3). Table-driven, because
 * the "Done when" of M1.1 asks for at least 40 cases and a list is where a reviewer can
 * see the whole contract at once.
 */
const DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  // Host
  ['https://EXAMPLE.com/a', 'https://example.com/a'],
  ['https://www.example.com/a', 'https://example.com/a'],
  ['https://WWW.Example.COM/a', 'https://example.com/a'],
  // `www.com` is a registrable domain: stripping the label would invent another site.
  ['https://www.com/a', 'https://www.com/a'],
  ['https://www2.example.com/a', 'https://www2.example.com/a'],
  ['https://www.www.example.com/a', 'https://example.com/a'],
  ['https://müller.de/', 'https://xn--mller-kva.de/'],

  // Ports: the default one goes, any other stays.
  ['https://example.com:443/a', 'https://example.com/a'],
  ['http://example.com:80/a', 'http://example.com/a'],
  ['http://example.com:8080/a', 'http://example.com:8080/a'],
  ['https://www.example.com:8443/a', 'https://example.com:8443/a'],

  // Trailing slash, except the root.
  ['https://example.com/a/', 'https://example.com/a'],
  ['https://example.com/a/b/', 'https://example.com/a/b'],
  ['https://example.com/', 'https://example.com/'],
  ['https://example.com', 'https://example.com/'],
  ['https://example.com/a//', 'https://example.com/a'],

  // Case outside the host is part of the address.
  ['https://example.com/A/B', 'https://example.com/A/B'],

  // Query: sorted by name, tracking parameters dropped.
  ['https://example.com/a?b=2&a=1', 'https://example.com/a?a=1&b=2'],
  ['https://example.com/a?z=1&y=2&x=3', 'https://example.com/a?x=3&y=2&z=1'],
  ['https://example.com/a?a=2&a=1', 'https://example.com/a?a=2&a=1'],
  ['https://example.com/a?utm_source=news&id=7', 'https://example.com/a?id=7'],
  ['https://example.com/a?utm_source=x&utm_medium=y&utm_campaign=z', 'https://example.com/a'],
  ['https://example.com/a?UTM_SOURCE=x&id=7', 'https://example.com/a?id=7'],
  ['https://example.com/a?fbclid=abc', 'https://example.com/a'],
  ['https://example.com/a?gclid=abc&dclid=def&msclkid=ghi', 'https://example.com/a'],
  ['https://example.com/a?mc_cid=1&mc_eid=2&igshid=3', 'https://example.com/a'],
  ['https://example.com/a?ref_src=twsrc&_ga=2.1&spm=a1', 'https://example.com/a'],
  ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc', 'https://youtube.com/watch?v=dQw4w9WgXcQ'],
  ['https://example.com/a?', 'https://example.com/a'],
  ['https://example.com/a?flag', 'https://example.com/a?flag='],
  // Both spellings of a space in a query decode to the same thing.
  ['https://example.com/a?q=a+b', 'https://example.com/a?q=a+b'],
  ['https://example.com/a?q=a%20b', 'https://example.com/a?q=a+b'],

  // Hash: dropped, unless it is the route of a single-page app.
  ['https://example.com/a#section', 'https://example.com/a'],
  ['https://example.com/#top', 'https://example.com/'],
  ['https://example.com/#/inbox/42', 'https://example.com/#/inbox/42'],
  ['https://example.com#/inbox', 'https://example.com/#/inbox'],
  ['https://example.com/#/', 'https://example.com/#/'],
  // A `?` inside the fragment is part of the route, so it is neither sorted nor filtered.
  ['https://example.com/#/inbox?b=2&a=1', 'https://example.com/#/inbox?b=2&a=1'],
  // Only on the root: a hash under a real path is a fragment, not a route.
  ['https://example.com/app#/inbox', 'https://example.com/app'],
  ['https://example.com/a?b=1#frag', 'https://example.com/a?b=1'],

  // Internal pages of both browsers.
  ['about:blank', 'about:blank'],
  ['about:newtab', 'about:newtab'],
  ['about:home', 'about:home'],
  ['about:reader?url=https%3A%2F%2Fe.com', 'about:reader?url=https%3A%2F%2Fe.com'],
  ['chrome://newtab', 'chrome://newtab/'],
  ['chrome://newtab/', 'chrome://newtab/'],
  ['chrome://settings/clearBrowserData', 'chrome://settings/clearBrowserData'],
  ['edge://newtab/', 'edge://newtab/'],
  ['moz-extension://1b2c-3d/sidepanel.html', 'moz-extension://1b2c-3d/sidepanel.html'],
  ['chrome-extension://abcdef/panel.html?b=2&a=1', 'chrome-extension://abcdef/panel.html?a=1&b=2'],
  ['file:///C:/tmp/report.pdf', 'file:///C:/tmp/report.pdf'],
  ['file:///home/r/notes/', 'file:///home/r/notes'],
  // Opaque schemes keep their payload: there is no path to tidy inside it.
  ['view-source:https://example.com/a/', 'view-source:https://example.com/a/'],
  ['data:text/html,<p>hello</p>', 'data:text/html,<p>hello</p>'],

  // Invalid or empty input comes back trimmed, never as an exception.
  ['', ''],
  ['   ', ''],
  ['not a url', 'not a url'],
  ['//example.com/a', '//example.com/a'],
  ['http://', 'http://'],
  ['  https://example.com/a  ', 'https://example.com/a'],

  // Hosts without a registrable domain are still normalized.
  ['https://192.168.1.1:443/a/', 'https://192.168.1.1/a'],
  ['https://[::1]:8443/a/', 'https://[::1]:8443/a'],
  ['http://localhost:3000/', 'http://localhost:3000/'],
];

describe('normalizeUrl, with the default options', () => {
  it.each(DEFAULTS)('%j → %j', (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  it('is idempotent on every case above', () => {
    for (const [, expected] of DEFAULTS) {
      expect(normalizeUrl(expected)).toBe(expected);
    }
  });

  it('is the same function whether the options are passed or defaulted', () => {
    for (const [input, expected] of DEFAULTS) {
      expect(normalizeUrl(input, DEFAULT_MATCH_OPTIONS)).toBe(expected);
    }
  });
});

describe('normalizeUrl: ignoreWww', () => {
  it('keeps the label when the option is off', () => {
    expect(normalizeUrl('https://www.example.com/a', withOptions({ ignoreWww: false }))).toBe(
      'https://www.example.com/a',
    );
  });

  it('keeps the port when it drops the label', () => {
    expect(normalizeUrl('https://www.example.com:8443/a', withOptions({ ignoreWww: false }))).toBe(
      'https://www.example.com:8443/a',
    );
  });
});

describe('normalizeUrl: ignoreHash', () => {
  it('keeps an ordinary fragment when the option is off', () => {
    expect(normalizeUrl('https://example.com/a#section', withOptions({ ignoreHash: false }))).toBe(
      'https://example.com/a#section',
    );
  });

  it('keeps an SPA route either way', () => {
    const url = 'https://example.com/#/inbox';
    expect(normalizeUrl(url, withOptions({ ignoreHash: false }))).toBe(url);
    expect(normalizeUrl(url, withOptions({ ignoreHash: true }))).toBe(url);
  });
});

describe('normalizeUrl: ignoreTrackingParams', () => {
  it('keeps the campaign parameters when the option is off', () => {
    expect(
      normalizeUrl(
        'https://example.com/a?utm_source=news&id=7',
        withOptions({ ignoreTrackingParams: false }),
      ),
    ).toBe('https://example.com/a?id=7&utm_source=news');
  });
});

describe('normalizeUrl: ignoreAllParams', () => {
  const options = withOptions({ ignoreAllParams: true });

  it('drops the whole query', () => {
    expect(normalizeUrl('https://example.com/a?id=7&q=x', options)).toBe('https://example.com/a');
  });

  it('keeps the path', () => {
    expect(normalizeUrl('https://example.com/a/b?id=7', options)).toBe('https://example.com/a/b');
  });

  // The `?` is inside the fragment, so it is part of the route and not the URL's query.
  it('leaves the query of an SPA route alone', () => {
    expect(normalizeUrl('https://example.com/#/inbox?id=7', options)).toBe(
      'https://example.com/#/inbox?id=7',
    );
  });
});

describe('normalizeUrl: ignorePath', () => {
  const options = withOptions({ ignorePath: true });

  it('compares the host only', () => {
    expect(normalizeUrl('https://www.example.com/a/b?id=7#frag', options)).toBe(
      'https://example.com/',
    );
  });

  it('keeps the port, which is part of the host', () => {
    expect(normalizeUrl('http://example.com:8080/a', options)).toBe('http://example.com:8080/');
  });

  it('does nothing to a URL that has no host', () => {
    expect(normalizeUrl('about:blank', options)).toBe('about:blank');
    expect(normalizeUrl('about:addons', options)).toBe('about:addons');
  });
});

describe('normalizeUrl: ignoreCase', () => {
  const options = withOptions({ ignoreCase: true });

  it('lower-cases the path and the query', () => {
    expect(normalizeUrl('https://example.com/A/B?Q=Xy', options)).toBe(
      'https://example.com/a/b?q=xy',
    );
  });

  it('lower-cases a URL it could not parse', () => {
    expect(normalizeUrl('  NOT A URL  ', options)).toBe('not a url');
  });
});

describe('isTrackingParam', () => {
  it.each(['utm_source', 'utm_medium', 'UTM_CAMPAIGN', 'fbclid', 'gclid', 'si', 'spm', '_ga'])(
    '%s is a tracking parameter',
    (name) => {
      expect(isTrackingParam(name)).toBe(true);
    },
  );

  it.each(['id', 'q', 'v', 'page', 'utm', 'sid', 'gclid_x'])('%s is not', (name) => {
    expect(isTrackingParam(name)).toBe(false);
  });
});

describe('registrableDomain', () => {
  it.each([
    ['https://mail.google.com/mail/u/0', 'google.com'],
    ['https://docs.google.com/document/d/1', 'google.com'],
    ['mail.google.com', 'google.com'],
    ['https://www.bbc.co.uk/news', 'bbc.co.uk'],
    ['https://a.b.bbc.co.uk/news', 'bbc.co.uk'],
    // Private suffixes: two users' pages are two different sites.
    ['https://user.github.io/project', 'user.github.io'],
    ['https://other.github.io/project', 'other.github.io'],
    ['foo.blogspot.com', 'foo.blogspot.com'],
    ['  https://example.com/a  ', 'example.com'],
  ])('%j → %j', (input, expected) => {
    expect(registrableDomain(input)).toBe(expected);
  });

  it.each([
    'https://192.168.1.1/a',
    'http://localhost:3000/',
    'about:blank',
    'chrome://newtab/',
    'moz-extension://1b2c-3d/panel.html',
    'file:///C:/tmp/report.pdf',
    'not a url',
    '',
  ])('%j has no registrable domain', (input) => {
    expect(registrableDomain(input)).toBeNull();
  });
});

describe('displayHost', () => {
  it.each([
    ['https://www.example.com/a/b?id=7', 'example.com'],
    ['https://EXAMPLE.com/a', 'example.com'],
    // Not the registrable domain: these are two different places to the user.
    ['https://docs.google.com/document/d/1', 'docs.google.com'],
    ['https://mail.google.com/mail/u/0', 'mail.google.com'],
    // And a host with no registrable domain still has something to show.
    ['http://localhost:3000/', 'localhost'],
    ['https://192.168.1.1/a', '192.168.1.1'],
    ['  https://example.com/a  ', 'example.com'],
    ['https://müller.de/', 'xn--mller-kva.de'],
  ])('%j → %j', (input, expected) => {
    expect(displayHost(input)).toBe(expected);
  });

  it.each(['about:blank', 'about:newtab', 'file:///C:/tmp/report.pdf', 'not a url', '', '   '])(
    '%j has no host to show',
    (input) => {
      expect(displayHost(input)).toBe('');
    },
  );
});
