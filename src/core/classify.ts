/**
 * Page type classification (PLAN.md §6.3).
 *
 * What kind of page a tab is showing, decided from the URL and the title alone. No
 * content is ever read: there is no content script and no `host_permissions`
 * (TASKS.md §2.8), so this is all the evidence there is — and a title is untrusted
 * input, matched against patterns and never interpreted (TASKS.md §2.7).
 *
 * The class is one input of the score (PLAN.md §6.4): `search`, `auth`, `error` and
 * `browser-internal` are transient pages, `own` is a protection, `content` is the
 * default and says nothing. The lists live in `rules.ts`.
 */

import {
  AUTH_HOSTS,
  AUTH_PATH_TOKENS,
  BLANK_URLS,
  ERROR_TITLE_PATTERNS,
  INTERNAL_SCHEMES,
  MEDIA_EXTENSIONS,
  SEARCH_ENGINE_HOSTS,
  SEARCH_ENGINE_PATHS,
  SEARCH_QUERY_PARAMS,
  SITE_SEARCH_RULES,
} from './rules';
import { registrableDomain } from './url';

/**
 * The classes of PLAN.md §6.3, plus `own`.
 *
 * `own` is TabDeclutter's own panel and pages: §6.3 excludes them from
 * `browser-internal` and §6.4 protects them, so they need a name of their own
 * (docs/DECISIONS.md).
 */
export type PageType =
  'blank' | 'own' | 'browser-internal' | 'file' | 'media' | 'search' | 'auth' | 'error' | 'content';

/** What the classification cannot know from the tab itself. */
export interface ClassifyContext {
  /**
   * Where the extension's own pages live, as `browser.runtime.getURL('')` returns it
   * (`chrome-extension://<id>/`, `moz-extension://<uuid>/`). Injected, because the id
   * differs per browser and per installation and `src/core/` may not ask the browser
   * anything (TASKS.md §2.4). Without it an own page is just another extension page.
   */
  readonly ownOrigin?: string;
}

/** The part of a tab the classification looks at. */
export interface ClassifiableTab {
  /** The URL the tab is showing. A loading tab has none: pass `pendingUrl` instead. */
  readonly url: string;
  readonly title?: string;
}

/** Lower-case, no query, no fragment, no trailing slash. */
export function canonicalUrl(url: string): string {
  const lower = url.trim().toLowerCase();
  const cut = lower.search(/[?#]/);
  let out = cut === -1 ? lower : lower.slice(0, cut);
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/** The scheme of a URL, with its colon, or `''` when the string has none. */
function scheme(url: string): string {
  const match = /^[a-z][a-z0-9+.-]*:/i.exec(url.trim());
  return match === null ? '' : match[0].toLowerCase();
}

function parse(url: string): URL | null {
  try {
    return new URL(url.trim());
  } catch {
    return null;
  }
}

/** A new tab, an empty tab, or a tab whose URL we were not given (PLAN.md §6.3). */
export function isBlankUrl(url: string): boolean {
  const canonical = canonicalUrl(url);
  return canonical === '' || BLANK_URLS.includes(canonical);
}

/**
 * Whether `url` is one of the extension's own pages. `ownOrigin` is compared as a path
 * prefix, so another extension whose id merely starts with the same characters cannot
 * borrow the protection.
 */
export function isOwnPage(url: string, ownOrigin?: string): boolean {
  if (ownOrigin === undefined || ownOrigin.trim() === '') return false;
  const base = canonicalUrl(ownOrigin);
  const candidate = canonicalUrl(url);
  return candidate === base || candidate.startsWith(`${base}/`);
}

/**
 * `pattern` against a host: a host matches itself and its subdomains, and `label.*`
 * matches that label under any public suffix (`google.*` → `google.co.uk`).
 */
function matchesHostPattern(pattern: string, host: string): boolean {
  if (pattern.endsWith('.*')) {
    const domain = registrableDomain(host);
    return domain !== null && domain.split('.')[0] === pattern.slice(0, -2);
  }
  return host === pattern || host.endsWith(`.${pattern}`);
}

/** `prefix` against a path, by whole segments: `/s` matches `/s/x`, never `/sport`. */
function isPathUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Lower-case, trailing slashes removed: `/Search/` and `/search` are one path. A URL
 * with an authority always has at least `/`, so there is no empty case to invent.
 */
function normalizePath(pathname: string): string {
  let path = pathname.toLowerCase();
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

/**
 * The path with every run of non-alphanumeric characters turned into a single `-`, and
 * one `-` added at each end, so a token can be looked for between boundaries.
 */
function tokenizePath(pathname: string): string {
  const tokens = pathname
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `-${tokens}-`;
}

/** A sign-in, sign-out or redirection page (PLAN.md §6.3 "auth"). */
export function isAuthUrl(url: string): boolean {
  const parsed = parse(url);
  if (parsed === null) return false;
  if (AUTH_HOSTS.some((pattern) => matchesHostPattern(pattern, parsed.hostname))) return true;
  const tokens = tokenizePath(parsed.pathname);
  return AUTH_PATH_TOKENS.some((token) => tokens.includes(`-${token}-`));
}

/** A list of results, on a search engine or inside a known site (PLAN.md §6.3). */
function isSearchUrl(parsed: URL): boolean {
  const host = parsed.hostname;
  const path = normalizePath(parsed.pathname);

  if (SEARCH_ENGINE_HOSTS.some((pattern) => matchesHostPattern(pattern, host))) {
    if (SEARCH_ENGINE_PATHS.some((prefix) => isPathUnder(path, prefix))) return true;
    // On the root path only: an engine that is also something else puts that something
    // else under a path of its own, and its query parameter is not a search there.
    if (path === '/' && SEARCH_QUERY_PARAMS.some((name) => parsed.searchParams.has(name))) {
      return true;
    }
  }

  return SITE_SEARCH_RULES.some(
    (rule) =>
      rule.hosts.some((pattern) => matchesHostPattern(pattern, host)) &&
      rule.paths.some((prefix) => isPathUnder(path, prefix)),
  );
}

/** The extension of the last path segment, with its dot, or `''`. */
function fileExtension(pathname: string): string {
  const last = pathname.slice(pathname.lastIndexOf('/') + 1).toLowerCase();
  const dot = last.lastIndexOf('.');
  // `dot === 0` is a dotfile (`/.htaccess`), which is a name and not an extension.
  return dot <= 0 ? '' : last.slice(dot);
}

/** A file the browser is showing on its own: an image, a PDF, a video. */
function isMediaUrl(parsed: URL): boolean {
  return MEDIA_EXTENSIONS.includes(fileExtension(parsed.pathname));
}

/**
 * Whether a title reads like a browser's or a server's error page, in English or in
 * Italian. Low confidence on purpose (PLAN.md §6.3): the scoring only ever uses it as a
 * secondary reason.
 */
export function looksLikeErrorTitle(title: string): boolean {
  return ERROR_TITLE_PATTERNS.some((pattern) => pattern.test(title));
}

/**
 * The class of the page a tab is showing.
 *
 * The order of the rules is the answer to the pages that are two things at once, and it
 * goes from the most certain evidence to the least:
 *
 * 1. `blank`, `own`, `browser-internal`, `file` — the URL alone says what the page is;
 * 2. `media` — an extension in the path;
 * 3. `auth` before `search`, so a sign-in page on a search engine stays a sign-in page
 *    (the auth rules read the path and the host, never the query, so a search *for* the
 *    word "login" is unaffected);
 * 4. `error` last, because it rests on a title we only pattern-match, and a real search
 *    or auth page whose title happens to look like an error is better called by its URL;
 * 5. `content` — everything else, which is most of the web.
 */
export function classify(tab: ClassifiableTab, context: ClassifyContext = {}): PageType {
  const { url } = tab;

  if (isBlankUrl(url)) return 'blank';
  if (isOwnPage(url, context.ownOrigin)) return 'own';

  const protocol = scheme(url);
  if (INTERNAL_SCHEMES.includes(protocol)) return 'browser-internal';
  if (protocol === 'file:') return 'file';

  const parsed = parse(url);
  // Not a URL the platform could have loaded (an empty-ish string is already `blank`):
  // there is nothing to read, and a class we cannot justify would only mislead.
  if (parsed === null) return 'content';

  if (isMediaUrl(parsed)) return 'media';
  if (isAuthUrl(url)) return 'auth';
  if (isSearchUrl(parsed)) return 'search';
  if (tab.title !== undefined && looksLikeErrorTitle(tab.title)) return 'error';

  return 'content';
}
