/**
 * Group proposals without AI: by site (PLAN.md §7.1) and by topic (PLAN.md §7.2).
 *
 * What comes out is a **proposal**, never an action: a list of groups with a title, a
 * colour and the tabs they would hold, plus the tabs no group earned. The Organize view
 * shows it, the user edits it, and only then does `src/platform/` create native groups
 * (PLAN.md §7.4). Nothing here touches a browser — `src/core/` is pure TypeScript
 * (TASKS.md §2.4), which is also why the thresholds arrive as `ClusterOptions` instead of
 * being read from storage.
 *
 * Both modes **run per window** and are independent there: a group cannot hold tabs of
 * two windows (PLAN.md §7.4), so the document set a topic's TF-IDF is computed over, the
 * minimum of 3 tabs for a site and the limit of 8 groups all apply to one window at a
 * time (docs/DECISIONS.md, M4.1).
 *
 * Everything is deterministic: the same tabs in the same order always produce the same
 * titles, the same colours and the same groups, down to the order of the groups. Every
 * tie — two equally similar clusters, two equally weighted tokens — is broken by an index
 * or alphabetically, never by the order a `Map` happens to have been filled in.
 */

import type { TabInfo } from './types';
import { NO_GROUP_ID } from './types';
import { displayHost, registrableDomain, unwrapSuspendedUrl } from './url';

/** The tab group colours Chrome accepts (`chrome.tabGroups.ColorEnum`, PLAN.md §7.1). */
export type GroupColor =
  'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';

/** In Chrome's own order, which is what the hash of PLAN.md §7.1 indexes into. */
export const GROUP_COLORS: readonly GroupColor[] = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
];

/** By site (PLAN.md §7.1, immediate) or by topic (PLAN.md §7.2, TF-IDF). */
export type ClusterMode = 'site' | 'topic';

/** One group the user is being offered. Its tabs all live in `windowId`. */
export interface ProposedGroup {
  /**
   * What the group *is*, independently of its title: the site key in `site` mode, the
   * lower-case title in `topic` mode. The colour is the hash of this, so renaming a group
   * in the preview does not recolour it.
   */
  readonly key: string;
  /** What the group is called: a readable site name, or 1-2 tokens (PLAN.md §7.2.5). */
  readonly title: string;
  readonly color: GroupColor;
  readonly windowId: number;
  /** At least `minClusterTabs` of them, in the order the tabs were given. */
  readonly tabIds: readonly number[];
}

export interface GroupProposal {
  readonly mode: ClusterMode;
  /** Largest group first; groups of equal size in the order their first tab appears. */
  readonly groups: readonly ProposedGroup[];
  /**
   * The tabs that stay out of every group — "Altro" (PLAN.md §7.2.4): a site with too few
   * tabs, a cluster of one, a cluster the limit of 8 cut, a tab with no site at all. They
   * are **not** a group: §7.2.4 says "not grouped", so the view labels them through i18n
   * and nothing is ever applied to them (docs/DECISIONS.md, M4.1).
   */
  readonly ungrouped: readonly number[];
}

/**
 * The numbers PLAN.md §7.1 and §7.2 call configurable, and the two exclusions the
 * Organize view offers as options (PLAN.md §4.4).
 */
export interface ClusterOptions {
  /** PLAN.md §7.1: a site needs this many tabs in a window to earn a group. */
  readonly minSiteTabs?: number;
  /** PLAN.md §7.2.3: cosine similarity below which two clusters are not merged. */
  readonly threshold?: number;
  /** PLAN.md §7.2.4: a cluster smaller than this goes to "Altro". */
  readonly minClusterTabs?: number;
  /** PLAN.md §7.2.6: at most this many groups per window. */
  readonly maxGroups?: number;
  /** PLAN.md §7.2.2: what the extra domain token weighs against a real one. */
  readonly domainWeight?: number;
  /** PLAN.md §7.2.1: shorter tokens are dropped. */
  readonly minTokenLength?: number;
  /** PLAN.md §4.4.4 "Lascia fuori le schede fissate", off by default. */
  readonly includePinned?: boolean;
  /** PLAN.md §4.4: a tab already in one of the user's groups is left alone by default. */
  readonly includeGrouped?: boolean;
}

export const DEFAULT_CLUSTER_OPTIONS: Required<ClusterOptions> = {
  minSiteTabs: 3,
  threshold: 0.25,
  minClusterTabs: 2,
  maxGroups: 8,
  domainWeight: 0.5,
  minTokenLength: 3,
  includePinned: false,
  includeGrouped: false,
};

/**
 * Readable site names (PLAN.md §7.1), keyed **either** by the registrable domain or by
 * its bare label. A label has no dot, so the two kinds of key cannot collide, and one
 * entry covers a brand that lives under a dozen suffixes (`amazon.it`, `amazon.co.uk`).
 *
 * Small on purpose: the fallback — the label capitalised — is right for most of the web,
 * and this list only has to beat it where the user would notice ("Stack Overflow", not
 * "Stackoverflow").
 */
/**
 * Distinct web applications that live on a subdomain of a shared parent domain.
 *
 * Keeping them as separate site keys means Gemini, Gmail, Google Docs, Drive, Calendar,
 * YouTube Music, Outlook, and Teams each get their own clean group/window instead of all
 * collapsing into `google.com` or `microsoft.com`.
 */
const APP_SUBDOMAINS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    'calendar chat classroom docs drive keep maps meet photos scholar sheets slides translate'
      .split(' ')
      .map((sub) => [`${sub}.google.com`, `Google ${capitalize(sub)}`] as const),
  ),
  'aistudio.google.com': 'Google AI Studio',
  'colab.research.google.com': 'Google Colab',
  'console.cloud.google.com': 'Google Cloud',
  'gemini.google.com': 'Gemini',
  'mail.google.com': 'Gmail',
  'notebooklm.google.com': 'NotebookLM',
  'copilot.microsoft.com': 'Copilot',
  'music.youtube.com': 'YouTube Music',
  'onedrive.live.com': 'OneDrive',
  'outlook.live.com': 'Outlook',
  'outlook.office.com': 'Outlook',
  'outlook.office365.com': 'Outlook',
  'portal.azure.com': 'Azure',
  'studio.youtube.com': 'YouTube Studio',
  'teams.microsoft.com': 'Microsoft Teams',
  'web.telegram.org': 'Telegram',
  'web.whatsapp.com': 'WhatsApp',
};

const SITE_NAMES: Readonly<Record<string, string>> = {
  'ansa.it': 'ANSA',
  bbc: 'BBC',
  'booking.com': 'Booking.com',
  'chatgpt.com': 'ChatGPT',
  'corriere.it': 'Corriere della Sera',
  'duckduckgo.com': 'DuckDuckGo',
  'extensionworkshop.com': 'Extension Workshop',
  'gazzettaufficiale.it': 'Gazzetta Ufficiale',
  getyourguide: 'GetYourGuide',
  'giallozafferano.it': 'GialloZafferano',
  'github.com': 'GitHub',
  'gitlab.com': 'GitLab',
  'html.it': 'HTML.it',
  ikea: 'IKEA',
  'ilpost.it': 'Il Post',
  'intesasanpaolo.com': 'Intesa Sanpaolo',
  'linkedin.com': 'LinkedIn',
  'lonelyplanet.com': 'Lonely Planet',
  'microsoftonline.com': 'Microsoft',
  'npmjs.com': 'npm',
  'openai.com': 'OpenAI',
  'pragmaticengineer.com': 'The Pragmatic Engineer',
  'preactjs.com': 'Preact',
  'raiplay.it': 'RaiPlay',
  'repubblica.it': 'la Repubblica',
  'rome2rio.com': 'Rome2rio',
  'stackoverflow.com': 'Stack Overflow',
  'theguardian.com': 'The Guardian',
  'typescriptlang.org': 'TypeScript',
  'visitportugal.com': 'Visit Portugal',
  'w3.org': 'W3C',
  'whatsapp.com': 'WhatsApp',
  'wxt.dev': 'WXT',
  'youtube.com': 'YouTube',
};

/**
 * Italian and English words that are in every other title and say nothing about the topic
 * (PLAN.md §7.2.1). Only words of three characters or more are listed: shorter ones never
 * become tokens anyway (`minTokenLength`).
 */
const STOPWORDS: ReadonlySet<string> = new Set(
  // Italian
  (
    'agli alla alle allo altra altre altri altro anche ancora avere che chi cio cioe coi col ' +
    'come con cosa cosi cui dagli dai dal dall dalla dalle dallo degli dei del dell della delle ' +
    'dello dopo dove due era essere fare fra gia gli hanno invece loro meno mentre mia mio molto ' +
    'negli nei nel nell nella nelle nello noi non nostro ogni oppure per perche pero piu poi ' +
    'prima puo quale quali quando quante quanti quanto quella quelle quelli quello questa queste ' +
    'questi questo quindi sara sempre senza sia siamo solo sono sopra sotto stato sua sue sugli ' +
    'sui sul sull sulla sulle sullo suo tra tre tuo tutta tutte tutti tutto una uno vedi voi ' +
    // English
    'about after all also and any are because been before being but can could did does doing ' +
    'done each for from get getting had has have her here his how into its just like made make ' +
    'many may more most much must new not now one only other our out over own said same say see ' +
    'should since some such than that the their them then there these they this those through ' +
    'too two under use used using very was way were what when where which while who why will ' +
    'with would you your ' +
    // Web furniture
    'amp aspx com default home htm html http https index jsp net org page pages php www'
  ).split(' '),
);

/**
 * URL-path routing segments and file extensions that carry no topical signal (e.g. `/watch`
 * on YouTube, `/wiki/` on Wikipedia, `/comments/` on Reddit, `/app/…` on Gemini, `.jpg`).
 * Filtered ONLY from URL paths — never from page titles — so a title legitimately about
 * watches, mobile apps, or wikis keeps those words.
 */
const PATH_NOISE: ReadonlySet<string> = new Set(
  (
    'app apps article articles auth blob callback channel channels chat chats comment comments ' +
    'commit commits css document download downloads drive edit embed feed file files folder ' +
    'folders forms gif inbox issue issues item items jpeg jpg json login logout mail node oauth ' +
    'oauth2 park parked pdf playlist png post posts presentation profile profiles pull pulls ' +
    'question questions raw redirect results search searchresults share shorts signin signup ' +
    'spreadsheets status suspend suspended svg tagged thread threads tree txt user users video ' +
    'videos view views watch webp wiki xml'
  ).split(' '),
);

/** Strips diacritics only when non-ASCII characters appear, so ASCII words stay zero-cost. */
function foldAccents(word: string): string {
  for (let i = 0; i < word.length; i += 1) {
    if (word.charCodeAt(i) > 127) {
      return word.normalize('NFD').replace(/\p{Mn}+/gu, '');
    }
  }
  return word;
}

/**
 * Detects opaque URL path IDs (pure numbers like `2026` or `847291`, prefixed site IDs like
 * Tripadvisor's `g189158`, or long hex/base64-like slugs such as Gemini/Docs/ChatGPT IDs
 * `6c9f4e2b8a1d`) that would otherwise add high-IDF noise to TF-IDF vectors.
 */
function isOpaquePathToken(token: string): boolean {
  let digits = 0;
  for (let i = 0; i < token.length; i += 1) {
    const code = token.charCodeAt(i);
    if (code >= 48 && code <= 57) digits += 1;
  }
  if (digits === token.length) return true;
  if (token.length >= 8 && digits >= 2) return true;
  if (token.length >= 5 && digits === token.length - 1 && /^[a-z]\d{4,}$/.test(token)) return true;
  return false;
}

/**
 * Ordered Italian + English derivational suffixes with their minimum remaining root length,
 * used only when vectorizing topics so inflected/derived forms (`ortogonali` /
 * `ortogonalizzazione`, `derivata` / `derivate` / `derivazione`, `cluster` / `clustering`)
 * match while displayed group titles still use the original surface words.
 */
const STEM_SUFFIXES: readonly string[] =
  'alizzazioni alizzazione izzazioni izzazione izations ization isations isation imenti imento amenti amento azioni azione ations ation ments ment mente ings ing'.split(
    ' ',
  );

/** Conservative Italian + English light stemmer for TF-IDF vector keys. */
function stemToken(raw: string): string {
  const word = foldAccents(raw);
  if (word.length < 5 || /\d/.test(word)) return word;

  for (const suffix of STEM_SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
      return word.slice(0, -suffix.length);
    }
  }
  if (word.endsWith('ies') && word.length >= 6) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ed') && word.length >= 7) return word.slice(0, -2);
  if (word.length >= 7 && /al[ei]$/.test(word)) return word.slice(0, -3);
  if (word.length >= 8 && /at[aeio]$/.test(word)) return word.slice(0, -3);
  if (word.length >= 7 && /[cg]h[ei]$/.test(word)) return word.slice(0, -2);
  if (word.length >= 6 && /(?:sh|ch|[sxz])es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1);
  if (word.length >= 6 && /[aeio]$/.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * Known localized or branded title suffixes that differ from `siteName(key)` (e.g. Google Docs
 * hosts Documenti / Fogli / Presentazioni / Moduli on `docs.google.com`, and Wikipedia appends
 * its tagline on landing pages).
 */
const SITE_TITLE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'docs.google.com': 'Documenti Fogli Presentazioni Moduli Sheets Slides Forms'
    .split(' ')
    .map((n) => `Google ${n}`),
  'mail.google.com': ['Google Mail'],
  'translate.google.com': ['Google Traduttore'],
  google: ['Cerca con Google', 'Google Search'],
  brave: ['Brave Search'],
  'ycombinator.com': ['Hacker News'],
  'wikipedia.org': ["Wikipedia, l'enciclopedia libera", 'Wikipedia, the free encyclopedia'],
};

/**
 * The separators a site puts between a page's name and its own (PLAN.md §7.2.1). Spaced,
 * so a hyphenated word or a path separator in a title is not mistaken for one.
 */
const TITLE_SEPARATORS: readonly string[] = [
  ' - ',
  ' – ',
  ' — ',
  ' | ',
  ' · ',
  ' • ',
  ' :: ',
  ' // ',
];

/** Anything that is not a letter or a digit, in any script, separates two tokens. */
const TOKEN_BOUNDARY = /[^\p{L}\p{N}]+/u;

/** A token whose weight is below this share of the best one is left out of a title. */
const SECOND_TOKEN_SHARE = 0.5;

/** What a title joins its one or two tokens with: "Rust · Async" (PLAN.md §7.2.5). */
const TITLE_JOIN = ' · ';

/**
 * Marks the synthetic domain token so it cannot collide with a real one: tokens are split
 * on everything that is not a letter or a digit, so none of them contains a colon.
 */
const DOMAIN_PREFIX = 'site:';

/**
 * A stable 32-bit hash. FNV-1a, which is a few lines and spreads short strings — domains
 * and titles — evenly enough for nine colours.
 */
function hashOf(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * The colour of a group, from the hash of its key (PLAN.md §7.1). The same site always
 * gets the same colour, in every window and across restarts, and two groups are allowed
 * to share one: Chrome's palette has nine and the plan asks for a hash, not for a
 * distinct colour per group.
 */
export function colorFor(key: string): GroupColor {
  // `as`, not `?? 'grey'`: the index is a remainder of the palette's own length, so there
  // is nothing to fall back to. Every read in this module that cannot miss is written this
  // way — `noUncheckedIndexedAccess` types it as possibly undefined and a `??` would add a
  // branch no input can take, in the loops that have to stay inside 50 ms (PLAN.md §11).
  return GROUP_COLORS[hashOf(key) % GROUP_COLORS.length] as GroupColor;
}

interface ParsedTabUrl {
  readonly key: string;
  readonly host: string;
  readonly domain: string;
  readonly path: string;
}

/**
 * Parses `url` once into its site key, display host, registrable domain, and decoded path
 * (+ search query), avoiding repeated `new URL()` and PSL trie lookups across suffix stripping,
 * tokenization, vectorization, and dominant-site selection.
 */
function parseTabUrl(url: string): ParsedTabUrl {
  const trimmed = unwrapSuspendedUrl(url).trim();
  let parsed: URL | null;
  try {
    parsed = new URL(trimmed);
  } catch {
    parsed = null;
  }
  if (parsed === null) {
    const domain = registrableDomain(trimmed) ?? '';
    return { key: domain, host: '', domain, path: '' };
  }
  const query =
    parsed.searchParams.get('search_query') ??
    parsed.searchParams.get('q') ??
    parsed.searchParams.get('query') ??
    '';
  const rawPath = query !== '' ? `${parsed.pathname}/${query}` : parsed.pathname;
  let path = rawPath;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    // A stray `%` is not an escape; the raw path still tokenizes.
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { key: '', host: '', domain: '', path };
  }
  let host = parsed.hostname.toLowerCase();
  while (host.startsWith('www.')) {
    const rest = host.slice(4);
    if (!rest.includes('.')) break;
    host = rest;
  }
  const domain = registrableDomain(host) ?? '';
  const key = host in APP_SUBDOMAINS ? host : domain !== '' ? domain : host;
  return { key, host, domain, path };
}

/**
 * Which site a tab belongs to, as a key: the registrable domain, or the host shown in a
 * row when there is none — `localhost`, an IP address, an intranet name are sites to the
 * user even though they have no eTLD+1 (docs/DECISIONS.md, M4.1). `''` for a tab with no
 * web host (`about:blank`, `chrome-extension://…`, `chrome://…`, a `file:` path), which
 * can therefore not be grouped by site under an internal ID.
 */
export function siteKey(url: string): string {
  const trimmed = unwrapSuspendedUrl(url).trim();
  try {
    const protocol = new URL(trimmed).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') return '';
  } catch {
    // Let registrableDomain / displayHost handle bare hostnames or unparseable strings.
  }
  const host = displayHost(trimmed);
  if (host in APP_SUBDOMAINS) return host;
  return registrableDomain(trimmed) ?? host;
}

/** The label of a domain: `example.co.uk` → `example`, `localhost` → `localhost`. */
function domainLabel(key: string): string {
  const dot = key.indexOf('.');
  return dot === -1 ? key : key.slice(0, dot);
}

/**
 * What the group of a site is called (PLAN.md §7.1): the known app/site name, otherwise the
 * domain without its TLD, capitalised. `''` in, `''` out.
 */
export function siteName(key: string): string {
  if (key === '') return '';
  const known = APP_SUBDOMAINS[key] ?? SITE_NAMES[key] ?? SITE_NAMES[domainLabel(key)];
  if (known !== undefined) return known;
  // Nothing to drop when there is no TLD (`localhost`, `127.0.0.1`): the host is the name.
  return capitalize(key.includes('.') ? domainLabel(key) : key);
}

function capitalize(word: string): string {
  // `slice` rather than `word[0]`, so an empty word is the empty string without a guard.
  return `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;
}

/** Lower-case, letters and digits only: how two spellings of a site name are compared. */
function simplify(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function stripSiteSuffixWith(
  title: string,
  meta: Pick<ParsedTabUrl, 'key' | 'host' | 'domain'>,
): string {
  const { key, host, domain: parentKey } = meta;
  const label = domainLabel(key);
  const appName = APP_SUBDOMAINS[key] ?? '';
  const parentLabel = parentKey !== '' && parentKey !== key ? domainLabel(parentKey) : '';
  const candidates: string[] = [appName, key, label, host];
  if (parentLabel !== '') {
    const sub = appName || label;
    candidates.push(parentLabel, `${parentLabel} ${sub}`, `${sub} ${parentLabel}`);
  }
  const aliases = SITE_TITLE_ALIASES[key] ?? SITE_TITLE_ALIASES[label];
  if (aliases !== undefined) candidates.push(...aliases);
  const forms = new Set(candidates.filter((form) => form !== '').map(simplify));
  let out = title.trim();
  if (forms.size === 0) return out;

  for (;;) {
    const cut = lastSeparator(out);
    if (cut === null) break;
    const tail = out.slice(cut.at + cut.separator.length);
    if (!forms.has(simplify(tail))) break;
    out = out.slice(0, cut.at).trim();
  }

  // Also drop a leading `"Site: "` prefix (e.g. `"Amazon.it: monitor 27 pollici"`) when
  // followed by a real title, so store prefixes do not falsely merge unrelated products.
  const colon = out.indexOf(': ');
  if (colon > 0 && colon < out.length - 2) {
    const head = out.slice(0, colon);
    if (forms.has(simplify(head))) {
      const rest = out.slice(colon + 2).trim();
      if (rest !== '') out = rest;
    }
  }

  return out;
}

/**
 * The title without the site's own name at the end (PLAN.md §7.2.1): " - YouTube",
 * " | Medium", " · GitHub".
 *
 * The tail after the last separator is dropped when, ignoring case and punctuation, it is
 * one of the ways this site spells itself — its readable name, its domain, its label or
 * its host. Repeated, because a site can add two ("Issue #1 · user/repo · GitHub"), and
 * it never empties the title: `lastSeparator` only answers past the first character of an
 * already trimmed title, so what is kept always starts with that character.
 */
export function stripSiteSuffix(title: string, url: string): string {
  return stripSiteSuffixWith(title, parseTabUrl(url));
}

function lastSeparator(title: string): { at: number; separator: string } | null {
  let best: { at: number; separator: string } | null = null;
  for (const separator of TITLE_SEPARATORS) {
    const at = title.lastIndexOf(separator);
    if (at > 0 && (best === null || at > best.at)) best = { at, separator };
  }
  return best;
}

function collectTokens(text: string, isPath: boolean, minLength: number, into: string[]): void {
  for (const raw of text.toLowerCase().split(TOKEN_BOUNDARY)) {
    if (raw.length < minLength) continue;
    if (isPath && (PATH_NOISE.has(raw) || isOpaquePathToken(raw))) continue;
    if (STOPWORDS.has(raw) || STOPWORDS.has(foldAccents(raw))) continue;
    into.push(raw);
  }
}

/**
 * The tokens of a tab (PLAN.md §7.2.1): its title without the site suffix, plus its URL
 * path, lower-cased, split on everything that is not a letter or a digit, with the
 * stopwords and the tokens shorter than `minTokenLength` dropped.
 *
 * Repetitions are kept: a word the title and the path both carry is two occurrences, and
 * that is the term frequency TF-IDF is built on.
 */
export function tokenize(
  tab: Pick<TabInfo, 'url' | 'title'>,
  options: ClusterOptions = {},
): readonly string[] {
  const minLength = options.minTokenLength ?? DEFAULT_CLUSTER_OPTIONS.minTokenLength;
  const meta = parseTabUrl(tab.url);
  const tokens: string[] = [];
  collectTokens(stripSiteSuffixWith(tab.title, meta), false, minLength, tokens);
  collectTokens(meta.path, true, minLength, tokens);
  return tokens;
}

/** A tab is a candidate for a group unless it is hidden or an option leaves it out. */
function isEligible(tab: TabInfo, options: Required<ClusterOptions>): boolean {
  // Not a policy but a fact: a hidden tab is not on screen at all (PLAN.md §5.5).
  if (tab.hidden) return false;
  if (tab.pinned && !options.includePinned) return false;
  if (tab.groupId !== NO_GROUP_ID && !options.includeGrouped) return false;
  return true;
}

function resolve(options: ClusterOptions): Required<ClusterOptions> {
  return { ...DEFAULT_CLUSTER_OPTIONS, ...options };
}

/** One window's tabs, in the order they were given. Never empty: it has at least its first. */
interface Window {
  readonly windowId: number;
  readonly tabs: readonly TabInfo[];
}

/** The windows of `tabs`, in the order their first tab appears, with their own tabs. */
function byWindow(tabs: readonly TabInfo[]): readonly Window[] {
  const windows = new Map<number, TabInfo[]>();
  for (const tab of tabs) {
    const found = windows.get(tab.windowId);
    if (found === undefined) windows.set(tab.windowId, [tab]);
    else found.push(tab);
  }
  return [...windows].map(([windowId, own]) => ({ windowId, tabs: own }));
}

/** One candidate group of one window, before the limits and the titles are applied. */
interface Candidate {
  readonly key: string;
  readonly title: string;
  readonly windowId: number;
  readonly tabIds: readonly number[];
  /** Where its first tab sits in its window's list: the tie-break of the ordering. */
  readonly firstAt: number;
}

function proposalOf(
  mode: ClusterMode,
  groups: readonly Candidate[],
  ungrouped: readonly number[],
): GroupProposal {
  return {
    mode,
    groups: groups.map((candidate) => ({
      key: candidate.key,
      title: candidate.title,
      color: colorFor(candidate.key),
      windowId: candidate.windowId,
      tabIds: candidate.tabIds,
    })),
    ungrouped,
  };
}

interface SiteBucket {
  readonly key: string;
  readonly windowId: number;
  readonly tabIds: readonly number[];
  readonly firstAt: number;
}

function compareBuckets(
  a: { readonly tabIds: readonly number[]; readonly firstAt: number },
  b: { readonly tabIds: readonly number[]; readonly firstAt: number },
): number {
  if (a.tabIds.length !== b.tabIds.length) return b.tabIds.length - a.tabIds.length;
  return a.firstAt - b.firstAt;
}

function siteBuckets(
  tabs: readonly TabInfo[],
  resolved: Required<ClusterOptions>,
): { readonly buckets: readonly SiteBucket[]; readonly ungrouped: readonly number[] } {
  const buckets: SiteBucket[] = [];
  const ungrouped: number[] = [];

  for (const { windowId, tabs: own } of byWindow(tabs)) {
    const sites = new Map<string, { tabIds: number[]; firstAt: number }>();
    for (const [at, tab] of own.entries()) {
      if (!isEligible(tab, resolved)) continue;
      const key = siteKey(tab.url);
      if (key === '') {
        ungrouped.push(tab.id);
        continue;
      }
      const found = sites.get(key);
      if (found === undefined) sites.set(key, { tabIds: [tab.id], firstAt: at });
      else found.tabIds.push(tab.id);
    }

    const candidates: SiteBucket[] = [];
    for (const [key, site] of sites) {
      if (site.tabIds.length < resolved.minSiteTabs) {
        ungrouped.push(...site.tabIds);
        continue;
      }
      candidates.push({ key, windowId, tabIds: site.tabIds, firstAt: site.firstAt });
    }
    buckets.push(...candidates.sort(compareBuckets));
  }

  return { buckets, ungrouped };
}

/**
 * By site (PLAN.md §7.1): one group per registrable domain that has at least
 * `minSiteTabs` tabs in the window. The others stay out of groups.
 */
export function groupBySite(tabs: readonly TabInfo[], options: ClusterOptions = {}): GroupProposal {
  const { buckets, ungrouped } = siteBuckets(tabs, resolve(options));
  const groups: Candidate[] = buckets.map((b) => ({
    key: b.key,
    title: siteName(b.key),
    windowId: b.windowId,
    tabIds: b.tabIds,
    firstAt: b.firstAt,
  }));
  return proposalOf('site', groups, ungrouped);
}

/** A tab's TF-IDF vector, L2-normalised, as two arrays sorted by token id. */
interface Vector {
  readonly ids: Int32Array;
  readonly values: Float64Array;
}

/** The dot product of two normalised sparse vectors, which is their cosine similarity. */
function cosine(a: Vector, b: Vector): number {
  let i = 0;
  let j = 0;
  let sum = 0;
  while (i < a.ids.length && j < b.ids.length) {
    const left = a.ids[i] as number;
    const right = b.ids[j] as number;
    if (left === right) {
      sum += (a.values[i] as number) * (b.values[j] as number);
      i += 1;
      j += 1;
    } else if (left < right) i += 1;
    else j += 1;
  }
  return sum;
}

/** Weight of URL-path tokens relative to title tokens so long URL slugs do not drown titles. */
const PATH_TOKEN_WEIGHT = 0.7;

/** What one window's tabs add up to: a vector each, the vocabulary, and cached tab metadata. */
interface Vectors {
  readonly vectors: readonly Vector[];
  /** Token id → the stem key (or `site:…` for domain tokens). */
  readonly vocabulary: readonly string[];
  /** Site key per eligible tab, reused by `dominantSite` without re-parsing URLs. */
  readonly siteKeys: readonly string[];
  /** Optional `[stem, surfaceWord]` pairs per tab, populated when titles will be rendered. */
  readonly surfacePairs: readonly (readonly (readonly [string, string])[])[];
}

/** Whether two stems differ by one edit (substitution, insertion, deletion, or adjacent swap). */
function isEditDistanceOne(a: string, b: string): boolean {
  const diff = a.length - b.length;
  if (diff < -1 || diff > 1 || a[0] !== b[0]) return false;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length && a[i] === b[j]) {
    i += 1;
    j += 1;
  }
  if (diff === 0) {
    return (
      a.slice(i + 1) === b.slice(j + 1) ||
      (i + 1 < a.length &&
        a[i] === b[j + 1] &&
        a[i + 1] === b[j] &&
        a.slice(i + 2) === b.slice(j + 2))
    );
  }
  return diff > 0 ? a.slice(i + 1) === b.slice(j) : a.slice(i) === b.slice(j + 1);
}

/**
 * Snaps rare singleton stems (`df === 1`, length ≥ 6, no digits) that are one edit away from a
 * dominant stem in the same window (`df >= 3`, max length ≥ 7) so uploader typos such as
 * "Corraudo Augias" merge cleanly with "Corrado Augias" instead of fracturing the cluster.
 */
function snapTypoStems(
  vocabulary: readonly string[],
  documentFrequency: number[],
  counts: Map<number, number>[],
): void {
  const anchors: number[] = [];
  for (let id = 0; id < vocabulary.length; id += 1) {
    const stem = vocabulary[id] as string;
    if (
      (documentFrequency[id] as number) >= 3 &&
      stem.length >= 6 &&
      !stem.startsWith(DOMAIN_PREFIX) &&
      !/\d/.test(stem)
    ) {
      anchors.push(id);
    }
  }
  if (anchors.length === 0) return;

  const remap = new Map<number, number>();
  for (let id = 0; id < vocabulary.length; id += 1) {
    const stem = vocabulary[id] as string;
    if (
      (documentFrequency[id] as number) !== 1 ||
      stem.length < 6 ||
      stem.startsWith(DOMAIN_PREFIX) ||
      /\d/.test(stem)
    ) {
      continue;
    }
    let bestId = -1;
    let bestDf = -1;
    for (const anchorId of anchors) {
      const anchor = vocabulary[anchorId] as string;
      if (Math.max(stem.length, anchor.length) < 7 || !isEditDistanceOne(stem, anchor)) continue;
      const anchorDf = documentFrequency[anchorId] as number;
      if (
        anchorDf > bestDf ||
        (anchorDf === bestDf && anchor.localeCompare(vocabulary[bestId] as string) < 0)
      ) {
        bestId = anchorId;
        bestDf = anchorDf;
      }
    }
    if (bestId !== -1) remap.set(id, bestId);
  }
  if (remap.size === 0) return;

  for (const perTab of counts) {
    for (const [oldId, newId] of remap) {
      const weight = perTab.get(oldId);
      if (weight === undefined) continue;
      perTab.delete(oldId);
      documentFrequency[oldId] = (documentFrequency[oldId] as number) - 1;
      const existing = perTab.get(newId);
      if (existing === undefined) {
        perTab.set(newId, weight);
        documentFrequency[newId] = (documentFrequency[newId] as number) + 1;
      } else {
        perTab.set(newId, existing + weight);
      }
    }
  }
}

/**
 * TF-IDF over the tabs of one window (PLAN.md §7.2.2), with an extra token for the domain
 * at `domainWeight`.
 *
 * `idf = ln(1 + N/df)`, so it is always positive: a token every tab carries still counts
 * for something (ln 2) instead of vanishing, which matters with the two or three
 * documents a small window has. Content words are stemmed conservatively for matching while
 * sublinear TF keeps repeated URL slugs from skewing norms against tabs with opaque paths.
 */
function vectorize(
  tabs: readonly TabInfo[],
  options: Required<ClusterOptions>,
  collectSurface: boolean,
): Vectors {
  const vocabulary: string[] = [];
  const ids = new Map<string, number>();
  const documentFrequency: number[] = [];
  const counts: Map<number, number>[] = [];
  const siteKeys: string[] = [];
  const surfacePairs: (readonly [string, string])[][] = [];

  const register = (key: string, weight: number, perTab: Map<number, number>): void => {
    let id = ids.get(key);
    if (id === undefined) {
      id = vocabulary.length;
      ids.set(key, id);
      vocabulary.push(key);
      documentFrequency.push(0);
    }
    const seen = perTab.get(id);
    if (seen === undefined) {
      perTab.set(id, weight);
      documentFrequency[id] = (documentFrequency[id] as number) + 1;
    } else {
      perTab.set(id, seen + weight);
    }
  };

  for (const tab of tabs) {
    const meta = parseTabUrl(tab.url);
    const titleTokens: string[] = [];
    const pathTokens: string[] = [];
    collectTokens(stripSiteSuffixWith(tab.title, meta), false, options.minTokenLength, titleTokens);
    collectTokens(meta.path, true, options.minTokenLength, pathTokens);

    const perTab = new Map<number, number>();
    const pairs: (readonly [string, string])[] | null = collectSurface ? [] : null;
    for (const raw of titleTokens) {
      const stem = stemToken(raw);
      register(stem, 1, perTab);
      if (pairs !== null) pairs.push([stem, raw]);
    }
    for (const raw of pathTokens) {
      const stem = stemToken(raw);
      register(stem, PATH_TOKEN_WEIGHT, perTab);
      if (pairs !== null) pairs.push([stem, raw]);
    }
    siteKeys.push(meta.key);
    if (meta.key !== '') register(`${DOMAIN_PREFIX}${meta.key}`, 1, perTab);
    if (pairs !== null) surfacePairs.push(pairs);

    counts.push(perTab);
  }

  snapTypoStems(vocabulary, documentFrequency, counts);

  const total = tabs.length;
  const vectors: Vector[] = [];
  for (const perTab of counts) {
    const sorted = [...perTab.keys()].sort((a, b) => a - b);
    const vectorIds = new Int32Array(sorted.length);
    const values = new Float64Array(sorted.length);
    let norm = 0;
    for (const [at, id] of sorted.entries()) {
      const df = documentFrequency[id] as number;
      const isDomain = (vocabulary[id] as string).startsWith(DOMAIN_PREFIX);
      // Smooth IDF prevents a large dominant topic (e.g. 10+ tabs on one subject) from being
      // penalised against unique decorative title words (`df === 1`), while damping singleton
      // content words so long titles still merge cleanly with their topic.
      const baseIdf = 1 + 0.25 * Math.log(1 + total / df);
      const idf = df === 1 && !isDomain ? 0.7 * baseIdf : baseIdf;
      const rawTf = perTab.get(id) as number;
      const tf = rawTf > 1 ? 1 + Math.log(rawTf) : rawTf;
      const weight = tf * idf * (isDomain ? options.domainWeight : 1);
      vectorIds[at] = id;
      values[at] = weight;
      norm += weight * weight;
    }
    // A tab whose every token was a stopword has no vector at all; it is similar to
    // nothing and ends up in "Altro" on its own.
    const length = Math.sqrt(norm);
    if (length > 0) {
      for (let at = 0; at < values.length; at += 1) values[at] = (values[at] as number) / length;
    }
    vectors.push({ ids: vectorIds, values });
  }

  return { vectors, vocabulary, siteKeys, surfacePairs };
}

/**
 * Agglomerative clustering with average linkage (PLAN.md §7.2.3): the two most similar
 * clusters merge while that similarity is at least `threshold`.
 *
 * The initial cosine matrix is filled through an inverted index over `vocabulary`, touching
 * only tab pairs that share at least one token (in ascending token-id order, so the sums are
 * bit-for-bit identical to pairwise dot products while skipping 90%+ zero pairs).
 *
 * Average linkage is updated in place with Lance-Williams —
 * `sim(A∪B, C) = (|A|·sim(A,C) + |B|·sim(B,C)) / (|A|+|B|)` — over a compact sorted list of
 * live cluster indices so `refresh()` and merge selection never scan dead slots.
 */
function agglomerate(
  vectors: readonly Vector[],
  vocabSize: number,
  threshold: number,
): readonly number[][] {
  const count = vectors.length;
  if (count === 0) return [];

  const sim = new Float64Array(count * count);
  const postings: number[][] = Array.from({ length: vocabSize }, () => []);
  for (let i = 0; i < count; i += 1) {
    const vec = vectors[i] as Vector;
    for (let at = 0; at < vec.ids.length; at += 1) {
      (postings[vec.ids[at] as number] as number[]).push(i, vec.values[at] as number);
    }
  }
  for (let tokenId = 0; tokenId < vocabSize; tokenId += 1) {
    const list = postings[tokenId] as number[];
    if (list.length <= 2) continue;
    for (let a = 0; a < list.length; a += 2) {
      const i = list[a] as number;
      const wi = list[a + 1] as number;
      const row = i * count;
      for (let b = a + 2; b < list.length; b += 2) {
        const j = list[b] as number;
        sim[row + j] = (sim[row + j] as number) + wi * (list[b + 1] as number);
      }
    }
  }
  for (let i = 0; i < count; i += 1) {
    const row = i * count;
    for (let j = i + 1; j < count; j += 1) {
      sim[j * count + i] = sim[row + j] as number;
    }
  }

  const active: number[] = [];
  const size = new Int32Array(count).fill(1);
  const members: number[][] = [];
  for (let i = 0; i < count; i += 1) {
    active.push(i);
    members.push([i]);
  }
  const nearest = new Int32Array(count).fill(-1);
  const nearestSim = new Float64Array(count);

  /** The live cluster most similar to `i`, ties going to the lower index (`active` is sorted). */
  const refresh = (i: number): void => {
    let best = -1;
    let bestSim = Number.NEGATIVE_INFINITY;
    const row = i * count;
    for (let k = 0; k < active.length; k += 1) {
      const j = active[k] as number;
      if (j === i) continue;
      const value = sim[row + j] as number;
      if (value > bestSim) {
        bestSim = value;
        best = j;
      }
    }
    nearest[i] = best;
    nearestSim[i] = best === -1 ? Number.NEGATIVE_INFINITY : bestSim;
  };
  for (let i = 0; i < count; i += 1) refresh(i);

  for (;;) {
    let from = -1;
    let bestSim = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < active.length; k += 1) {
      const i = active[k] as number;
      if (nearest[i] === -1) continue;
      const value = nearestSim[i] as number;
      if (value > bestSim) {
        bestSim = value;
        from = i;
      }
    }
    if (from === -1 || bestSim < threshold) break;

    const other = nearest[from] as number;
    // The survivor is the lower index, so a cluster's position never depends on which of
    // the two the scan happened to reach first.
    const kept = Math.min(from, other);
    const gone = Math.max(from, other);
    const keptSize = size[kept] as number;
    const goneSize = size[gone] as number;
    const invTotal = 1 / (keptSize + goneSize);
    const keptRow = kept * count;
    const goneRow = gone * count;
    for (let k = 0; k < active.length; k += 1) {
      const c = active[k] as number;
      if (c === kept || c === gone) continue;
      const merged =
        ((sim[keptRow + c] as number) * keptSize + (sim[goneRow + c] as number) * goneSize) *
        invTotal;
      sim[keptRow + c] = merged;
      sim[c * count + kept] = merged;
    }
    size[kept] = keptSize + goneSize;
    const keptMembers = members[kept] as number[];
    const goneMembers = members[gone] as number[];
    keptMembers.push(...goneMembers);
    keptMembers.sort((a, b) => a - b);
    goneMembers.length = 0;
    active.splice(active.indexOf(gone), 1);
    nearest[gone] = -1;

    refresh(kept);
    // Only the clusters whose nearest neighbour has just disappeared or changed.
    for (let k = 0; k < active.length; k += 1) {
      const c = active[k] as number;
      if (c === kept) continue;
      if (nearest[c] === kept || nearest[c] === gone) refresh(c);
    }
  }

  const clusters: number[][] = [];
  for (let k = 0; k < active.length; k += 1) {
    clusters.push(members[active[k] as number] as number[]);
  }
  return clusters;
}

/** L2-normalised centroid of a cluster's sparse vectors together with its unnormalised norm. */
function centroidOf(
  members: readonly number[],
  vectors: readonly Vector[],
): { readonly centroid: Vector; readonly norm: number } {
  const sum = new Map<number, number>();
  for (const index of members) {
    const vector = vectors[index] as Vector;
    for (let at = 0; at < vector.ids.length; at += 1) {
      const id = vector.ids[at] as number;
      sum.set(id, (sum.get(id) ?? 0) + (vector.values[at] as number));
    }
  }
  const sorted = [...sum.keys()].sort((a, b) => a - b);
  const ids = new Int32Array(sorted.length);
  const values = new Float64Array(sorted.length);
  let normSq = 0;
  for (const [at, id] of sorted.entries()) {
    const weight = sum.get(id) as number;
    ids[at] = id;
    values[at] = weight;
    normSq += weight * weight;
  }
  const norm = Math.sqrt(normSq);
  if (norm > 0) {
    for (let at = 0; at < values.length; at += 1) values[at] = (values[at] as number) / norm;
  }
  return { centroid: { ids, values }, norm };
}

/** Total cosine similarity and non-domain (content-only) cosine similarity in one linear pass. */
function splitCosine(
  a: Vector,
  b: Vector,
  isDomainId: Uint8Array,
): { readonly total: number; readonly content: number } {
  let i = 0;
  let j = 0;
  let total = 0;
  let content = 0;
  while (i < a.ids.length && j < b.ids.length) {
    const left = a.ids[i] as number;
    const right = b.ids[j] as number;
    if (left === right) {
      const product = (a.values[i] as number) * (b.values[j] as number);
      total += product;
      if (isDomainId[left] === 0) content += product;
      i += 1;
      j += 1;
    } else if (left < right) i += 1;
    else j += 1;
  }
  return { total, content };
}

/**
 * Post-agglomeration centroid refinement: rescues tabs that greedy pairwise linkage prematurely
 * locked into a weak 2-tab coincidence (e.g. sharing one high-IDF decorative word like "segreti"
 * or "incontro") when they strongly match a larger dominant cluster's core centroid.
 *
 * Leave-one-out similarity to a tab's own cluster uses the exact identity
 * `cos(v, (S - v) / ‖S - v‖) = (d - 1) / sqrt(‖S‖² - 2d + 1)` with `d = (v · c) · ‖S‖`,
 * avoiding O(K²) centroid rebuilds per cluster.
 */
function refineClusters(
  initial: readonly number[][],
  vectors: readonly Vector[],
  vocabulary: readonly string[],
  threshold: number,
): readonly number[][] {
  if (initial.length < 2) return initial;
  const isDomainId = new Uint8Array(vocabulary.length);
  for (let id = 0; id < vocabulary.length; id += 1) {
    if ((vocabulary[id] as string).startsWith(DOMAIN_PREFIX)) isDomainId[id] = 1;
  }

  let current: number[][] = initial.map((c) => [...c]);
  for (let pass = 0; pass < 2; pass += 1) {
    const targets: { readonly idx: number; readonly centroid: Vector; readonly norm: number }[] =
      [];
    const targetByIdx = new Map<number, { readonly centroid: Vector; readonly norm: number }>();
    for (let c = 0; c < current.length; c += 1) {
      const members = current[c] as number[];
      if (members.length >= 2) {
        const entry = centroidOf(members, vectors);
        targets.push({ idx: c, ...entry });
        targetByIdx.set(c, entry);
      }
    }
    if (targets.length === 0) break;

    const owner = new Int32Array(vectors.length);
    for (let c = 0; c < current.length; c += 1) {
      for (const tabIdx of current[c] as number[]) owner[tabIdx] = c;
    }
    const nextOwner = Int32Array.from(owner);
    let moved = false;

    for (let i = 0; i < vectors.length; i += 1) {
      const ownIdx = owner[i] as number;
      const ownMembers = current[ownIdx] as number[];
      const tabVec = vectors[i] as Vector;
      const isSingleton = ownMembers.length === 1;
      let ownSim = 0;
      if (!isSingleton && tabVec.ids.length > 0) {
        const own = targetByIdx.get(ownIdx) as { readonly centroid: Vector; readonly norm: number };
        const d = cosine(tabVec, own.centroid) * own.norm;
        const remSq = own.norm * own.norm - 2 * d + 1;
        ownSim = remSq > 1e-18 ? (d - 1) / Math.sqrt(remSq) : 0;
      }

      const minTotal = isSingleton ? Math.max(threshold, 0.32) : threshold;
      const minContent = isSingleton ? Math.max(threshold * 0.8, 0.2) : threshold * 0.6;
      let bestCluster = ownIdx;
      let bestSim = ownSim;

      for (const target of targets) {
        if (target.idx === ownIdx) continue;
        const { total, content } = splitCosine(tabVec, target.centroid, isDomainId);
        if (total < minTotal || content < minContent) continue;
        if (total > bestSim + 1e-9) {
          bestSim = total;
          bestCluster = target.idx;
        }
      }
      if (bestCluster !== ownIdx) {
        nextOwner[i] = bestCluster;
        moved = true;
      }
    }

    if (!moved) break;
    const grouped = new Map<number, number[]>();
    for (let i = 0; i < vectors.length; i += 1) {
      const clusterId = nextOwner[i] as number;
      const list = grouped.get(clusterId);
      if (list === undefined) grouped.set(clusterId, [i]);
      else list.push(i);
    }
    current = [...grouped.values()].sort((a, b) => (a[0] as number) - (b[0] as number));
  }

  return current;
}

/** A token of a cluster and what it weighs there: the ranking a title is built from. */
interface RankedToken {
  readonly token: string;
  readonly weight: number;
}

/**
 * The cluster's tokens by total TF-IDF weight, heaviest first, ties alphabetical. Each stem
 * is rendered using the most frequent original surface word inside the cluster (tie-broken by
 * shortest length, then alphabetical) so group titles are always real, readable words.
 */
function rankTokens(
  cluster: readonly number[],
  vectors: readonly Vector[],
  vocabulary: readonly string[],
  surfacePairs: readonly (readonly (readonly [string, string])[])[],
): readonly RankedToken[] {
  const weights = new Map<string, number>();
  const formCounts = new Map<string, Map<string, number>>();
  for (const index of cluster) {
    const vector = vectors[index] as Vector;
    for (let at = 0; at < vector.ids.length; at += 1) {
      const key = vocabulary[vector.ids[at] as number] as string;
      if (key.startsWith(DOMAIN_PREFIX)) continue;
      weights.set(key, (weights.get(key) ?? 0) + (vector.values[at] as number));
    }
    for (const [stem, word] of surfacePairs[index] as readonly (readonly [string, string])[]) {
      let agg = formCounts.get(stem);
      if (agg === undefined) {
        agg = new Map<string, number>();
        formCounts.set(stem, agg);
      }
      agg.set(word, (agg.get(word) ?? 0) + 1);
    }
  }
  return [...weights]
    .map(([stem, weight]) => ({ token: bestSurfaceForm(formCounts.get(stem), stem), weight }))
    .sort((a, b) => (b.weight !== a.weight ? b.weight - a.weight : a.token.localeCompare(b.token)));
}

function bestSurfaceForm(counts: Map<string, number> | undefined, fallback: string): string {
  if (counts === undefined || counts.size === 0) return fallback;
  let bestWord = fallback;
  let bestCount = -1;
  for (const [word, count] of counts) {
    if (
      count > bestCount ||
      (count === bestCount &&
        (word.length < bestWord.length ||
          (word.length === bestWord.length && word.localeCompare(bestWord) < 0)))
    ) {
      bestWord = word;
      bestCount = count;
    }
  }
  return bestWord;
}

/**
 * The title of a topical group (PLAN.md §7.2.5): the one or two heaviest tokens,
 * capitalised. The second is left out when it weighs less than half the first, so a
 * cluster about one thing is called by that one thing.
 *
 * `taken` holds the titles already used in this window: on a collision the second token
 * is replaced by the next one down the ranking, and when the cluster has no other word to
 * offer its dominant site names it instead ("Pasta · Cucina"). Two groups the user cannot
 * tell apart would be worse than a title the plan did not foresee (docs/DECISIONS.md,
 * M4.1).
 */
function titleOf(ranked: readonly RankedToken[], site: string, taken: ReadonlySet<string>): string {
  const first = ranked[0];
  if (first === undefined) return '';
  const alone = capitalize(first.token);

  // The pair when a second token earned its place, then the single name, then the site,
  // then the pairs built from the tokens further down the ranking.
  const pairs = ranked.slice(1).map((next) => `${alone}${TITLE_JOIN}${capitalize(next.token)}`);
  const second = ranked[1];
  const earned = second !== undefined && second.weight >= first.weight * SECOND_TOKEN_SHARE;
  const qualified = site === '' ? [] : [`${alone}${TITLE_JOIN}${site}`];
  const ordered = earned
    ? [...pairs.slice(0, 1), alone, ...qualified, ...pairs.slice(1)]
    : [alone, ...qualified, ...pairs];

  for (const title of ordered) {
    if (!taken.has(title)) return title;
  }
  // Every name this cluster could offer is a group's already: two groups with one title
  // is still better than a group this one cannot be told from.
  return alone;
}

/**
 * The site most of the cluster's tabs are on, as a readable name: the last resort of a
 * title, and `''` when no site has more tabs there than another.
 */
function dominantSite(cluster: readonly number[], siteKeys: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const index of cluster) {
    const key = siteKeys[index] as string;
    if (key !== '') counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  let tied = false;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) tied = true;
  }
  return tied ? '' : siteName(best);
}

function hasContentToken(
  cluster: readonly number[],
  vectors: readonly Vector[],
  vocabulary: readonly string[],
): boolean {
  for (const index of cluster) {
    const vector = vectors[index] as Vector;
    for (let at = 0; at < vector.ids.length; at += 1) {
      if (!(vocabulary[vector.ids[at] as number] as string).startsWith(DOMAIN_PREFIX)) return true;
    }
  }
  return false;
}

interface TopicWindowResult {
  readonly windowId: number;
  readonly vectors: readonly Vector[];
  readonly vocabulary: readonly string[];
  readonly siteKeys: readonly string[];
  readonly surfacePairs: readonly (readonly (readonly [string, string])[])[];
  readonly kept: readonly {
    readonly indexes: readonly number[];
    readonly tabIds: readonly number[];
    readonly firstAt: number;
  }[];
  readonly ungrouped: readonly number[];
}

function topicWindowClusters(
  windowId: number,
  own: readonly TabInfo[],
  resolved: Required<ClusterOptions>,
  collectSurface: boolean,
): TopicWindowResult {
  const eligible = own.filter((tab) => isEligible(tab, resolved));
  const { vectors, vocabulary, siteKeys, surfacePairs } = vectorize(
    eligible,
    resolved,
    collectSurface,
  );
  const ungrouped: number[] = [];
  const candidates: {
    readonly indexes: readonly number[];
    readonly tabIds: readonly number[];
    readonly firstAt: number;
  }[] = [];

  const rawClusters = agglomerate(vectors, vocabulary.length, resolved.threshold);
  const refined = refineClusters(rawClusters, vectors, vocabulary, resolved.threshold);
  for (const cluster of refined) {
    const tabIds = cluster.map((index) => (eligible[index] as TabInfo).id);
    if (cluster.length < resolved.minClusterTabs) {
      ungrouped.push(...tabIds);
      continue;
    }
    candidates.push({ indexes: cluster, tabIds, firstAt: cluster[0] as number });
  }
  candidates.sort(compareBuckets);

  for (const cut of candidates.slice(resolved.maxGroups)) ungrouped.push(...cut.tabIds);
  const kept: typeof candidates = [];
  for (const entry of candidates.slice(0, resolved.maxGroups)) {
    if (!hasContentToken(entry.indexes, vectors, vocabulary)) {
      ungrouped.push(...entry.tabIds);
      continue;
    }
    kept.push(entry);
  }
  return { windowId, vectors, vocabulary, siteKeys, surfacePairs, kept, ungrouped };
}

/**
 * Lightweight clustering returning only the tab IDs per cluster and the ungrouped tab IDs,
 * without computing titles or colours. Used by `platform/windows.ts` so the background service
 * worker stays small and skips unused naming/colouring work.
 */
export function clusterTabIds(
  tabs: readonly TabInfo[],
  mode: ClusterMode,
  options: ClusterOptions = {},
): { readonly groups: readonly (readonly number[])[]; readonly ungrouped: readonly number[] } {
  const resolved = resolve(options);
  if (mode === 'site') {
    const { buckets, ungrouped } = siteBuckets(tabs, resolved);
    return { groups: buckets.map((b) => b.tabIds), ungrouped };
  }
  const groups: (readonly number[])[] = [];
  const ungrouped: number[] = [];
  for (const { windowId, tabs: own } of byWindow(tabs)) {
    const result = topicWindowClusters(windowId, own, resolved, false);
    for (const entry of result.kept) groups.push(entry.tabIds);
    ungrouped.push(...result.ungrouped);
  }
  return { groups, ungrouped };
}

/**
 * By topic, without AI (PLAN.md §7.2): tokens, TF-IDF, average-linkage clustering, at
 * least `minClusterTabs` tabs per group and at most `maxGroups` groups per window.
 * Everything else is "Altro".
 */
export function groupByTopic(
  tabs: readonly TabInfo[],
  options: ClusterOptions = {},
): GroupProposal {
  const resolved = resolve(options);
  const groups: Candidate[] = [];
  const ungrouped: number[] = [];

  for (const { windowId, tabs: own } of byWindow(tabs)) {
    const {
      vectors,
      vocabulary,
      siteKeys,
      surfacePairs,
      kept,
      ungrouped: dropped,
    } = topicWindowClusters(windowId, own, resolved, true);
    ungrouped.push(...dropped);

    const taken = new Set<string>();
    for (const entry of kept) {
      const ranked = rankTokens(entry.indexes, vectors, vocabulary, surfacePairs);
      const title = titleOf(ranked, dominantSite(entry.indexes, siteKeys), taken);
      taken.add(title);
      groups.push({
        windowId,
        tabIds: entry.tabIds,
        firstAt: entry.firstAt,
        title,
        key: title.toLowerCase(),
      });
    }
  }

  return proposalOf('topic', groups, ungrouped);
}

/** The proposal of one mode or the other (PLAN.md §4.4.2). */
export function proposeGroups(
  tabs: readonly TabInfo[],
  mode: ClusterMode,
  options: ClusterOptions = {},
): GroupProposal {
  return mode === 'site' ? groupBySite(tabs, options) : groupByTopic(tabs, options);
}
