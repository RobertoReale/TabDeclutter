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

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
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
  const trimmed = url.trim();
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
  return getDomain(urlOrHostname.trim(), { allowPrivateDomains: true });
}
