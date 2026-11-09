/**
 * `resolveDuplicate`, case by case (PLAN.md §8.4, §8.6, §8.3).
 *
 * The table in §8.4 is a decision with a lot of ways to say "do nothing" and one way to
 * say "close this tab", and the thing that must never happen is a close the user did not
 * ask for (PLAN.md §3.1, TASKS.md §2.2). So the exit filters come first and one at a time:
 * each test turns on exactly the condition it is about, against a pair of tabs that would
 * otherwise certainly resolve, and checks that the answer is `null` — and, where the
 * condition can be switched off or can expire, that the same pair then does resolve. A
 * filter that returned `null` for the wrong reason would pass the first half of that and
 * fail the second.
 *
 * Then the priority rules of §8.4.3, each on its own and then stacked in the order the
 * plan gives them, the scopes, and the action that follows the close.
 */

import { describe, expect, it } from 'vitest';

import type { GuardContext } from '../../src/core/duplicate-guard';
import { resolveAllDuplicates, resolveDuplicate } from '../../src/core/duplicate-guard';
import { compile } from '../../src/core/patterns';
import type { GuardSettings, TabInfo } from '../../src/core/types';
import { DEFAULT_GUARD_SETTINGS, DEFAULT_MATCH_OPTIONS, NO_GROUP_ID } from '../../src/core/types';

const NOW = 1_700_000_000_000;
const PAGE = 'https://example.com/article';

/** A tab that is nothing in particular, so a test only states what it is testing. */
function tab(id: number, overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id,
    windowId: 1,
    index: id,
    url: PAGE,
    title: 'Article',
    pinned: false,
    audible: false,
    active: false,
    discarded: false,
    hidden: false,
    groupId: NO_GROUP_ID,
    incognito: false,
    ...overrides,
  };
}

/**
 * The context of a guard that is on and has nothing to excuse: automatic mode, no pause,
 * no grace period, no exemptions, nothing whitelisted. `createdAt` is given for the two
 * tabs every test uses, oldest first, so the age rule has something to say and the
 * tab-id tie-break is not what quietly decides these cases.
 */
function ctxOf(
  settings: Partial<GuardSettings> = {},
  rest: Partial<GuardContext> = {},
): GuardContext {
  return {
    settings: { ...DEFAULT_GUARD_SETTINGS, mode: 'auto', ...settings },
    match: DEFAULT_MATCH_OPTIONS,
    now: NOW,
    createdAt: { 1: NOW - 60_000, 2: NOW - 1_000 },
    ...rest,
  };
}

/**
 * The old tab, and the new one that has just appeared showing the same page.
 *
 * `NEW` is in the foreground, which is the ordinary case — Ctrl+T then typing, or a link
 * opened with a plain click. A tab opened in the *background* is the exception of §8.4.4
 * and arrives with `active: false`, so the tests about it say so.
 */
const OLD = tab(1, { index: 0 });
const NEW = tab(2, { index: 1, active: true });

describe('the exit filters of a duplicate close (PLAN.md §8.4.1, §8.6)', () => {
  it('closes nothing unless the mode is "Chiudi automaticamente"', () => {
    for (const mode of ['off', 'warn'] as const) {
      expect(resolveDuplicate(NEW, [OLD], ctxOf({ mode })), mode).toBeNull();
    }
    // The same pair, with the one mode that may act, to show the pair itself resolves.
    expect(resolveDuplicate(NEW, [OLD], ctxOf())).toEqual({
      closeTabId: 2,
      keepTabId: 1,
      after: 'activate',
    });
  });

  it('closes nothing while the guard is paused, and resumes when the pause expires', () => {
    const paused = ctxOf({}, { pausedUntil: NOW + 1 });
    expect(resolveDuplicate(NEW, [OLD], paused)).toBeNull();

    // `pausedUntil === now` is over: the alarm that ends a pause fires on that edge.
    const expired = ctxOf({}, { pausedUntil: NOW });
    expect(resolveDuplicate(NEW, [OLD], expired)?.closeTabId).toBe(2);
  });

  it('closes nothing during the start-up grace period, where duplicates are session restore', () => {
    const restoring = ctxOf({}, { autoClosesAllowedFrom: NOW + 1 });
    expect(resolveDuplicate(NEW, [OLD], restoring)).toBeNull();

    const settled = ctxOf({}, { autoClosesAllowedFrom: NOW });
    expect(resolveDuplicate(NEW, [OLD], settled)?.closeTabId).toBe(2);
  });

  it('never touches an incognito tab', () => {
    const trigger = tab(2, { incognito: true });
    expect(resolveDuplicate(trigger, [OLD], ctxOf())).toBeNull();
  });

  it('never touches a hidden tab, which is not on screen to have been duplicated', () => {
    expect(resolveDuplicate(tab(2, { hidden: true }), [OLD], ctxOf())).toBeNull();
  });

  it('has nothing to compare when the trigger has no URL yet', () => {
    const loading = tab(2, { url: '' });
    expect(resolveDuplicate(loading, [OLD], ctxOf())).toBeNull();

    // Chrome's `pendingUrl` is the URL of a tab that has not loaded yet, and is enough.
    const pending = tab(2, { url: '', pendingUrl: PAGE });
    expect(resolveDuplicate(pending, [OLD], ctxOf())?.closeTabId).toBe(2);
  });

  it('leaves a whitelisted URL alone, and keeps working for the URLs around it', () => {
    const whitelist = compile(['https://example.com/*']);
    const ctx = ctxOf({}, { isWhitelisted: whitelist.match });
    expect(resolveDuplicate(NEW, [OLD], ctx)).toBeNull();

    const elsewhere = { url: 'https://other.test/page' };
    expect(
      resolveDuplicate(tab(2, elsewhere), [tab(1, { ...elsewhere, index: 0 })], ctx)?.closeTabId,
    ).toBe(2);
  });

  it('ignores a line of the whitelist that is not a valid regular expression', () => {
    // An unclosed group: `compile` reports it and drops it, and the guard never sees a
    // throw. The line after it still protects its URL (PLAN.md §8.3, "never a crash").
    const whitelist = compile(['/(unclosed/', 'https://example.com/*']);
    expect(whitelist.errors).toHaveLength(1);
    expect(whitelist.errors[0]?.code).toBe('invalid-regex');

    const ctx = ctxOf({}, { isWhitelisted: whitelist.match });
    expect(resolveDuplicate(NEW, [OLD], ctx)).toBeNull();
  });

  it('matches a whitelist written as a regular expression', () => {
    const whitelist = compile(['/example\\.com\\/art/i']);
    expect(resolveDuplicate(NEW, [OLD], ctxOf({}, { isWhitelisted: whitelist.match }))).toBeNull();
  });

  it('leaves empty tabs alone while "Ignora schede vuote" is on', () => {
    const blank = { url: 'about:blank' };
    const pair: [TabInfo, TabInfo[]] = [tab(2, blank), [tab(1, { ...blank, index: 0 })]];
    expect(resolveDuplicate(...pair, ctxOf({ ignoreEmptyTabs: true }))).toBeNull();
    // Unticked, `about:blank` is a page like any other — the one blank URL that option
    // governs, and only once the user has taken it out of the whitelist as well.
    expect(resolveDuplicate(...pair, ctxOf({ ignoreEmptyTabs: false }))?.closeTabId).toBe(2);
  });

  it('leaves a new tab page alone even with "Ignora schede vuote" off (§8.3)', () => {
    for (const url of ['chrome://newtab', 'about:newtab', 'edge://new-tab-page']) {
      const trigger = tab(2, { url });
      const existing = [tab(1, { url, index: 0 })];
      expect(
        resolveDuplicate(trigger, existing, ctxOf({ ignoreEmptyTabs: false })),
        url,
      ).toBeNull();
    }
  });

  it('leaves a login page alone while "Ignora pagine di login" is on', () => {
    const auth = { url: 'https://example.com/login' };
    const pair: [TabInfo, TabInfo[]] = [tab(2, auth), [tab(1, { ...auth, index: 0 })]];
    expect(resolveDuplicate(...pair, ctxOf({ ignoreAuthPages: true }))).toBeNull();
    expect(resolveDuplicate(...pair, ctxOf({ ignoreAuthPages: false }))?.closeTabId).toBe(2);
  });

  it('never closes a page of the browser, whatever the settings say', () => {
    const internal = { url: 'chrome://settings/privacy' };
    const ctx = ctxOf({ ignoreEmptyTabs: false, ignoreAuthPages: false });
    expect(resolveDuplicate(tab(2, internal), [tab(1, { ...internal, index: 0 })], ctx)).toBeNull();
  });

  it('never closes one of its own pages', () => {
    const own = { url: 'chrome-extension://tabdeclutter/sidepanel.html' };
    const ctx = ctxOf({}, { ownOrigin: 'chrome-extension://tabdeclutter' });
    expect(resolveDuplicate(tab(2, own), [tab(1, { ...own, index: 0 })], ctx)).toBeNull();
  });

  it('ignores a tab the extension itself opened, by id, until the exemption expires', () => {
    const byId = ctxOf({}, { exemptions: [{ tabId: 2, until: NOW + 1 }] });
    expect(resolveDuplicate(NEW, [OLD], byId)).toBeNull();

    const stale = ctxOf({}, { exemptions: [{ tabId: 2, until: NOW }] });
    expect(resolveDuplicate(NEW, [OLD], stale)?.closeTabId).toBe(2);
  });

  it('ignores a tab the extension itself opened, by URL', () => {
    const byUrl = ctxOf({}, { exemptions: [{ url: PAGE, until: NOW + 1 }] });
    expect(resolveDuplicate(NEW, [OLD], byUrl)).toBeNull();

    const otherUrl = ctxOf({}, { exemptions: [{ url: 'https://other.test/', until: NOW + 1 }] });
    expect(resolveDuplicate(NEW, [OLD], otherUrl)?.closeTabId).toBe(2);
  });

  it('reads an exemption that names neither a tab nor a URL as matching nothing', () => {
    const empty = ctxOf({}, { exemptions: [{ until: NOW + 1 }] });
    expect(resolveDuplicate(NEW, [OLD], empty)?.closeTabId).toBe(2);
  });

  it('will not close an exempt tab, nor use it as a reason to close another', () => {
    // The old tab is the one the extension restored. Closing the new one "because the old
    // one exists" would undo an Annulla just as surely as closing the old one.
    const ctx = ctxOf({}, { exemptions: [{ tabId: 1, until: NOW + 1 }] });
    expect(resolveDuplicate(NEW, [OLD], ctx)).toBeNull();
  });

  it('does nothing when no other tab is showing that page', () => {
    const different = tab(1, { url: 'https://example.com/other', index: 0 });
    expect(resolveDuplicate(NEW, [different], ctxOf())).toBeNull();
    expect(resolveDuplicate(NEW, [], ctxOf())).toBeNull();
  });

  it('does not count the trigger itself as its own duplicate', () => {
    expect(resolveDuplicate(NEW, [NEW], ctxOf())).toBeNull();
  });

  it('ignores a hidden, an incognito or a whitelisted candidate', () => {
    const whitelist = compile(['https://example.com/article']);
    expect(resolveDuplicate(NEW, [tab(1, { hidden: true })], ctxOf())).toBeNull();
    expect(resolveDuplicate(NEW, [tab(1, { incognito: true })], ctxOf())).toBeNull();
    expect(
      resolveDuplicate(NEW, [tab(1, { url: 'http://example.com/article' })], {
        ...ctxOf(),
        isWhitelisted: whitelist.match,
      }),
    ).toBeNull();
  });

  it('ignores a candidate that has no URL of its own yet', () => {
    expect(resolveDuplicate(NEW, [tab(1, { url: '' })], ctxOf())).toBeNull();
  });

  it('treats the same URL in two Firefox containers as two pages', () => {
    const trigger = tab(2, { cookieStoreId: 'firefox-container-1' });
    const other = tab(1, { cookieStoreId: 'firefox-container-2', index: 0 });
    expect(resolveDuplicate(trigger, [other], ctxOf({ containersAreSeparate: true }))).toBeNull();
    // Unticked, the container is not part of the page's identity any more.
    expect(
      resolveDuplicate(trigger, [other], ctxOf({ containersAreSeparate: false }))?.closeTabId,
    ).toBe(2);
  });
});

describe('Chrome\'s own "Duplica scheda" (PLAN.md §8.6)', () => {
  /** The heuristic's own case: created from its opener, just after it, URL already set. */
  const DUPLICATED = tab(2, { index: 1, url: PAGE, openerTabId: 1 });

  it('is left alone while the option allows intentional duplicates', () => {
    expect(resolveDuplicate(DUPLICATED, [OLD], ctxOf())).toBeNull();
  });

  it('is closed like any other duplicate once the option is off', () => {
    const ctx = ctxOf({ allowIntentionalDuplicates: false });
    expect(resolveDuplicate(DUPLICATED, [OLD], ctx)?.closeTabId).toBe(2);
  });

  it('is not recognized when the new tab is not next to its opener', () => {
    const elsewhere = tab(2, { index: 4, url: PAGE, openerTabId: 1 });
    expect(resolveDuplicate(elsewhere, [OLD], ctxOf())?.closeTabId).toBe(2);
  });

  it('is not recognized when the opener is not showing that page', () => {
    const other = tab(3, { url: 'https://example.com/other', index: 0 });
    const fromOther = tab(2, { index: 1, url: PAGE, openerTabId: 3 });
    expect(resolveDuplicate(fromOther, [OLD, other], ctxOf())?.closeTabId).toBe(2);
  });

  it('is not recognized without an opener at all', () => {
    expect(resolveDuplicate(tab(2, { index: 1, url: PAGE }), [OLD], ctxOf())?.closeTabId).toBe(2);
  });

  it('is not recognized for a tab opened from a link, which arrives without its URL', () => {
    // A link opens a tab whose `url` is empty and whose address is in `pendingUrl`: that
    // is the signal the heuristic rests on (PLAN.md §8.6).
    const fromLink = tab(2, { index: 1, url: '', pendingUrl: PAGE, openerTabId: 1 });
    expect(resolveDuplicate(fromLink, [OLD], ctxOf())?.closeTabId).toBe(2);
  });

  it('is not recognized for a tab that navigated here rather than being created here', () => {
    const navigated = ctxOf({}, { navigatedTabIds: new Set([2]) });
    expect(resolveDuplicate(DUPLICATED, [OLD], navigated)?.closeTabId).toBe(2);
  });
});

describe('which of two duplicates is kept (PLAN.md §8.4.3)', () => {
  it('keeps the pinned tab, whichever of the two it is', () => {
    const pinnedOld = resolveDuplicate(NEW, [tab(1, { index: 0, pinned: true })], ctxOf());
    expect(pinnedOld).toMatchObject({ keepTabId: 1, closeTabId: 2 });

    // Pinned beats the age rule, which would otherwise have kept the old tab.
    const pinnedNew = resolveDuplicate(tab(2, { index: 1, pinned: true }), [OLD], ctxOf());
    expect(pinnedNew).toMatchObject({ keepTabId: 2, closeTabId: 1 });
  });

  it('stops preferring the pinned tab when "Mantieni la scheda fissata" is off', () => {
    const trigger = tab(2, { index: 1, pinned: true });
    const resolution = resolveDuplicate(trigger, [OLD], ctxOf({ keepPinned: false }));
    expect(resolution).toMatchObject({ keepTabId: 1, closeTabId: 2 });
  });

  it('keeps the active tab the user navigated to a URL already open elsewhere', () => {
    // Typing in the address bar of the tab you are working on: it stays, the other goes.
    const working = tab(2, { index: 1, active: true });
    const ctx = ctxOf({}, { navigatedTabIds: new Set([2]) });
    expect(resolveDuplicate(working, [OLD], ctx)).toMatchObject({ keepTabId: 2, closeTabId: 1 });
  });

  it('does not count a newly created tab as "the tab you are working on"', () => {
    // The whole point of §8.4.3.2: `NEW` is active, having been opened in the foreground,
    // and keeping it on that ground would close the tab the user came from.
    expect(resolveDuplicate(NEW, [OLD], ctxOf())).toMatchObject({ keepTabId: 1, closeTabId: 2 });
  });

  it('stops preferring the active tab when "Mantieni la scheda attiva" is off', () => {
    const working = tab(2, { index: 1, active: true });
    const ctx = ctxOf({ keepActive: false }, { navigatedTabIds: new Set([2]) });
    expect(resolveDuplicate(working, [OLD], ctx)).toMatchObject({ keepTabId: 1, closeTabId: 2 });
  });

  it('keeps the https tab, which is the only scheme difference a shared key allows', () => {
    const insecureOld = tab(1, { index: 0, url: 'http://example.com/article' });
    expect(resolveDuplicate(NEW, [insecureOld], ctxOf())).toMatchObject({
      keepTabId: 2,
      closeTabId: 1,
    });
  });

  it('stops preferring https when the option is off, and then compares by age', () => {
    const insecureOld = tab(1, { index: 0, url: 'http://example.com/article' });
    const resolution = resolveDuplicate(NEW, [insecureOld], ctxOf({ preferHttps: false }));
    // With `preferHttps` off the two schemes are different pages again, so there is
    // nothing to resolve: the key itself no longer matches.
    expect(resolution).toBeNull();
  });

  it('keeps the oldest tab by default', () => {
    expect(resolveDuplicate(NEW, [OLD], ctxOf({ keep: 'oldest' }))).toMatchObject({
      keepTabId: 1,
      closeTabId: 2,
    });
  });

  it('keeps the newest tab when the user asked for that', () => {
    expect(resolveDuplicate(NEW, [OLD], ctxOf({ keep: 'newest' }))).toMatchObject({
      keepTabId: 2,
      closeTabId: 1,
    });
  });

  it('falls back to the tab id when the tracker knows neither age', () => {
    // Ids grow with time, so this agrees with "oldest" rather than contradicting it.
    const ageless = ctxOf({ keep: 'oldest' }, { createdAt: {} });
    expect(resolveDuplicate(NEW, [OLD], ageless)).toMatchObject({ keepTabId: 1, closeTabId: 2 });

    const agelessNewest = ctxOf({ keep: 'newest' }, { createdAt: {} });
    expect(resolveDuplicate(NEW, [OLD], agelessNewest)).toMatchObject({
      keepTabId: 2,
      closeTabId: 1,
    });
  });

  it('prefers the focused window, but only when the scope spans the others', () => {
    const inFocused = tab(2, { windowId: 7, index: 0 });
    const elsewhere = tab(1, { windowId: 9, index: 0 });
    // Same age, so the window rule is what decides.
    const sameAge = { createdAt: { 1: NOW - 1_000, 2: NOW - 1_000 }, focusedWindowId: 7 };

    const spanning = ctxOf({ scope: 'all-windows', preferActiveWindow: true }, sameAge);
    expect(resolveDuplicate(inFocused, [elsewhere], spanning)).toMatchObject({
      keepTabId: 2,
      closeTabId: 1,
    });

    const off = ctxOf({ scope: 'all-windows', preferActiveWindow: false }, sameAge);
    expect(resolveDuplicate(inFocused, [elsewhere], off)).toMatchObject({
      keepTabId: 1,
      closeTabId: 2,
    });
  });

  it("applies the rules in the plan's order when several of them disagree", () => {
    // Pinned (old) vs navigated-active + https + newer (new): pinned is rule 1 and wins.
    const pinnedOld = tab(1, { index: 0, pinned: true, url: 'http://example.com/article' });
    const activeNew = tab(2, { index: 1, active: true });
    const ctx = ctxOf({ keep: 'newest' }, { navigatedTabIds: new Set([2]) });
    expect(resolveDuplicate(activeNew, [pinnedOld], ctx)).toMatchObject({ keepTabId: 1 });

    // Take the pin away and rule 2 decides for the active tab, against the age rule.
    const plainOld = tab(1, { index: 0, url: 'http://example.com/article' });
    expect(resolveDuplicate(activeNew, [plainOld], ctx)).toMatchObject({ keepTabId: 2 });
  });

  it('compares the trigger with the best candidate, and closes exactly one tab', () => {
    // Three tabs on one page: the pinned one is the best candidate, and the single close
    // is the trigger. The third tab is left to the event that concerns it.
    const pinned = tab(1, { index: 0, pinned: true });
    const plain = tab(3, { index: 2 });
    const resolution = resolveDuplicate(NEW, [plain, pinned], ctxOf());
    expect(resolution).toMatchObject({ keepTabId: 1, closeTabId: 2 });
  });
});

describe('the scope of the search (PLAN.md §8.3)', () => {
  const OTHER_WINDOW = tab(1, { windowId: 2, index: 0 });

  it('finds a duplicate in another window with the "Tutte le finestre" scope', () => {
    const ctx = ctxOf({ scope: 'all-windows' });
    expect(resolveDuplicate(NEW, [OTHER_WINDOW], ctx)).toMatchObject({
      keepTabId: 1,
      closeTabId: 2,
    });
  });

  it('ignores another window with the "Stessa finestra" scope', () => {
    expect(resolveDuplicate(NEW, [OTHER_WINDOW], ctxOf({ scope: 'window' }))).toBeNull();
  });

  it('still finds a duplicate in the same window with the "Stessa finestra" scope', () => {
    expect(resolveDuplicate(NEW, [OLD], ctxOf({ scope: 'window' }))).toMatchObject({
      keepTabId: 1,
      closeTabId: 2,
    });
  });
});

describe('what happens to the tab that stays (PLAN.md §8.4.4)', () => {
  it('activates it by default', () => {
    expect(resolveDuplicate(NEW, [OLD], ctxOf({ after: 'activate' }))?.after).toBe('activate');
  });

  it('leaves it where it is when the user asked for no action', () => {
    expect(resolveDuplicate(NEW, [OLD], ctxOf({ after: 'none' }))?.after).toBe('none');
  });

  it("moves it into the closed tab's place and activates it when asked", () => {
    const resolution = resolveDuplicate(NEW, [OLD], ctxOf({ after: 'move-activate' }));
    expect(resolution).toEqual({ closeTabId: 2, keepTabId: 1, after: 'move-activate' });
  });

  it('does not move the focus when the closed tab was opened in the background', () => {
    // Middle click or Ctrl+click: the tab arrives with `active === false`, and the user
    // did not want to switch tabs. Neither "Attivala" nor "Sposta e attiva" may fire.
    const background = tab(2, { index: 1, active: false });
    for (const after of ['activate', 'move-activate'] as const) {
      const resolution = resolveDuplicate(background, [OLD], ctxOf({ after }));
      expect(resolution, after).toMatchObject({ closeTabId: 2, after: 'none' });
    }
  });

  it('still activates when the tab being closed is the older one', () => {
    // The background exception is about the tab that was just opened in the background.
    // Here that tab is the one kept, and the user is looking at the old tab that goes.
    const background = tab(2, { index: 1, active: false });
    const resolution = resolveDuplicate(background, [OLD], ctxOf({ keep: 'newest' }));
    expect(resolution).toMatchObject({ keepTabId: 2, closeTabId: 1, after: 'activate' });
  });

  it('still activates for a tab that navigated here while in the background', () => {
    // Not a newly opened tab: a background tab that redirected. The exception of §8.4.4
    // is about the gesture that opened a tab, which did not happen here.
    const navigated = tab(2, { index: 1, active: false });
    const ctx = ctxOf({ after: 'activate' }, { navigatedTabIds: new Set([2]) });
    expect(resolveDuplicate(navigated, [OLD], ctx)?.after).toBe('activate');
  });
});

describe('"Più vecchia ricaricata con la nuova URL" (PLAN.md §8.4.3.4)', () => {
  /** The same page with a fragment the comparison ignores, so the two keys still match. */
  const WITH_HASH = 'https://example.com/article#section-3';
  const TRIGGER = tab(2, { index: 1, active: true, url: WITH_HASH });

  it('reloads the kept tab with the URL that triggered the event', () => {
    const resolution = resolveDuplicate(TRIGGER, [OLD], ctxOf({ keep: 'oldest-reloaded' }));
    expect(resolution).toEqual({
      closeTabId: 2,
      keepTabId: 1,
      after: 'activate',
      reloadKeptWith: WITH_HASH,
    });
  });

  it('keeps the same tab as "Più vecchia": only the reload is added', () => {
    const plain = resolveDuplicate(NEW, [OLD], ctxOf({ keep: 'oldest' }));
    const reloaded = resolveDuplicate(NEW, [OLD], ctxOf({ keep: 'oldest-reloaded' }));
    expect(reloaded?.keepTabId).toBe(plain?.keepTabId);
    expect(reloaded?.closeTabId).toBe(plain?.closeTabId);
  });

  it('asks for no reload when the kept tab already shows that exact URL', () => {
    // Reloading would throw away the scroll position and the forms of the kept tab for
    // a URL it is already on.
    const resolution = resolveDuplicate(NEW, [OLD], ctxOf({ keep: 'oldest-reloaded' }));
    expect(resolution?.reloadKeptWith).toBeUndefined();
    expect(resolution).not.toHaveProperty('reloadKeptWith');
  });

  it('asks for no reload when the trigger is the tab that stays', () => {
    const working = tab(2, { index: 1, active: true, url: WITH_HASH });
    const ctx = ctxOf({ keep: 'oldest-reloaded' }, { navigatedTabIds: new Set([2]) });
    const resolution = resolveDuplicate(working, [OLD], ctx);
    expect(resolution).toMatchObject({ keepTabId: 2, closeTabId: 1 });
    expect(resolution).not.toHaveProperty('reloadKeptWith');
  });

  it('asks for no reload under the other two age rules', () => {
    for (const keep of ['oldest', 'newest'] as const) {
      const resolution = resolveDuplicate(TRIGGER, [OLD], ctxOf({ keep }));
      expect(resolution, keep).not.toHaveProperty('reloadKeptWith');
    }
  });
});

/**
 * `resolveAllDuplicates`, which is "Chiudi tutti i duplicati" (PLAN.md §8.7).
 *
 * The same rules as above, read over the whole tab list instead of one event, with two
 * deliberate differences the tests pin down: the gate (the mode, the pause and the start-up
 * grace do not apply, because the user pressed a key) and the shape of the answer (one keep
 * per set, every other tab of it closed, and nothing done to the tab that stays).
 */
describe('“Chiudi tutti i duplicati” (PLAN.md §8.7)', () => {
  const OTHER = 'https://example.com/other';

  /** Three tabs of one page and one of another, which has no duplicate at all. */
  const THREE = [tab(1, { index: 0 }), tab(2, { index: 1 }), tab(3, { index: 2 })];

  function sweepCtx(
    settings: Partial<GuardSettings> = {},
    rest: Partial<GuardContext> = {},
  ): GuardContext {
    return ctxOf(settings, {
      createdAt: { 1: NOW - 60_000, 2: NOW - 30_000, 3: NOW - 1_000 },
      ...rest,
    });
  }

  it('closes every tab of a set but the one that wins the §8.4.3 rules', () => {
    expect(resolveAllDuplicates(THREE, sweepCtx())).toEqual([
      { closeTabId: 2, keepTabId: 1 },
      { closeTabId: 3, keepTabId: 1 },
    ]);
  });

  it('keeps the tab the priorities point at, not the first one in the list', () => {
    // Pinned beats everything (§8.4.3.1), so the newest tab is the one that stays.
    const tabs = [tab(1, { index: 0 }), tab(2, { index: 1, pinned: true })];
    expect(resolveAllDuplicates(tabs, sweepCtx())).toEqual([{ closeTabId: 1, keepTabId: 2 }]);
  });

  it('leaves a page with only one tab alone', () => {
    const tabs = [tab(1, { index: 0 }), tab(2, { index: 1, url: OTHER })];
    expect(resolveAllDuplicates(tabs, sweepCtx())).toEqual([]);
  });

  it('handles several sets at once, each with its own survivor', () => {
    const tabs = [
      tab(1, { index: 0 }),
      tab(2, { index: 1, url: OTHER }),
      tab(3, { index: 2 }),
      tab(4, { index: 3, url: OTHER }),
    ];
    const ctx = sweepCtx({}, { createdAt: { 1: NOW - 4, 2: NOW - 3, 3: NOW - 2, 4: NOW - 1 } });
    expect(resolveAllDuplicates(tabs, ctx)).toEqual([
      { closeTabId: 3, keepTabId: 1 },
      { closeTabId: 4, keepTabId: 2 },
    ]);
  });

  it('works in OFF and in "Solo avvisi" too, which the live guard does not', () => {
    // §8.7: the action is the user's own gesture, and the mode only governs what the guard
    // does on its own.
    for (const mode of ['off', 'warn', 'auto'] as const) {
      expect(resolveAllDuplicates(THREE, sweepCtx({ mode })), mode).toHaveLength(2);
    }
  });

  it('is not held back by a pause or by the start-up grace', () => {
    const excused = sweepCtx(
      {},
      { pausedUntil: NOW + 60_000, autoClosesAllowedFrom: NOW + 60_000 },
    );
    // Both stop the guard from acting *by itself* (§8.1, §8.6). Neither has anything to
    // say about a key the user has just pressed.
    expect(resolveAllDuplicates(THREE, excused)).toHaveLength(2);
  });

  it('closes a duplicate the user made on purpose with "Duplica scheda"', () => {
    // §8.6's heuristic reads an opener and guesses at intent; an explicit "close them all"
    // is not a guess. The live guard's own test above keeps the opposite case.
    const ctx = sweepCtx({ allowIntentionalDuplicates: true });
    const tabs = [tab(1, { index: 0 }), tab(2, { index: 1, openerTabId: 1 })];
    expect(resolveAllDuplicates(tabs, ctx)).toEqual([{ closeTabId: 2, keepTabId: 1 }]);
  });

  it('asks for nothing to be done to the tabs that stay', () => {
    // §8.4.4's "Attivala" and "Sposta e attiva" answer one close the user did not ask for.
    // Twenty of them would shuffle the tab strip twenty times.
    const ctx = sweepCtx({ after: 'move-activate', keep: 'oldest-reloaded' });
    for (const close of resolveAllDuplicates(THREE, ctx)) {
      expect(Object.keys(close).sort()).toEqual(['closeTabId', 'keepTabId']);
    }
  });

  it('leaves a whitelisted site alone', () => {
    const ctx = sweepCtx({}, { isWhitelisted: compile(['*://example.com/*']).match });
    expect(resolveAllDuplicates(THREE, ctx)).toEqual([]);
  });

  it('leaves the browser’s pages, ours, and an empty tab alone', () => {
    const ctx = sweepCtx({}, { ownOrigin: 'chrome-extension://tabdeclutter/' });
    for (const url of [
      'chrome://settings/',
      'chrome-extension://tabdeclutter/panel.html',
      'about:blank',
    ]) {
      const tabs = [tab(1, { index: 0, url }), tab(2, { index: 1, url })];
      expect(resolveAllDuplicates(tabs, ctx), url).toEqual([]);
    }
  });

  it('leaves a sign-in page alone while "Ignora pagine di login" is on', () => {
    const login = 'https://example.com/login';
    const tabs = [tab(1, { index: 0, url: login }), tab(2, { index: 1, url: login })];
    expect(resolveAllDuplicates(tabs, sweepCtx())).toEqual([]);
    expect(resolveAllDuplicates(tabs, sweepCtx({ ignoreAuthPages: false }))).toEqual([
      { closeTabId: 2, keepTabId: 1 },
    ]);
  });

  it('leaves an incognito tab alone', () => {
    const tabs = [tab(1, { index: 0, incognito: true }), tab(2, { index: 1, incognito: true })];
    expect(resolveAllDuplicates(tabs, sweepCtx())).toEqual([]);
  });

  it('leaves a hidden tab alone', () => {
    const tabs = [tab(1, { index: 0 }), tab(2, { index: 1, hidden: true })];
    expect(resolveAllDuplicates(tabs, sweepCtx())).toEqual([]);
  });

  it('leaves a tab the extension has just reopened alone', () => {
    // The exemption behind "Annulla" and "Riapri l'ultimo duplicato chiuso" (§8.5): closing
    // that tab would undo the reopen the user made a second ago.
    const ctx = sweepCtx({}, { exemptions: [{ tabId: 3, until: NOW + 10_000 }] });
    expect(resolveAllDuplicates(THREE, ctx)).toEqual([{ closeTabId: 2, keepTabId: 1 }]);
  });

  it('forgets an exemption that has expired', () => {
    const ctx = sweepCtx({}, { exemptions: [{ tabId: 3, until: NOW - 1 }] });
    expect(resolveAllDuplicates(THREE, ctx)).toHaveLength(2);
  });

  it('leaves a tab with no URL at all alone', () => {
    const tabs = [tab(1, { index: 0, url: '' }), tab(2, { index: 1, url: '' })];
    expect(resolveAllDuplicates(tabs, sweepCtx())).toEqual([]);
  });

  describe('with the "Stessa finestra" scope (PLAN.md §8.3)', () => {
    const SPREAD = [
      tab(1, { index: 0 }),
      tab(2, { index: 1 }),
      tab(3, { windowId: 2, index: 0 }),
      tab(4, { windowId: 2, index: 1 }),
    ];
    const SPREAD_AGES = { 1: NOW - 4, 2: NOW - 3, 3: NOW - 2, 4: NOW - 1 };

    it('keeps one tab of the page in each window', () => {
      const ctx = sweepCtx({ scope: 'window' }, { createdAt: SPREAD_AGES });
      expect(resolveAllDuplicates(SPREAD, ctx)).toEqual([
        { closeTabId: 2, keepTabId: 1 },
        { closeTabId: 4, keepTabId: 3 },
      ]);
    });

    it('keeps one in the whole browser with "Tutte le finestre"', () => {
      const ctx = sweepCtx({ scope: 'all-windows' }, { createdAt: SPREAD_AGES });
      expect(resolveAllDuplicates(SPREAD, ctx)).toEqual([
        { closeTabId: 2, keepTabId: 1 },
        { closeTabId: 3, keepTabId: 1 },
        { closeTabId: 4, keepTabId: 1 },
      ]);
    });

    it('leaves a window holding a single tab of the page alone', () => {
      const tabs = [tab(1, { index: 0 }), tab(2, { windowId: 2, index: 0 })];
      const ctx = sweepCtx({ scope: 'window' }, { createdAt: SPREAD_AGES });
      expect(resolveAllDuplicates(tabs, ctx)).toEqual([]);
    });

    it('ignores the focused window, which is a rule about all of them', () => {
      // §8.4.3.5 applies "only with the 'Tutte le finestre' scope", and inside one window
      // there is nothing for it to prefer.
      const ctx = sweepCtx({ scope: 'window' }, { createdAt: SPREAD_AGES, focusedWindowId: 2 });
      expect(resolveAllDuplicates(SPREAD, ctx)).toEqual([
        { closeTabId: 2, keepTabId: 1 },
        { closeTabId: 4, keepTabId: 3 },
      ]);
    });
  });
});
