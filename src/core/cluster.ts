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
import { displayHost, registrableDomain } from './url';

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
    [
      ['aistudio', 'Google AI Studio'],
      ['calendar', 'Google Calendar'],
      ['chat', 'Google Chat'],
      ['classroom', 'Google Classroom'],
      ['colab.research', 'Google Colab'],
      ['console.cloud', 'Google Cloud'],
      ['docs', 'Google Docs'],
      ['drive', 'Google Drive'],
      ['gemini', 'Gemini'],
      ['keep', 'Google Keep'],
      ['mail', 'Gmail'],
      ['maps', 'Google Maps'],
      ['meet', 'Google Meet'],
      ['notebooklm', 'NotebookLM'],
      ['photos', 'Google Photos'],
      ['scholar', 'Google Scholar'],
      ['sheets', 'Google Sheets'],
      ['slides', 'Google Slides'],
      ['translate', 'Google Translate'],
    ].map(([sub, name]) => [`${sub}.google.com`, name] as const),
  ),
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
  airbnb: 'Airbnb',
  amazon: 'Amazon',
  'ansa.it': 'ANSA',
  'anthropic.com': 'Anthropic',
  'atlassian.com': 'Atlassian',
  bbc: 'BBC',
  'bing.com': 'Bing',
  'booking.com': 'Booking.com',
  'brave.com': 'Brave',
  'chatgpt.com': 'ChatGPT',
  'claude.ai': 'Claude',
  'corriere.it': 'Corriere della Sera',
  'discord.com': 'Discord',
  'duckduckgo.com': 'DuckDuckGo',
  'ecosia.org': 'Ecosia',
  'extensionworkshop.com': 'Extension Workshop',
  'facebook.com': 'Facebook',
  'figma.com': 'Figma',
  'gazzettaufficiale.it': 'Gazzetta Ufficiale',
  getyourguide: 'GetYourGuide',
  'giallozafferano.it': 'GialloZafferano',
  'github.com': 'GitHub',
  'gitlab.com': 'GitLab',
  'google.com': 'Google',
  'html.it': 'HTML.it',
  ikea: 'IKEA',
  'ilpost.it': 'Il Post',
  'instagram.com': 'Instagram',
  'intesasanpaolo.com': 'Intesa Sanpaolo',
  'linkedin.com': 'LinkedIn',
  'lonelyplanet.com': 'Lonely Planet',
  'medium.com': 'Medium',
  'microsoft.com': 'Microsoft',
  'microsoftonline.com': 'Microsoft',
  'mozilla.org': 'Mozilla',
  'netflix.com': 'Netflix',
  'notion.so': 'Notion',
  'npmjs.com': 'npm',
  'openai.com': 'OpenAI',
  'perplexity.ai': 'Perplexity',
  'pragmaticengineer.com': 'The Pragmatic Engineer',
  'preactjs.com': 'Preact',
  'python.org': 'Python',
  'raiplay.it': 'RaiPlay',
  'react.dev': 'React',
  'reddit.com': 'Reddit',
  'repubblica.it': 'la Repubblica',
  'rome2rio.com': 'Rome2rio',
  skyscanner: 'Skyscanner',
  'slack.com': 'Slack',
  'spotify.com': 'Spotify',
  'stackoverflow.com': 'Stack Overflow',
  'subito.it': 'Subito',
  'theguardian.com': 'The Guardian',
  trello: 'Trello',
  tripadvisor: 'Tripadvisor',
  'twitch.tv': 'Twitch',
  'twitter.com': 'Twitter',
  'typescriptlang.org': 'TypeScript',
  'visitportugal.com': 'Visit Portugal',
  'vitest.dev': 'Vitest',
  'w3.org': 'W3C',
  'whatsapp.com': 'WhatsApp',
  'wikimedia.org': 'Wikimedia',
  'wikipedia.org': 'Wikipedia',
  'wxt.dev': 'WXT',
  'x.com': 'X',
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
    'agli alla alle allo anche ancora avere che chi cioe come con cosa cosi dai dal dall dalla ' +
    'degli dei del dell della delle dello dopo due essere fare fra gia gli hanno loro meno mia ' +
    'mio molto nel nell nella nelle nello noi non nostro ogni oppure per perche pero piu poi ' +
    'prima puo quale quando quanto quella quelle quelli quello questa queste questi questo sara ' +
    'sempre senza siamo solo sono sopra sotto stato sua sue sui sul sull sulla suo tra tre tuo ' +
    'tutta tutte tutti tutto una uno vedi voi ' +
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
 * URL-path routing segments that carry no topical signal (e.g. `/watch` on YouTube, `/app/…`
 * on Gemini, `/document/d/…/edit` on Google Docs). Filtered ONLY from URL paths — never from
 * page titles — so a title legitimately about watches or mobile apps keeps those words.
 */
const PATH_NOISE: ReadonlySet<string> = new Set(
  'app apps auth blob callback channel chat chats commit commits document edit embed feed file files folder folders inbox issue issues login logout mail oauth oauth2 playlist post posts presentation pull pulls raw redirect results search share shorts signin signup spreadsheets status thread threads tree view watch'.split(
    ' ',
  ),
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
 * Detects opaque URL path IDs (pure numbers like `2026` or `847291`, or long hex/base64-like
 * slugs such as Gemini/Docs/ChatGPT IDs `6c9f4e2b8a1d`) that would otherwise add high-IDF noise
 * to TF-IDF vectors and drown out real topic words.
 */
function isOpaquePathToken(token: string): boolean {
  let digits = 0;
  for (let i = 0; i < token.length; i += 1) {
    const code = token.charCodeAt(i);
    if (code >= 48 && code <= 57) digits += 1;
  }
  if (digits === token.length) return true;
  if (token.length >= 8 && digits >= 2) return true;
  return false;
}

/**
 * The separators a site puts between a page's name and its own (PLAN.md §7.2.1). Spaced,
 * so a hyphenated word or a path separator in a title is not mistaken for one.
 */
const TITLE_SEPARATORS: readonly string[] = [' - ', ' – ', ' — ', ' | ', ' · ', ' :: ', ' // '];

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

const NON_WEB_PROTOCOLS: ReadonlySet<string> = new Set([
  'chrome:',
  'chrome-extension:',
  'moz-extension:',
  'edge:',
  'brave:',
  'vivaldi:',
  'opera:',
  'about:',
  'devtools:',
  'view-source:',
  'file:',
  'data:',
  'blob:',
]);

/**
 * Which site a tab belongs to, as a key: the registrable domain, or the host shown in a
 * row when there is none — `localhost`, an IP address, an intranet name are sites to the
 * user even though they have no eTLD+1 (docs/DECISIONS.md, M4.1). `''` for a tab with no
 * web host (`about:blank`, `chrome-extension://…`, `chrome://…`, a `file:` path), which
 * can therefore not be grouped by site under an internal ID.
 */
export function siteKey(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if (NON_WEB_PROTOCOLS.has(parsed.protocol.toLowerCase())) return '';
  } catch {
    // Let registrableDomain / displayHost handle bare hostnames or unparseable strings.
  }
  const host = displayHost(trimmed).toLowerCase();
  if (host in APP_SUBDOMAINS) return host;
  return registrableDomain(trimmed) ?? displayHost(trimmed);
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
  const key = siteKey(url);
  const forms = new Set(
    [siteName(key), key, domainLabel(key), displayHost(url)]
      .filter((form) => form !== '')
      .map(simplify),
  );
  let out = title.trim();
  if (forms.size === 0) return out;

  for (;;) {
    const cut = lastSeparator(out);
    if (cut === null) return out;
    const tail = out.slice(cut.at + cut.separator.length);
    if (!forms.has(simplify(tail))) return out;
    out = out.slice(0, cut.at).trim();
  }
}

function lastSeparator(title: string): { at: number; separator: string } | null {
  let best: { at: number; separator: string } | null = null;
  for (const separator of TITLE_SEPARATORS) {
    const at = title.lastIndexOf(separator);
    if (at > 0 && (best === null || at > best.at)) best = { at, separator };
  }
  return best;
}

/** The path of a URL, percent-decoded when it can be, or `''` when there is none. */
function pathOf(url: string): string {
  let path: string;
  try {
    path = new URL(url.trim()).pathname;
  } catch {
    return '';
  }
  try {
    return decodeURIComponent(path);
  } catch {
    // A stray `%` is not an escape; the raw path still tokenizes.
    return path;
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
  const tokens: string[] = [];
  const collect = (text: string, isPath: boolean): void => {
    for (const raw of text.toLowerCase().split(TOKEN_BOUNDARY)) {
      if (raw.length < minLength) continue;
      if (isPath && (PATH_NOISE.has(raw) || isOpaquePathToken(raw))) continue;
      if (STOPWORDS.has(raw) || STOPWORDS.has(foldAccents(raw))) continue;
      tokens.push(raw);
    }
  };
  collect(stripSiteSuffix(tab.title, tab.url), false);
  collect(pathOf(tab.url), true);
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

/**
 * Largest group first, and groups of equal size in the order their first tab appears.
 * Both modes order their output this way, so the preview opens on the groups that matter
 * and the limit of 8 cuts the smallest (docs/DECISIONS.md, M4.1).
 */
function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.tabIds.length !== b.tabIds.length) return b.tabIds.length - a.tabIds.length;
  return a.firstAt - b.firstAt;
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

/**
 * By site (PLAN.md §7.1): one group per registrable domain that has at least
 * `minSiteTabs` tabs in the window. The others stay out of groups.
 */
export function groupBySite(tabs: readonly TabInfo[], options: ClusterOptions = {}): GroupProposal {
  const resolved = resolve(options);
  const groups: Candidate[] = [];
  const ungrouped: number[] = [];

  for (const { windowId, tabs: own } of byWindow(tabs)) {
    const sites = new Map<string, { tabIds: number[]; firstAt: number }>();
    for (const [at, tab] of own.entries()) {
      if (!isEligible(tab, resolved)) continue;
      const key = siteKey(tab.url);
      // No host at all: there is no site to group it with.
      if (key === '') {
        ungrouped.push(tab.id);
        continue;
      }
      const found = sites.get(key);
      if (found === undefined) sites.set(key, { tabIds: [tab.id], firstAt: at });
      else found.tabIds.push(tab.id);
    }

    const candidates: Candidate[] = [];
    for (const [key, site] of sites) {
      if (site.tabIds.length < resolved.minSiteTabs) {
        ungrouped.push(...site.tabIds);
        continue;
      }
      candidates.push({
        key,
        title: siteName(key),
        windowId,
        tabIds: site.tabIds,
        firstAt: site.firstAt,
      });
    }
    groups.push(...candidates.sort(compareCandidates));
  }

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

/** What one window's tabs add up to: a vector each, and the vocabulary behind them. */
interface Vectors {
  readonly vectors: readonly Vector[];
  /** Token id → the token, for the titles. Domain tokens keep their prefix. */
  readonly vocabulary: readonly string[];
}

/**
 * TF-IDF over the tabs of one window (PLAN.md §7.2.2), with an extra token for the domain
 * at `domainWeight`.
 *
 * `idf = ln(1 + N/df)`, so it is always positive: a token every tab carries still counts
 * for something (ln 2) instead of vanishing, which matters with the two or three
 * documents a small window has. The vectors are L2-normalised, so a cosine is a dot
 * product and a long title is not more similar to everything than a short one.
 */
function vectorize(
  tabs: readonly TabInfo[],
  options: Required<ClusterOptions>,
  tokensOf: (tab: TabInfo) => readonly string[],
): Vectors {
  const vocabulary: string[] = [];
  const ids = new Map<string, number>();
  const documentFrequency: number[] = [];
  const counts: Map<number, number>[] = [];

  for (const tab of tabs) {
    const tokens = [...tokensOf(tab)];
    const key = siteKey(tab.url);
    if (key !== '') tokens.push(`${DOMAIN_PREFIX}${key}`);

    const perTab = new Map<number, number>();
    for (const token of tokens) {
      let id = ids.get(token);
      if (id === undefined) {
        id = vocabulary.length;
        ids.set(token, id);
        vocabulary.push(token);
        documentFrequency.push(0);
      }
      const seen = perTab.get(id);
      if (seen === undefined) {
        perTab.set(id, 1);
        documentFrequency[id] = (documentFrequency[id] as number) + 1;
      } else perTab.set(id, seen + 1);
    }
    counts.push(perTab);
  }

  const total = tabs.length;
  const vectors: Vector[] = [];
  for (const perTab of counts) {
    const sorted = [...perTab.keys()].sort((a, b) => a - b);
    const vectorIds = new Int32Array(sorted.length);
    const values = new Float64Array(sorted.length);
    let norm = 0;
    for (const [at, id] of sorted.entries()) {
      const df = documentFrequency[id] as number;
      const idf = Math.log(1 + total / df);
      const isDomain = (vocabulary[id] as string).startsWith(DOMAIN_PREFIX);
      const weight = (perTab.get(id) as number) * idf * (isDomain ? options.domainWeight : 1);
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

  return { vectors, vocabulary };
}

/**
 * Agglomerative clustering with average linkage (PLAN.md §7.2.3): the two most similar
 * clusters merge while that similarity is at least `threshold`.
 *
 * Average linkage is updated in place with Lance-Williams —
 * `sim(A∪B, C) = (|A|·sim(A,C) + |B|·sim(B,C)) / (|A|+|B|)` — which is exactly the mean
 * of the pairwise similarities and costs one pass per merge. Each live cluster also keeps
 * its nearest neighbour, so finding the pair to merge is a scan of the clusters rather
 * than of the whole matrix: that is what keeps 300 tabs inside the 50 ms of PLAN.md §11.
 *
 * Returns one sorted array of member indexes per cluster, in the order the clusters
 * started: the merge is driven by indexes throughout, so the answer cannot depend on the
 * iteration order of anything.
 */
function agglomerate(vectors: readonly Vector[], threshold: number): readonly number[][] {
  const count = vectors.length;
  if (count === 0) return [];

  const sim = new Float64Array(count * count);
  for (let i = 0; i < count; i += 1) {
    const left = vectors[i] as Vector;
    for (let j = i + 1; j < count; j += 1) {
      const right = vectors[j] as Vector;
      const value = cosine(left, right);
      sim[i * count + j] = value;
      sim[j * count + i] = value;
    }
  }

  const alive = new Uint8Array(count).fill(1);
  const size = new Int32Array(count).fill(1);
  const members: number[][] = [];
  for (let i = 0; i < count; i += 1) members.push([i]);
  const nearest = new Int32Array(count).fill(-1);
  const nearestSim = new Float64Array(count);

  /** The live cluster most similar to `i`, ties going to the lower index. */
  const refresh = (i: number): void => {
    let best = -1;
    let bestSim = Number.NEGATIVE_INFINITY;
    for (let j = 0; j < count; j += 1) {
      if (j === i || alive[j] === 0) continue;
      const value = sim[i * count + j] as number;
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
    for (let i = 0; i < count; i += 1) {
      if (alive[i] === 0 || nearest[i] === -1) continue;
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
    for (let c = 0; c < count; c += 1) {
      if (c === kept || c === gone || alive[c] === 0) continue;
      const merged =
        ((sim[kept * count + c] as number) * keptSize +
          (sim[gone * count + c] as number) * goneSize) /
        (keptSize + goneSize);
      sim[kept * count + c] = merged;
      sim[c * count + kept] = merged;
    }
    size[kept] = keptSize + goneSize;
    const keptMembers = members[kept] as number[];
    const goneMembers = members[gone] as number[];
    keptMembers.push(...goneMembers);
    keptMembers.sort((a, b) => a - b);
    goneMembers.length = 0;
    alive[gone] = 0;
    nearest[gone] = -1;

    refresh(kept);
    // Only the clusters whose nearest neighbour has just disappeared or changed.
    for (let c = 0; c < count; c += 1) {
      if (alive[c] === 0 || c === kept) continue;
      if (nearest[c] === kept || nearest[c] === gone) refresh(c);
    }
  }

  const clusters: number[][] = [];
  for (let i = 0; i < count; i += 1) {
    if (alive[i] === 1) clusters.push(members[i] as number[]);
  }
  return clusters;
}

/** A token of a cluster and what it weighs there: the ranking a title is built from. */
interface RankedToken {
  readonly token: string;
  readonly weight: number;
}

/**
 * The cluster's tokens by total TF-IDF weight, heaviest first, ties alphabetical. The
 * synthetic domain token is left out: it is an aid to the similarity, not a word, and a
 * group named after its site would say nothing a "by site" grouping does not.
 */
function rankTokens(
  cluster: readonly number[],
  vectors: readonly Vector[],
  vocabulary: readonly string[],
): readonly RankedToken[] {
  const weights = new Map<string, number>();
  for (const index of cluster) {
    const vector = vectors[index] as Vector;
    for (let at = 0; at < vector.ids.length; at += 1) {
      const token = vocabulary[vector.ids[at] as number] as string;
      if (token.startsWith(DOMAIN_PREFIX)) continue;
      weights.set(token, (weights.get(token) ?? 0) + (vector.values[at] as number));
    }
  }
  return [...weights]
    .map(([token, weight]) => ({ token, weight }))
    .sort((a, b) => (b.weight !== a.weight ? b.weight - a.weight : a.token.localeCompare(b.token)));
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
function dominantSite(cluster: readonly number[], tabs: readonly TabInfo[]): string {
  const counts = new Map<string, number>();
  for (const index of cluster) {
    const key = siteKey((tabs[index] as TabInfo).url);
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
    const eligible = own.filter((tab) => isEligible(tab, resolved));
    const { vectors, vocabulary } = vectorize(eligible, resolved, (tab) => tokenize(tab, resolved));

    const candidates: { indexes: readonly number[]; candidate: Candidate }[] = [];
    for (const cluster of agglomerate(vectors, resolved.threshold)) {
      const tabIds = cluster.map((index) => (eligible[index] as TabInfo).id);
      if (cluster.length < resolved.minClusterTabs) {
        ungrouped.push(...tabIds);
        continue;
      }
      candidates.push({
        indexes: cluster,
        // The title is not known yet: it depends on which groups survive the limit.
        candidate: { key: '', title: '', windowId, tabIds, firstAt: cluster[0] as number },
      });
    }
    candidates.sort((a, b) => compareCandidates(a.candidate, b.candidate));

    // PLAN.md §7.2.6: past the limit of 8 the smallest clusters go to "Altro".
    for (const cut of candidates.slice(resolved.maxGroups)) ungrouped.push(...cut.candidate.tabIds);

    const taken = new Set<string>();
    for (const { indexes, candidate } of candidates.slice(0, resolved.maxGroups)) {
      const ranked = rankTokens(indexes, vectors, vocabulary);
      const title = titleOf(ranked, dominantSite(indexes, eligible), taken);
      if (title === '') {
        // Nothing to call it by: no group rather than a group with no name.
        ungrouped.push(...candidate.tabIds);
        continue;
      }
      taken.add(title);
      // The key is the title: that is what the group *is* here, and the colour follows it
      // so that renaming a group in the preview does not recolour it.
      groups.push({ ...candidate, title, key: title.toLowerCase() });
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
