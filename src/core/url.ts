/**
 * URL normalization (PLAN.md §6.2) and the registrable domain (eTLD+1).
 *
 * The output of `normalizeUrl` is a **key**, not something to show: two tabs the user
 * would call "the same page" must produce the same string. It is what `duplicateKey()`
 * is built on and what "Mantieni" is stored under (PLAN.md §9), so it has to be
 * deterministic and total — a tab URL can be anything, including `about:blank`,
 * `chrome://newtab/`, a `data:` URL or an empty string, and none of those may throw.
 */

import { getDomain } from 'tldts-experimental';
import type { MatchOptions } from './types';
import { DEFAULT_MATCH_OPTIONS } from './types';

/** Query parameters that identify the campaign, not the page (PLAN.md §6.2). */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ref_src',
  '_ga',
  // YouTube's share parameter.
  'si',
  'spm',
]);

/** Whole families of them, matched on the prefix. */
const TRACKING_PARAM_PREFIXES = ['utm_'];

/**
 * Whether a query parameter only says where the visit came from.
 *
 * Compared lower-case: `UTM_SOURCE` is the same tracker as `utm_source`, and dropping
 * it is right whatever the `ignoreCase` option says about the rest of the URL.
 */
export function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return TRACKING_PARAMS.has(lower) || TRACKING_PARAM_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * `www.example.com` → `example.com`, but `www.com` stays as it is: it is a registrable
 * domain in its own right, and stripping the label would invent a different site.
 *
 * Repeated rather than single, so that normalizing an already normalized URL cannot
 * change it again (`www.www.example.com` and `www.example.com` are one key, not two).
 */
function stripWww(hostname: string): string {
  let host = hostname;
  while (host.startsWith('www.')) {
    const rest = host.slice('www.'.length);
    if (!rest.includes('.')) break;
    host = rest;
  }
  return host;
}

const SUSPENDER_PAGE =
  /\/(?:suspend(?:ed)?|park(?:ed)?|discard(?:ed)?|sleep(?:ing)?|hibernat(?:e|ed)|freez(?:e|ing)|frozen|unload(?:ed)?)(?:\.html?)?$/i;

const SUSPENDER_NEXT_PARAM =
  /&(?:ttl|title|pos|wh|fav(?:icon|IconUrl)?|scroll_[xy]|(?:tab|window)Id)=/i;

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function asWebUrl(candidate: string): string | null {
  const trimmed = candidate.trim();
  const parsed = parse(trimmed);
  if (parsed === null) return null;
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  return parsed.hostname === '' ? null : trimmed;
}

function extractFromParamString(raw: string): string | null {
  if (raw === '') return null;
  // Unencoded `uri=https://…` / `url=https://…` (The Great / Marvellous Suspender places an
  // unencoded `uri=` last in the fragment, where `URLSearchParams` would truncate at any `&`
  // belonging to the wrapped page's own query string).
  const unencoded = /(?:^|&)(?:uri|url)=(https?:\/\/.+)$/i.exec(raw);
  if (unencoded?.[1] !== undefined) {
    const tail = unencoded[1];
    const cut = tail.search(SUSPENDER_NEXT_PARAM);
    const candidate = asWebUrl(cut === -1 ? tail : tail.slice(0, cut));
    if (candidate !== null) return candidate;
  }
  const params = new URLSearchParams(raw);
  const value = params.get('url') ?? params.get('uri');
  return value === null ? null : asWebUrl(value);
}

/**
 * Extracts the original web URL wrapped by tab-suspender extensions (e.g. Tiny Suspender's
 * `suspend.html?url=…`, The Great / Marvellous Suspender's `suspended.html#…&uri=…`, or
 * Tab Suspender's `park.html?url=…`).
 *
 * Returns `url` unchanged for normal web URLs, non-suspender extension pages (options, PDF /
 * Office viewers), or any wrapped payload that is not an `http:` / `https:` URL.
 */
export function unwrapSuspendedUrl(url: string): string {
  let current = url.trim();
  for (let depth = 0; depth < 2; depth += 1) {
    // Fast-path normal web URLs (`http://`, `https://`, `about:`, etc.) without allocating
    // a prefix slice or lower-casing unless the string begins with `c`/`C` or `m`/`M`.
    const first = current.charCodeAt(0);
    if (first !== 99 && first !== 67 && first !== 109 && first !== 77) {
      return depth === 0 ? url : current;
    }
    const head = current.slice(0, 17).toLowerCase();
    if (!head.startsWith('chrome-extension:') && !head.startsWith('moz-extension:')) {
      return depth === 0 ? url : current;
    }
    const parsed = parse(current);
    if (parsed === null || !SUSPENDER_PAGE.test(parsed.pathname)) {
      return depth === 0 ? url : current;
    }
    const queryRaw = parsed.search.startsWith('?') ? parsed.search.slice(1) : '';
    const hashRaw = parsed.hash.replace(/^#\??/, '');
    const extracted = extractFromParamString(queryRaw) ?? extractFromParamString(hashRaw);
    if (extracted === null) return depth === 0 ? url : current;
    current = extracted;
  }
  return current;
}

/** Whether `url` is wrapped by a tab-suspender extension (`unwrapSuspendedUrl` extracted a real web URL). */
export function isSuspendedUrl(url: string): boolean {
  return unwrapSuspendedUrl(url) !== url;
}

/**
 * Rewrites `url` into the key form described by `options`.
 *
 * Always, whatever the options say: the host is lower-cased and IDN-encoded, a default
 * port is dropped, the query is sorted by parameter name and a trailing slash is
 * removed from everything but the root. Those are the parts of a URL that can differ
 * without the page differing. The rest is up to `MatchOptions` (PLAN.md §8.3).
 *
 * A URL the parser rejects is returned trimmed and otherwise untouched, so two tabs
 * showing the same unparseable string still match each other.
 */
export function normalizeUrl(url: string, options: MatchOptions = DEFAULT_MATCH_OPTIONS): string {
  const trimmed = unwrapSuspendedUrl(url).trim();
  const parsed = parse(trimmed);
  if (parsed === null) return options.ignoreCase ? trimmed.toLowerCase() : trimmed;

  // `about:blank`, `data:…`, `javascript:…`, `view-source:https://…`: there is no
  // authority, so the "path" is an opaque remainder and has no slashes to tidy. A
  // `file:///…` URL has an empty host but does have an authority, which is why this
  // looks for `//` and not for a host.
  // Asked of `href`, not of the input: the parser forgives `https:/example.com` and
  // reports it as an ordinary authority URL, which the raw string does not look like.
  const hierarchical = parsed.href.startsWith(`${parsed.protocol}//`);

  // `new URL` has already lower-cased the host, punycoded it and removed the port when
  // it is the scheme's default (`https://example.com:443/` → no port); a scheme with no
  // known default has no default port to remove.
  const hostname = options.ignoreWww ? stripWww(parsed.hostname) : parsed.hostname;
  const authority = parsed.port === '' ? hostname : `${hostname}:${parsed.port}`;
  const prefix = hierarchical ? `${parsed.protocol}//${authority}` : parsed.protocol;

  // "Ignore the path" compares scheme and host only. With no host there is nothing to
  // compare, so the option is a no-op rather than a way of making every `about:` page
  // the same page.
  if (options.ignorePath && hierarchical) return finish(`${prefix}/`, options);

  let path = parsed.pathname;
  if (hierarchical) {
    // Every trailing slash, not just the last one, so that normalizing an already
    // normalized path cannot change it again.
    while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    if (path === '') path = '/';
  }

  let search = '';
  if (!options.ignoreAllParams && parsed.search !== '') {
    const params = new URLSearchParams(parsed.search);
    if (options.ignoreTrackingParams) {
      for (const name of [...params.keys()]) {
        if (isTrackingParam(name)) params.delete(name);
      }
    }
    params.sort();
    const query = params.toString();
    if (query !== '') search = `?${query}`;
  }

  // A hash is noise (`#section`) unless it is the route of a single-page app, which is
  // the whole address of the page (PLAN.md §6.2). Kept verbatim: a `?` inside the
  // fragment belongs to the route, not to the URL's query, and the option that drops
  // the query says nothing about it.
  const isSpaRoute = path === '/' && parsed.hash.startsWith('#/');
  const hash = options.ignoreHash && !isSpaRoute ? '' : parsed.hash;

  return finish(`${prefix}${path}${search}${hash}`, options);
}

function finish(normalized: string, options: MatchOptions): string {
  return options.ignoreCase ? normalized.toLowerCase() : normalized;
}

/**
 * The registrable domain (eTLD+1) of a URL or a bare hostname, or `null` when it has
 * none: an IP address, `localhost`, an internal page, an unparseable string.
 *
 * Used to group `mail.google.com` with `docs.google.com` (PLAN.md §5.1) and to match
 * the protected sites.
 */
export function registrableDomain(urlOrHostname: string): string | null {
  // `allowPrivateDomains` makes `user.github.io` and `foo.blogspot.com` sites of their
  // own, which is what the user sees them as; see docs/DECISIONS.md.
  return getDomain(unwrapSuspendedUrl(urlOrHostname).trim(), { allowPrivateDomains: true });
}

/**
 * The host as a row shows it (PLAN.md §4.3, the grey domain): lower-case, without
 * `www.`, `''` when the URL has no host at all (`about:blank`, a `file:` path, an empty
 * string).
 *
 * Not `registrableDomain`: this is for the user to read, and `docs.example.com` and
 * `example.com` are two different places to them, while `localhost` and `127.0.0.1` have
 * no registrable domain and would otherwise show nothing. It is also what the favicon
 * avatar takes its letter and its colour from, so the letter always matches the domain
 * on screen (PLAN.md §5.5).
 */
const EXTENSION_SCHEMES = new Set(['chrome-extension:', 'moz-extension:']);

export function displayHost(url: string): string {
  const parsed = parse(unwrapSuspendedUrl(url).trim());
  if (parsed === null) return '';
  if (EXTENSION_SCHEMES.has(parsed.protocol.toLowerCase())) return '';
  return stripWww(parsed.hostname.toLowerCase());
}
