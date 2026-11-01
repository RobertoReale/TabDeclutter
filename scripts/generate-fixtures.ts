/**
 * Generates `tests/fixtures/tabs-50.json`, `tabs-300.json` and `tabs-1000.json`
 * (TASKS.md M1.5, PLAN.md §6.5).
 *
 *   pnpm fixtures
 *
 * Everything comes from the curated templates below and a seeded PRNG, so the same seed
 * produces the same file byte for byte; `tests/unit/fixtures.test.ts` regenerates all
 * three and fails if the committed files differ.
 *
 * The `expected` labels of `tabs-300.json` answer one question — *would a careful user
 * close this tab?* — and are written by hand, situation by situation, **before** the
 * scoring of PLAN.md §6.4 exists. They are not derived from it, and a few of them
 * deliberately disagree with what a weights-and-thresholds rule would say: a false
 * positive costs more than a false negative (PLAN.md §3.1), so anything a careful user
 * would hesitate over is labelled `keep`.
 *
 * Run under `node --experimental-strip-types`, which does not resolve extensionless
 * imports: everything taken from `src/core/` here is a type (docs/DECISIONS.md).
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { TabActivity, TabInfo } from '../src/core/types.ts';
import {
  FIXTURE_STALE_DAYS,
  GROUP_COLORS,
  UNGROUPED,
  type FixtureGroup,
  type FixtureLabel,
  type FixtureLang,
  type FixtureTab,
  type FixtureWindow,
  type TabsFixture,
} from '../tests/fixtures/schema.ts';

const HOUR_MS = 3_600_000;

/** The injected clock: a Monday morning, so "nine days ago" is a plausible story. */
export const FIXTURE_NOW = Date.UTC(2026, 2, 16, 9, 30, 0);

// ---------------------------------------------------------------------------
// The seeded PRNG
// ---------------------------------------------------------------------------

type Range = readonly [number, number];

/**
 * mulberry32: 32-bit integer arithmetic only, so it gives the same stream on every
 * platform and Node version. Good enough for fixtures, and short enough to read.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

class Rng {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1 - Number.EPSILON));
  }

  span(range: Range): number {
    return this.float(range[0], range[1]);
  }

  spanInt(range: Range): number {
    return this.int(range[0], range[1]);
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick: nothing to pick from');
    return item;
  }

  weighted<T extends { readonly weight: number }>(items: readonly T[]): T {
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    let roll = this.float(0, total);
    for (const item of items) {
      roll -= item.weight;
      if (roll <= 0) return item;
    }
    return this.pick(items);
  }
}

// ---------------------------------------------------------------------------
// The curated templates
// ---------------------------------------------------------------------------

/**
 * One situation a page can be in: how long ago it was last read, how much it was read,
 * and the label a careful user would give it.
 */
interface Situation {
  id: string;
  /** Relative frequency inside its template. `0` means "only when asked for by id". */
  weight: number;
  /** Hours since the tab was last in the foreground. */
  idleH: Range;
  /** Extra hours between its creation and that last foreground moment. */
  ageH?: Range;
  activations: Range;
  /** Cumulative foreground seconds. */
  foregroundS: Range;
  pinned?: true;
  audible?: true;
  discarded?: true;
  active?: true;
  /** Hours since the extension invented this record on first run (PLAN.md §6.1). */
  bootstrappedH?: Range;
  expected: FixtureLabel;
  rationale: string;
}

/**
 * A page source: a site, and the subjects that site can be showing. `{S}` in the title
 * is the subject as written, `{s}` its slug, `{q}` its query form and `{n}` a number
 * unique to the fixture. A source whose URL has no `{n}` and is not `reusable` is used
 * at most once per fixture, so no tab is an accidental duplicate of another.
 */
interface PageSource {
  url: string;
  title: string;
  lang: FixtureLang;
  subjects: readonly string[];
  /** Empty tabs and browser pages are genuinely opened many times over. */
  reusable?: true;
}

interface Template {
  name: string;
  weight: number;
  /** Tabs a user plausibly collects into a tab group. */
  groupable?: true;
  /** Pages a user plausibly ends up opening twice. */
  duplicable?: true;
  /** Pages usually reached from a search result, which becomes their opener. */
  fromSearch?: true;
  pages: readonly PageSource[];
  situations: readonly Situation[];
}

const SEARCH: Template = {
  name: 'search',
  weight: 10,
  duplicable: true,
  pages: [
    {
      url: 'https://www.google.com/search?q={q}',
      title: '{S} - Cerca con Google',
      lang: 'it',
      subjects: [
        'ricetta pasta alla norma',
        'come rinnovare il passaporto',
        'orari museo egizio torino',
        'detrazioni fiscali 2026 ristrutturazione',
        'tram 28 lisbona quanto costa',
        'differenza tra spid e cie',
      ],
    },
    {
      url: 'https://www.google.com/search?q={q}',
      title: '{S} - Google Search',
      lang: 'en',
      subjects: [
        'chrome extension mv3 service worker lifetime',
        'preact signals batch updates',
        'vitest coverage thresholds per file',
        'playwright launch persistent context extension',
        'tab groups api color enum',
      ],
    },
    {
      url: 'https://duckduckgo.com/?q={q}',
      title: '{S} at DuckDuckGo',
      lang: 'en',
      subjects: [
        'tldts public suffix list size',
        'firefox mv3 background scripts',
        'web-ext lint rules list',
        'structured clone storage quota',
      ],
    },
    {
      url: 'https://www.bing.com/search?q={q}',
      title: '{S} - Bing',
      lang: 'it',
      subjects: [
        'voli low cost lisbona aprile',
        'miglior monitor 27 pollici 2026',
        'come pulire la lavatrice aceto',
        'bonus mobili come funziona',
      ],
    },
    {
      url: 'https://kagi.com/search?q={q}',
      title: '{S} - Kagi Search',
      lang: 'en',
      subjects: [
        'local first software principles',
        'tab hoarding research paper',
        'mulberry32 prng quality',
        'service worker keepalive anti pattern',
      ],
    },
    {
      url: 'https://www.youtube.com/results?search_query={q}',
      title: '{S} - YouTube',
      lang: 'en',
      subjects: [
        'lofi beats to code to',
        'preact tutorial 2026',
        'lisbon tram 28 full ride',
        'typescript satisfies operator explained',
      ],
    },
    {
      url: 'https://www.amazon.it/s?k={q}',
      title: 'Amazon.it: {S}',
      lang: 'it',
      subjects: [
        'monitor 27 pollici usb c',
        'tastiera meccanica layout italiano',
        'zaino porta laptop 15 pollici',
        'lampada da scrivania led',
      ],
    },
    {
      url: 'https://github.com/search?q={q}&type=repositories',
      title: 'Search · {S} · GitHub',
      lang: 'en',
      subjects: [
        'wxt firefox mv3',
        'preact signals devtools',
        'seeded prng typescript',
        'duplicate tabs closer',
      ],
    },
    {
      url: 'https://www.ecosia.org/search?q={q}',
      title: '{S} - Ecosia',
      lang: 'en',
      subjects: ['plastic free shops milano', 'carbon footprint of a browser tab'],
    },
    {
      url: 'https://search.brave.com/search?q={q}',
      title: '{S} - Brave Search',
      lang: 'en',
      subjects: ['side panel api firefox', 'declarative net request vs blocking'],
    },
  ],
  situations: [
    {
      id: 'done',
      weight: 6,
      idleH: [72, 480],
      ageH: [0.2, 24],
      activations: [1, 1],
      foregroundS: [2, 25],
      expected: 'suggest',
      rationale: 'A finished search: opened once, glanced at, untouched for days.',
    },
    {
      id: 'just-now',
      weight: 2,
      idleH: [0.2, 1.5],
      activations: [1, 2],
      foregroundS: [5, 60],
      expected: 'keep',
      rationale: 'Searched minutes ago: the user is still on this question.',
    },
    {
      id: 'working-hub',
      weight: 1,
      idleH: [48, 150],
      activations: [4, 9],
      foregroundS: [120, 700],
      expected: 'keep',
      rationale:
        'Came back to this result list again and again: it is the thread of the work, not a leftover.',
    },
  ],
};

const AUTH: Template = {
  name: 'auth',
  weight: 5,
  pages: [
    {
      url: 'https://accounts.google.com/signin/v2/identifier?service=mail&n={n}',
      title: 'Accedi - Account Google',
      lang: 'it',
      subjects: ['accedi'],
    },
    {
      url: 'https://login.microsoftonline.com/common/oauth2/authorize?client_id=4b4a{n}',
      title: 'Sign in to your account',
      lang: 'en',
      subjects: ['sign in'],
    },
    {
      url: 'https://github.com/login?return_to=%2F{s}',
      title: 'Sign in to GitHub · GitHub',
      lang: 'en',
      subjects: ['RobertoReale/phasekit', 'wxt-dev/wxt', 'preactjs/signals'],
    },
    {
      url: 'https://www.intesasanpaolo.com/it/login.html',
      title: 'Accesso all area riservata',
      lang: 'it',
      subjects: ['accesso'],
    },
    {
      url: 'https://id.atlassian.com/login?continue=https%3A%2F%2F{s}',
      title: 'Log in to continue - Atlassian account',
      lang: 'en',
      subjects: ['jira.example.com', 'confluence.example.com'],
    },
    {
      url: 'https://sso.example.com/saml/sso?SAMLRequest=r{n}',
      title: 'Single Sign-On',
      lang: 'en',
      subjects: ['sso'],
    },
    {
      url: 'https://auth.notion.so/callback?code=c{n}',
      title: 'Notion',
      lang: 'neutral',
      subjects: ['callback'],
    },
  ],
  situations: [
    {
      id: 'left-over',
      weight: 6,
      idleH: [24, 400],
      ageH: [0.1, 2],
      activations: [1, 2],
      foregroundS: [3, 40],
      expected: 'suggest',
      rationale: 'A sign-in page left behind once the login went through.',
    },
    {
      id: 'in-progress',
      weight: 2,
      idleH: [0.1, 0.6],
      activations: [1, 3],
      foregroundS: [20, 90],
      expected: 'keep',
      rationale: 'A sign-in happening right now: closing it would interrupt it.',
    },
  ],
};

const DOCS: Template = {
  name: 'docs',
  weight: 10,
  groupable: true,
  duplicable: true,
  fromSearch: true,
  pages: [
    {
      url: 'https://developer.mozilla.org/en-US/docs/Web/API/{s}',
      title: '{S} - Web APIs | MDN',
      lang: 'en',
      subjects: [
        'URL/searchParams',
        'Window/structuredClone',
        'AbortController',
        'IntersectionObserver',
        'Element/scrollIntoView',
      ],
    },
    {
      url: 'https://developer.chrome.com/docs/extensions/reference/api/{s}',
      title: 'chrome.{S} | Chrome Extensions',
      lang: 'en',
      subjects: ['tabGroups', 'sidePanel', 'tabs', 'storage', 'idle'],
    },
    {
      url: 'https://preactjs.com/guide/v10/{s}/',
      title: '{S} – Preact Guide',
      lang: 'en',
      subjects: ['signals', 'hooks', 'differences-to-react'],
    },
    {
      url: 'https://vitest.dev/guide/{s}.html',
      title: '{S} | Vitest',
      lang: 'en',
      subjects: ['coverage', 'mocking', 'cli'],
    },
    {
      url: 'https://wxt.dev/guide/essentials/{s}.html',
      title: '{S} – WXT',
      lang: 'en',
      subjects: ['config/manifest', 'entrypoints', 'target-browsers'],
    },
    {
      url: 'https://docs.python.org/3/library/{s}.html',
      title: '{S} — Python 3 documentation',
      lang: 'en',
      subjects: ['itertools', 'pathlib', 'sqlite3'],
    },
    {
      url: 'https://www.html.it/guide/{s}/',
      title: '{S} | HTML.it',
      lang: 'it',
      subjects: ['guida-css', 'guida-javascript', 'guida-accessibilita'],
    },
    {
      url: 'https://it.react.dev/learn/{s}',
      title: '{S} – React',
      lang: 'it',
      subjects: [
        'forse-non-ti-serve-un-effect',
        'pensare-in-react',
        'gestire-lo-stato',
        'passare-dati-in-profondita',
      ],
    },
    {
      url: 'https://extensionworkshop.com/documentation/develop/{s}/',
      title: '{S} | Firefox Extension Workshop',
      lang: 'en',
      subjects: [
        'manifest-v3-migration-guide',
        'test-permission-requests',
        'browser-compatibility',
      ],
    },
    {
      url: 'https://developer.mozilla.org/it/docs/Web/Accessibility/{s}',
      title: '{S} - Accessibilità | MDN',
      lang: 'it',
      subjects: ['ARIA/Roles', 'Keyboard-navigable_JavaScript_widgets'],
    },
  ],
  situations: [
    {
      id: 'reading',
      weight: 4,
      idleH: [1, 40],
      activations: [3, 12],
      foregroundS: [300, 2800],
      expected: 'keep',
      rationale: 'A reference the user keeps going back to while working.',
    },
    {
      id: 'never-read',
      weight: 3,
      idleH: [480, 1400],
      ageH: [0.2, 48],
      activations: [1, 1],
      foregroundS: [8, 45],
      expected: 'suggest',
      rationale: 'Opened over a month ago, read for seconds, never reopened.',
    },
    {
      id: 'read-and-parked',
      weight: 2,
      idleH: [190, 460],
      activations: [2, 4],
      foregroundS: [90, 420],
      expected: 'keep',
      rationale:
        'Read properly a couple of weeks ago and parked on purpose: a careful user would rather keep it than hunt for it again.',
    },
  ],
};

const GITHUB: Template = {
  name: 'github',
  weight: 8,
  groupable: true,
  duplicable: true,
  fromSearch: true,
  pages: [
    {
      url: 'https://github.com/RobertoReale/phasekit/pull/{n}',
      title: '{S} by RobertoReale · Pull Request #{n} · RobertoReale/phasekit',
      lang: 'en',
      subjects: ['Add a dynamic pacing mode', 'Retry a run that hit the usage limit'],
    },
    {
      url: 'https://github.com/wxt-dev/wxt/issues/{n}',
      title: '{S} · Issue #{n} · wxt-dev/wxt',
      lang: 'en',
      subjects: ['Firefox MV3 background type', 'publicDir is ignored in dev'],
    },
    {
      url: 'https://github.com/preactjs/signals/pull/{n}',
      title: '{S} · Pull Request #{n} · preactjs/signals',
      lang: 'en',
      subjects: ['fix(core): batch nested effects', 'docs: document untracked()'],
    },
    {
      url: 'https://github.com/mozilla/web-ext/pull/{n}/files',
      title: '{S} · Pull Request #{n} · mozilla/web-ext',
      lang: 'en',
      subjects: ['Bump the minimum Node to 20', 'Report the lint rule id'],
    },
    {
      url: 'https://gitlab.com/gitlab-org/gitlab/-/merge_requests/{n}',
      title: '{S} (!{n}) · Merge requests · GitLab',
      lang: 'en',
      subjects: ['Rework the pipeline editor', 'Draft: cache the policy list'],
    },
    {
      url: 'https://github.com/remusao/tldts',
      title: 'GitHub - remusao/tldts: a fast URL parser',
      lang: 'en',
      subjects: ['tldts'],
    },
  ],
  situations: [
    {
      id: 'in-review',
      weight: 3,
      idleH: [2, 30],
      activations: [3, 8],
      foregroundS: [240, 1500],
      expected: 'keep',
      rationale: 'A review in progress, picked up several times.',
    },
    {
      id: 'old-pr',
      weight: 3,
      idleH: [500, 1600],
      activations: [1, 2],
      foregroundS: [20, 140],
      expected: 'suggest',
      rationale: 'A pull request from over three weeks ago: by now it is merged or closed.',
    },
    {
      id: 'skimmed',
      weight: 2,
      idleH: [100, 300],
      ageH: [0.2, 6],
      activations: [1, 1],
      foregroundS: [10, 60],
      expected: 'suggest',
      rationale: 'Opened from a search, skimmed once, never went back to it.',
    },
  ],
};

const VIDEO: Template = {
  name: 'video',
  weight: 6,
  duplicable: true,
  fromSearch: true,
  pages: [
    {
      url: 'https://www.youtube.com/watch?v=kQ7pR2{n}',
      title: '{S} - YouTube',
      lang: 'en',
      subjects: [
        'What the heck is the event loop anyway?',
        'Building a browser extension from scratch',
        'Big Buck Bunny',
      ],
    },
    {
      url: 'https://www.youtube.com/watch?v=mB4vTq{n}',
      title: '{S} - YouTube',
      lang: 'it',
      subjects: ['Come funziona il Public Suffix List', 'Lisbona in 3 giorni: cosa vedere'],
    },
    {
      url: 'https://www.raiplay.it/video/2026/03/{s}-{n}.html',
      title: '{S} - RaiPlay',
      lang: 'it',
      subjects: ['Report puntata del 9 marzo', 'Presa Diretta la casa di tutti'],
    },
    {
      url: 'https://open.spotify.com/album/1ATL5GLyef{n}',
      title: '{S} | Spotify',
      lang: 'it',
      subjects: ['Random Access Memories - album di Daft Punk', 'Playlist per concentrarsi'],
    },
    {
      url: 'https://www.twitch.tv/videos/20893{n}',
      title: '{S} - Twitch',
      lang: 'en',
      subjects: ['Live coding: a tab manager in two hours'],
    },
  ],
  situations: [
    {
      id: 'playing',
      weight: 2,
      idleH: [0, 0.3],
      activations: [1, 4],
      foregroundS: [120, 2400],
      audible: true,
      expected: 'keep',
      rationale: 'Playing sound right now.',
    },
    {
      id: 'watch-later',
      weight: 4,
      idleH: [120, 700],
      ageH: [0.1, 3],
      activations: [1, 1],
      foregroundS: [4, 60],
      expected: 'suggest',
      rationale: 'Put aside to watch later, weeks ago, and never started.',
    },
    {
      id: 'half-watched',
      weight: 2,
      idleH: [4, 14],
      activations: [2, 4],
      foregroundS: [600, 2600],
      expected: 'keep',
      rationale: 'Watched for a long stretch yesterday: it is going to be resumed.',
    },
  ],
};

const NEWS: Template = {
  name: 'news',
  weight: 8,
  groupable: true,
  duplicable: true,
  fromSearch: true,
  pages: [
    {
      url: 'https://www.ilpost.it/2026/03/09/{s}/',
      title: '{S} - Il Post',
      lang: 'it',
      subjects: [
        'Quando si vota alle prossime amministrative',
        'Perché abbiamo tutti troppe schede aperte',
        'La storia del tram 28 di Lisbona',
      ],
    },
    {
      url: 'https://www.corriere.it/economia/26_marzo_10/{s}-{n}.shtml',
      title: '{S} - Corriere.it',
      lang: 'it',
      subjects: ['Le borse europee chiudono in rialzo', 'Il mercato del lavoro nel 2026'],
    },
    {
      url: 'https://www.ansa.it/sito/notizie/cronaca/2026/03/09/{s}_{n}.html',
      title: '{S} - Ansa.it',
      lang: 'it',
      subjects: ['Maltempo al Nord allerta arancione', 'Treni in ritardo sulla linea Milano Roma'],
    },
    {
      url: 'https://www.repubblica.it/tecnologia/2026/03/07/news/{s}-{n}/',
      title: '{S} - la Repubblica',
      lang: 'it',
      subjects: [
        'Le estensioni che tolgono il disordine dal browser',
        'Intelligenza artificiale sul dispositivo',
      ],
    },
    {
      url: 'https://www.bbc.com/news/technology-{n}',
      title: '{S} - BBC News',
      lang: 'en',
      subjects: [
        'Browser makers agree on a shared extension API',
        'The quiet return of local-only software',
      ],
    },
    {
      url: 'https://www.theguardian.com/technology/2026/mar/05/{s}',
      title: '{S} | The Guardian',
      lang: 'en',
      subjects: ['Why we all have 97 tabs open', 'The slow death of the browser bookmark'],
    },
    {
      url: 'https://news.ycombinator.com/item?id={n}',
      title: '{S} | Hacker News',
      lang: 'en',
      subjects: ['Show HN: a local-first tab manager', 'Ask HN: how many tabs do you have open?'],
    },
  ],
  situations: [
    {
      id: 'for-later',
      weight: 5,
      idleH: [100, 720],
      ageH: [0.1, 3],
      activations: [1, 1],
      foregroundS: [5, 50],
      expected: 'suggest',
      rationale: 'An article opened "for later" and never read.',
    },
    {
      id: 'read',
      weight: 2,
      idleH: [24, 90],
      activations: [2, 3],
      foregroundS: [200, 900],
      expected: 'keep',
      rationale:
        'Already read for several minutes, and recently: suggesting it would feel like being told to throw away today\u2019s paper.',
    },
  ],
};

const READ_LATER: Template = {
  name: 'read-later',
  weight: 9,
  groupable: true,
  duplicable: true,
  fromSearch: true,
  pages: [
    {
      url: 'https://www.giallozafferano.it/ricette/{s}.html',
      title: '{S}: la ricetta originale',
      lang: 'it',
      subjects: ['Pasta alla Norma', 'Tiramisu classico', 'Pane in casa senza impasto'],
    },
    {
      url: 'https://overreacted.io/{s}/',
      title: '{S} — overreacted',
      lang: 'en',
      subjects: [
        'writing-resilient-components',
        'before-you-memo',
        'a-complete-guide-to-useeffect',
      ],
    },
    {
      url: 'https://simonwillison.net/2026/Feb/18/{s}/',
      title: '{S}',
      lang: 'en',
      subjects: ['notes-on-local-first', 'things-i-learned-shipping-an-extension'],
    },
    {
      url: 'https://www.amazon.it/dp/B0{n}',
      title: '{S} - Amazon.it',
      lang: 'it',
      subjects: [
        'Monitor 27 pollici 4K USB-C',
        'Tastiera meccanica wireless',
        'Sedia da ufficio ergonomica',
      ],
    },
    {
      url: 'https://www.booking.com/hotel/pt/{s}.it.html',
      title: '{S} - Booking.com',
      lang: 'it',
      subjects: ['lisboa-centro-suites', 'alfama-river-view'],
    },
    {
      url: 'https://newsletter.pragmaticengineer.com/p/{s}',
      title: '{S} - The Pragmatic Engineer',
      lang: 'en',
      subjects: ['the-tab-hoarders', 'shipping-on-two-stores'],
    },
    {
      url: 'https://www.ikea.com/it/it/p/{s}-00{n}/',
      title: '{S} - IKEA',
      lang: 'it',
      subjects: ['billy-libreria-bianco', 'markus-sedia-da-ufficio'],
    },
    {
      url: 'https://it.wikipedia.org/wiki/{s}',
      title: '{S} - Wikipedia',
      lang: 'it',
      subjects: ['Public_Suffix_List', 'Lisbona', 'Generatore_di_numeri_pseudocasuali'],
    },
  ],
  situations: [
    {
      id: 'stale',
      weight: 6,
      idleH: [260, 1700],
      ageH: [0.1, 72],
      activations: [1, 1],
      foregroundS: [2, 30],
      expected: 'suggest',
      rationale: 'Opened for later weeks ago and read for a handful of seconds.',
    },
    {
      id: 'today',
      weight: 3,
      idleH: [0.3, 10],
      activations: [1, 1],
      foregroundS: [10, 70],
      expected: 'keep',
      rationale: 'Opened today and not read yet: it is still on the list.',
    },
  ],
};

const WEBAPP: Template = {
  name: 'webapp',
  weight: 7,
  pages: [
    {
      url: 'https://mail.google.com/mail/u/0/#inbox',
      title: 'Posta in arrivo - Gmail',
      lang: 'it',
      subjects: ['gmail'],
    },
    {
      url: 'https://calendar.google.com/calendar/u/0/r/week',
      title: 'Google Calendar - Settimana',
      lang: 'it',
      subjects: ['calendar'],
    },
    { url: 'https://web.whatsapp.com/', title: 'WhatsApp Web', lang: 'neutral', subjects: ['wa'] },
    {
      url: 'https://app.slack.com/client/T024BE7LD/C024BE{n}',
      title: 'Slack | {S} | TabDeclutter',
      lang: 'en',
      subjects: ['general', 'releases'],
    },
    {
      url: 'https://www.notion.so/{s}-2f1c4a',
      title: '{S}',
      lang: 'neutral',
      subjects: ['TabDeclutter', 'Spesa-della-settimana'],
    },
    {
      url: 'https://jira.example.com/browse/TD-{n}',
      title: '[TD-{n}] {S} - Jira',
      lang: 'en',
      subjects: ['Side panel keyboard navigation', 'Archive retention job'],
    },
    {
      url: 'https://www.google.com/maps/place/{s}',
      title: '{S} - Google Maps',
      lang: 'it',
      subjects: ['Lisbona', 'Museo+Egizio+Torino'],
    },
    {
      url: 'https://www.intesasanpaolo.com/it/persone-e-famiglie/conti.html',
      title: 'Il mio conto - Intesa Sanpaolo',
      lang: 'it',
      subjects: ['conto'],
    },
  ],
  situations: [
    {
      id: 'pinned',
      weight: 3,
      idleH: [0.5, 30],
      activations: [8, 40],
      foregroundS: [900, 6000],
      pinned: true,
      expected: 'keep',
      rationale: 'A pinned tab: the user already decided it stays.',
    },
    {
      id: 'daily',
      weight: 3,
      idleH: [0.3, 6],
      activations: [6, 25],
      foregroundS: [600, 4000],
      expected: 'keep',
      rationale: 'An app opened every single day.',
    },
    {
      id: 'discarded-daily',
      weight: 1,
      idleH: [8, 40],
      activations: [5, 15],
      foregroundS: [400, 2500],
      discarded: true,
      expected: 'keep',
      rationale: 'Suspended by the browser to save memory, but a tool the user opens constantly.',
    },
  ],
};

const BLANK: Template = {
  name: 'blank',
  weight: 4,
  pages: [
    {
      url: 'chrome://newtab/',
      title: 'Nuova scheda',
      lang: 'it',
      subjects: ['newtab'],
      reusable: true,
    },
    {
      url: 'about:newtab',
      title: 'Nuova scheda',
      lang: 'it',
      subjects: ['newtab'],
      reusable: true,
    },
    { url: 'about:blank', title: '', lang: 'neutral', subjects: ['blank'], reusable: true },
    {
      url: 'chrome://new-tab-page/',
      title: 'New Tab',
      lang: 'en',
      subjects: ['newtab'],
      reusable: true,
    },
  ],
  situations: [
    {
      id: 'left-open',
      weight: 5,
      idleH: [20, 400],
      ageH: [0.05, 1],
      activations: [0, 1],
      foregroundS: [0, 4],
      expected: 'suggest',
      rationale: 'An empty tab nobody ever typed anything into.',
    },
    {
      id: 'fresh',
      weight: 2,
      idleH: [0.05, 0.5],
      activations: [1, 1],
      foregroundS: [1, 15],
      expected: 'keep',
      rationale: 'Just opened: the user is about to type in it.',
    },
  ],
};

const ERROR: Template = {
  name: 'error',
  weight: 3,
  pages: [
    {
      url: 'https://old.example.com/docs/{s}-{n}',
      title: '404 Not Found',
      lang: 'en',
      subjects: ['legacy-api', 'release-notes'],
    },
    {
      url: 'https://intranet.azienda.it/report/{n}',
      title: 'Pagina non trovata',
      lang: 'it',
      subjects: ['report'],
    },
    {
      url: 'https://api.example.net/v1/{s}',
      title: "This site can't be reached",
      lang: 'en',
      subjects: ['status', 'health'],
    },
    {
      url: 'https://vecchio-sito.it/{s}-{n}',
      title: 'Impossibile raggiungere il sito',
      lang: 'it',
      subjects: ['offerte', 'contatti'],
    },
    {
      url: 'https://paywall.example.org/article/{n}',
      title: 'Access denied | 403 Forbidden',
      lang: 'en',
      subjects: ['article'],
    },
  ],
  situations: [
    {
      id: 'dead',
      weight: 5,
      idleH: [30, 500],
      ageH: [0.05, 1],
      activations: [1, 2],
      foregroundS: [3, 30],
      expected: 'suggest',
      rationale: 'The page does not load: there is nothing to come back to.',
    },
    {
      id: 'maybe-the-network',
      weight: 2,
      idleH: [0.2, 1],
      activations: [1, 2],
      foregroundS: [3, 20],
      expected: 'keep',
      rationale: 'Failed minutes ago: it may have been the connection, so it deserves a retry.',
    },
  ],
};

const INTERNAL: Template = {
  name: 'browser-internal',
  weight: 4,
  pages: [
    { url: 'chrome://downloads/', title: 'Download', lang: 'it', subjects: ['downloads'] },
    {
      url: 'chrome://settings/privacy',
      title: 'Impostazioni - Privacy e sicurezza',
      lang: 'it',
      subjects: ['settings'],
    },
    { url: 'chrome://extensions/', title: 'Estensioni', lang: 'it', subjects: ['extensions'] },
    {
      url: 'about:addons',
      title: 'Gestione componenti aggiuntivi',
      lang: 'it',
      subjects: ['addons'],
    },
    { url: 'chrome://history/', title: 'Cronologia', lang: 'it', subjects: ['history'] },
    { url: 'about:config', title: 'Configurazione avanzata', lang: 'it', subjects: ['config'] },
    { url: 'chrome://bookmarks/', title: 'Preferiti', lang: 'it', subjects: ['bookmarks'] },
  ],
  situations: [
    {
      id: 'job-done',
      weight: 5,
      idleH: [24, 500],
      ageH: [0.05, 2],
      activations: [1, 3],
      foregroundS: [10, 90],
      expected: 'suggest',
      rationale: 'A browser page opened for a job that is finished.',
    },
    {
      id: 'using-it',
      weight: 2,
      idleH: [0.1, 1],
      activations: [1, 4],
      foregroundS: [20, 180],
      expected: 'keep',
      rationale: 'In use right now.',
    },
  ],
};

const FILE_MEDIA: Template = {
  name: 'file-media',
  weight: 4,
  groupable: true,
  duplicable: true,
  pages: [
    {
      url: 'file:///C:/Users/Roberto/Downloads/fattura-2026-{n}.pdf',
      title: 'fattura-2026-{n}.pdf',
      lang: 'neutral',
      subjects: ['fattura'],
    },
    {
      url: 'file:///C:/Users/Roberto/Documents/{s}.md',
      title: '{S}.md',
      lang: 'neutral',
      subjects: ['appunti', 'spesa', 'idee-regalo'],
    },
    {
      url: 'https://www.w3.org/TR/wai-aria-1.2/{s}.pdf',
      title: '{S}.pdf',
      lang: 'neutral',
      subjects: ['aria', 'aria-practices'],
    },
    {
      url: 'https://upload.wikimedia.org/wikipedia/commons/3/3f/{s}_{n}.jpg',
      title: '{S}_{n}.jpg (JPEG Image)',
      lang: 'en',
      subjects: ['Lisbon_tram', 'Torre_de_Belem'],
    },
    {
      url: 'https://www.gazzettaufficiale.it/atto/serie_generale/2026-03-{n}.pdf',
      title: '2026-03-{n}.pdf',
      lang: 'neutral',
      subjects: ['gazzetta'],
    },
  ],
  situations: [
    {
      id: 'already-saved',
      weight: 5,
      idleH: [120, 900],
      ageH: [0.05, 2],
      activations: [1, 2],
      foregroundS: [10, 80],
      expected: 'suggest',
      rationale: 'A file that is already on disk: the Downloads folder still has it.',
    },
    {
      id: 'reading-it',
      weight: 2,
      idleH: [2, 24],
      activations: [2, 5],
      foregroundS: [180, 900],
      expected: 'keep',
      rationale: 'A document the user is working through.',
    },
  ],
};

const BOOTSTRAPPED: Template = {
  name: 'bootstrapped',
  weight: 2,
  pages: [
    {
      url: 'https://stackoverflow.com/questions/{n}/{s}',
      title: '{S} - Stack Overflow',
      lang: 'en',
      subjects: ['typescript-satisfies-operator', 'how-to-debounce-storage-writes'],
    },
    {
      url: 'https://www.subito.it/annunci-lombardia/vendita/usato/?q={q}',
      title: 'Annunci {S} in Lombardia - Subito.it',
      lang: 'it',
      subjects: ['bici da corsa', 'scrivania'],
    },
    {
      url: 'https://trello.com/b/8KxQw{n}/{s}',
      title: '{S} | Trello',
      lang: 'neutral',
      subjects: ['casa', 'viaggi'],
    },
  ],
  situations: [
    {
      id: 'just-installed',
      weight: 1,
      idleH: [100, 600],
      ageH: [0.1, 4],
      activations: [0, 1],
      foregroundS: [0, 40],
      bootstrappedH: [2, 20],
      expected: 'keep',
      rationale:
        'The extension met this tab when it was installed and still knows nothing real about it: it would be guessing.',
    },
    {
      id: 'installed-a-while-ago',
      weight: 1,
      idleH: [300, 900],
      ageH: [0.1, 4],
      activations: [0, 1],
      foregroundS: [0, 40],
      bootstrappedH: [40, 200],
      expected: 'suggest',
      rationale:
        'Known only since the install, but that was days ago and it has not been touched since.',
    },
  ],
};

/** The tab the user is looking at, one per ordinary window. */
const ACTIVE: Template = {
  name: 'active',
  weight: 0,
  pages: [
    {
      url: 'https://mail.google.com/mail/u/0/#search/{s}',
      title: 'Cerca {S} - Gmail',
      lang: 'it',
      subjects: ['fattura', 'volo+lisbona'],
    },
    {
      url: 'https://github.com/RobertoReale/TabDeclutter/pull/{n}',
      title: '{S} · Pull Request #{n} · RobertoReale/TabDeclutter',
      lang: 'en',
      subjects: ['Labelled fixtures', 'Uselessness score'],
    },
    {
      url: 'https://developer.chrome.com/docs/extensions/reference/api/{s}',
      title: 'chrome.{S} | Chrome Extensions',
      lang: 'en',
      subjects: ['windows', 'sessions'],
    },
    {
      url: 'chrome://newtab/',
      title: 'Nuova scheda',
      lang: 'it',
      subjects: ['newtab'],
      reusable: true,
    },
    {
      url: 'https://www.ilpost.it/2026/03/16/{s}/',
      title: '{S} - Il Post',
      lang: 'it',
      subjects: ['Le notizie del lunedi', 'Cosa succede in Portogallo'],
    },
    {
      url: 'https://www.google.com/search?q={q}',
      title: '{S} - Cerca con Google',
      lang: 'it',
      subjects: ['come etichettare dati di test', 'precisione e richiamo spiegate'],
    },
  ],
  situations: [
    {
      id: 'front',
      weight: 0,
      idleH: [0, 0.04],
      activations: [1, 20],
      foregroundS: [30, 3000],
      active: true,
      expected: 'keep',
      rationale: 'The tab the user is looking at right now.',
    },
  ],
};

/**
 * The forgotten windows: a whole window of one finished subject, untouched for weeks
 * (PLAN.md §6.4). Its front tab is still the active tab of that window, which is why it
 * is kept even though it is just as old as the rest.
 */
const FORGOTTEN_TRIP: Template = {
  name: 'forgotten-trip',
  weight: 0,
  pages: [
    {
      url: 'https://www.lonelyplanet.com/portugal/{s}',
      title: '{S} travel guide - Lonely Planet',
      lang: 'en',
      subjects: ['lisbon', 'sintra', 'cascais'],
    },
    {
      url: 'https://www.skyscanner.it/trasporti/voli/mxp/{s}/',
      title: 'Voli Milano {S} - Skyscanner',
      lang: 'it',
      subjects: ['lis', 'opo'],
    },
    {
      url: 'https://www.tripadvisor.it/Restaurants-g189158-{s}.html',
      title: 'I 10 migliori ristoranti a {S} - Tripadvisor',
      lang: 'it',
      subjects: ['Lisbona', 'Alfama', 'Belem'],
    },
    {
      url: 'https://www.getyourguide.it/{s}-l42/',
      title: 'Cose da fare a {S} - GetYourGuide',
      lang: 'it',
      subjects: ['lisbona', 'sintra'],
    },
    {
      url: 'https://www.booking.com/searchresults.it.html?ss={q}&offset={n}',
      title: 'Hotel a {S} - Booking.com',
      lang: 'it',
      subjects: ['Lisbona', 'Porto'],
    },
    {
      url: 'https://www.rome2rio.com/it/s/{s}',
      title: '{S} - 4 modi per viaggiare - Rome2rio',
      lang: 'it',
      subjects: ['Lisbona/Sintra', 'Lisbona/Cascais'],
    },
    {
      url: 'https://www.transtejo.pt/en/{s}/',
      title: '{S} - Transtejo',
      lang: 'en',
      subjects: ['timetables', 'fares'],
    },
    {
      url: 'https://www.airbnb.it/s/{s}/homes',
      title: 'Case vacanza a {S} - Airbnb',
      lang: 'it',
      subjects: ['Lisbona', 'Sintra'],
    },
    {
      url: 'https://www.visitportugal.com/it/node/{n}',
      title: '{S} | VisitPortugal',
      lang: 'it',
      subjects: ['Lisbona', 'Alentejo'],
    },
    {
      url: 'https://www.ilmeteo.it/meteo/{s}',
      title: 'Meteo {S} - iLMeteo.it',
      lang: 'it',
      subjects: ['Lisbona', 'Porto'],
    },
  ],
  situations: [
    {
      id: 'parked',
      weight: 1,
      idleH: [700, 1700],
      ageH: [0.2, 48],
      activations: [1, 3],
      foregroundS: [20, 400],
      expected: 'suggest',
      rationale: 'In a window nobody has opened in weeks: the trip is over.',
    },
    {
      id: 'front',
      weight: 0,
      idleH: [700, 1700],
      ageH: [0.2, 48],
      activations: [1, 3],
      foregroundS: [20, 400],
      active: true,
      expected: 'keep',
      rationale:
        'The front tab of a window nobody has opened in weeks: it is still an active tab, and an active tab is never suggested.',
    },
  ],
};

const FORGOTTEN_HOME: Template = {
  name: 'forgotten-home',
  weight: 0,
  pages: [
    {
      url: 'https://www.ikea.com/it/it/cat/{s}-10382/',
      title: '{S} - IKEA',
      lang: 'it',
      subjects: ['cucine', 'divani', 'illuminazione'],
    },
    {
      url: 'https://www.leroymerlin.it/prodotti/{s}-{n}.html',
      title: '{S} - Leroy Merlin',
      lang: 'it',
      subjects: ['piastrelle-cucina', 'pittura-lavabile'],
    },
    {
      url: 'https://www.houzz.it/foto/{s}-phbr0-bp~',
      title: 'Idee per {S} - Houzz',
      lang: 'it',
      subjects: ['cucine-moderne', 'bagni-piccoli'],
    },
    {
      url: 'https://www.edilportale.com/normativa/{n}/{s}',
      title: '{S} - Edilportale',
      lang: 'it',
      subjects: ['bonus-ristrutturazione', 'detrazione-infissi'],
    },
    {
      url: 'https://www.subito.it/annunci-lombardia/vendita/arredamento/?q={q}',
      title: 'Annunci {S} - Subito.it',
      lang: 'it',
      subjects: ['tavolo allungabile', 'libreria usata'],
    },
    {
      url: 'https://www.pinterest.it/search/pins/?q={q}',
      title: '{S} - Pinterest',
      lang: 'it',
      subjects: ['cucina piccola idee', 'studio in casa'],
    },
    {
      url: 'https://www.archiproducts.com/it/{s}',
      title: '{S} - Archiproducts',
      lang: 'it',
      subjects: ['prodotti/cucine', 'prodotti/sedie'],
    },
    {
      url: 'https://www.homify.it/librerie/{s}',
      title: '{S} - homify',
      lang: 'it',
      subjects: ['idee-cucine', 'idee-soggiorni'],
    },
  ],
  situations: [
    {
      id: 'parked',
      weight: 1,
      idleH: [700, 1700],
      ageH: [0.2, 48],
      activations: [1, 3],
      foregroundS: [20, 400],
      expected: 'suggest',
      rationale: 'In a window nobody has opened in weeks: the decision was taken long ago.',
    },
    {
      id: 'front',
      weight: 0,
      idleH: [700, 1700],
      ageH: [0.2, 48],
      activations: [1, 3],
      foregroundS: [20, 400],
      active: true,
      expected: 'keep',
      rationale:
        'The front tab of a window nobody has opened in weeks: it is still an active tab, and an active tab is never suggested.',
    },
  ],
};

const FILL_TEMPLATES: readonly Template[] = [
  SEARCH,
  AUTH,
  DOCS,
  GITHUB,
  VIDEO,
  NEWS,
  READ_LATER,
  WEBAPP,
  BLANK,
  ERROR,
  INTERNAL,
  FILE_MEDIA,
  BOOTSTRAPPED,
];

const FORGOTTEN_TEMPLATES: readonly Template[] = [FORGOTTEN_TRIP, FORGOTTEN_HOME];

/** The two sides of an exact duplicate: the one that was used, and the forgotten copy. */
const DUPLICATE_KEEPER: Situation = {
  id: 'duplicate-keeper',
  weight: 1,
  idleH: [40, 200],
  ageH: [48, 240],
  activations: [3, 8],
  foregroundS: [200, 1200],
  expected: 'keep',
  rationale: 'Of the identical tabs open, this is the older one, and the one actually used.',
};

const DUPLICATE_COPY: Situation = {
  id: 'duplicate-copy',
  weight: 1,
  idleH: [1, 100],
  ageH: [0.05, 4],
  activations: [1, 1],
  foregroundS: [1, 20],
  expected: 'suggest',
  rationale: 'An exact copy of a tab that is already open: nothing is lost by closing it.',
};

/**
 * Near-duplicates: the same page with a different query, which PLAN.md §6.4 counts as a
 * hint and not as a duplicate. Sometimes the second one is a leftover, sometimes the two
 * filters are both deliberate, so each side is labelled on its own.
 */
const NEAR_USED: Situation = {
  id: 'near-used',
  weight: 1,
  idleH: [20, 120],
  ageH: [24, 200],
  activations: [3, 6],
  foregroundS: [200, 800],
  expected: 'keep',
  rationale: 'The variant of this page the user actually worked with.',
};

const NEAR_SPARE: Situation = {
  id: 'near-spare',
  weight: 1,
  idleH: [2, 60],
  ageH: [0.05, 4],
  activations: [1, 1],
  foregroundS: [4, 40],
  expected: 'suggest',
  rationale: 'A second variant of the same page, opened later and barely looked at.',
};

const NEAR_ALSO_USED: Situation = {
  id: 'near-also-used',
  weight: 1,
  idleH: [10, 80],
  ageH: [24, 200],
  activations: [2, 4],
  foregroundS: [150, 600],
  expected: 'keep',
  rationale: 'A different filter of the same search, kept open on purpose next to the other.',
};

interface NearSide {
  url: string;
  title: string;
  situation: Situation;
}

interface NearPair {
  template: string;
  lang: FixtureLang;
  sides: readonly [NearSide, NearSide];
}

const NEAR_DUPLICATE_PAIRS: readonly NearPair[] = [
  {
    template: 'near-duplicate-shop',
    lang: 'it',
    sides: [
      {
        url: 'https://www.amazon.it/s?k=monitor+27+pollici&rh=p_36%3A1253504031',
        title: 'Amazon.it: monitor 27 pollici',
        situation: NEAR_USED,
      },
      {
        url: 'https://www.amazon.it/s?k=monitor+27+pollici',
        title: 'Amazon.it: monitor 27 pollici',
        situation: NEAR_SPARE,
      },
    ],
  },
  {
    template: 'near-duplicate-issues',
    lang: 'en',
    sides: [
      {
        url: 'https://github.com/wxt-dev/wxt/issues?q=is%3Aopen+firefox+mv3',
        title: 'Issues · wxt-dev/wxt',
        situation: NEAR_USED,
      },
      {
        url: 'https://github.com/wxt-dev/wxt/issues?q=firefox+mv3',
        title: 'Issues · wxt-dev/wxt',
        situation: NEAR_SPARE,
      },
    ],
  },
  {
    template: 'near-duplicate-ads',
    lang: 'it',
    sides: [
      {
        url: 'https://www.subito.it/annunci-lombardia/vendita/usato/?q=bici&so=1',
        title: 'Annunci bici in Lombardia - Subito.it',
        situation: NEAR_USED,
      },
      {
        url: 'https://www.subito.it/annunci-lombardia/vendita/usato/?q=bici',
        title: 'Annunci bici in Lombardia - Subito.it',
        situation: NEAR_SPARE,
      },
    ],
  },
  {
    template: 'near-duplicate-hotels',
    lang: 'it',
    sides: [
      {
        url: 'https://www.booking.com/searchresults.it.html?checkin=2026-04-10&ss=Lisbona',
        title: 'Hotel a Lisbona - Booking.com',
        situation: NEAR_USED,
      },
      {
        url: 'https://www.booking.com/searchresults.it.html?checkin=2026-04-17&ss=Lisbona',
        title: 'Hotel a Lisbona - Booking.com',
        situation: NEAR_ALSO_USED,
      },
    ],
  },
  {
    template: 'near-duplicate-flights',
    lang: 'it',
    sides: [
      {
        url: 'https://www.skyscanner.it/trasporti/voli/mxp/lis/?adults=2&departure=2026-04-10',
        title: 'Voli Milano Lisbona - Skyscanner',
        situation: NEAR_USED,
      },
      {
        url: 'https://www.skyscanner.it/trasporti/voli/mxp/lis/?adults=1&departure=2026-04-10',
        title: 'Voli Milano Lisbona - Skyscanner',
        situation: NEAR_SPARE,
      },
    ],
  },
  {
    template: 'near-duplicate-docs',
    lang: 'en',
    sides: [
      {
        url: 'https://developer.chrome.com/docs/extensions/reference/api/tabs?authuser=0',
        title: 'chrome.tabs | Chrome Extensions',
        situation: NEAR_USED,
      },
      {
        url: 'https://developer.chrome.com/docs/extensions/reference/api/tabs?authuser=1',
        title: 'chrome.tabs | Chrome Extensions',
        situation: NEAR_SPARE,
      },
    ],
  },
  {
    template: 'near-duplicate-trains',
    lang: 'it',
    sides: [
      {
        url: 'https://www.trenitalia.com/it/ricerca?from=Milano&to=Roma&date=2026-03-18',
        title: 'Treni Milano Roma - Trenitalia',
        situation: NEAR_USED,
      },
      {
        url: 'https://www.trenitalia.com/it/ricerca?from=Milano&to=Roma&date=2026-03-19',
        title: 'Treni Milano Roma - Trenitalia',
        situation: NEAR_ALSO_USED,
      },
    ],
  },
  {
    template: 'near-duplicate-maps',
    lang: 'en',
    sides: [
      {
        url: 'https://www.google.com/maps/dir/Lisbon/Sintra?travelmode=transit',
        title: 'Lisbon to Sintra - Google Maps',
        situation: NEAR_USED,
      },
      {
        url: 'https://www.google.com/maps/dir/Lisbon/Sintra?travelmode=driving',
        title: 'Lisbon to Sintra - Google Maps',
        situation: NEAR_SPARE,
      },
    ],
  },
];

const GROUP_TITLES: readonly string[] = [
  'Lavoro',
  'TabDeclutter',
  'Da leggere',
  'Ricette',
  'Viaggio Lisbona',
  'Fatture',
  'Casa',
  'React',
  'Spesa',
  'Formazione',
];

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

export interface FixtureSpec {
  name: string;
  seed: number;
  count: number;
  /** Only `tabs-300` carries the hand-written labels (TASKS.md M1.5). */
  labelled: boolean;
  windows: number;
  /** How many tabs each forgotten window holds. */
  forgotten: readonly number[];
  duplicateClusters: number;
  nearDuplicatePairs: number;
}

export const FIXTURE_SPECS: readonly FixtureSpec[] = [
  {
    name: 'tabs-50',
    seed: 1050,
    count: 50,
    labelled: false,
    windows: 3,
    forgotten: [5],
    duplicateClusters: 2,
    nearDuplicatePairs: 1,
  },
  {
    name: 'tabs-300',
    seed: 1300,
    count: 300,
    labelled: true,
    windows: 6,
    forgotten: [14],
    duplicateClusters: 10,
    nearDuplicatePairs: 6,
  },
  {
    name: 'tabs-1000',
    seed: 11000,
    count: 1000,
    labelled: false,
    windows: 14,
    forgotten: [11, 23],
    duplicateClusters: 34,
    nearDuplicatePairs: 8,
  },
];

/** A tab before it has an id, an index or a group: everything else is already decided. */
interface Draft {
  template: string;
  url: string;
  title: string;
  lang: FixtureLang;
  windowId: number;
  groupable: boolean;
  fromSearch: boolean;
  pinned: boolean;
  audible: boolean;
  discarded: boolean;
  active: boolean;
  createdAt: number;
  lastActiveAt: number;
  activations: number;
  foregroundMs: number;
  bootstrappedAt?: number;
  expected: FixtureLabel;
  rationale: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9/_+-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function fill(pattern: string, subject: string, n: number): string {
  return pattern.replace(/\{(q|s|S|n)\}/g, (_match, key: string) => {
    switch (key) {
      case 'q':
        return encodeURIComponent(subject).replace(/%20/g, '+');
      case 's':
        return slugify(subject);
      case 'S':
        return subject;
      default:
        return String(n);
    }
  });
}

interface Page {
  url: string;
  title: string;
  lang: FixtureLang;
}

/** Tracks which curated (site, subject) pairs a fixture has already spent. */
class PageBook {
  private readonly used = new Set<string>();
  private nextNumber = 1024;

  /** The pairs of a template, in a fixed order, that can still produce a fresh URL. */
  private free(template: Template): { source: PageSource; subject: string }[] {
    const free: { source: PageSource; subject: string }[] = [];
    for (const [i, source] of template.pages.entries()) {
      const unlimited = source.reusable === true || source.url.includes('{n}');
      for (const subject of source.subjects) {
        if (unlimited || !this.used.has(`${template.name}/${i}/${subject}`)) {
          free.push({ source, subject });
        }
      }
    }
    return free;
  }

  hasPage(template: Template): boolean {
    return this.free(template).length > 0;
  }

  take(rng: Rng, template: Template): Page {
    const choices = this.free(template);
    if (choices.length === 0) throw new Error(`${template.name}: out of curated pages`);
    const choice = rng.pick(choices);
    const index = template.pages.indexOf(choice.source);
    this.used.add(`${template.name}/${index}/${choice.subject}`);
    const n = this.nextNumber++;
    return {
      url: fill(choice.source.url, choice.subject, n),
      title: fill(choice.source.title, choice.subject, n),
      lang: choice.source.lang,
    };
  }
}

function draft(
  rng: Rng,
  now: number,
  template: Template,
  page: Page,
  situation: Situation,
  windowId: number,
  idleH: Range = situation.idleH,
): Draft {
  const activations = rng.spanInt(situation.activations);
  const lastActiveAt = now - Math.round(rng.span(idleH) * HOUR_MS);
  // A tab that was activated many times has been around for a while, so unless the
  // situation says otherwise its creation is pushed back with its use.
  const ageH =
    situation.ageH !== undefined
      ? rng.span(situation.ageH)
      : rng.float(2, 24) + activations * rng.float(2, 24);
  return {
    template: template.name,
    url: page.url,
    title: page.title,
    lang: page.lang,
    windowId,
    groupable: template.groupable === true,
    fromSearch: template.fromSearch === true,
    pinned: situation.pinned === true,
    audible: situation.audible === true,
    discarded: situation.discarded === true,
    active: situation.active === true,
    createdAt: lastActiveAt - Math.round(ageH * HOUR_MS),
    lastActiveAt,
    activations,
    foregroundMs: Math.round(rng.span(situation.foregroundS) * 1000),
    bootstrappedAt:
      situation.bootstrappedH === undefined
        ? undefined
        : now - Math.round(rng.span(situation.bootstrappedH) * HOUR_MS),
    expected: situation.expected,
    rationale: situation.rationale,
  };
}

function situationById(template: Template, id: string): Situation {
  const situation = template.situations.find((s) => s.id === id);
  if (situation === undefined) throw new Error(`${template.name}: no situation ${id}`);
  return situation;
}

function favicon(url: string): string | undefined {
  const match = /^https?:\/\/([^/]+)/.exec(url);
  return match === null ? undefined : `https://${match[1]}/favicon.ico`;
}

export function generateFixture(spec: FixtureSpec): TabsFixture {
  const rng = new Rng(spec.seed);
  const book = new PageBook();
  const now = FIXTURE_NOW;

  const forgottenCount = spec.forgotten.length;
  const ordinaryCount = spec.windows - forgottenCount;
  if (ordinaryCount < 1) throw new Error(`${spec.name}: needs at least one ordinary window`);
  const ordinaryIds = Array.from({ length: ordinaryCount }, (_unused, i) => i + 1);
  const windows: FixtureWindow[] = Array.from({ length: spec.windows }, (_unused, i) => ({
    id: i + 1,
    focused: i === 0,
    forgotten: i >= ordinaryCount,
  }));

  const drafts: Draft[] = [];

  // The forgotten windows, each one a single finished subject.
  for (const [i, size] of spec.forgotten.entries()) {
    const windowId = ordinaryCount + i + 1;
    const template = FORGOTTEN_TEMPLATES[i % FORGOTTEN_TEMPLATES.length];
    if (template === undefined) throw new Error('no forgotten template');
    drafts.push(
      draft(
        rng,
        now,
        template,
        book.take(rng, template),
        situationById(template, 'front'),
        windowId,
      ),
    );
    const parked = situationById(template, 'parked');
    for (let k = 1; k < size; k++) {
      drafts.push(draft(rng, now, template, book.take(rng, template), parked, windowId));
    }
  }

  // Exactly one active tab per ordinary window.
  const front = situationById(ACTIVE, 'front');
  for (const windowId of ordinaryIds) {
    drafts.push(draft(rng, now, ACTIVE, book.take(rng, ACTIVE), front, windowId));
  }

  // One pinned tab and one tab playing sound in every fixture, however small: they are
  // the two clearest protections there are (PLAN.md §6.4), so leaving them to chance
  // would let a fixture quietly stop exercising them.
  drafts.push(
    draft(
      rng,
      now,
      WEBAPP,
      book.take(rng, WEBAPP),
      situationById(WEBAPP, 'pinned'),
      rng.pick(ordinaryIds),
    ),
  );
  drafts.push(
    draft(
      rng,
      now,
      VIDEO,
      book.take(rng, VIDEO),
      situationById(VIDEO, 'playing'),
      rng.pick(ordinaryIds),
    ),
  );

  // Exact duplicates: one tab that was used, and one or two copies nobody went back to.
  const duplicable = FILL_TEMPLATES.filter((t) => t.duplicable === true);
  for (let i = 0; i < spec.duplicateClusters; i++) {
    const template = rng.pick(duplicable.filter((t) => book.hasPage(t)));
    const page = book.take(rng, template);
    const keeperIdleH = rng.span(DUPLICATE_KEEPER.idleH);
    const keeperWindow = rng.pick(ordinaryIds);
    drafts.push(
      draft(rng, now, template, page, DUPLICATE_KEEPER, keeperWindow, [keeperIdleH, keeperIdleH]),
    );
    const copies = rng.chance(0.25) ? 2 : 1;
    for (let k = 0; k < copies; k++) {
      // The copy is always the younger tab, so which one survives is never a toss-up.
      const copyIdleH = rng.float(DUPLICATE_COPY.idleH[0], keeperIdleH / 2);
      const windowId = rng.chance(0.5) ? keeperWindow : rng.pick(ordinaryIds);
      drafts.push(
        draft(rng, now, template, page, DUPLICATE_COPY, windowId, [copyIdleH, copyIdleH]),
      );
    }
  }

  // Near-duplicates: the same page with a different query.
  for (let i = 0; i < spec.nearDuplicatePairs; i++) {
    const pair = NEAR_DUPLICATE_PAIRS[i % NEAR_DUPLICATE_PAIRS.length];
    if (pair === undefined) throw new Error('no near-duplicate pair');
    const windowId = rng.pick(ordinaryIds);
    const template: Template = {
      name: pair.template,
      weight: 0,
      groupable: true,
      pages: [],
      situations: [],
    };
    for (const side of pair.sides) {
      const page: Page = { url: side.url, title: side.title, lang: pair.lang };
      drafts.push(draft(rng, now, template, page, side.situation, windowId));
    }
  }

  // Everything else, drawn from the curated templates by weight.
  const remaining = spec.count - drafts.length;
  if (remaining < 0) throw new Error(`${spec.name}: ${-remaining} tabs over the count`);
  for (let i = 0; i < remaining; i++) {
    const available = FILL_TEMPLATES.filter((t) => book.hasPage(t));
    if (available.length === 0) throw new Error(`${spec.name}: out of curated pages`);
    const template = rng.weighted(available);
    const situation = rng.weighted(template.situations.filter((s) => s.weight > 0));
    drafts.push(
      draft(rng, now, template, book.take(rng, template), situation, rng.pick(ordinaryIds)),
    );
  }

  // Order each window the way a browser does: pinned tabs first, then the rest.
  const ordered: Draft[] = [];
  for (const window of windows) {
    const mine = drafts.filter((d) => d.windowId === window.id);
    ordered.push(...mine.filter((d) => d.pinned), ...mine.filter((d) => !d.pinned));
  }

  // Tab groups: a run of neighbouring tabs a user would have collected together.
  const groups: FixtureGroup[] = [];
  const groupOf = new Map<Draft, number>();
  const maxGroups = Math.max(1, Math.round(spec.count / 60));
  for (const window of windows) {
    const mine = ordered.filter((d) => d.windowId === window.id);
    let at = 0;
    while (at < mine.length && groups.length < maxGroups) {
      const start = mine.findIndex((d, i) => i >= at && d.groupable && !d.pinned);
      if (start === -1) break;
      let end = start;
      while (end + 1 < mine.length && mine[end + 1]?.groupable === true) end++;
      const length = Math.min(end - start + 1, rng.int(2, 6));
      if (length >= 2 && rng.chance(0.8)) {
        const id = 11 + groups.length;
        groups.push({
          id,
          windowId: window.id,
          title: GROUP_TITLES[groups.length % GROUP_TITLES.length] ?? 'Lavoro',
          color: GROUP_COLORS[groups.length % GROUP_COLORS.length] ?? 'grey',
        });
        for (let k = 0; k < length; k++) {
          const member = mine[start + k];
          if (member !== undefined) groupOf.set(member, id);
        }
      }
      at = start + Math.max(length, 1);
    }
  }

  // Ids and indices, then the opener: a tab reached from a search result keeps the
  // search as its opener, which is what the browser reports.
  const tabs: FixtureTab[] = [];
  const idOf = new Map<Draft, number>();
  let nextId = 101;
  for (const window of windows) {
    const mine = ordered.filter((d) => d.windowId === window.id);
    let lastSearch: number | undefined;
    for (const [index, item] of mine.entries()) {
      const id = nextId++;
      idOf.set(item, id);
      const opener =
        item.fromSearch && lastSearch !== undefined && rng.chance(0.6) ? lastSearch : undefined;
      if (item.template === 'search') lastSearch = id;

      const tab: TabInfo = {
        id,
        windowId: window.id,
        index,
        url: item.url,
        title: item.title,
        pinned: item.pinned,
        audible: item.audible,
        active: item.active,
        discarded: item.discarded,
        hidden: false,
        groupId: groupOf.get(item) ?? UNGROUPED,
        incognito: false,
      };
      const favIconUrl = favicon(item.url);
      if (favIconUrl !== undefined) tab.favIconUrl = favIconUrl;
      if (opener !== undefined) tab.openerTabId = opener;
      // PLAN.md §6.1: the browser forgets `lastAccessed` when it discards a tab.
      if (!item.discarded) tab.lastAccessed = item.lastActiveAt;

      const activity: TabActivity = {
        tabId: id,
        url: item.url,
        createdAt: item.createdAt,
        lastActiveAt: item.lastActiveAt,
        activations: item.activations,
        foregroundMs: item.foregroundMs,
      };
      if (item.bootstrappedAt !== undefined) activity.bootstrappedAt = item.bootstrappedAt;

      const entry: FixtureTab = { tab, activity, template: item.template, lang: item.lang };
      if (spec.labelled) {
        entry.expected = item.expected;
        entry.rationale = item.rationale;
      }
      tabs.push(entry);
    }
  }

  return {
    name: spec.name,
    seed: spec.seed,
    now,
    staleDays: FIXTURE_STALE_DAYS,
    labelled: spec.labelled,
    windows,
    groups,
    tabs,
  };
}

export function serializeFixture(fixture: TabsFixture): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

export const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'tests',
  'fixtures',
);

export function fixturePath(name: string): string {
  return join(FIXTURES_DIR, `${name}.json`);
}

function main(): void {
  for (const spec of FIXTURE_SPECS) {
    const fixture = generateFixture(spec);
    writeFileSync(fixturePath(spec.name), serializeFixture(fixture), 'utf8');
    const suggest = fixture.tabs.filter((t) => t.expected === 'suggest').length;
    const keep = fixture.tabs.filter((t) => t.expected === 'keep').length;
    const labels = fixture.labelled ? ` (${suggest} suggest, ${keep} keep)` : '';
    process.stdout.write(
      `${spec.name}: ${fixture.tabs.length} tabs, ${fixture.windows.length} windows, ` +
        `${fixture.groups.length} groups${labels}\n`,
    );
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main();
}
