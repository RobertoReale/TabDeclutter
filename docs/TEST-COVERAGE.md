# TEST-COVERAGE.md

What covers each item of PLAN.md §14 (test strategy and release checklist). One row per item of
§14, in §14's own order and words, against the test that proves it and the gate that runs that
test. Where no automated test can reach the behaviour, the row says so and names the manual check
that was done instead (`docs/MANUAL-CHECKS.md`, closed to new entries since 2026-11-09).

The gate names are the `name` fields of `phasekit.json`'s `gates` array, which is the only
definition of green: `unit tests` (`pnpm test`, Vitest over `tests/unit` and `tests/ext`),
`e2e chromium` (`pnpm e2e`, Playwright over `tests/e2e`), `e2e firefox` (`pnpm e2e:firefox`,
Vitest + Puppeteer/BiDi over `tests/e2e-firefox`), `perf budgets`, `web-ext lint`, `lint`,
`typecheck`, `build chrome`, `build firefox`, `permissions docs` (`tools/check-permissions.mjs`),
`bundle size` (`tools/size.mjs`).

`tests/unit/test-coverage.test.ts` keeps this file honest: every path it names has to exist, every
`MANUAL-CHECKS.md` entry it cites has to be there, and every E2E spec of either suite has to be
named here. A new spec that is not in this list fails the `unit tests` gate.

## Unit (Vitest) — gate `unit tests`

| §14 item | Covered by |
|---|---|
| URL normalization | `tests/unit/url.test.ts` — `normalizeUrl` with the defaults and one describe per option (`ignoreWww`, `ignoreHash`, `ignoreTrackingParams`, `ignoreAllParams`, `ignorePath`, `ignoreCase`), plus `isTrackingParam`, `registrableDomain`, `displayHost` |
| classification | `tests/unit/classify.test.ts` — `classify`, the extension's own pages, `isBlankUrl`, `isAuthUrl`, `isOwnPage`, `looksLikeErrorTitle`, `canonicalUrl` |
| duplicates | `tests/unit/duplicates.test.ts` — `duplicateKey`, `duplicateOptions`, `tabUrl`, `findDuplicateSets`, `compareKeepPriority`; the guard's own rules in `tests/unit/duplicate-guard.test.ts` |
| scoring: table of cases | `tests/unit/scoring.test.ts` — step 1 the protections, step 2 the strong rules, step 3 the additions, the window roll-up; and the hand-labelled 300-tab fixture in `tests/unit/scoring.fixtures.test.ts` |
| scoring property: protected tabs always score 0 | `tests/unit/scoring.test.ts`, "the properties the score promises" — every shape × situation × protection scores 0, in bucket `keep`, for reason `protected` |
| scoring property: the score is monotonic in inactivity | `tests/unit/scoring.test.ts`, "never lowers a score because the tab sat untouched for longer" (an idle ladder from 0 to a year, over every shape) |
| clustering: deterministic | `tests/unit/cluster.test.ts` — "gives the same answer every time, down to the titles and the colours", "keeps the colour of a group tied to its title, not to its position", "accounts for every tab exactly once, in both modes" |
| clustering: limits of 8 groups and minimum 2 | `tests/unit/cluster.test.ts` — "proposes at most eight groups and sends the smallest to «Altro» (PLAN.md §7.2.6)", "never proposes a group of one (PLAN.md §7.2.4)", "takes the minimum size from the options" |
| ai-grouping: valid output | `tests/unit/ai-grouping.test.ts`, "a valid answer" |
| ai-grouping: invented IDs, duplicates | `tests/unit/ai-grouping.test.ts`, "the answer is not trusted" — an invented id is dropped, a repeated one counts once, a missing one goes to "Altro" |
| ai-grouping: malformed JSON | `tests/unit/ai-grouping.test.ts`, "when the model cannot answer" |
| ai-grouping: quota exceeded | `tests/unit/ai-grouping.test.ts`, "the context and the quota"; the session itself in `tests/unit/llm.test.ts` |

## E2E (Playwright, Chromium, extension from `.output/chrome-mv3`) — gate `e2e chromium`

| §14 item | Covered by |
|---|---|
| opening the panel and rendering the sections with seeded tabs | `tests/e2e/declutter.spec.ts` — "the sections of §4.3 appear in order, each row saying why"; the shell itself in `tests/e2e/shell.spec.ts` |
| close + undo | `tests/e2e/actions.spec.ts` — "§4.3: a selection closes together, says so, and comes back with Annulla" and "ten tabs across two windows go together, and Annulla puts every one back" |
| keep → the tab disappears and does not come back for 7 days (simulated time) | `tests/e2e/actions.spec.ts` — "§14: «Mantieni» takes the row off the list, and the keep running out brings it back" (the keep is read back from `local:keeps` with its expiry, then expired) |
| organize by site → groups created with title and colour → undo | `tests/e2e/organize.spec.ts` — "the preview by site is renamed, applied as native groups and undone" and "apply and undo restore exactly the order and the groups"; by topic without a model in `tests/e2e/organize-ai.spec.ts` |
| archive: search, restore, empty | `tests/e2e/archive.spec.ts` — "every closed tab is listed, and the search and the filters narrow it", "«Ripristina» brings a row back…", "«Svuota archivio» asks inline before it empties (§9)"; across a restart in `tests/e2e/restart.spec.ts` |
| duplicate protection: all the M3b acceptance cases | `tests/e2e/guard.spec.ts` — the twelve cases of TASKS.md M3b.5, from "the second opening of a page closes in under 300 ms" to "a multi-step login is never cut in half" |
| duplicate protection: "Stessa finestra" vs "Tutte le finestre" | `tests/e2e/guard.spec.ts` — "§8.3: «Stessa finestra» leaves another window alone, «Tutte le finestre» does not" |
| duplicate protection: "Sposta e attiva" | `tests/e2e/guard.spec.ts` — "§8.4.4: «Sposta e attiva» puts the surviving tab where the closed one was" |
| duplicate protection: "Più vecchia ricaricata" | `tests/e2e/guard.spec.ts` — "§8.4.3.4: «Più vecchia ricaricata» keeps the old tab and takes it to the new URL" |
| duplicate protection: navigating an active tab to a URL already open | `tests/e2e/guard.spec.ts` — "§8.4.3.2: the active tab that navigated to the page stays, the older one goes" |

## Firefox E2E (Puppeteer with WebDriver BiDi, extension from `.output/firefox-mv3`) — gate `e2e firefox`

| §14 item | Covered by |
|---|---|
| opening the sidebar | `tests/e2e-firefox/panel.spec.ts` — the panel is the document the sidebar renders, with the header counts, the navigation and the title from the real `browser.tabs` |
| close + undo | `tests/e2e-firefox/actions.spec.ts` — "a picked row closes from the bar and comes back with Annulla" |
| guard on a duplicate URL | `tests/e2e-firefox/guard.spec.ts` — "§8.2: the second tab on a URL is closed, and the first one stays", plus the two login cases |
| organize by site | `tests/e2e-firefox/organize.spec.ts` — "organizing by site creates one native group and Annulla removes it" |
| (the suggestions list, which no §14 line asks of Firefox but the flows need) | `tests/e2e-firefox/declutter.spec.ts` — the section the scores put a duplicate pair in, and the row that says why |
| no console errors on Firefox | every Firefox spec ends on `session.errors.take()`; that the collector really fires is `tests/e2e-firefox/console.spec.ts` |

## Compatibility-specific unit tests (mocked `capabilities`) — gate `unit tests`

| §14 item | Covered by |
|---|---|
| favicons | `tests/unit/favicon.test.ts` — `faviconOf` on Chrome (the browser's own cache at 16 px) and on Firefox (never a remote `favIconUrl`, an initial-and-colour avatar instead) |
| the guard without `pendingUrl` | `tests/unit/duplicate-guard.test.ts` — "has nothing to compare when the trigger has no URL yet" and "ignores a candidate that has no URL of its own yet"; the fallback itself in `tests/unit/duplicates.test.ts`, "falls back to the URL a new tab is about to show" |
| the duplicate key with `cookieStoreId` | `tests/unit/duplicates.test.ts`, "containers (Firefox)" — the same URL in two containers is two pages, absent on Chrome, ignored when the option is off |
| `hidden` tabs | `tests/unit/duplicates.test.ts` — "excludes hidden tabs, which are not on screen at all"; `tests/unit/duplicate-guard.test.ts` — "never touches a hidden tab"; `tests/ext/tabs.test.ts` — "leaves out a hidden tab" |
| options hidden on Firefox | `tests/unit/guard-settings.test.ts` — `visibleGuardToggles` on Chrome (no containers option) and on Firefox (no "Duplicate tab"), each gated on a capability that exists |
| per-browser whitelist defaults | `tests/unit/guard-settings.test.ts`, `defaultWhitelist` — Chrome's own pages on Chrome, the `about:` pages and `moz-extension` on Firefox |
| (what the two browsers are taken to have) | `tests/unit/capabilities.test.ts` — `detectCapabilities` on Chrome, on Firefox and with nothing available; the two manifests in `tests/unit/manifest.test.ts` |

## Manual (Chrome)

| §14 item | Covered by |
|---|---|
| browser restart (age persistence) | Automated: `tests/unit/reconcile.test.ts` ("reconciliation after a restart" — the records are matched to the tabs that came back, by URL as a multiset, because ids do not survive) and `tests/ext/tracker.test.ts` ("gives the tabs that came back the records of the tabs that went away"). Verified by hand once as well: `docs/MANUAL-CHECKS.md` (M2.2), "Dopo il riavvio di Chrome le schede non tornano «nuove»". The archive across a real restart is `tests/e2e/restart.spec.ts`. |
| discard from `chrome://discards` (onReplaced) | Automated: `tests/ext/tracker.test.ts` — "moves the record when a discard gives the page a new id" and "has nothing to move when the replaced tab had no record"; the same event in `tests/ext/guard.test.ts`, `tests/ext/badge.test.ts` and `tests/ext/panel-state.test.ts`. A discarded tab's own score is `tests/unit/scoring.test.ts`, "counts a tab the browser has already dropped". |
| multiple windows | Automated: `tests/e2e/shell.spec.ts` ("the header counts a second window"), `tests/e2e/actions.spec.ts` ("ten tabs across two windows go together"), `tests/e2e/guard.spec.ts` ("«Stessa finestra» leaves another window alone"), `tests/unit/scoring.test.ts` ("the window roll-up"). |
| pinned/audio tabs | Automated: `tests/unit/scoring.test.ts`, "step 1, the protections" — a pinned tab and a tab playing audio score 0 in bucket `keep`; which of two duplicates is kept in `tests/unit/duplicate-guard.test.ts`, "keeps the pinned tab, whichever of the two it is". |
| dark theme | Automated: `tests/e2e/shell.spec.ts` — "the panel is dark, light text on a dark surface" and "the panel is light, dark text on a light surface" (WCAG luminance under a forced `colorScheme`); `tests/e2e/a11y.spec.ts` runs axe over every view in both themes. |
| 200% zoom | Automated: `tests/e2e/a11y.spec.ts` — "the panel still fits its width at 200% zoom". |
| screen reader (NVDA/VoiceOver) on the main actions | Not automatable: no driver speaks a screen reader. What can be checked is checked — `tests/e2e/a11y.spec.ts` (axe over every view, in both themes and on the onboarding screen), `tests/e2e/declutter.spec.ts` and `tests/e2e/actions.spec.ts` (the keyboard alone walks the grid, closes and undoes), `tests/unit/keyboard.test.ts`. Verified by hand with Narratore: `docs/MANUAL-CHECKS.md` (M2.3) and (M3.2). |

## Manual (Firefox)

| §14 item | Covered by |
|---|---|
| opening the sidebar from the icon and the shortcut | Not automatable: BiDi drives the panel document, not the browser chrome that holds the sidebar button, and no API opens a sidebar from a test. Verified by hand: `docs/MANUAL-CHECKS.md` (M0.2), the icon and Alt+Shift+D, both in Chrome and in Firefox. The sidebar entrypoint that the manifest builds from is `tests/unit/manifest.test.ts`; that the sidebar renders the panel is `tests/e2e-firefox/panel.spec.ts`. |
| restart with session restore (age preserved through `sessions.setTabValue`) | Automated: `tests/ext/tracker.test.ts`, "on Firefox, where a tab carries its own record" — the records are saved next to their tabs, read back before matching by URL, accepted when stored as a string, and a tab value that cannot be read or written does not stop the rest; `tests/unit/reconcile.test.ts` — `fromSession` wins over URL matching. A real Firefox restart needs a signed build, so it stays for release time: `docs/MANUAL-CHECKS.md` (setup), "Su Firefox, con la versione firmata, dopo il riavvio le schede non tornano «nuove»". |
| Multi-Account containers (same URL in different containers, no close) | Automated with the capability mocked: `tests/unit/duplicates.test.ts` "containers (Firefox)" and `tests/unit/duplicate-guard.test.ts` "treats the same URL in two Firefox containers as two pages"; the capability itself in `tests/unit/capabilities.test.ts`. Real containers need the Multi-Account Containers add-on and a second extension in the profile, which the Firefox harness does not install. |
| tab groups (create/undo) | Automated: `tests/e2e-firefox/organize.spec.ts` — a real native group created in Firefox and removed again by Annulla. |
| favicon/avatar | Automated with the capability mocked: `tests/unit/favicon.test.ts` on Firefox — never a remote `favIconUrl` (invariant 1), the domain's initial upper-cased, a plain square for a URL with no host, one stable colour per domain. |
| `about:` pages | Automated: `tests/unit/guard-settings.test.ts` `defaultWhitelist` (the `about:` pages are whitelisted out of the box on Firefox), `tests/unit/duplicate-guard.test.ts` ("never closes a page of the browser, whatever the settings say"), `tests/unit/classify.test.ts`. A headless Firefox will not let a test open `about:config`, which is also why nothing in the suite needs to. |
| dark theme | Automated: `tests/e2e-firefox/theme.spec.ts` — a Firefox told the system is dark and a Firefox told it is light, each read for `prefers-color-scheme` and for the body's WCAG luminance. |
| tabs unloaded from memory (`about:unloads`) | Automated: `tests/unit/scoring.test.ts` "counts a tab the browser has already dropped", `tests/ext/tabs.test.ts` "fills in everything the rules read, for a tab that arrived nearly empty" (an unloaded tab arrives without `lastAccessed`), `tests/ext/tracker.test.ts` (the record outlives the unload), `tests/ext/actions.test.ts` ("refuses a tab that is already discarded"). |

## Release checklist

This says what proves each box. The checklist itself, run with its results, is
`docs/RELEASE-CHECKLIST.md`.

| §14 box | Proved by |
|---|---|
| Chrome and Firefox builds generated from the same commit, same version | Gates `build chrome` and `build firefox` run on one tree. `build/manifest.ts` declares no `version`, so WXT writes the one in `package.json` into both manifests; no test asserts it, and `docs/RELEASE-CHECKLIST.md` reads it from both packages. The packages come from that same tree: `pnpm zip` and `pnpm zip:firefox`, in `.github/workflows/release.yml` on a `v*` tag. |
| `web-ext lint` with 0 errors, `data_collection_permissions` and `gecko.id` present | Gate `web-ext lint`; both fields are asserted in `tests/unit/manifest.test.ts`, "the Firefox manifest". |
| AMO sources zip without minified files, reproducible build verified | `tools/verify-reproducible.mjs` (`pnpm reproducible`, a step of `.github/workflows/release.yml`): it fails on a sources zip holding build output, dependencies, tests, a minified file or a file git does not track, then rebuilds from that zip in a fresh folder and compares every file with the add-on zip. |
| All flows verified on Chrome **and** Firefox | Gates `e2e chromium` and `e2e firefox`, which are the two sections above. |
| Zero network requests | Gate `e2e chromium`: every Playwright spec ends on the recorder's `takeForeignRequests` (invariant 1), and that the recorder really catches one is `tests/e2e/recorder.spec.ts`. On Firefox, no remote favicon by construction (`tests/unit/favicon.test.ts`). |
| Permissions = those of section 5.4, each one justified | `tests/unit/manifest.test.ts`: the exact lists in "the Chrome manifest" and "the Firefox manifest", no host permission and `bookmarks` only optional in "both manifests"; the prose is PERMISSIONS.md (M7.3), held to the built manifests by gate `permissions docs`. |
| Performance budgets met | Gate `perf budgets`, with `tests/unit/perf-budget-power.test.ts` and `tests/unit/perf-budget-verdict.test.ts` over the measurement itself; the JS bundle budgets are gate `bundle size` (`tools/size.mjs`, both builds). |
| No console errors/warnings | Gate `e2e chromium` (the recorder's `takeConsoleErrors` in every spec, proved by `tests/e2e/recorder.spec.ts`) and gate `e2e firefox` (`session.errors.take()`, proved by `tests/e2e-firefox/console.spec.ts`). |
| en/it i18n complete | `tests/unit/i18n.test.ts` (the catalogues agree, key by key and placeholder by placeholder) and `tests/unit/i18n-usage.test.ts` (invariant 11: no key the code asks for is missing, none the catalogues ship is dead). |
| axe clean | Gate `e2e chromium`: `tests/e2e/a11y.spec.ts` — "axe finds nothing serious in any view", in both themes, plus the onboarding screen. |
| PRIVACY.md, PERMISSIONS.md, STORE_LISTING.md, AMO_REVIEW.md with 1280×800 screenshots | `tests/unit/store-docs.test.ts` (the documents against the code and the manifests), gate `permissions docs` (PERMISSIONS.md against both manifests), and `scripts/store-screenshots.ts` (`pnpm screenshots`, the screenshots in `docs/store/screenshots/chrome/`). |

## Beyond §14's lists, also in the gates

Specs that no §14 line asks for, kept because they guard something the plan does ask for.

| Spec | What it holds |
|---|---|
| `tests/e2e/badge.spec.ts` | §4.1: the number on the icon says how many tabs are to close, and nothing when there are none. |
| `tests/e2e/guard-ui.spec.ts` | §4.2: the chip says what the protection does, its menu changes it and opens the duplicate settings, in both languages. |
| `tests/e2e/motion.spec.ts` | §4.7: `prefers-reduced-motion` leaves no real transition on a row, and a row closed from the middle collapses in its own place. |
| `tests/e2e/onboarding.spec.ts` | §17: the first run asks its questions, in the plan's own words, and does not come back. |
| `tests/e2e/settings.spec.ts` | §4.6: the language and the "old after" threshold change the panel while it is open. |
| `tests/e2e/recorder.spec.ts` | That the check behind "zero network requests" and "no console errors" fires at all. |
