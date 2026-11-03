/**
 * The 16 px favicon of a row (PLAN.md §4.3, §5.5, §11), without ever touching the
 * network — invariant 1, and the reason this is not simply `tab.favIconUrl`.
 *
 * Three cases, in this order:
 *
 * 1. a `data:` favicon is already in the tab object: nothing to fetch, either browser;
 * 2. Chrome has `/_favicon/?pageUrl=…&size=32`, which reads the browser's own favicon
 *    cache and is the only permitted way to show a site's real icon;
 * 3. anything else — Firefox, where `favIconUrl` is usually a remote URL we may not
 *    load — gets an avatar with the domain's initial, coloured from a hash of the
 *    domain, so two sites rarely look alike and one site always looks the same.
 *
 * Which browser we are on is never asked: `capabilities.faviconApi` is (invariant 5).
 */

import type { Capabilities } from './capabilities';
import { caps } from './capabilities';
import { displayHost } from '../core/url';

/** What to draw for a tab: an image we may load, or an avatar to compose. */
export type Favicon =
  | { readonly kind: 'image'; readonly src: string }
  /** `initial` can be empty (a URL with no host): then the avatar is just the colour. */
  | { readonly kind: 'initial'; readonly initial: string; readonly hue: number };

/** The part of a tab the favicon is decided from. */
export interface FaviconTab {
  readonly url: string;
  readonly favIconUrl?: string;
}

/** The size Chrome's favicon cache is asked for: 16 px at 2× (PLAN.md §11). */
const FAVICON_SIZE = '32';

export interface FaviconOptions {
  readonly capabilities?: Capabilities;
  /** `browser.runtime.getURL`, injected so this is testable without an extension. */
  readonly getURL?: (path: string) => string;
}

/**
 * WXT auto-imports `browser`; under the unit tests there is none, and then there is no
 * extension origin to build a `/_favicon/` URL on either.
 *
 * `getURL` is typed over `public/`, and `/_favicon/` is not a file of ours: Chrome serves
 * it from the extension's own origin when `favicon` is in the permissions. Hence the one
 * cast, which is also all this function is for.
 */
function runtimeUrl(path: string): string {
  if (typeof browser === 'undefined') return '';
  const runtime = browser.runtime as unknown as { getURL(path: string): string };
  return runtime.getURL(path);
}

/** Only an http(s) page has an icon in the cache; `about:`/`file:` never do. */
function isWebPage(url: string): boolean {
  const lower = url.trim().toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://');
}

export function faviconOf(tab: FaviconTab, options: FaviconOptions = {}): Favicon {
  const capabilities = options.capabilities ?? caps;
  const getURL = options.getURL ?? runtimeUrl;

  const inline = tab.favIconUrl ?? '';
  if (inline.startsWith('data:')) return { kind: 'image', src: inline };

  if (capabilities.faviconApi && isWebPage(tab.url)) {
    const base = getURL('/_favicon/');
    if (base !== '') {
      return {
        kind: 'image',
        src: `${base}?pageUrl=${encodeURIComponent(tab.url.trim())}&size=${FAVICON_SIZE}`,
      };
    }
  }

  return avatar(tab.url);
}

/** The avatar of PLAN.md §5.5: the domain's initial over a colour the domain decides. */
function avatar(url: string): Favicon {
  const host = displayHost(url);
  return { kind: 'initial', initial: initialOf(host), hue: hueOf(host) };
}

/**
 * The first letter or digit of the host, upper-cased, or `''` when it has none — a tab
 * on `about:blank` gets a plain coloured square rather than an invented glyph.
 */
function initialOf(host: string): string {
  const found = /[a-z0-9]/i.exec(host);
  return found === null ? '' : found[0].toUpperCase();
}

/**
 * A hue from the domain, through FNV-1a: stable across restarts and across both
 * browsers, spread evenly enough that neighbouring domains are not the same colour.
 * Saturation and lightness stay in the stylesheet, so the avatar follows the theme.
 */
function hueOf(host: string): number {
  let hash = 0x811c9dc5;
  for (let at = 0; at < host.length; at++) {
    hash ^= host.charCodeAt(at);
    // The FNV prime, as the 32-bit multiplication JavaScript can do exactly.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}
