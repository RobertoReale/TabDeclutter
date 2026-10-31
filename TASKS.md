# TASKS.md — TabDeclutter execution plan

> This is the file phasekit runs. Every task (`M1.4`, `M3b.2`…) is **one session, one
> `plan/phase-<id>` branch, one commit**. The product spec is `PLAN.md` and it is binding: this file
> holds only the order, the scope of each task and the observable condition that makes it "done".
> The agent's rules of behaviour are in `AGENT-RULES.md`.

## 1. How this plan is run

### 1.1 The gates

The gates are defined **in one place only**: the `gates` array in `phasekit.json`. Every commit must
leave them all green, and phasekit runs them again before every merge into `main`.

At the start they are: install (`--frozen-lockfile`), lint, typecheck, unit tests, Chrome build,
Firefox build, `web-ext lint`. They grow as the project gains new checks: M0.4 adds the Chromium
E2E, M0.5 the Firefox E2E, M7.2 the bundle budget. A gate is never removed or weakened.

M0.1 is the only task that starts without gates (it creates them).

### 1.2 Shared working files

- `docs/DECISIONS.md`: every choice PLAN.md does not make (versions, libraries, APIs that behave
  differently from the spec, tuning). One entry per decision, with the task that made it.
- `docs/MANUAL-CHECKS.md`: everything that cannot be verified automatically (a real browser
  restart, a screen reader, the AI model on the real PC). The agent adds the entries, written as
  step-by-step instructions for the owner. At the end of a phase `tools/assistant.ps1` shows them
  to the owner together with a test build. They do not block the sequence.
- Problems found by the checks become fix tasks `F.n` (section 13), inserted into `autoSequence`
  right after the task in progress.

### 1.3 Order

The phases follow the milestones of PLAN.md §13 (M0 → M7). Within each phase, tasks are ordered by
dependency. The labelled fixtures (M1.5) come **before** the scoring (M1.6), because the labels must
reflect human judgement, not the algorithm's output.

## 2. Invariants

Things that must never break, with the reason. Where possible they are enforced by a test or a lint
rule rather than by good will.

1. **Zero network requests from the extension's contexts.** Principle PLAN §3.4 and a requirement
   of both stores. The E2E tests fail if an extension context makes an external request (fixture
   created in M0.4).
2. **No tab closed without an explicit gesture**, except duplicate protection in "Chiudi
   automaticamente" mode. PLAN §3.1: it is the product's promise.
3. **Every close goes to the archive** and can be restored. PLAN §3.3.
4. **`src/core/` is pure TypeScript**: no `browser.*`/`chrome.*`, injected dependencies, injected
   `now`. This is what lets it be 100% tested and shared between the background and the panel
   (PLAN §5.2).
5. **`chrome.*` only inside `src/platform/`**, behind feature detection. Application code asks
   `capabilities.ts` and never checks the browser name (PLAN §5.5). Enforced by ESLint (M0.1).
6. **No state held only in memory in the background; listeners registered synchronously at the
   top level.** Chrome's service worker dies after about 30 s of inactivity (PLAN §5.2, §8.2).
7. **Tab titles and URLs are untrusted input**: never `innerHTML` or `dangerouslySetInnerHTML`. No
   `eval`/`new Function`, no remote code. A store requirement (PLAN §12.1). Enforced by ESLint
   (M0.1).
8. **Permissions exactly those of PLAN §5.4.** No `host_permissions`, no content scripts. Every
   extra permission is a reason for rejection in review.
9. **A single definition of "duplicate"**: `duplicateKey()` in `core/duplicates.ts`, used both by
   Declutter and by the guard (PLAN §6.2).
10. **Every Chrome/Firefox difference has a test with mocked capabilities or an entry in
    `docs/MANUAL-CHECKS.md`** (PLAN §5.5).
11. **Every visible string goes through i18n** and the `en`/`it` keys match (test from M0.3).

## 3. PHASE M0 — Scaffolding

### M0.1 — Toolchain and project skeleton

Creates the empty project but with the whole toolchain, so that all the initial gates of
`phasekit.json` exist and are green.

**Spec.** PLAN.md §5.1, §5.3, §12.3 (pinned versions, reproducible build), §13 M0.

**What to do.**
- `package.json`: `"type": "module"`, version `0.1.0`, MIT licence,
  `"packageManager": "pnpm@<the version from pnpm -v>"`, `engines.node`. `.nvmrc` with the
  **exact** version from `node -v` (needed for the reproducible AMO build). Lockfile committed.
- WXT (latest stable) with `srcDir: 'src'`. Preact + `@preact/signals` (integrated through
  `@preact/preset-vite` or an equivalent: choose and record it). TypeScript `strict` plus
  `noUncheckedIndexedAccess`.
- ESLint (flat config, typescript-eslint) + Prettier. Rules that enforce invariants 5 and 7:
  `chrome` forbidden outside `src/platform/`; `innerHTML`, `outerHTML`,
  `dangerouslySetInnerHTML`, `eval`, `new Function` forbidden.
- Vitest with a first real test: `src/core/time.ts` (`MINUTE`/`HOUR`/`DAY` constants, `clamp`)
  and its test. No `passWithNoTests`.
- `background` entrypoint (empty, `defineBackground`) and `sidepanel` entrypoint (Preact, a
  placeholder).
- Scripts: `dev`, `dev:firefox`, `build`, `build:firefox`, `zip`, `zip:firefox`, `lint` (eslint +
  prettier --check), `lint:firefox` (`web-ext lint -s .output/firefox-mv3`), `typecheck`
  (`wxt prepare` + `tsc --noEmit`), `test` (`vitest run`). `e2e` and `e2e:firefox` come in
  M0.4/M0.5: do not create scripts that do nothing.
- The minimum manifest needed for `web-ext lint` to report 0 errors (e.g. `gecko.id`); the full
  manifest is M0.2.
- `LICENSE` (MIT, Roberto Reale, 2026), a minimal `README.md` (what it is, how to build it).
- `.gitignore` already exists: add only what is missing.

**Scope.** Configuration and skeleton only. No product functionality.

**Done when.** From a clean tree, every command in the `gates` array of `phasekit.json` exits with
0, in order. `docs/DECISIONS.md` records the chosen versions (Node, pnpm, WXT, Preact) and how
Preact is integrated.

### M0.2 — Per-browser manifest, capabilities and opening the panel

The generated manifest must match PLAN §5.4 on both browsers, and clicking the icon must open the
panel.

**Spec.** PLAN.md §4.1 (entry points, only opening the panel and the shortcut), §5.4, §5.5.

**What to do.**
- `wxt.config.ts` with `manifest: ({ browser }) => …`: permissions, `optional_permissions`,
  `incognito`, `commands`, `side_panel` / `sidebar_action`, `minimum_chrome_version: "121"`,
  `gecko` (`strict_min_version: "140.0"`, `data_collection_permissions`). For the id use
  `tabdeclutter@robertoreale`: it is a provisional choice; record it in DECISIONS as "to be
  confirmed before the first AMO submission, immutable afterwards".
  Extract the function that builds the manifest into a testable module.
- `src/platform/capabilities.ts` as in §5.5, written as a testable factory
  (`detectCapabilities(env)`) plus the `caps` instance.
- `src/platform/panel.ts`: Chrome `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })`;
  Firefox `action.onClicked` → `sidebarAction.toggle()` called **synchronously**.
  Registered from the background at the top level.

**Scope.** `wxt.config.ts`, `src/platform/{capabilities,panel}.ts`, background entrypoint, unit
tests.

**Done when.**
- A unit test checks, for Chrome and for Firefox, that the manifest's keys and permissions are
  exactly those of §5.4: no `host_permissions`, no `content_scripts`.
- After the build, `.output/chrome-mv3/manifest.json` and `.output/firefox-mv3/manifest.json` have
  been inspected and match §5.4. Differences imposed by WXT are recorded.
- `web-ext lint`: 0 errors. Any warnings are recorded in DECISIONS.
- The `capabilities` tests cover mocked Chrome and Firefox.
- Added to MANUAL-CHECKS: "clic sull'icona apre il pannello (Chrome, Firefox)" and
  "Alt+Shift+D apre il pannello (Chrome, Firefox)".

### M0.3 — i18n and a localized "Hello" panel

Every string goes through a typed helper, and a test prevents `en` and `it` from drifting apart.

**Spec.** PLAN.md §2.1 (bilingual UI), §4.6 ("Language" row), §13 M0.

**What to do.**
- `src/public/_locales/{en,it}/messages.json` with `extName`, `extDescription`, `actionTitle`,
  `cmdCloseDuplicates`, `cmdToggleGuard`, `hello`.
- A `t(key, ...subs)` helper typed on the `en` keys (a key that does not exist is a compile
  error).
- Unit tests: the same keys in `en` and `it`, the same placeholders, correct substitution.
- The panel shows `t('hello')` and sets `lang` on the document.

**Scope.** `_locales`, i18n helper, panel, tests.

**Done when.** The parity tests pass. The built manifest uses `__MSG_*__` and the build resolves the
keys. The panel renders the localized string, verified in E2E from M0.4.

### M0.4 — Chromium E2E harness

E2E tests become a gate: after this task every merge checks the real extension, loaded in
Chromium.

**Spec.** PLAN.md §5.1 (Playwright), §14 (E2E), §13 M0 (acceptance), §11 (zero network).

**What to do.**
- Playwright with the extension loaded from `.output/chrome-mv3` in a persistent context.
  Use Playwright's Chromium, not branded Chrome: recent Chrome versions ignore
  `--load-extension`. Headless if it supports extensions (`channel: 'chromium'`); check and
  record.
- Reusable fixtures:
  1. the extension id (from the service worker) and opening `chrome-extension://<id>/sidepanel.html`
     in a tab (the real side panel does not open without a user gesture);
  2. fail the test if an extension page or the service worker writes an error to the console;
  3. fail the test if an extension context makes a network request to an origin other than the
     extension itself (invariant 1).
- First test: the panel shows a localized "Hello" in `en` and in `it`.
- `e2e` script: builds Chrome and then runs Playwright, so it never runs on a stale build.
- Add to `phasekit.json` the gate `{ "name": "e2e chromium", "cwd": ".", "run": "pnpm e2e",
  "retries": 1 }`.

**Scope.** Playwright config, `tests/e2e/`, `package.json`, `phasekit.json` (only adding the
gate).

**Done when.** `pnpm e2e` passes twice in a row from a clean tree. The gate is in `phasekit.json`.
The choices (headless, Chromium) are in DECISIONS.

### M0.5 — Firefox E2E harness

The same for Firefox: smoke tests on the real extension, through WebDriver BiDi.

**Spec.** PLAN.md §5.1 (Puppeteer + web-ext), §14 (Firefox E2E).

**What to do.**
- Puppeteer with `browser: 'firefox'` and WebDriver BiDi. Install the extension from
  `.output/firefox-mv3` (`browser.installExtension` or equivalent). Pin the internal UUID
  (preference `extensions.webextensions.uuids`) so the tests open
  `moz-extension://<uuid>/sidepanel.html`.
- Firefox: locally there is Firefox 157 at `C:\Program Files\Mozilla Firefox\firefox.exe`; in CI
  it is downloaded. Make the path configurable and record the choice.
- Test runner of your choice (a separate Vitest config or something else), recorded.
- First test: the panel shows a localized "Hello"; no console errors.
- `e2e:firefox` script: builds Firefox and then runs the tests. Headless.
- Add to `phasekit.json` the gate `{ "name": "e2e firefox", "cwd": ".", "run":
  "pnpm e2e:firefox", "retries": 1 }`.

**Scope.** Firefox harness, `tests/e2e-firefox/` (or similar), `package.json`,
`phasekit.json` (only adding the gate).

**Done when.** `pnpm e2e:firefox` passes twice in a row. The gate is in `phasekit.json`.

### M0.6 — GitHub Actions CI

CI runs the same checks as the gates, so a broken push shows up on GitHub.

**Spec.** PLAN.md §13 M0 (CI), §12.4.

**What to do.** `.github/workflows/ci.yml` on push and pull request: Node from `.nvmrc`, pnpm at
the `packageManager` version, then the same commands as the `gates` array of `phasekit.json`, in the
same order (Firefox installed in CI for the Firefox E2E). `release.yml` is M7.5.

**Scope.** Only `.github/workflows/ci.yml`.

**Done when.** The file is valid YAML (checked with a validator run through `pnpm dlx`, without
adding it to the dependencies) and its commands match the gates. Added to MANUAL-CHECKS: "CI verde
al primo push su GitHub".

## 4. PHASE M1 — Pure core and tracker

### M1.1 — Types and URL normalization

The base of the whole core: the shared types and a correct, tested URL normalization.

**Spec.** PLAN.md §6.1 (`TabActivity`), §6.2, §8.3 ("URL comparison" table → `MatchOptions`),
§10 (types of the storage keys).

**What to do.**
- `src/core/types.ts`: a browser-independent tab shape (`TabInfo`, with `pinned`, `audible`,
  `active`, `discarded`, `hidden`, `groupId`, `cookieStoreId`, `incognito`, `openerTabId`,
  `pendingUrl`, `lastAccessed`…), `TabActivity`, `Settings`, `GuardSettings`, `MatchOptions`,
  `ArchivedTab`, with the default values in a single module.
- `src/core/url.ts`: `normalizeUrl(url, options)` and `registrableDomain()` through tldts (an
  allowed runtime dependency; consider the lighter variant and record it). Handles invalid URLs
  and the internal schemes of both browsers without throwing.
- Coverage: `@vitest/coverage-v8` with a ≥ 95% threshold (lines and branches) on `src/core/**`,
  enforced by `pnpm test`.

**Scope.** `src/core/{types,url}.ts`, Vitest config, tests.

**Done when.** At least 40 test cases on `url.ts`: tracking params, `www.`, ports, trailing slash,
SPA hash `#/`, sorted queries, `about:`/`chrome:`/`moz-extension:`, invalid URLs. `pnpm test`
fails if the coverage of `core/` drops below 95%.

### M1.2 — Page type classification

Every tab gets a class (search, auth, error…) from rules on the URL and the title, without reading
the page.

**Spec.** PLAN.md §6.3, §5.5 ("Internal pages" row).

**What to do.** `src/core/rules.ts` (all the host and pattern lists in a single data file) and
`src/core/classify.ts`. Covers the internal pages of Chrome and Edge and those of Firefox;
TabDeclutter's own pages are recognisable (the scoring needs them as a protection). Error titles
are multilingual (at least IT/EN).

**Scope.** `src/core/{rules,classify}.ts`, tests.

**Done when.** Table tests with at least 5 cases per class, including false friends (a page whose
path contains "login" but is not a login, if the rules tell them apart). Coverage of `core/`
≥ 95%.

### M1.3 — Duplicate whitelist patterns

The whitelist compatible with Duplicate Tabs Closer, compiled once and never a source of crashes.

**Spec.** PLAN.md §8.3 ("Duplicate whitelist").

**What to do.** `src/core/patterns.ts`: `compile(patterns) → { match(url): boolean, errors:
{ line, message }[] }`. `*` = any sequence; `/…/` lines = regex; an invalid regex = an error for
that line, which is ignored. A 500-character limit per pattern. Export the per-browser defaults.
Before writing, check the exact semantics of Duplicate Tabs Closer's syntax (case, anchoring,
flags) in its repository (github.com/Peuj/duplicate-tabs-closer) and record what you found.

**Scope.** `src/core/patterns.ts`, tests.

**Done when.** Tests on wildcards, regexes, invalid regexes, empty lines or lines with spaces, the
length limit, the Chrome and Firefox defaults, and at least 3 real patterns in Duplicate Tabs
Closer's syntax that behave as they do there.

### M1.4 — Duplicate key and choosing the tab to keep

One definition of duplicate and one priority rule, shared by Declutter and the guard.

**Spec.** PLAN.md §6.2 (last point), §8.3 ("URL comparison", "Priority and exclusions"), §8.4
point 3, §5.5 (containers, hidden tabs).

**What to do.** `src/core/duplicates.ts`:
- `duplicateKey(url, matchOptions, cookieStoreId?)`;
- `findDuplicateSets(tabs, options, isWhitelisted)`, which excludes `hidden` tabs;
- a priority comparator that implements §8.4.3 (pinned, navigated active tab, HTTPS, age, active
  window), exported so that M3b.1 reuses it without duplicating it.

**Scope.** `src/core/duplicates.ts`, tests.

**Done when.** There are tests for every `MatchOptions` option, for equivalent http/https, for
containers (the same URL in different containers = not a duplicate), for hidden tabs, for every
priority rule and for the combinations where the first rule that tells them apart wins.

### M1.5 — Labelled fixtures (before the scoring)

Realistic fixtures with a "suggest yes/no" label written with human judgement, before the algorithm
that must honour them exists.

**Spec.** PLAN.md §6.5, §1 (what makes a tab useless), §3.1 (a false positive costs more than a
false negative).

**What to do.**
- A deterministic script (seeded PRNG) in `scripts/` that generates `tests/fixtures/tabs-50.json`,
  `tabs-300.json` and `tabs-1000.json` from curated templates: searches, logins, documentation,
  GitHub PRs, YouTube, news, "for later" pages, duplicates, pinned, audio, groups, several windows,
  a forgotten window, titles in Italian and in English.
- Every tab has the `TabInfo` fields, the activity record and a fixed `now`. The `tabs-300` tabs
  also have `expected: 'suggest' | 'keep'` and a short rationale.
- The labels answer "would a careful user close it?", conservatively. **Do not derive them from
  scoring rules.**
- A test validates the fixtures' schema.

**Scope.** `scripts/`, `tests/fixtures/`, schema test. No scoring code.

**Done when.** The fixtures exist, can be regenerated identically and the schema is validated. The
label distribution (how many `suggest`, by type) is recorded in DECISIONS. Added to MANUAL-CHECKS:
"rivedere a campione 30 etichette di `tabs-300.json`".

### M1.6 — Uselessness score

The heart of the product: an explainable, deterministic and fast score.

**Spec.** PLAN.md §6.4 (all of it), §6.5, §4.3 (window-level suggestion), §11 (budgets).

**What to do.**
- `src/core/scoring.config.ts`: all the weights and thresholds.
- `src/core/scoring.ts`: `scoreTabs(tabs, activity, settings, now, context)` with steps 1–3, the
  buckets, the primary reason, all the reasons with the data for the i18n text, and the
  "forgotten window" signal for the §4.3 card.
  The `context` carries duplicates, keeps, protected domains, whitelist, bookmarks (optional) and
  the extension's origin.

**Scope.** `src/core/scoring*.ts`, tests, benchmarks.

**Done when.**
- Every rule has a table test.
- Property tests: a protected tab always scores 0; the score is monotonic in inactivity; the same
  inputs give the same output.
- Precision ≥ 0.9 on the `close` bucket of `tabs-300.json`. If you do not reach it, tune
  `scoring.config.ts` within the spec's margins. **Never change the labels.** If that is not
  enough, stop and report the numbers.
- Benchmark: median scoring time for 1000 tabs ≤ 15 ms, measured after a warm-up.
- The final precision and benchmark values are recorded in DECISIONS.

### M1.7 — Typed, versioned storage

Every persisted value has a typed item, with a version and defaults, so future migrations are
possible.

**Spec.** PLAN.md §10.

**What to do.** `src/platform/storage.ts` with WXT `storage.defineItem` for all the §10 keys
(`version: 1`, migration structure ready, defaults). Helpers for the archive (FIFO with a cap, one
write per action), for keeps with an expiry and for the guard's exemptions in `storage.session`.

**Scope.** `src/platform/storage.ts`, tests with `fakeBrowser` from `wxt/testing`.

**Done when.** Tests on defaults, reads and writes, the archive's FIFO cap, keep expiry and
exemptions with a TTL.

### M1.8 — Tab activity tracker

The background records when each tab was used, and remembers it across discards and restarts.

**Spec.** PLAN.md §6.1 (all of it), §5.5 ("Reconciliation after restart" and "Discard" rows), §16
(flush on `onSuspend`).

**What to do.**
- `src/core/reconcile.ts`: pure matching of the saved records to the current tabs by URL
  (multiset; on a tie the window/index order wins).
- `src/entrypoints/background/tracker.ts`: every event in the §6.1 table, coalescing writes with a
  1–2 s debounce, a flush where the platform allows it (check what Chrome's service worker and
  Firefox's event page offer, and record it), bootstrap on `onInstalled` with
  `bootstrapped: true`. On Firefox use `sessions.setTabValue`/`getTabValue` first.

**Scope.** `src/core/reconcile.ts`, tracker, registration in the background, tests.

**Done when.**
- Tests with `fakeBrowser` for creation, activation, foreground time with focus changes,
  navigation, `onReplaced`, removal, reconciliation at start-up (matched and discarded),
  bootstrap, and the Firefox path with mocked tab values.
- A test checks that N events close together produce a single write.
- Added to MANUAL-CHECKS: "riavviando Chrome l'età delle schede si conserva", the same on
  Firefox, and "una scheda sospesa da `chrome://discards` conserva il suo record".

## 5. PHASE M2 — Read-only Declutter view

### M2.1 — Design tokens, panel shell and reactive state

The panel's visual skeleton and the state that keeps it updated live.

**Spec.** PLAN.md §4.2 (header and navigation), §4.7, §5.2 (Side Panel), §11 (signals, stable
`key`s).

**What to do.**
- `styles/tokens.css` and `styles/base.css`: tokens, light/dark theme with `prefers-color-scheme`,
  spacing scale, typography, `prefers-reduced-motion`.
- `App` with a header (title, "N schede · M finestre", ⚙) and Riordina / Organizza / Archivio
  navigation. For now Organize and Archive show a simple empty state.
- `state/tabs.ts`: loads tabs, activity and settings; listens to `tabs.on*` with a 150 ms debounce
  and to `storage.onChanged`; computes the scores with `core/`.

**Scope.** `sidepanel/` (App, styles, state), tests.

**Done when.** A Chromium E2E checks that the header counts match the open tabs and windows and
update when one is opened. An E2E with `colorScheme: 'dark'` checks that the dark theme applies. No
console errors.

### M2.2 — Rows, sections and reasons

The Declutter view shows the suggested tabs, grouped by reason and explained in human language.

**Spec.** PLAN.md §4.2, §4.3 (except selection and bulk actions), §6.4 ("Reason texts"), §5.5
("Favicon" row), §11 (`content-visibility`).

**What to do.**
- `HealthBar`, `Section` (collapsible; "Da valutare" collapsed by default), `TabRow`, `Chip`,
  `EmptyState` components. Section order as in §4.3. Age with `Intl.RelativeTimeFormat`, plurals
  with `Intl.PluralRules`.
- `src/platform/favicon.ts`: `_favicon` on Chrome; on Firefox `favIconUrl` only if `data:`,
  otherwise an avatar with the initial and a colour from a hash of the domain.
- "Vai" action: activates the tab and focuses its window.
- "Forgotten window" card.
- The transformation from scored tabs to sections is a pure, tested function.

**Scope.** Declutter view, components, `favicon.ts`, i18n keys, tests.

**Done when.**
- Unit tests for the transformation into sections and for `favicon.ts` with mocked capabilities.
- A Chromium E2E with seeded tabs (local pages served by the test, activity aged by writing
  directly to storage): the expected sections appear with the correct reasons, and "Vai" activates
  the tab.
- Firefox smoke E2E: the view opens and shows the sections.

### M2.3 — Keyboard navigation and ARIA

The list can be used entirely from the keyboard and is readable by a screen reader.

**Spec.** PLAN.md §4.8 (navigation only, `Enter`, ARIA roles, live region, focus ring,
targets ≥ 24 px; `Space`/`Del`/`K`/`Ctrl+A`/`Ctrl+Z` belong to M3.2).

**What to do.** Roving tabindex on ↑/↓ between rows and between sections, `Enter` goes to the tab,
consistent ARIA roles (`listbox`/`option` or `grid`: choose and record), `aria-live="polite"` on the
counts, visible focus ring.

**Scope.** Declutter view components, tests.

**Done when.** A Chromium E2E walks the list with the keyboard only, opens and closes a section and
goes to a tab with `Enter`. The ARIA roles are checked in the DOM.

### M2.4 — Badge on the icon

The icon shows how many tabs are "Da chiudere", without polling.

**Spec.** PLAN.md §4.1 (Badge), §11 (2 s debounce, alarm every 30 min), §8.5 (flash, only prepared
here).

**What to do.** `src/entrypoints/background/badge.ts`: count of the `close` bucket with the same
`core/`, recomputed on tab events (2 s debounce) and on an alarm every 30 min, hidden at 0, neutral
colour, honouring the "Show badge" setting. Export a `flash()` function (colour change for 1.5 s)
that the guard will use.

**Scope.** `badge.ts`, registration in the background, tests.

**Done when.** Tests with `fakeBrowser` on the count, debounce, alarm, the setting turned off and
the value 0. A Chromium E2E reads the badge text from the service worker.

### M2.5 — Panel opening budget

With 300 tabs the panel must show the list within 150 ms.

**Spec.** PLAN.md §11, §13 M2 (acceptance).

**What to do.** Measure the time from opening the panel to the list being visible with 300 tabs.
The method (300 real tabs in the E2E, or a harness that renders the panel with the fixture's data)
is yours to choose and record. If you are over budget, optimize (signals, `content-visibility`,
deferred work). Real virtualization is needed only if nothing else is enough.

**Scope.** The panel code needed to get within budget, measurement test.

**Done when.** An automated test measures and checks ≤ 150 ms (median of several openings) and runs
in the gates. The measured number is recorded in DECISIONS.

## 6. PHASE M3 — Actions, archive, undo

### M3.1 — Tab actions and safeguards

Close, undo, keep, discard: all reversible, all with the §9 safeguards.

**Spec.** PLAN.md §9 (all of it), §8.6 (first row: exemptions for tabs opened by the extension),
§5.5 ("Tab groups" and "Discard" rows).

**What to do.**
- `src/core/actions.ts` (pure): building the `ArchivedTab` entries (no remote favicons) and
  computing the safeguards (a selection that covers a whole window, the active tab of the current
  window, more than 25 tabs).
- `src/platform/tabs.ts`:
  - close (archive in a batch, then remove);
  - undo (`sessions.getRecentlyClosed` by URL → `restore`, otherwise `tabs.create` with window and
    index, then re-insertion into the group; on Firefox the group is looked up by title);
  - keep (7 days or forever), protect site, discard, close window, restore from the archive.
- Every tab opened or restored by the extension is recorded in the guard's exemptions.

**Scope.** `core/actions.ts`, `platform/tabs.ts`, tests.

**Done when.** Pure tests on the safeguards. Tests with `fakeBrowser` for every action, including
undo with no entry in `getRecentlyClosed`, a group that no longer exists and a tab already closed.

### M3.2 — Selection, bar, toast and row actions

The user selects, closes and undoes from the panel, with the mouse or the keyboard.

**Spec.** PLAN.md §4.3 (row actions, section header, selection bar, toast), §4.8
(`Space`, `Del`/`Backspace`, `K`, `Ctrl/Cmd+A`, `Ctrl/Cmd+Z`), §9 (Safeguards: inline
confirmations, never `confirm()`).

**What to do.**
- `state/selection.ts` and `state/undo.ts`.
- Sticky `SelectionBar` (Chiudi N, Mantieni, Sospendi; "Raggruppa" arrives in M4.3).
- Inline confirmations.
- 8 s `Toast`: focusable, does not disappear while hovered, `aria-live`.
- Row actions on hover/focus.
- "Chiudi tutti (N)" and "Seleziona tutti" in the sections.
- Keyboard shortcuts.

**Scope.** Panel components and state, i18n, tests.

**Done when.** Unit tests on selection and undo. A Chromium E2E covers: closing a selection, the
toast, Annulla; the confirmation above 25 tabs; the confirmation for the active tab; the text
"Chiudi N schede e la finestra"; the shortcuts.

### M3.3 — Archive view and periodic cleanup

Everything that was closed can be found, searched and restored; the archive does not grow without
limit.

**Spec.** PLAN.md §4.5, §10 (cleanup every 6 h).

**What to do.**
- `ArchiveView`: search on title and URL; filters by date and by origin; single and multiple
  restore; delete; empty with an inline confirmation; export as a Markdown list of links to the
  clipboard.
- A cleanup alarm every 6 h in the background: archive entries beyond retention or the cap,
  expired keeps, orphaned activity records.

**Scope.** `ArchiveView`, cleanup in the background, i18n, tests.

**Done when.** Unit tests on filters, search, export and cleanup (with an injected `now`). A
Chromium E2E covers search, restore and empty.

### M3.4 — Page and tab context menus

"Mantieni sempre", "Proteggi sito" and "Consenti duplicati per questo sito" one right-click away.

**Spec.** PLAN.md §4.1 (context menu on the page/tab), §5.5 ("Context menus" row).
The guard-related icon menus belong to M3b.3.

**What to do.** `src/entrypoints/background/menus.ts`: the three items, common contexts (`page`,
plus `tab` if it exists), registration on `onInstalled`, i18n titles. "Consenti duplicati per questo
sito" adds `*://<domain>/*` to the whitelist.

**Scope.** `menus.ts`, registration in the background, tests.

**Done when.** Tests with `fakeBrowser` for every item. Added to MANUAL-CHECKS: "i menu
contestuali compaiono e funzionano su Chrome e Firefox".

### M3.5 — Actions E2E

The M3 acceptance verified on the real extension.

**Spec.** PLAN.md §13 M3 (acceptance), §14 (E2E: close + undo, keep, archive).

**What to do.**
- Chromium E2E:
  - close 10 tabs → Annulla → they all come back, same URL, same window;
  - the archive survives a browser restart (relaunch the persistent context on the same profile);
  - "Mantieni" removes the tab from the suggestions, and the tab comes back when the keep expires
    (simulate time by writing expiries to storage);
  - the §9 safeguards.
- Firefox smoke: close + undo.

**Scope.** Tests only (plus the fixes the tests reveal, in the same commit).

**Done when.** All these E2E tests pass in the gates.

## 7. PHASE M3b — Duplicate protection

### M3b.1 — Pure guard decision

The function that decides which tab to close and which to keep, covered case by case.

**Spec.** PLAN.md §8.4 (all of it), §8.6 (exit filters), §8.3 (options).

**What to do.** `src/core/duplicate-guard.ts`: `resolveDuplicate(trigger, candidates, ctx)` as in
§8.4. Reuses `duplicateKey`, the M1.4 priority comparator and `patterns.ts`, without duplicating
them.

**Scope.** `src/core/duplicate-guard.ts`, tests.

**Done when.** At least 30 test cases: every exit filter, every priority rule and their
combinations, window and all-windows scope, pinned, new tab vs navigated active tab, background
opening, whitelist, invalid regex, `reloadKeptWith`, `move-activate`.

### M3b.2 — Live guard in the background

The guard closes duplicates in real time, without ever letting two of them close each other.

**Spec.** PLAN.md §8.1, §8.2, §8.5 (badge flash), §8.6 (every edge case), §5.5 (`pendingUrl`,
"Duplicate tab", containers and hidden tabs rows), §11 (latencies).

**What to do.** `src/entrypoints/background/guard.ts`:
- `Map<duplicateKey, Set<tabId>>` index rebuilt on wake-up;
- a serial queue and a single `ready` promise;
- `onCreated`/`onUpdated`/`onAttached`/`onReplaced`, with the Firefox path without `pendingUrl`;
- exemptions, a 15 s grace period at start-up, pause with an alarm and `storage.session`;
- the "Duplicate tab" heuristic (Chrome only);
- the actions after closing, with the background-opening exception;
- archive with the reason `duplicate-auto` and a reference to the kept tab;
- `badge.flash()`.

**Scope.** `guard.ts`, registration in the background, tests.

**Done when.**
- Tests with `fakeBrowser`: every mode; 20 simultaneous openings of the same URL leave exactly
  one tab; exemptions with a TTL; start-up grace; returning from pause to the previous mode;
  Firefox without `pendingUrl`; containers; `onReplaced` updating the index without closing
  anything.
- Added to MANUAL-CHECKS: "'Duplica scheda' su Chrome stabile non viene chiusa (o il segnale
  inaffidabile è annotato in DECISIONS)" and "flussi di login con redirect non vengono interrotti".

### M3b.3 — Guard commands and menus

Shortcuts and icon menus to close all duplicates, pause, and reopen the last one closed.

**Spec.** PLAN.md §4.1 (shortcuts, icon menu), §8.5 ("Quick restore"), §8.7.

**What to do.**
- Commands `close-all-duplicates` (works in OFF and "Solo avvisi" too, archives; undo goes
  through the icon menu) and `toggle-duplicate-guard`.
- Icon menu:
  - "Riapri l'ultimo duplicato chiuso", with an exemption;
  - "…e consenti sempre duplicati per questo sito";
  - "Pausa protezione duplicati" 15 min / 1 h / until restart.

**Scope.** `menus.ts`, commands in the background, i18n, tests.

**Done when.** Tests with `fakeBrowser` for every command and every menu item, including the
reopened tab not being closed again by the guard.

### M3b.4 — Guard interface and whitelist

The user sees the protection's state, configures it, and pastes the whitelist they use today.

**Spec.** PLAN.md §4.2 ("🛡 Duplicati" chip and counter), §8.3 (the whole sub-page), §8.6
(warnings: "Più recente", coexistence with Duplicate Tabs Closer), §8.7 ("Chiudi tutti" from
Declutter), §5.5 (options hidden on Firefox).

**What to do.**
- `GuardChip`: state, menu, 5 s counter.
- A settings shell reachable from ⚙ (the rest of the settings is M6.1) with
  `DuplicateSettingsView`.
- `PatternListEditor`: live per-line validation, "matches N open tabs" preview, explanation of the
  import from Duplicate Tabs Closer, per-browser defaults.
- Options conditioned on the capabilities: "Duplicate tab" only on Chrome, containers only on
  Firefox.
- "Chiudi tutti i duplicati" in Declutter's Duplicates section.

**Scope.** Panel components and views, i18n, tests.

**Done when.** Unit tests for the editor (valid lines, invalid lines, preview). A Chromium E2E
changes the mode from the chip and saves a whitelist. Unit tests with mocked capabilities for the
hidden options.

### M3b.5 — Duplicate protection E2E

The M3b acceptance, case by case, on the real extension.

**Spec.** PLAN.md §13 M3b (acceptance, every point), §14 (duplicate protection E2E).

**What to do.**
- Chromium E2E for every M3b acceptance point:
  - the second opening closes in under 300 ms and the first is activated;
  - wildcard and regex whitelist;
  - pause and return to the previous mode;
  - Ctrl+click without a focus change;
  - Annulla not closed again;
  - 20 simultaneous openings → one remains;
  - a whitelist pasted in Duplicate Tabs Closer format;
  - window / all-windows scope;
  - "Sposta e attiva";
  - "Più vecchia ricaricata";
  - the navigated active tab rule.
- Firefox smoke: guard on a duplicate URL.

**Scope.** Tests only (plus the fixes they reveal, in the same commit).

**Done when.** All these E2E tests pass in the gates.

## 8. PHASE M4 — Organize without AI

### M4.1 — Grouping by site and by topic

Deterministic group proposals: by domain and by topic, without AI.

**Spec.** PLAN.md §7.1, §7.2, §11 (clustering 300 tabs ≤ 50 ms).

**What to do.** `src/core/cluster.ts`:
- by site (at least 3 tabs, configurable; readable names from a map; stable colour from a hash);
- by topic: tokenization with IT/EN stopwords and removal of site suffixes, TF-IDF with a domain
  token, agglomerative average linkage with a ~0.25 threshold, minimum 2, maximum 8 groups,
  "Altro";
- run per window.

**Scope.** `src/core/cluster.ts`, tests, benchmarks.

**Done when.** Tests on determinism, limits (8 groups, minimum 2), stable names and colours, and
stopwords. Benchmark: median ≤ 50 ms on `tabs-300`. Coverage of `core/` ≥ 95%.

### M4.2 — Applying and undoing groups

The proposed groups become native groups, and undo puts everything back exactly as it was.

**Spec.** PLAN.md §7.4, §4.4 (points 4–5 and the last one), §5.5 ("Tab groups" row).

**What to do.** In `src/platform/`:
- `{tabId, windowId, index, groupId}` snapshot;
- `tabs.group` per window + `tabGroups.update` (title, colour, collapsed);
- options: sort by group, leave pinned tabs out, include the user's groups;
- partial errors summarised in one message;
- undo: ungroup + original indexes and groups (on Firefox with the title fallback).

**Scope.** Platform module for groups, tests.

**Done when.** Tests with `fakeBrowser`: apply → undo restores exactly the order and the groups; a
tab closed in the meantime; the user's groups not touched by default.

### M4.3 — Organize view

An editable preview of the groups before applying them.

**Spec.** PLAN.md §4.4 (all of it), §4.3 ("Raggruppa" in the selection bar), §11 (dynamic
`import()`).

**What to do.**
- `OrganizeView` loaded with `import()`: scope, mode, `GroupPreview` preview.
- Edits in the preview: inline rename, colour, deselect, "Sposta in…", merge.
- Options, Applica and a toast with Annulla.
- "Raggruppa" from Declutter's selection bar brings the selection into the preview.

**Scope.** View, components, i18n, tests.

**Done when.** Unit tests on the preview edits (pure functions). A Chromium E2E covers: preview by
site → rename → Applica → native groups with title and colour → Annulla.

### M4.4 — Cluster review and Organize E2E

Topic grouping judged on realistic data, and the M4 acceptance on both browsers.

**Spec.** PLAN.md §13 M4 (acceptance), §14 (organize E2E).

**What to do.**
- `docs/CLUSTER-REVIEW.md`: run topic grouping on `tabs-300` and judge at least 8 clusters
  (sensible / not / why). If the result is clearly poor, tune the threshold in `cluster.ts` and
  record it.
- Complete the E2E tests: Chromium "apply and undo restore exactly the order and the groups";
  Firefox smoke "organize by site → undo".

**Scope.** `docs/CLUSTER-REVIEW.md`, tests, tuning if needed.

**Done when.** The review is written and the E2E tests pass in the gates. Added to MANUAL-CHECKS:
"leggere CLUSTER-REVIEW.md e provare Organizza per argomento sulle proprie schede".

## 9. PHASE M5 — On-device AI

### M5.1 — AI grouping with an injected LLM

The complete AI logic, tested with a fake model: batching, schema, validation, fallback.

**Spec.** PLAN.md §7.3 (prompt, schema, batching, validation, Italian names, "the AI never decides
what to close").

**What to do.** `src/core/ai-grouping.ts`:
- injected LLM interface;
- compact `id|title|host` input;
- `responseConstraint` with the §7.3 schema;
- batches of up to ~40 with a context check, and a smaller batch on `QuotaExceededError`;
- above 40 tabs, pre-clustering with `cluster.ts`;
- validation (invented IDs discarded, missing ones in "Other", no duplicates) and fallback to §7.2.

The choice about Italian names must be recorded in DECISIONS.

**Scope.** `src/core/ai-grouping.ts`, tests.

**Done when.** Tests with mocks for: valid output, invented IDs, duplicate IDs, malformed JSON,
quota exceeded, timeout, more than 40 tabs.

### M5.2 — Prompt API adapter and integration

On Chrome with Gemini Nano available, Organize by topic uses the AI; elsewhere nobody notices.

**Spec.** PLAN.md §7.3 ("Detection and state", "Performance"), §4.4 ("AI on-device" badge), §4.6
(AI row), §5.5 ("On-device AI" row), §11 (`import()`).

**What to do.** First check the current API at developer.chrome.com/docs/ai/prompt-api: APIs
change. Then `src/platform/llm.ts`:
- availability states;
- download only on click, with progress;
- a lazy session, reused and destroyed when the panel closes;
- `AbortController`, a 20 s timeout with fallback.

Integrate it into Organize and into the settings state. With `caps.promptApi` false the option does
not appear. Loaded dynamically, so the Firefox build does not pay for it.

**Scope.** `llm.ts`, Organize view, i18n, tests.

**Done when.** Tests with a mocked `LanguageModel` for every availability state, timeout and abort.
A Chromium E2E without the model checks that no errors appear and that the fallback is used. Added
to MANUAL-CHECKS: "su questo PC, con il modello: gruppi per 40 schede in meno di 10 s (oppure:
hardware non supportato, fallback verificato)".

## 10. PHASE M6 — Settings, polish, accessibility

### M6.1 — Complete settings

All the §4.6 settings, including bookmarks with the optional permission, and the language.

**Spec.** PLAN.md §4.6, §6.4 ("Already bookmarked" component), §5.4 (`optional_permissions`).

**What to do.**
- Complete `SettingsView`.
- The "bookmarks" toggle requests the `bookmarks` permission inside the user gesture and turns on
  the +10 signal in the scoring.
- Automatic / IT / EN language: `browser.i18n` does not allow changing the language at runtime,
  so choose the mechanism (e.g. loading the requested `messages.json`) and record it.

**Scope.** `SettingsView`, i18n, scoring (only the bookmarks hook-up), tests.

**Done when.** Unit tests on every setting that changes the core's behaviour. A Chromium E2E
changes the language and the threshold and sees the effect. Added to MANUAL-CHECKS: "toggle
preferiti: compare la richiesta di permesso (Chrome, Firefox)".

### M6.2 — First-run onboarding

A single screen in the panel that has the user choose the threshold and the guard mode.

**Spec.** PLAN.md §17, §8.1 (default mode chosen in onboarding).

**What to do.** A single screen on first run, never pages opened automatically. The choices are
saved in the settings. The "Hai una whitelist di Duplicate Tabs Closer?" link opens the editor.

**Scope.** Onboarding component, "onboarding completed" state, i18n, tests.

**Done when.** A Chromium E2E covers: first run → onboarding → choices → "Inizia" → the settings
reflect the choices → when the panel is reopened the onboarding does not come back.

### M6.3 — Visual polish and final icon

Empty states, restrained animations, reduced motion honoured, and an icon readable at 16 px.

**Spec.** PLAN.md §4.3 (empty state), §4.7 (motion, icon).

**What to do.**
- 150 ms animations and height collapse on close, all disabled with `prefers-reduced-motion`.
- Empty states for every view.
- Icon: source SVG plus PNG 16/32/48/128 generated by a script (an allowed dev dependency, to be
  recorded), wired into the manifest.

**Scope.** CSS and components, `src/public/icon/`, generation script.

**Done when.** An E2E with `reducedMotion: 'reduce'` checks that there are no transitions. The
icons are generated reproducibly and present in both manifests.

### M6.4 — Accessibility audit and i18n completeness

Zero serious accessibility violations and no forgotten string.

**Spec.** PLAN.md §13 M6 (acceptance), §4.8.

**What to do.**
- `@axe-core/playwright` in the Chromium E2E tests on every view (Declutter, Organize, Archive,
  Settings, Duplicate protection, Onboarding), in light and dark theme.
- Tests: every key used in the code exists in `en` and in `it`, no unused keys, no hand-written
  visible string (a test or a lint rule: choose and record).

**Scope.** Accessibility tests and fixes.

**Done when.** axe reports zero "serious" and "critical" violations on every view, in both themes.
The i18n tests pass. Added to MANUAL-CHECKS: "NVDA sulle azioni principali" and "zoom al 200%".

## 11. PHASE M7 — Hardening and release preparation

### M7.1 — Complete E2E on both browsers

Every §14 flow automated, or explicitly in the manual checklist.

**Spec.** PLAN.md §14 (E2E, Firefox E2E, compatibility unit tests, manual).

**What to do.** Compare the §14 lists with the existing tests and complete the missing ones.
Whatever cannot be automated on Firefox goes into MANUAL-CHECKS. Gather in MANUAL-CHECKS all the
manual items of §14 (Chrome and Firefox).

**Scope.** Tests, MANUAL-CHECKS.

**Done when.** Every §14 item corresponds to a test that passes in the gates or to an entry in
MANUAL-CHECKS. The correspondence list is in `docs/TEST-COVERAGE.md`.

### M7.2 — Bundle budget as a gate

The package size becomes an automated check.

**Spec.** PLAN.md §11 (JS budgets), §13 M7 (`rollup-plugin-visualizer`).

**What to do.**
- A report with `rollup-plugin-visualizer`.
- A `size` script: gzip of the panel's initial JS ≤ 60 KB (tldts excluded only if recorded) and
  of the background ≤ 15 KB, on both builds.
- Add to `phasekit.json` the gate `{ "name": "bundle size", "cwd": ".", "run":
  "pnpm size" }`.

If the budget is exceeded, optimize. If that is impossible without violating the spec, stop and
report.

**Scope.** Build config, `size` script, `phasekit.json` (only adding the gate), any
optimizations.

**Done when.** `pnpm size` passes and is a gate. The measurements are recorded in DECISIONS.

### M7.3 — Store documents

All the text needed to publish, ready to copy into the forms.

**Spec.** PLAN.md §12 (all of it), §8.6 (coexistence with Duplicate Tabs Closer).

**What to do.**
- `docs/PRIVACY.md`.
- `docs/PERMISSIONS.md`: one permission per row, per browser, with the warning text and the
  justification.
- `docs/STORE_LISTING.md`: IT/EN texts for the Chrome Web Store and AMO, AMO summary ≤ 250
  characters, single purpose.
- `docs/AMO_REVIEW.md`: operating system, exact Node and pnpm versions, build commands, notes for
  reviewers.
- Complete `README.md`, `CHANGELOG.md`.

**Scope.** Documents only.

**Done when.** The documents exist and are consistent with the real manifest: a test or a script
compares the list of permissions in `PERMISSIONS.md` with the built manifests.

### M7.4 — Store screenshots

1280×800 screenshots generated by a script, reproducible for every version.

**Spec.** PLAN.md §12.2 and §12.3 (assets), §13 M7.

**What to do.** A script that, with seeded demo data, produces 1280×800 screenshots of Declutter,
Organize, Duplicate protection, Archive and the dark theme: Chromium with Playwright, Firefox with
Puppeteer. The panel is narrow: compose the screenshot (e.g. the panel at its real width inside a
1280×800 frame) and record the method. Output in `docs/store/`.

**Scope.** Script and generated images.

**Done when.** The script runs from a single command and produces the images at the required size.
Added to MANUAL-CHECKS: "rivedere gli screenshot prima dell'invio".

### M7.5 — Packages and reproducible build

Zips ready for both stores, and proof that AMO can rebuild the package from the sources.

**Spec.** PLAN.md §12.3 (sources, reproducible build, `minify: false` to be considered), §12.4.

**What to do.**
- `pnpm zip` and `pnpm zip:firefox`. The sources zip contains no minified or generated files
  (`.output/`, `node_modules/`, `.phasekit/`).
- A script that unpacks the sources zip into a temporary folder, runs
  `pnpm install --frozen-lockfile && pnpm build:firefox` and compares the result with the add-on
  zip.
- `release.yml` on `v*` tags, without automatic submission to the stores.
- Decide on `minify: false` for Firefox and record it.

**Scope.** Zip config, verification script, `.github/workflows/release.yml`.

**Done when.** The reproducibility script passes locally. `release.yml` is valid YAML.
**No submission to the stores** (it is a manual step for the owner, in MANUAL-CHECKS).

### M7.6 — Release checklist and final audit

An honest account of where things stand: what is verified, what is left to the owner.

**Spec.** PLAN.md §14 ("Release checklist"), §13 M7 (acceptance).

**What to do.**
- `docs/RELEASE-CHECKLIST.md`: every §14 item with its status and the evidence (command run and
  result) or a pointer to MANUAL-CHECKS.
- Audit: compare `README.md`, `docs/` and `TASKS.md` with the code and fix whatever has become
  untrue.

**Scope.** Documents.

**Done when.** Every item of the §14 checklist has a status with evidence or a pointer. No statement
in the documents is contradicted by the code.

## 12. Ledger

Ticked **in the same commit** as the task, never before. `phasekit status` shows it next to the
`git log`.

- [x] M0.1 Toolchain and project skeleton
- [x] M0.2 Per-browser manifest, capabilities and opening the panel
- [x] M0.3 i18n and a localized "Hello" panel
- [ ] M0.4 Chromium E2E harness
- [ ] M0.5 Firefox E2E harness
- [ ] M0.6 GitHub Actions CI
- [ ] M1.1 Types and URL normalization
- [ ] M1.2 Page type classification
- [ ] M1.3 Duplicate whitelist patterns
- [ ] M1.4 Duplicate key and choosing the tab to keep
- [ ] M1.5 Labelled fixtures (before the scoring)
- [ ] M1.6 Uselessness score
- [ ] M1.7 Typed, versioned storage
- [ ] M1.8 Tab activity tracker
- [ ] M2.1 Design tokens, panel shell and reactive state
- [ ] M2.2 Rows, sections and reasons
- [ ] M2.3 Keyboard navigation and ARIA
- [ ] M2.4 Badge on the icon
- [ ] M2.5 Panel opening budget
- [ ] M3.1 Tab actions and safeguards
- [ ] M3.2 Selection, bar, toast and row actions
- [ ] M3.3 Archive view and periodic cleanup
- [ ] M3.4 Page and tab context menus
- [ ] M3.5 Actions E2E
- [ ] M3b.1 Pure guard decision
- [ ] M3b.2 Live guard in the background
- [ ] M3b.3 Guard commands and menus
- [ ] M3b.4 Guard interface and whitelist
- [ ] M3b.5 Duplicate protection E2E
- [ ] M4.1 Grouping by site and by topic
- [ ] M4.2 Applying and undoing groups
- [ ] M4.3 Organize view
- [ ] M4.4 Cluster review and Organize E2E
- [ ] M5.1 AI grouping with an injected LLM
- [ ] M5.2 Prompt API adapter and integration
- [ ] M6.1 Complete settings
- [ ] M6.2 First-run onboarding
- [ ] M6.3 Visual polish and final icon
- [ ] M6.4 Accessibility audit and i18n completeness
- [ ] M7.1 Complete E2E on both browsers
- [ ] M7.2 Bundle budget as a gate
- [ ] M7.3 Store documents
- [ ] M7.4 Store screenshots
- [ ] M7.5 Packages and reproducible build
- [ ] M7.6 Release checklist and final audit

## 13. PHASE F — Fixes from the manual checks

Tasks added during the work, when a manual check finds a problem. Each one has the same shape as
the others: a `### F.<n> — …` title, the check that gave rise to it, what happens and what should
happen (in the owner's words), **Spec**, **What to do**, **Scope**, **Done when**. "Done when"
always includes an automated test that reproduces the problem, when one is possible, and a new
entry in MANUAL-CHECKS to try it again by hand. The ledger row goes at the end of section 12 and the
target goes into `autoSequence` right after the task in progress.
