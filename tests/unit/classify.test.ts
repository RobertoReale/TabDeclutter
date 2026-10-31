import { describe, expect, it } from 'vitest';

import {
  canonicalUrl,
  classify,
  isAuthUrl,
  isBlankUrl,
  isOwnPage,
  looksLikeErrorTitle,
} from '../../src/core/classify';
import type { PageType } from '../../src/core/classify';

/**
 * A page to classify. `is` is the class it really belongs to, and is only set on the
 * **false friends**: a page listed under `search` that is not a search, a title that
 * contains a number but is not an error. They live next to the rule they could break,
 * which is where someone extending that rule will look.
 */
interface Case {
  readonly url: string;
  readonly title?: string;
  readonly is?: PageType;
}

/**
 * One table per class (PLAN.md §6.3). Table-driven because the classification *is* a
 * table: this is where a reviewer sees the whole contract at once, and where the next
 * search engine or the next Italian error title is added.
 */
const CLASSES: ReadonlyArray<readonly [PageType, readonly Case[]]> = [
  [
    'blank',
    [
      { url: 'about:blank' },
      { url: 'about:blank#blocked' },
      { url: 'about:newtab' },
      { url: 'about:home' },
      { url: 'chrome://newtab/' },
      { url: 'chrome://new-tab-page/' },
      { url: 'edge://newtab' },
      { url: 'brave://newtab' },
      // A tab the browser has not told us anything about yet.
      { url: '' },
      { url: '   ' },
      // The label of a new tab page is never evidence of anything else.
      { url: 'chrome://newtab/', title: '404 Not Found' },
    ],
  ],
  [
    'browser-internal',
    [
      { url: 'chrome://settings/' },
      { url: 'chrome://downloads' },
      { url: 'chrome://extensions/?id=abc' },
      { url: 'chrome://history/' },
      { url: 'edge://settings/privacy' },
      { url: 'about:addons' },
      { url: 'about:config' },
      { url: 'about:preferences#general' },
      { url: 'moz-extension://11111111-2222-3333-4444-555555555555/options.html' },
      { url: 'devtools://devtools/bundled/inspector.html' },
      // Another extension's page. Only our own pages are excluded from this class.
      { url: 'chrome-extension://nonsenseextensionidnonsenseextid/popup.html' },
      // A browser's error wording does not change what the page is.
      { url: 'chrome://settings/', title: 'Impossibile raggiungere il sito' },
      // False friends: web pages that merely talk about the browser.
      { url: 'https://about.gitlab.com/company/', is: 'content' },
      { url: 'https://chrome.google.com/webstore/category/extensions', is: 'content' },
      { url: 'https://support.mozilla.org/kb/about-config-editor', is: 'content' },
    ],
  ],
  [
    'file',
    [
      { url: 'file:///C:/Users/roberto/Downloads/fattura.pdf' },
      { url: 'file:///home/roberto/notes.txt' },
      // A local image is a local file first: the class the spec gives it (PLAN.md §6.3).
      { url: 'file:///C:/Users/roberto/Pictures/photo.png' },
      { url: 'FILE:///C:/Users/roberto/report.pdf' },
      { url: 'file:///D:/archive/' },
      { url: 'file://' },
      // False friends: "file" inside a web URL.
      { url: 'https://example.com/file/123', is: 'content' },
      { url: 'https://filezilla-project.org/', is: 'content' },
    ],
  ],
  [
    'media',
    [
      { url: 'https://example.com/img/photo.PNG' },
      { url: 'https://example.com/a/b/diagram.svg' },
      { url: 'https://cdn.example.com/papers/paper.pdf?download=1' },
      { url: 'https://example.com/clips/video.mp4' },
      { url: 'https://example.com/audio/song.mp3' },
      { url: 'https://example.com/scans/scan.tiff' },
      // False friends: the extension is in the query, in the host, in the middle of the
      // path, or it is a dotfile's name and not an extension at all.
      { url: 'https://example.com/articles/png-vs-jpeg', is: 'content' },
      { url: 'https://example.com/gallery?img=photo.png', is: 'content' },
      { url: 'https://example.com/download.pdf.html', is: 'content' },
      { url: 'https://www.pdf.com/', is: 'content' },
      { url: 'https://example.com/.htaccess', is: 'content' },
    ],
  ],
  [
    'search',
    [
      { url: 'https://www.google.com/search?q=rust+traits' },
      { url: 'https://www.google.co.uk/search?q=trains' },
      { url: 'https://www.google.de/search?q=zug' },
      { url: 'https://duckduckgo.com/?q=privacy' },
      { url: 'https://www.bing.com/search?q=weather' },
      { url: 'https://search.brave.com/search?q=weather' },
      { url: 'https://www.ecosia.org/search?q=trees' },
      { url: 'https://search.yahoo.com/search?p=news' },
      { url: 'https://yandex.com/search/?text=news' },
      { url: 'https://kagi.com/search?q=lenses' },
      { url: 'https://www.startpage.com/sp/search?query=maps' },
      { url: 'https://www.qwant.com/?q=paris' },
      // The internal searches of known sites (PLAN.md §6.3).
      { url: 'https://www.youtube.com/results?search_query=lofi' },
      { url: 'https://www.amazon.it/s?k=cavo+usb+c' },
      { url: 'https://github.com/search?q=preact' },
      // False friends. A repository called `searchkit` is not a search, a product page
      // under `/sport` is not Amazon's `/s`, an engine's home page is not a result list,
      // and `/maps?q=` is a map the user is reading.
      { url: 'https://github.com/searchkit/searchkit', is: 'content' },
      { url: 'https://www.amazon.it/sport/dp/B0123456', is: 'content' },
      { url: 'https://duckduckgo.com/', is: 'content' },
      { url: 'https://www.google.com/maps?q=roma', is: 'content' },
      { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', is: 'content' },
      { url: 'https://news.yahoo.com/article?p=2', is: 'content' },
      // Not a known engine: the spec classifies the result lists we can recognise, and
      // guessing from a `/search` path alone would catch documentation and forums.
      { url: 'https://example.com/search?q=anything', is: 'content' },
      { url: 'http://127.0.0.1:8080/search?q=local', is: 'content' },
    ],
  ],
  [
    'auth',
    [
      { url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=1' },
      { url: 'https://login.microsoftonline.com/common/oauth2/authorize' },
      { url: 'https://appleid.apple.com/' },
      { url: 'https://github.com/login?return_to=%2Fdashboard' },
      { url: 'https://gitlab.com/users/sign_in' },
      { url: 'https://example.com/auth/callback?code=abc' },
      { url: 'https://example.com/account/logout' },
      { url: 'https://example.com/sso/start?rp=1' },
      { url: 'https://example.com/Login.php' },
      { url: 'https://example.com/oauth2/authorize?client_id=2' },
      // False friends: the token is part of a longer word, so the page is not a flow
      // the user is in the middle of.
      { url: 'https://blog.example.com/posts/blogin-review', is: 'content' },
      { url: 'https://example.com/authors/jane-doe', is: 'content' },
      { url: 'https://example.com/plugins/autologin', is: 'content' },
      { url: 'https://example.com/callbacks-in-javascript', is: 'content' },
      { url: 'https://en.wikipedia.org/wiki/Single_sign-on', is: 'content' },
      // The auth rules read the host and the path, never the query, so searching *for*
      // the word stays a search.
      { url: 'https://www.google.com/search?q=login+google', is: 'search' },
    ],
  ],
  [
    'error',
    [
      { url: 'https://example.com/missing', title: '404 Not Found' },
      { url: 'https://example.com/missing', title: '404 - Pagina non trovata | Esempio' },
      { url: 'https://example.com/x', title: "This site can't be reached" },
      { url: 'https://example.com/x', title: 'Impossibile raggiungere il sito' },
      { url: 'https://example.com/x', title: 'Access denied' },
      { url: 'https://example.com/x', title: 'Accesso negato' },
      { url: 'https://example.com/x', title: '503 Service Unavailable' },
      { url: 'https://example.com/x', title: 'Errore del server' },
      { url: 'https://example.com/x', title: 'Problema nel caricamento della pagina' },
      { url: 'https://example.com/x', title: 'Server not found' },
      { url: 'https://example.com/x', title: 'Error 500 — Internal Server Error' },
      { url: 'https://example.com/x', title: 'Nessuna connessione a Internet' },
      // False friends: a number or the word "error" inside an ordinary title. A status
      // code only counts at the start of the title.
      {
        url: 'https://example.com/x',
        title: 'Peugeot 404: la storia di una berlina',
        is: 'content',
      },
      { url: 'https://example.com/x', title: 'Error handling in Rust', is: 'content' },
      { url: 'https://example.com/x', title: 'Forbidden City: a guide', is: 'content' },
      { url: 'https://example.com/x', title: 'Room 403 booking', is: 'content' },
      { url: 'https://example.com/x', title: 'Come risolvere un errore di stampa', is: 'content' },
      // The URL wins over the title: `error` rests on a pattern over a string the page
      // chose, and PLAN.md §6.3 makes it low confidence for exactly this reason.
      { url: 'https://www.google.com/search?q=x', title: '404 Not Found', is: 'search' },
    ],
  ],
  [
    'content',
    [
      { url: 'https://example.com/' },
      { url: 'https://en.wikipedia.org/wiki/Rust_(programming_language)' },
      { url: 'https://news.ycombinator.com/item?id=1', title: 'A thread' },
      { url: 'https://example.com/blog/2026/01/post', title: 'A post' },
      { url: 'http://localhost:3000/app' },
      { url: 'data:text/html,<p>hi</p>' },
      { url: 'javascript:void(0)' },
      { url: 'mailto:someone@example.com' },
      // Not a URL at all: there is nothing to read, and a class we cannot justify would
      // only mislead the score.
      { url: 'not a url' },
      { url: 'example.com/a' },
    ],
  ],
];

/** Every case above with the class it must come out as. */
const CASES = CLASSES.flatMap(([expected, cases]) =>
  cases.map((c) => ({ ...c, expected: c.is ?? expected })),
);

describe('classify', () => {
  it.each(CASES)('$expected ← $url $title', ({ url, title, expected }) => {
    expect(classify({ url, title })).toBe(expected);
  });

  it('has at least five pages of its own in every class', () => {
    for (const [name, cases] of CLASSES) {
      expect(cases.filter((c) => c.is === undefined).length, name).toBeGreaterThanOrEqual(5);
    }
  });

  it('names at least one false friend per class that has rules to fool', () => {
    for (const [name, cases] of CLASSES) {
      // `blank` and `content` are lists of exact URLs and the default: there is no rule
      // to mislead. Every other class matches a pattern, and so can be fooled.
      if (name === 'blank' || name === 'content') continue;
      expect(
        cases.some((c) => c.is !== undefined),
        name,
      ).toBe(true);
    }
  });

  it('reads nothing but the URL when there is no title', () => {
    // The tracker has no title for a tab it has only just seen, and a missing title
    // must not be read as an empty one.
    expect(classify({ url: 'https://example.com/x' })).toBe('content');
    expect(classify({ url: 'https://example.com/x', title: '' })).toBe('content');
  });

  it('trims the URL before looking at it', () => {
    expect(classify({ url: '  https://www.google.com/search?q=x  ' })).toBe('search');
  });
});

/**
 * The extension's own pages (PLAN.md §6.3, §6.4). The origin is injected, because
 * `src/core/` may not ask the browser for it (TASKS.md §2.4).
 */
describe('classify: the extension’s own pages', () => {
  const chrome = { ownOrigin: 'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/' };
  const firefox = { ownOrigin: 'moz-extension://11111111-2222-3333-4444-555555555555/' };

  const ownPage = 'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/sidepanel.html';

  const OWN: readonly string[] = [
    ownPage,
    'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/sidepanel.html?view=archive',
    'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/sidepanel.html#/archive',
    'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/',
    'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh',
    'CHROME-EXTENSION://AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH/sidepanel.html',
  ];

  it.each(OWN)('%j is own', (url) => {
    expect(classify({ url }, chrome)).toBe('own');
  });

  it('works the same on Firefox, where the origin is a uuid', () => {
    const url = 'moz-extension://11111111-2222-3333-4444-555555555555/sidepanel.html';
    expect(classify({ url }, firefox)).toBe('own');
  });

  it('is browser-internal when the origin was not injected', () => {
    expect(classify({ url: ownPage })).toBe('browser-internal');
  });

  it('does not lend the class to another extension', () => {
    const url = 'chrome-extension://zzzzyyyyxxxxwwwwvvvvuuuuttttssss/x.html';
    expect(classify({ url }, chrome)).toBe('browser-internal');
  });

  // The origin is compared as a whole path prefix, so an extension whose id merely
  // starts like ours cannot borrow the protection the class carries.
  it('does not match an id that only starts the same way', () => {
    const url = 'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhhiiii/x.html';
    expect(classify({ url }, chrome)).toBe('browser-internal');
  });

  it('is not confused by the other browser’s extension scheme', () => {
    expect(classify({ url: ownPage }, firefox)).toBe('browser-internal');
  });
});

describe('isBlankUrl', () => {
  it('is true for the new tab page of either browser', () => {
    expect(isBlankUrl('about:newtab')).toBe(true);
    expect(isBlankUrl('chrome://newtab/')).toBe(true);
  });

  it('is true for a URL we do not have', () => {
    expect(isBlankUrl('')).toBe(true);
  });

  it('is false for a real page', () => {
    expect(isBlankUrl('https://example.com/')).toBe(false);
    expect(isBlankUrl('about:addons')).toBe(false);
  });
});

describe('isAuthUrl', () => {
  it('reads the host and the path, never the query', () => {
    expect(isAuthUrl('https://accounts.google.com/')).toBe(true);
    expect(isAuthUrl('https://example.com/users/sign_in')).toBe(true);
    expect(isAuthUrl('https://example.com/articles?topic=login')).toBe(false);
  });

  it('is false, and does not throw, on a string that is not a URL', () => {
    expect(isAuthUrl('not a url')).toBe(false);
  });
});

describe('isOwnPage', () => {
  const url = 'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/sidepanel.html';

  it('is false when no origin is known', () => {
    expect(isOwnPage(url)).toBe(false);
    expect(isOwnPage(url, '')).toBe(false);
    expect(isOwnPage(url, '   ')).toBe(false);
  });

  it('accepts the origin with or without its trailing slash', () => {
    expect(isOwnPage(url, 'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/')).toBe(true);
    expect(isOwnPage(url, 'chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh')).toBe(true);
  });
});

describe('looksLikeErrorTitle', () => {
  it('matches the Italian and the English wording of the same failure', () => {
    expect(looksLikeErrorTitle('Pagina non trovata')).toBe(true);
    expect(looksLikeErrorTitle('Page not found')).toBe(true);
    expect(looksLikeErrorTitle('Sito non raggiungibile')).toBe(true);
    expect(looksLikeErrorTitle('Unable to connect')).toBe(true);
    expect(looksLikeErrorTitle('Impossibile connettersi')).toBe(true);
    expect(looksLikeErrorTitle('Connection refused')).toBe(true);
    expect(looksLikeErrorTitle('Errore di connessione')).toBe(true);
    expect(looksLikeErrorTitle('Gateway Time-out')).toBe(true);
    expect(looksLikeErrorTitle('Servizio non disponibile')).toBe(true);
    expect(looksLikeErrorTitle('No internet')).toBe(true);
    expect(looksLikeErrorTitle('Problem loading page')).toBe(true);
    expect(looksLikeErrorTitle('404 error')).toBe(true);
    expect(looksLikeErrorTitle('This site cannot be reached')).toBe(true);
  });

  it('leaves an ordinary title alone', () => {
    expect(looksLikeErrorTitle('Esempio — Home')).toBe(false);
    expect(looksLikeErrorTitle('')).toBe(false);
  });
});

describe('canonicalUrl', () => {
  it('drops the query, the fragment and the trailing slashes', () => {
    expect(canonicalUrl('HTTPS://Example.com/a/b/?x=1#top')).toBe('https://example.com/a/b');
    expect(canonicalUrl('https://example.com/')).toBe('https://example.com');
    expect(canonicalUrl('  about:blank  ')).toBe('about:blank');
  });

  it('keeps a single character as it is', () => {
    expect(canonicalUrl('/')).toBe('/');
  });
});
