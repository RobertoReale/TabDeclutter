/**
 * The host and pattern lists the classification is made of (PLAN.md §6.3).
 *
 * Data only, no logic: `classify.ts` holds the matching rules, this file holds the
 * knowledge they are applied to. That is the point of a single data file — adding a
 * search engine or an Italian error title is an edit here, with no code to re-read.
 *
 * Conventions, all of them case-insensitive:
 * - a **host pattern** is either a host (`search.brave.com`, `youtube.com`), which also
 *   matches its subdomains, or a label followed by `.*` (`google.*`), which matches that
 *   label under any public suffix: `google.com`, `google.co.uk`, `google.de`;
 * - a **path prefix** matches whole path segments: `/search` matches `/search` and
 *   `/search/images`, never `/searchkit`;
 * - an **auth token** is matched between word boundaries, where any run of characters
 *   that are not letters or digits is a boundary: `sign-in` matches `/users/sign_in`,
 *   and `login` does not match `/blogin`.
 */

/**
 * A new tab or an empty tab, in the two browsers and their Chromium cousins
 * (PLAN.md §6.3 "blank", §5.5 "Internal pages"). Written canonically: lower-case, no
 * query, no fragment, no trailing slash, which is the form `canonicalUrl()` produces.
 */
export const BLANK_URLS: readonly string[] = [
  'about:blank',
  'about:newtab',
  'about:home',
  'about:privatebrowsing',
  'chrome://newtab',
  'chrome://new-tab-page',
  'chrome://new-tab-page-third-party',
  'edge://newtab',
  'edge://new-tab-page',
  'brave://newtab',
  'vivaldi://startpage',
];

/**
 * Schemes that belong to the browser rather than to the web (PLAN.md §5.5): Chrome and
 * Edge's `chrome://`/`edge://`, Firefox's `about:` and `resource:`, and the pages of any
 * installed extension. The extension's own pages are told apart by origin, not by
 * scheme, so they are not listed here.
 */
export const INTERNAL_SCHEMES: readonly string[] = [
  'about:',
  'chrome:',
  'chrome-untrusted:',
  'chrome-search:',
  'chrome-extension:',
  'moz-extension:',
  'resource:',
  'edge:',
  'brave:',
  'vivaldi:',
  'opera:',
  'devtools:',
];

/** Search engines (PLAN.md §6.3). A result list on one of these hosts is transient. */
export const SEARCH_ENGINE_HOSTS: readonly string[] = [
  'google.*',
  'yahoo.*',
  'yandex.*',
  'bing.com',
  'duckduckgo.com',
  'ecosia.org',
  'search.brave.com',
  'startpage.com',
  'kagi.com',
  'qwant.com',
];

/** Where those engines put their results. */
export const SEARCH_ENGINE_PATHS: readonly string[] = ['/search', '/sp/search'];

/**
 * Parameters that carry the query itself. Only honoured on an engine's root path, so
 * that `google.com/maps?q=roma` stays the map the user is reading (see docs/DECISIONS.md).
 */
export const SEARCH_QUERY_PARAMS: readonly string[] = ['q', 'p', 'query'];

/** An internal search of a site that is not a search engine (PLAN.md §6.3). */
export interface SiteSearchRule {
  /** Host patterns the rule applies to. */
  readonly hosts: readonly string[];
  /** Path prefixes that mean "a list of results". */
  readonly paths: readonly string[];
}

export const SITE_SEARCH_RULES: readonly SiteSearchRule[] = [
  { hosts: ['youtube.com'], paths: ['/results'] },
  { hosts: ['amazon.*'], paths: ['/s'] },
  { hosts: ['github.com'], paths: ['/search'] },
];

/**
 * Sign-in, sign-out and redirection paths (PLAN.md §6.3 "auth"). Matched as tokens, so
 * `/authors/jane` is not an auth page even though it contains "auth".
 */
export const AUTH_PATH_TOKENS: readonly string[] = [
  'login',
  'log-in',
  'logout',
  'log-out',
  'signin',
  'sign-in',
  'signout',
  'sign-out',
  'oauth',
  'oauth2',
  'auth',
  'callback',
  'sso',
];

/** Hosts that only ever serve a sign-in flow (PLAN.md §6.3). */
export const AUTH_HOSTS: readonly string[] = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
];

/**
 * Titles of error pages, in English and Italian (PLAN.md §6.3). The class is **low
 * confidence** by design — a title is all we have, and we never read the page — so these
 * patterns stay as literal as the wording the browsers and the servers actually produce.
 *
 * A bare status code only counts at the start of the title ("404 Not Found"), otherwise
 * "Peugeot 404" and "Room 503" would be error pages.
 */
export const ERROR_TITLE_PATTERNS: readonly RegExp[] = [
  /^\s*(?:4\d\d|5\d\d)\b/,
  /\b(?:error|errore)\b[^\d]{0,20}(?:4\d\d|5\d\d)\b/i,
  /\b(?:4\d\d|5\d\d)\s+(?:error|errore)\b/i,

  // English
  /\bnot found\b/i,
  /\bcan(?:'|’|no)t be reached\b/i,
  /\bunable to connect\b/i,
  /\bconnection (?:refused|reset|failed|timed out)\b/i,
  /\baccess denied\b/i,
  /\bserver error\b/i,
  /\bservice unavailable\b/i,
  /\bgateway time-?out\b/i,
  /\bproblem loading page\b/i,
  /\bno internet\b/i,

  // Italian
  /\bpagina non trovata\b/i,
  /\bimpossibile raggiungere il sito\b/i,
  /\bsito non raggiungibile\b/i,
  /\bimpossibile (?:connettersi|caricare)\b/i,
  /\baccesso negato\b/i,
  /\berrore del server\b/i,
  /\bservizio non disponibile\b/i,
  /\berrore (?:di|nella) connessione\b/i,
  /\bnessuna connessione\b/i,
  /\bproblema nel caricamento della pagina\b/i,
];

/**
 * Extensions a tab shows on its own, with no page around them (PLAN.md §6.3 "media"):
 * the user opened a file, not a document to come back to.
 */
export const MEDIA_EXTENSIONS: readonly string[] = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.svg',
  '.bmp',
  '.ico',
  '.tif',
  '.tiff',
  '.pdf',
  '.mp4',
  '.webm',
  '.mov',
  '.mkv',
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.flac',
];
