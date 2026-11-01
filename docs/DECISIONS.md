# Decisions

Choices that PLAN.md did not make, and places where a browser API behaved differently from the
spec. One entry per decision, newest at the bottom. Format in AGENT-RULES.md.

## setup — Execution plan and tooling for unattended runs
- **Context:** PLAN.md §13 describes milestones of one or two days each, too large for one
  reviewable commit.
- **Decision:** the milestones are split into 45 single-commit tasks in TASKS.md and run by
  phasekit. The gates live only in `phasekit.json` and grow as the project gains checks (M0.4,
  M0.5, M7.2). Checks that need a person are collected in `docs/MANUAL-CHECKS.md` and do not block
  the sequence.
- **Why:** one task per commit keeps every change reviewable and revertable on its own, and the
  gates are re-run before every merge.

## setup — Firefox add-on id (provisional)
- **Context:** PLAN.md §5.4 leaves `gecko.id` as `tabdeclutter@<domain-or-username>`, and the id
  can never change after the first AMO submission.
- **Decision:** `tabdeclutter@robertoreale`, provisional.
- **Why:** the build needs an id from M0.1. The owner confirms or changes it before the first AMO
  submission (an entry in MANUAL-CHECKS.md).

## setup — The owner is called, not polled
- **Context:** the owner does not want to watch the run or remember which manual checks are due.
- **Decision:** `tools/assistant.ps1` runs every 10 minutes as a scheduled task. When the sequence
  stops, a phase with manual checks finishes, the runner dies or everything is done, it plays a
  sound, shows a notification and opens `Desktop\TabDeclutter - cosa fare.html` with step-by-step
  instructions. Manual checks run on a stable build of `main` copied to
  `%USERPROFILE%\TabDeclutter-prova`, never on the runner's working tree. Answers, check results
  and fix tasks go through an interactive Claude session (CLAUDE.md), which edits `main` only via
  `-BeginEdit`/`-EndEdit` so the runner's tree is never touched.
- **Why:** a stop that nobody notices costs hours, and checks done long after their phase find
  problems that later work has already been built on.

## M0.1 — Pinned toolchain versions
- **Context:** PLAN.md §12.3 requires an AMO reviewer to rebuild the add-on identically, so every
  version has to be exact. TypeScript 7.0.2 is the current stable release, but typescript-eslint
  8.72.1 (the current stable) declares `typescript >=4.8.4 <6.1.0`.
- **Decision:** Node 24.13.0 (`.nvmrc`), pnpm 11.17.0 (`packageManager`), WXT 0.21.5,
  Preact 11.1.0, `@preact/signals` 2.11.4, TypeScript **6.0.3**, typescript-eslint 8.72.1,
  ESLint 10.14.0, Prettier 3.9.10, Vitest 5.0.5, web-ext 10.8.0. Every dependency is pinned to an
  exact version and `pnpm-lock.yaml` is committed, together with the `pnpm-workspace.yaml` that
  pnpm 11 generates for its release-age policy.
- **Why:** TypeScript 6.0.3 is the newest release typescript-eslint supports; running the lint gate
  on an unsupported compiler would mean accepting warnings we cannot act on. `engines.node` stays a
  range (`>=22.12.0`, what WXT and Vitest need) while `.nvmrc` carries the exact version, so the
  reproducible build has one answer and contributors are not blocked on one patch release.

## M0.1 — Preact is integrated with `@preact/preset-vite`
- **Context:** WXT ships framework modules (`@wxt-dev/module-react`, `-vue`, `-svelte`, `-solid`)
  but there is no `@wxt-dev/module-preact` on npm. TASKS.md M0.1 leaves the integration open.
- **Decision:** `@preact/preset-vite` 2.10.6, added through `vite: () => ({ plugins: [preact()] })`
  in `wxt.config.ts`, with `jsx: "react-jsx"` and `jsxImportSource: "preact"` in `tsconfig.json`.
- **Why:** it is Preact's own Vite plugin and the only maintained option; it brings the JSX
  transform and prefresh (per-component HMR for `pnpm dev`), which is what the WXT framework
  modules do for the other frameworks.

## M0.1 — Firefox is built as MV3
- **Context:** `wxt build -b firefox` defaults to MV2, so it wrote `.output/firefox-mv2` while the
  `lint:firefox` gate and PLAN.md §5.4 both expect `.output/firefox-mv3`.
- **Decision:** `manifestVersion: 3` in `wxt.config.ts`, for every browser.
- **Why:** PLAN.md §5.4 specifies MV3 on both browsers (event page on Firefox, `strict_min_version`
  140), and AMO accepts MV3. Keeping one manifest version avoids a second code path.

## M0.1 — Unit tests live in `tests/unit/`, with a plain Vitest config
- **Context:** PLAN.md §5.3 puts the unit tests in `tests/unit/`, next to `tests/fixtures/` and
  `tests/e2e/`. WXT also offers a `WxtVitest()` plugin that mocks the extension APIs.
- **Decision:** `vitest.config.ts` with `include: ['tests/unit/**/*.test.ts']` and
  `passWithNoTests: false`, no WXT plugin yet.
- **Why:** `src/core/` is pure TypeScript by invariant 4, so these tests need no browser API. The
  task that first tests code touching `platform/` (M1.7) adds `WxtVitest()` then, with a reason.

## M0.1 — Prettier does not format the plan documents
- **Context:** `prettier --check .` is part of the `lint` gate, and it wanted to reflow PLAN.md,
  TASKS.md, AGENT-RULES.md, PROMPTS.md, RUNNING.md, CLAUDE.md and `docs/`.
- **Decision:** those files are listed in `.prettierignore`; Prettier covers the code, the configs
  and README.md.
- **Why:** agents navigate PLAN.md by the line numbers of `grep -n '^#' PLAN.md`, and
  `docs/MANUAL-CHECKS.md` is read to the owner word for word. Reflowing prose would move those
  lines and add noise to every diff without making anything safer.

## M0.1 — The two `web-ext lint` warnings, assessed
- **Context:** PLAN.md §12.3 requires 0 errors and says the warnings must be assessed and
  documented. The Firefox build reports 0 errors, 0 notices and 2 warnings.
- **Decision:** both are accepted as they are.
  - `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`: `strict_min_version: "140.0"` predates the
    Firefox for Android 142 that understands `data_collection_permissions`. TabDeclutter is a
    desktop add-on (side panel, tab groups, `about:debugging`), so Android is not a target; both
    keys come straight from PLAN.md §5.4.
  - `UNSAFE_VAR_ASSIGNMENT` on `chunks/sidepanel-*.js`: it is Preact's own renderer, the branch
    that implements `dangerouslySetInnerHTML` (`t.innerHTML = g.__html`). Nothing reaches it,
    because ESLint forbids `dangerouslySetInnerHTML`, `innerHTML` and `outerHTML` in our sources
    (invariant 7). It cannot be removed without forking Preact.
- **Why:** neither warning describes something this extension does; recording them here is what
  `docs/AMO_REVIEW.md` will cite at submission time.

## M0.2 — The manifest is built by `build/manifest.ts`
- **Context:** TASKS.md M0.2 asks for the manifest-building function in a testable module, and
  PLAN.md §5.3 does not name a place for build-time code that is not part of `src/`.
- **Decision:** `build/manifest.ts`, exporting `buildManifest(browser)`, which `wxt.config.ts`
  calls from `manifest: ({ browser }) => …`. The Firefox-only `sidebar_action` key is declared
  there too, because WXT derives `UserManifest` from Chrome's MV3 type and does not know it.
- **Why:** it keeps PLAN.md §5.4 stated once, in a module `tests/unit/manifest.test.ts` can assert
  key by key (invariant 8), while leaving `src/` to the extension's own code. `build/` sits next to
  the other root-level build configuration (`wxt.config.ts`, `eslint.config.js`).

## M0.2 — Provisional Firefox add-on id
- **Context:** PLAN.md §5.4 leaves `gecko.id` as `tabdeclutter@<domain-or-username>`.
- **Decision:** `tabdeclutter@robertoreale`, to be confirmed before the first AMO submission and
  immutable afterwards. The owner's reminder is the `(setup)` entry in `docs/MANUAL-CHECKS.md`,
  whose path now points at `build/manifest.ts`.
- **Why:** AMO identifies the add-on by this string for the rest of its life, and a wrong one
  cannot be corrected after the first upload
  ([AMO](https://extensionworkshop.com/documentation/develop/extensions-and-the-add-on-id/)). The
  build needs an id now, so the choice is made and flagged rather than postponed.

## M0.2 — What WXT adds to or takes from the manifest of PLAN.md §5.4
- **Context:** the "Done when" of M0.2 requires the two built manifests to be inspected and the
  differences WXT imposes to be recorded. They were read from `.output/chrome-mv3/manifest.json`
  and `.output/firefox-mv3/manifest.json` after `pnpm build` and `pnpm build:firefox`.
- **Decision:** four differences are accepted, one is worked around.
  - `version: "0.1.0"`: WXT copies it from `package.json`. A required key that §5.4 omits.
  - `background`: WXT generates it from the entrypoint, `service_worker` on Chrome and
    `scripts: ["background.js"]` on Firefox. §5.4 shows the Firefox form and leaves Chrome's
    implicit.
  - `action` is present on the Firefox build too. §5.4's Firefox block lists only the differences
    from Chrome, and PLAN.md §4.1 needs `browser.action.onClicked` there to toggle the sidebar, so
    the key has to exist.
  - `sidebar_action` is **regenerated** by WXT from the sidepanel entrypoint, overwriting the one
    in `build/manifest.ts`, which silently dropped `open_at_install`. Firefox's own default for it
    is `true`
    ([MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/sidebar_action#syntax)),
    i.e. the panel would open by itself at install, against PLAN.md §3.1. It is set where WXT
    reads it, as `<meta name="manifest.open_at_install" content="false" />` in
    `src/entrypoints/sidepanel/index.html` (`default_title` likewise comes from its `<title>`).
    `tests/unit/manifest.test.ts` asserts the HTML and `build/manifest.ts` still agree.
  - WXT adds the `sidePanel` permission for a sidepanel entrypoint on Chrome; §5.4 lists it, and
    WXT does not duplicate it.
- **Why:** none of the four changes what the extension may do. The fifth did, so it was fixed
  rather than recorded.

## M0.2 — `__MSG_*` and `default_locale` wait for M0.3
- **Context:** PLAN.md §5.4 writes `name`, `description`, the action title and the two command
  descriptions as `__MSG_*` placeholders with `default_locale: "en"`. `_locales/` is created by
  M0.3, and `default_locale` without it makes the extension refuse to load, which would leave
  M0.2's two manual checks impossible to perform.
- **Decision:** English literals for now, and no `default_locale`. M0.3 replaces the five strings
  with `__MSG_extName__`, `__MSG_extDescription__`, `__MSG_actionTitle__`,
  `__MSG_cmdCloseDuplicates__`, `__MSG_cmdToggleGuard__`, adds `default_locale: "en"` and updates
  `tests/unit/manifest.test.ts`. The Firefox `sidebar_action.default_title` lives in the
  entrypoint's `<title>`, so M0.3 changes that too.
- **Why:** a build nobody can load is worth less than a build in one language, and M0.3 is the
  next task in the sequence. Invariant 11 (every visible string goes through i18n) is M0.3's to
  enforce, with the `en`/`it` parity test.

## M0.2 — `capabilities.ts` reads WXT's `browser`, not `globalThis.browser`
- **Context:** PLAN.md §5.5 writes the probes as `!!browser.tabGroups`, `!!browser.sidebarAction`
  and so on. Reading them off `globalThis` instead looked equivalent and avoids depending on an
  auto-import, but Chrome does not define a `browser` global at all: every one of those
  capabilities came out `false` in the Chrome bundle.
- **Decision:** `currentEnv()` uses the `browser` WXT provides, which resolves to Firefox's
  namespace or to `chrome` on Chrome, behind a `typeof` guard so that `detectCapabilities` can be
  imported by a unit test where no auto-import exists. `chrome` itself is still read off
  `globalThis`, as §5.5 does, because both browsers define it.
- **Why:** the capability table is what the rest of the code asks instead of naming a browser
  (invariant 5), so a probe that is wrong on one browser is worse than no probe. Caught by reading
  `.output/chrome-mv3/background.js`, not by a test: a mocked environment cannot show which global
  the real one comes from.

## M0.3 — `wxt.config.ts` has to name `publicDir: 'src/public'`
- **Context:** PLAN.md §5.3 puts `_locales/` in `src/public/`, and `srcDir` is already `'src'`, so
  WXT looked like it would find it. It does not: `publicDir` defaults to `public` and is resolved
  against the project **root**, not against `srcDir`
  (`wxt/dist/internal/resolve-config.mjs`: `path.resolve(root, mergedConfig.publicDir ?? "public")`).
  The first build came out with every `__MSG_*` in place and no `_locales/` directory at all — an
  extension that cannot load, and a Firefox `web-ext lint` that would reject the unresolvable
  placeholders.
- **Decision:** `publicDir: 'src/public'` in `wxt.config.ts`. The directory keeps the place PLAN.md
  gives it, and the icons will be copied from there as well.
- **Why:** the alternative was a second public directory at the root, which would split the static
  assets across two trees and contradict §5.3. The setting also feeds `.wxt/types/i18n.d.ts`, which
  WXT generates from `publicDir/_locales/<default_locale>/messages.json`, so with the wrong
  `publicDir` that file is generated empty and types nothing.

## M0.3 — the typed `t` lives in `src/platform/i18n.ts`
- **Context:** PLAN.md §5.3 lists no file for the i18n helper, and invariant 11 wants every visible
  string to go through one. WXT already generates key-narrowed `browser.i18n.getMessage` overloads
  in `.wxt/types/i18n.d.ts`, so `t` could have been skipped.
- **Decision:** `src/platform/i18n.ts` exports `t`, `MessageKey`, `LOCALES`, `DEFAULT_LOCALE` and a
  `translator(api)` factory. `MessageKey` is `keyof typeof enMessages` from a **type-only** import
  of `src/public/_locales/en/messages.json`, so `t('nope')` is a compile error (checked: `TS2345`)
  and the catalogue is not bundled — the browser loads `_locales/` itself.
- **Why:** `platform/` is the layer allowed to touch browser APIs (invariant 5), and `src/core/`
  must stay free of them, so the helper cannot live in `core/`. One named entry point is also what
  makes invariant 11 reviewable, and `translator()` lets `tests/unit/i18n.test.ts` exercise the real
  `messages.json` of both locales without an extension context. WXT's generated overloads are a
  bonus check on the same keys, not a substitute: they do not exist for a plain unit test, and
  nothing stops a caller from reaching past them to `browser.i18n`.

## M0.3 — the panel sets its own `title` and `lang`, from `_locales`
- **Context:** `__MSG_*` is substituted in `manifest.json` and in CSS, never in HTML
  ([Chrome](https://developer.chrome.com/docs/extensions/reference/api/i18n#overview-predefined),
  [MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Internationalization#internationalizing_manifest.json)).
  But WXT copies the sidepanel entrypoint's `<title>` into Firefox's
  `sidebar_action.default_title` (M0.2 above), where it *is* substituted, so the one string has to
  serve both.
- **Decision:** `index.html` keeps `<title>__MSG_extName__</title>`, for the manifest; `main.tsx`
  then overwrites `document.title` with `t('extName')` and sets `document.documentElement.lang`
  from `panelLanguage()`.
- **Why:** it keeps a single source of truth for the sidebar title, which the existing
  `tests/unit/manifest.test.ts` already compares against `build/manifest.ts`. The alternative, a
  `<meta name="manifest.title">` override, works but states the title twice. Neither panel chrome
  displays the document's own title — Chrome's side panel and Firefox's sidebar both label the
  header from the manifest — so the placeholder should never be visible; the M0.3 manual check
  looks for it anyway.

## M0.3 — `lang` is derived from the UI language, not from the chosen locale
- **Context:** `lang` should name the language the strings are actually in (PLAN.md §4.8: the panel
  is navigable by screen reader). No API reports which directory out of `_locales/` the browser
  picked.
- **Decision:** `documentLanguage(uiLanguage)` repeats the browser's own rule: keep the tag from
  `i18n.getUILanguage()` if we ship its primary subtag (`it-CH` → `it-CH`), fall back to
  `default_locale` otherwise (`de` → `en`). An `@@ui_locale`-style underscore is normalised to the
  hyphen a `lang` attribute needs (`en_GB` → `en-GB`).
- **Why:** a wrong `lang` is worse than a coarse one — it makes a screen reader read Italian with
  English phonetics — and this rule can only be wrong about the region, never about the language.
  It is a pure function of its argument, so `tests/unit/i18n.test.ts` pins all of it. If the
  locale set grows beyond `en`/`it`, `LOCALES` is the only place to change.

## M0.4 — Chromium for E2E, headless, and the extension loaded from the build
- **Context:** an MV3 extension cannot be installed into an ordinary Playwright context: it needs a
  persistent profile launched with `--load-extension`. Recent branded Chrome ignores that flag, and
  Playwright's default headless binary is the *headless shell*, which has no extension support at
  all (the extension simply never loads).
- **Decision:** `@playwright/test` pinned at `1.64.1` as a dev dependency; every test launches its
  own `chromium.launchPersistentContext` with `channel: 'chromium'` — the full Chromium browser —
  loading `.output/chrome-mv3`, and **headless**: checked, and extensions do load. `headless` stays
  Playwright's own option, so `pnpm e2e -- --headed` still works when a run has to be watched.
  `playwright install chromium` runs from `postinstall`, not from the `e2e` script: it is a no-op
  once the browser is cached, and the `install` gate is the place that is allowed to download.
- **Why:** `channel: 'chromium'` is the only combination of the three that loads the extension at
  all, and headless keeps the `e2e chromium` gate usable on a machine without a display. Pinning
  matters more here than elsewhere: the browser build is tied to the Playwright version, so an
  unpinned bump would change the browser under the gate without a commit.

## M0.4 — the panel is tested as a tab, and the gate rebuilds before it runs
- **Context:** `sidePanel.open()` requires a user gesture that no test can produce, so the real side
  panel cannot be opened from Playwright. And E2E that reads `.output/` is only as honest as that
  directory is fresh.
- **Decision:** the `panel` fixture navigates an ordinary tab to
  `chrome-extension://<id>/sidepanel.html`, the same document the side panel renders; the id comes
  from the background service worker's URL. `"e2e": "wxt build && playwright test"`, so the gate
  cannot pass against a stale build. The browser profile is seeded in `testInfo.outputPath()` and
  `preserveOutput: 'failures-only'`, which leaves Playwright to create and remove it. The config
  sets `retries: 0` (the gate already retries the command once) and `forbidOnly: true`.
- **Why:** everything about the document — markup, i18n, styles, scripts — behaves identically in a
  tab; what a tab cannot reproduce is the panel *chrome* around it, which is the browser's and is
  covered by the M0.2 and M0.3 manual checks. Retrying inside Playwright as well as in phasekit
  would hide a flaky test twice over, and a committed `.only` has to fail a gate rather than
  silently shrink it.

## M0.4 — the UI language has to be set twice, and that qualifies the M0.3 rule
- **Context:** the first test asserts the panel greets in `en` and in `it`, which means driving the
  browser's UI language. Measured, in the runner, with the extension loaded (7 variants):
  `intl.app_locale` in the profile's `Local State` selects the `_locales/` catalogue
  (`getMessage('hello')` → `Ciao`) but leaves `i18n.getUILanguage()` at `en-US`; Playwright's
  `locale` context option moves `getUILanguage()` and `navigator.language` but not the catalogue
  (`locale: 'it'` alone → `it` + `Hello`); `--lang=it-IT` selects the catalogue and nothing else.
  The cause of the first surprise is the test runner: it defaults `locale` to `en-US`, so a context
  that does not ask for one is pinned to English however the profile is configured.
- **Decision:** the `uiLanguage` option drives both — `intl.app_locale` written into `Local State`
  before launch, and `locale` passed to `launchPersistentContext` — and `--lang` is not used.
- **Why:** only together do catalogue, `getUILanguage()` and `navigator.language` agree, which is
  the state a real browser is in; either one alone fabricates a disagreement no user has. It is also
  the counter-example to the M0.3 decision "`lang` is derived from the UI language": `lang` can be
  wrong about the *language*, not only the region, when the browser resolves `_locales/` against
  something other than `getUILanguage()`. The extension is right to trust `getUILanguage()` — it is
  the only thing it can ask — but the claim that the two cannot disagree was too strong.

## M0.4 — the two invariants are guarded for every test, and the guards are tested
- **Context:** invariant 1 (no network from any extension context) and "no console errors"
  (PLAN.md §14) are properties of every E2E run, not assertions a test should have to remember.
  A guard that silently never fires is worse than no guard.
- **Decision:** `tests/e2e/fixtures/recorder.ts` records console errors and uncaught exceptions from
  extension pages and from the service worker, and every request whose initiator is an extension
  context, attributing requests by `request.serviceWorker()` first and `request.frame()` second.
  An automatic `health` fixture fails the test afterwards if either list is not empty. Reading a
  list drains it, which is what lets `tests/e2e/recorder.spec.ts` provoke six real violations — a
  `fetch` from a page, a `fetch` from the service worker, `console.error` from both, an uncaught
  exception — take them, and still end clean.
- **Why:** the guards are the reason the harness exists, so they are the part that most needs a
  test. The probe URL is `http://127.0.0.1:1/…`: the request is refused immediately, the suite stays
  offline, and reading the extension's own `manifest.json` is asserted *not* to be a violation so
  the check cannot pass by being indiscriminate.

## M0.5 — Puppeteer over WebDriver BiDi for Firefox, and a configurable binary

- **Context:** PLAN.md §5.1 names Puppeteer over WebDriver BiDi as the Firefox E2E tool, because it
  is the only thing that can install an extension into a real Firefox from a directory
  (`webExtension.install`). Installing is the only route: an unsigned directory cannot be loaded any
  other way in a release build. And `puppeteer-core` never downloads a browser, so a binary has to
  be found.
- **Decision:** `puppeteer-core` 25.16.0, a dev dependency pinned exactly, driven through
  `puppeteer.launch({ browser: 'firefox', headless: true })` — which uses BiDi by default — and
  `browser.installExtension('.output/firefox-mv3')`, whose return value is asserted to be
  `tabdeclutter@robertoreale`. The binary comes from `FIREFOX_PATH`, and when that is unset, from
  the first well-known location that exists: `C:\Program Files\Mozilla Firefox\firefox.exe` and the
  x86 variant on Windows, `/Applications/Firefox.app/…` on macOS, `/usr/bin`, `/usr/local/bin`,
  `/snap/bin` on Linux. With neither, it throws naming `FIREFOX_PATH` and everywhere it looked.
  Locally that resolves to the installed Firefox 157; CI will set `FIREFOX_PATH` to what it fetched.
- **Why:** the full `puppeteer` package would pull a Chrome download on every install, and Chromium
  is already covered by Playwright, so `puppeteer-core` is the smaller half of the same library. The
  exact pin matters more here than usual, because the harness has to touch one API that is not
  public (see below). Asserting the installed id is what guards the UUID pin: were the manifest id
  ever to change, the tests would otherwise navigate to an origin serving nothing and fail
  unintelligibly.

## M0.5 — Vitest in a second config, not a second test runner

- **Context:** the task leaves the runner open. Playwright, which runs the Chromium suite, cannot be
  reused: it drives its own browsers and has no way to talk to a Puppeteer session.
- **Decision:** `vitest.firefox.config.ts`, run by `"e2e:firefox": "wxt build -b firefox && vitest
  run --config vitest.firefox.config.ts"`, with `include: ['tests/e2e-firefox/**/*.spec.ts']`,
  `fileParallelism: false`, `retry: 0`, `allowOnly: false` and `passWithNoTests: false`. The root
  `vitest.config.ts` keeps `include: ['tests/unit/**/*.test.ts']`, so `pnpm test` cannot pick up a
  browser test and stays a fast unit run. The new config is listed in `tsconfig.json`, so
  `pnpm typecheck` covers it.
- **Why:** Vitest is already a gate dependency, so this adds a runner in name only; a third
  framework would need something Vitest cannot do, and there is nothing here. `retry: 0` and
  `allowOnly: false` are the same policy as `playwright.config.ts`: the gate already retries the
  command once, so retrying here too would hide a flaky test twice over, and a committed `.only` has
  to fail the gate rather than silently shrink it. `fileParallelism: false` because each file
  launches its own Firefox. The small `message()` reader is duplicated from
  `tests/e2e/fixtures/extension.ts` rather than shared: moving it would edit the Chromium harness,
  which is outside this task's scope, and the two suites are better off not importing each other's
  test framework.

## M0.5 — three things Firefox needs that Chromium does not

- **Context:** measured on Firefox 157.0.1 against the real build. Three plain approaches do not
  work, and without a way round each the harness would be either broken or dishonest.
- **Decision:** (1) the internal UUID is pinned with `extensions.webextensions.uuids`
  (`{ "tabdeclutter@robertoreale": "4f2bb1ea-…-3f1bb0f2a001" }`, a JSON *string*, which is how
  Firefox stores that pref), so the panel's URL is known before the browser starts. (2)
  `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` is set in the browser's environment. (3) navigation goes
  through `page.mainFrame().browsingContext.navigate(url, 'complete')` rather than `page.goto`.
- **Why:** (1) Firefox assigns a random UUID per profile, and its background page is not a WebDriver
  target there, so reading the id off the service worker's URL — the Chromium trick — has no
  equivalent; the pref is the only way to know the origin in advance. (2) without it,
  `browsingContext.navigate` answers `unsupported operation: Navigation to "moz-extension://…" is
  not allowed in this context`: Gecko gates privileged URLs on `RemoteAgent.allowSystemAccess`, and
  that variable (equivalently `--remote-allow-system-access`) is the documented switch for it. The
  alternative, listing `sidepanel.html` in `web_accessible_resources`, would widen the shipped
  manifest for the tests' benefit and hand the panel to every web page. (3) `page.goto` never
  resolves against the panel: it waits on navigation events Gecko does not emit for a privileged
  document — verified by firing it without awaiting and polling the document, which sat at the panel
  URL and `complete` for ten consecutive polls while `page.url()` still said `about:blank` and no
  `framenavigated` ever arrived. The browsing context underneath does resolve. It is not public API,
  which is why the version is pinned exactly rather than ranged.

## M0.5 — "no console errors" on Firefox comes out of the browser's own output

- **Context:** PLAN.md §14 asks for no console errors, and the M0.4 recorder gets them from
  Playwright. On Firefox nothing in WebDriver reports them. Measured with a throwaway extension
  whose page logs and throws while loading: `page.on('console')` and `page.on('pageerror')` stay
  empty, and so does a raw unfiltered `log.entryAdded` subscription on the BiDi session — Gecko
  emits no log entry for a `moz-extension://` document at all. `evaluateOnNewDocument`
  (`script.addPreloadScript`) never runs there either, so no collector can be injected ahead of the
  page's own scripts. The same probe found both the `console.error` and the uncaught exception on the
  browser process's stdout and stderr.
- **Decision:** the launch sets `devtools.console.stdout.content: true` and
  `devtools.console.stdout.chrome: false`, and the harness reads `browser.process()`'s stdout and
  stderr line by line, recording `console.error: …` lines and `JavaScript error:
  moz-extension://<uuid>/…` lines. Reading drains, as in M0.4. It throws if the streams are not
  piped, so the check cannot quietly become a no-op, and `tests/e2e-firefox/console.spec.ts`
  provokes one of each, takes them, and ends clean.
- **Why:** it is the only mechanism that sees anything, and it sees *more* than the BiDi one would:
  it is already listening before the first script runs, so an error thrown while the panel boots is
  caught — which is the failure a smoke test exists for. The two prefs are what make it usable:
  Gecko's own internals log a steady stream of errors (`resource://gre/modules/…`, remote settings,
  shutdown races), and all of it rides on `.chrome`, which stays off. `console.error` lines carry no
  origin, so they are scoped by being content-only: the suite opens nothing but the panel, and
  counting a stray page's error as the extension's would fail loudly rather than pass silently.
  Uncaught exceptions do carry the script's URL, so those are matched on the extension's own origin.
  Warnings are not recorded, which is what `takeConsoleErrors` does on the Chromium side.

## M0.5 — the Firefox smoke test asserts English only

- **Context:** the Chromium suite checks the panel in both `en` and `it`. Firefox resolves
  `_locales/` against its application locale, which it negotiates against the langpacks actually
  installed. Measured: with `intl.locale.requested: 'it'`, `i18n.getUILanguage()` stays `en-US`,
  `getMessage('hello')` stays `Hello` and `<html lang>` stays `en-US` — a stock build ships no
  Italian langpack, so the request negotiates straight back to English.
- **Decision:** the Firefox test asserts the `en` catalogue, read from
  `src/public/_locales/en/messages.json`, and asserts that `getUILanguage()` and `lang` agree with
  it. A manual check covers the Italian sidebar.
- **Why:** the task asks for "a localized Hello", and reading the greeting out of the shipped
  catalogue is what makes the assertion localized rather than a hard-coded word. Driving the other
  language would mean downloading and installing a langpack inside the gate — network, a second
  moving part, a second thing to pin — to re-test a mapping `tests/unit/i18n.test.ts` and the
  Chromium suite already cover in both directions. What is genuinely Firefox-specific about it, that
  the sidebar shows the Italian string on an Italian Firefox, is something a person sees in ten
  seconds and no test sees cheaply.

## M0.6 — CI is one Linux job, and it downloads Firefox with `@puppeteer/browsers`

- **Context:** the gates launch two real browsers. The Chromium one comes with `pnpm install`
  (`playwright install chromium` in `postinstall`), but Puppeteer downloads no Firefox, and the
  harness takes the binary from `FIREFOX_PATH` (`tests/e2e-firefox/fixtures/panel.ts`, M0.5). The
  runner's own Firefox would be a third thing to depend on, and the task forbids adding the
  downloader to the dependencies.
- **Decision:** a single `gates` job on `ubuntu-latest`, and one setup step before the gates:
  `pnpm dlx @puppeteer/browsers@3.2.6 install firefox@stable --path "$RUNNER_TEMP/firefox"`, whose
  stdout line `firefox@<buildId> <executable>` is cut into `FIREFOX_PATH` in `$GITHUB_ENV`. No
  `apt` step, no `xvfb`, no second operating system.
- **Why:** `@puppeteer/browsers` is already in the tree at 3.2.6 as `puppeteer-core`'s own
  installer, so the download comes from the same tool that then drives the browser, and `dlx`
  keeps it out of `package.json`. The version is pinned and the channel is not: the Firefox gate
  exists to catch a Gecko change before the add-on's users do, and pinning a build is a one-word
  edit if a release ever breaks it. The output format was verified by running the command (it
  prints the result line on stdout and the progress on stderr, so the cut is safe). One Linux job
  is enough because both harnesses launch headless — no display is needed — and the runner image
  ships Chrome and Firefox, so the shared libraries they want are already installed; a second OS
  would double the minutes to re-test what the sequence runs on Windows before every commit
  anyway.

## M0.6 — the workflow mirrors the gates and retries nothing

- **Context:** `phasekit.json` gives the two E2E gates `retries: 1`, and the workflow could copy
  that. PLAN.md §13 asks only for "CI green".
- **Decision:** `.github/workflows/ci.yml` runs on a push to any branch (not on tags, which are
  `release.yml`'s in M7.5) and on a pull request to `main`. One step per gate, named exactly as in
  `phasekit.json` and in the same order, with no retries, a 30-minute job timeout, `contents: read`
  and a concurrency group that cancels a superseded run on the same ref. The three actions are
  pinned to their major tags (`actions/checkout@v5`, `actions/setup-node@v5`,
  `pnpm/action-setup@v4`); Node comes from `.nvmrc` via `node-version-file`, pnpm from
  `packageManager` (which is what `pnpm/action-setup` reads when given no version), and pnpm is set
  up first so `setup-node`'s `cache: pnpm` can find the store.
- **Why:** the retry in `phasekit.json` is there to keep an unattended sequence moving; CI is a
  signal to a person, and a run that goes green on a second attempt would hide exactly the flake
  worth seeing. Every branch, because the owner's check is "green at the first push" and a push to
  a phase branch has to show something. Major tags rather than commit SHAs: these are GitHub's own
  and pnpm's own actions, the tag keeps their fixes coming, and the job has no secrets and no write
  permission to abuse.

## M1.1 — `tldts-experimental` rather than `tldts`

- **Context:** AGENT-RULES.md allows `tldts` "or a lighter variant", PLAN.md §11 excludes the
  library from the panel's 60 KB budget but still says "consider the lightweight variant". The two
  packages expose the same API over the same Public Suffix List; the experimental one trades a
  smaller, differently encoded trie for API stability.
- **Decision:** `tldts-experimental@7.4.19`, pinned exactly, as the only new runtime dependency.
  `src/core/url.ts` imports `getDomain` from it and nothing else.
- **Why:** measured, not assumed. Bundled and minified through the project's own bundler, `tldts`
  is 267,577 B raw / 111,461 B gzip against `tldts-experimental`'s 107,801 B / 47,049 B — 64 KB of
  gzip saved on a dependency that ships in the service worker as well as in the panel. The risk of
  "experimental" is a different answer, so both were compared on 34 hand-picked hostnames (PSL
  wildcards and exceptions, private suffixes, IDN, IPv4, IPv6, `localhost`, `about:`, `chrome://`,
  `moz-extension://`, `file://`, malformed strings) and on 200,000 generated three-label hostnames,
  with `allowPrivateDomains` both on and off: zero differences. The name refers to the data
  encoding, not to the correctness of the lookup, and only the import path would change if that
  ever stopped holding.

## M1.1 — `registrableDomain` counts private suffixes as sites

- **Context:** `getDomain` can treat the PSL's private section (`github.io`, `blogspot.com`,
  `vercel.app`) either as a suffix or as an ordinary domain. The answer decides whether
  `alice.github.io` and `bob.github.io` are one site or two, which in turn decides what "Proteggi
  questo sito" protects and how tabs are grouped by site (PLAN.md §5.1).
- **Decision:** `allowPrivateDomains: true`, so `alice.github.io` is its own registrable domain.
- **Why:** the grouping has to match what the user sees. Two people's project pages have nothing to
  do with each other, and protecting `github.io` because one of them is open would silently protect
  every page hosted there. The opposite mistake — splitting one site into several — cannot happen
  this way, because the private section only ever adds labels to the suffix.

## M1.1 — a URL the parser rejects is its own key

- **Context:** `normalizeUrl` is total: tab URLs include `''` (a tab that has not committed a
  load), `about:blank`, `data:`, and on Firefox a user-typed string that never became a URL. The
  spec does not say what the key of an unparseable URL is.
- **Decision:** return it trimmed, lower-cased only if `ignoreCase` is set, and never throw.
  Nothing else is attempted: no scheme is guessed and no prefix is added.
- **Why:** the key only has to be stable and equal to itself, which a passthrough guarantees — two
  tabs showing the same broken string still match, and a broken string never collides with a real
  URL, having no scheme the parser accepts. Guessing a scheme would be the one way to make
  `example.com` typed in the address bar look like a duplicate of a page the user is actually on,
  and by invariant 2 a wrong duplicate is a tab wrongly closed.

## M1.1 — what normalization does to a URL with no authority

- **Context:** `about:reader?url=…`, `data:text/html,…`, `javascript:…` and `view-source:https://…`
  have no host: everything after the scheme is one opaque string that `URL` reports as `pathname`.
  Applying the host and path rules to it would rewrite the payload — `view-source:https://example.com/a/`
  would lose a slash that belongs to the inner URL.
- **Decision:** `normalizeUrl` tests `href` for `scheme://` and treats only those URLs as
  hierarchical. For the rest the opaque remainder is kept verbatim: no trailing-slash rule, and
  `ignorePath` is a no-op. `href` and not the raw input, because the parser forgives
  `https:/example.com` and reports it as an ordinary authority URL. The query and the fragment are
  still normalized, since `URL` separates those on every scheme.
- **Why:** these strings are keys for comparison, and the payload is the whole identity of such a
  page. Making `ignorePath` a no-op there is the conservative reading: with no host, "compare the
  host only" would collapse every `about:` page into a single key, so the guard would call
  `about:addons` a duplicate of `about:preferences`.

## M1.1 — normalization is idempotent by construction

- **Context:** the keys are stored, not only compared — `local:keeps` is keyed by normalized URL
  (PLAN.md §10) — so a key can be read back and normalized again. A first draft stripped one `www.`
  label and one trailing slash, which made `https://www.www.example.com/a` and
  `https://example.com/a//` normalize to strings that normalize further: two keys for one page.
- **Decision:** both rules loop — every leading `www.` label (while a dot remains, so that `www.com`
  survives) and every trailing slash down to the root. A test asserts
  `normalizeUrl(normalizeUrl(u)) === normalizeUrl(u)` over the whole table of cases.
- **Why:** anything else makes a stored key depend on how many times it has been through the
  function, which is the kind of bug that surfaces only as a keep that stopped working.

## M1.1 — the fragment of an SPA route is kept verbatim

- **Context:** `#/` on the root path is the address of the page rather than noise (PLAN.md §6.2), so
  it survives `ignoreHash`. Such a route can carry its own query (`/#/inbox?id=7`), which `URL` puts
  inside `hash` and not inside `search`.
- **Decision:** the fragment is kept as it is. The query rules — sorting, dropping tracking
  parameters, `ignoreAllParams` — apply to `search` only, so a `?` inside the route is untouched.
- **Why:** parsing the inside of a fragment means guessing the router's convention (hash-bang, query
  before route, encoded path), and guessing wrong changes a key for the worse. The visible cost is a
  `utm_` parameter inside a hash route surviving, which is rare and harmless: it makes two tabs look
  different, and never makes two different pages look the same.

## M1.1 — tracking parameters are matched case-insensitively

- **Context:** `ignoreCase` is off by default, so the rest of the URL keeps its case, and a link can
  arrive with `UTM_SOURCE` or `FBCLID`.
- **Decision:** `isTrackingParam` lower-cases the name before matching, whatever `ignoreCase` says.
  `utm_` is matched as a prefix; the rest are an explicit set.
- **Why:** the case of a campaign parameter is an accident of whoever built the link, and the
  parameter is noise either way. That is a different question from whether two paths differing in
  case are the same page, which is what `ignoreCase` is for and is left to the user.

## M1.1 — coverage: `@vitest/coverage-v8`, on by default, `src/core/**` only

- **Context:** M1.1 asks for a ≥ 95% threshold on `src/core/**` enforced by `pnpm test`, which is
  the `test` gate. Vitest needs a coverage provider as a separate package, and coverage is off
  unless asked for.
- **Decision:** `@vitest/coverage-v8@5.0.5` as a dev dependency, pinned to the Vitest version, with
  `coverage.enabled: true`, `include: ['src/core/**/*.ts']`, the `text-summary` reporter and the
  thresholds `lines: 95, branches: 95` in `vitest.config.ts`. `coverage/` is already ignored by git.
- **Why:** the v8 provider is the one Vitest ships and it needs no instrumentation step, so the gate
  stays as fast as the tests. Enabled in the config rather than behind a `--coverage` flag, because
  a threshold that depends on remembering a flag is not a gate. `include` is a list and not a filter
  over whatever the tests happened to import: a core module nobody tests at all then shows up as 0%
  and fails the run instead of being left out of the denominator — verified by adding an untested
  core file, which took the run to 82.81% lines and exit 1.

## M1.1 — `TabActivity.bootstrappedAt` instead of a `bootstrapped` flag

- **Context:** PLAN.md §6.1 writes `bootstrapped: true` on the records invented at
  `runtime.onInstalled`, and §6.4 protects such a tab for the first 24 hours. A boolean cannot say
  when those 24 hours end, so the protection would need a second field or the install time.
- **Decision:** `bootstrappedAt?: number` (ms epoch), absent on an observed record, plus
  `BOOTSTRAP_GRACE_MS = DAY` in `src/core/types.ts`.
- **Why:** one field answers both questions the spec asks of it — whether the history is guesswork,
  and whether the grace has passed — and it expires by itself, so nothing has to go back and clear a
  flag. `undefined` is the honest absence: a record that was observed has no such moment.

## M1.1 — the stored default guard mode is `warn`, not `auto`

- **Context:** PLAN.md §8.3 leaves the duplicate mode to the user and §17 preselects "Chiudila e
  torna a quella esistente" in onboarding. `DEFAULT_GUARD_SETTINGS` is also what applies before
  onboarding has run, and after a storage reset.
- **Decision:** `mode: 'warn'` in `DEFAULT_GUARD_SETTINGS`. Onboarding writes `auto` when the user
  confirms the preselected choice.
- **Why:** invariant 2 — no tab is closed without an explicit gesture, and the exception is the
  guard in auto mode, which is a mode the user has to have chosen. A default of `auto` would close a
  tab on the strength of a question nobody answered yet. The preselection in the onboarding UI is
  how the spec's preference is expressed; the stored default is not the place for it.

## M1.2 — `own` is a page class of its own, and the origin is injected

- **Context:** PLAN.md §6.3 lists eight classes and excludes "TabDeclutter's own pages" from
  `browser-internal`, without saying what they are instead. §6.4 then protects them, so the scoring
  has to be able to ask. `src/core/` may not call `browser.runtime.getURL()` (TASKS.md §2.4), and
  the extension id differs per browser and per installation, so the origin cannot be a constant
  either.
- **Decision:** a ninth `PageType`, `own`, and `classify(tab, { ownOrigin })`, with `ownOrigin` in
  the shape `browser.runtime.getURL('')` returns. Without it an own page classifies as
  `browser-internal`, which is what it is to a context that does not know who it is. `isOwnPage()`
  is exported as well, so the protection in M1.6 does not have to go through the class.
- **Why:** the alternatives were a flag alongside the class or folding own pages into `content`, and
  both make the caller remember a second thing to look at. One class means the exclusion §6.3 asks
  for and the protection §6.4 asks for are the same fact. The origin is compared as a whole path
  prefix, so an extension whose id merely starts like ours cannot inherit the protection.

## M1.2 — matching by boundaries, not by substring

- **Context:** §6.3 is written in prose: a path "containing `login`", a `/search` path, "a `q` /
  `p` / `query` parameter". Taken literally, `/blogin` is an auth page, `/searchkit/searchkit` is a
  search, `/sport/dp/B01` is Amazon's `/s`, and `google.com/maps?q=roma` is a result list. M1.2 asks
  for false friends, so the prose has to be read as "a word", not "a sequence of characters".
- **Decision:** auth tokens are matched between boundaries, where a boundary is any run of
  characters that are not letters or digits (the path is folded to `-` separated tokens, so
  `sign-in` matches `/users/sign_in` and `login` does not match `/blogin`); path prefixes match
  whole segments (`/s` matches `/s` and `/s/x`, never `/sport`); and a search parameter only counts
  on an engine's root path, which is where `duckduckgo.com/?q=` puts its results, so
  `google.com/maps?q=` stays `content`.
- **Why:** PLAN.md §6.5 says a false positive costs more than a false negative — a suggestion to
  close a page the user is reading is the expensive mistake — and these rules feed the +25 of a
  transient page (§6.4). Each rule is narrower than the prose and never wider, so nothing the spec
  names is lost. The two it cannot tell apart are `/wiki/Login` and a title like "Not Found: a
  novel", both of which need the page's content to resolve; they are left as known limits of a
  classification that may not read the page.

## M1.2 — the order of the rules: URL evidence before the title

- **Context:** a page can satisfy two rules at once. A sign-in page on a search engine, a search
  whose server answered 404, a local PDF (`file` or `media`), an own page under an extension scheme.
  The spec gives a table, not a precedence.
- **Decision:** `blank` → `own` → `browser-internal` → `file` → `media` → `auth` → `search` →
  `error` → `content`. `auth` runs before `search` and reads only the host and the path, so a search
  *for* the word "login" is still a search. `error` runs last of all.
- **Why:** the order goes from the most certain evidence to the least. A scheme is a fact; an
  extension in the path is nearly one; `auth` and `search` are host and path rules; `error` is a
  pattern over a string the page itself chose, which is why §6.3 calls it low confidence and only a
  secondary reason. Putting it last means a page whose URL we understand is never demoted to a guess
  about its title.

## M1.3 — Duplicate Tabs Closer's whitelist syntax, read off its source

- **Context:** PLAN.md §8.3 asks for a whitelist "compatible with Duplicate Tabs Closer's syntax,
  so the user can paste the whitelist they use today", and names only `*` and `/…/`. Compatibility
  lives in what it does not say: whether a pattern is anchored, whether it is case-sensitive, which
  regex flags survive. M1.3 asks for the exact semantics, so they were read in
  [Peuj/duplicate-tabs-closer](https://github.com/Peuj/duplicate-tabs-closer) (`options.js`,
  `whiteListToPattern`; `worker.js`, `isUrlWhiteListed`) rather than guessed.
- **Decision:** `compile()` reproduces that function exactly. What it does, and what that implies:
  - lines are split on `\n`, trimmed, and the empty ones dropped with no complaint;
  - a line matching `/^\/(.+)\/([gimsuy]*)$/` is a **regular expression**: the body is used as
    written, so it is **not anchored** and matches anywhere in the URL, with the flags the user
    gave minus `g` and `y`. A flag letter outside that set (`/x/d`) makes the whole line a wildcard
    pattern instead, and `//` is the literal pattern `//`, not an empty regex;
  - any other line is a **wildcard** pattern: one trailing `/` is removed, `*` becomes `.*`, every
    regex metacharacter is escaped, and the result is wrapped as `^…\/?$`. So it is **anchored at
    both ends**, **case-sensitive**, and tolerant of a trailing slash on either side. The
    consequence worth knowing is that a bare `example.com` whitelists *nothing*;
  - the URL tested is the tab's **raw** URL, not the normalized duplicate key: that is what
    `isUrlWhiteListed` is given, and what the user wrote the pattern against. `chrome://newtab`
    therefore only covers Chrome's `chrome://newtab/` because of the optional trailing slash.
- **Why:** every one of these is a case where a reasonable implementation would differ (anchoring
  and case especially), and a pasted whitelist that silently matches less than it used to would
  close a tab the user had protected — the one mistake PLAN.md §3.1 promises not to make. The
  agreement is checked and not assumed: the expectations in `tests/unit/patterns.test.ts` were
  produced by running that extension's own `whiteListToPattern`/`isUrlWhiteListed` over the same
  pattern/URL pairs and comparing (35 patterns × 37 URLs, no disagreement).

## M1.3 — a reported line, not a silently dropped one, and a code next to the message

- **Context:** PLAN.md §8.3 asks for "live line-by-line validation: invalid regexes are highlighted
  with the error message and ignored (never a crash)" and a 500-character limit per pattern, and
  M1.3 fixes the shape `errors: { line, message }[]`. Two things were open. Duplicate Tabs Closer
  also caps a wildcard pattern at five `*` and drops the line **silently**; and §2.11 requires every
  visible string to go through i18n, which an English `message` cannot.
- **Decision:** three failures are reported — `too-long` (over 500 characters, measured after
  trimming), `too-many-wildcards` (the reference extension's cap of 5, kept) and `invalid-regex` —
  each as `{ line, code, message }`, with the line 1-based over every line of the input, blank ones
  included. `code` is the addition to the shape M1.3 gave: the UI renders the localized sentence
  from it and shows `message` (two numbers, or what the engine said) as the detail beside it. A
  reported line is ignored and the rest of the list still matches.
- **Why:** keeping the wildcard cap keeps a pasted list behaving identically, and `.*` repeated in
  one anchored pattern is the one way a 500-character line can cost real time on a long URL;
  reporting it instead of dropping it costs nothing and answers §8.3's "never a crash" with "and
  never a silence" — a pattern that does nothing, with nothing said about it, is the kind of thing
  the user would blame on the extension. The `code` is what makes the message translatable at all;
  without it the panel would have to show the core's English.

## M1.3 — `compile` takes a text block or lines, and the browser defaults are two exported lists

- **Context:** storage holds the whitelist as one string (the line editor of §8.3 is a textarea),
  the editor works on lines, and §8.3 also wants a per-line preview ("matches 3 open tabs"). §8.3
  prefills a different list on each browser.
- **Decision:** `compile` accepts `string | readonly string[]` and splits a string on `\n`; the
  per-line preview is a `compile` of that one line, so there is no second API for it. The defaults
  are exported as `DEFAULT_WHITELIST_CHROME` and `DEFAULT_WHITELIST_FIREFOX`, with no function to
  choose between them.
- **Why:** both callers get the form they already have, with no `join`/`split` at the call site, and
  one code path compiles everything. Choosing the list is the only part that depends on which
  browser this is, and TASKS.md §2.4 and §2.5 put that outside `src/core/`: `src/platform/` picks
  one when it writes the storage defaults (M1.7).

## M1.4 — the two options that decide a duplicate but are not comparison options

- **Context:** M1.4 fixes the signature `duplicateKey(url, matchOptions, cookieStoreId?)`, and
  `MatchOptions` is the "URL comparison" table of PLAN.md §8.3 — six options, exactly the six rows
  the settings page shows. But two more things change what a duplicate is, and both live in the
  "Priority and exclusions" table instead: "Prefer the HTTPS tab **(and treat `http`/`https` as
  equivalent)**" and "Treat containers as separate".
- **Decision:** `MatchOptions` is left as it is, and `duplicates.ts` declares
  `DuplicateOptions extends MatchOptions` with `treatHttpAsHttps?` and `containersAreSeparate?`,
  both defaulting to `true` when absent (as in `DEFAULT_GUARD_SETTINGS`). `duplicateOptions(settings)`
  derives them from `settings.match` + `settings.guard`, and is the one place that knows which
  checkbox feeds which.
- **Why:** `MatchOptions` is a stored shape and the settings UI's own table; growing it with fields
  that have no row there would make the two drift. Deriving the wider options in one exported
  function is what keeps "duplicate" meaning one thing (TASKS.md §2.9): Declutter and the guard
  cannot pass different flags without saying so.

## M1.4 — `http` and `https` collapse to one scheme, but a port written out does not

- **Context:** with "Prefer the HTTPS tab" on, `http://x/a` and `https://x/a` must be one page.
  `normalizeUrl` drops a port only when it is the scheme's own default, so collapsing the scheme
  before normalizing would turn `http://x:80` into `https://x:80` and keep the port.
- **Decision:** normalize first, then replace a leading `http://` or `https://` with the token
  `http(s)://`. So `http://x:80/a` and `https://x:443/a` are one key, while `http://x:443/a` and
  `https://x:443/a` stay two.
- **Why:** the key is opaque — only equality is ever asked of it — so a token that is not a scheme
  is the cheapest way to say "either of the two" without a second normalization pass. The port that
  survives is the honest answer: `http` on 443 is a different endpoint from `https` on 443, and
  neither is the ordinary form of the other, so calling them one page would be a guess.

## M1.4 — the tab id is the last priority rule

- **Context:** PLAN.md §8.4.3 lists five rules, and they can all stay silent: two tabs of one set,
  neither pinned, neither navigated, same scheme, no `TabActivity` record yet (the tracker is M1.8,
  and a record can be missing after a restart), same window. The comparator then returns 0, and
  which tab survives would depend on the order the tabs happen to be in — that is, on the order the
  events arrived in, since PLAN.md §8.2 fires the guard from several of them.
- **Decision:** a sixth rule after the five: the lower tab id wins, reversed to the higher one when
  the age rule is "Più recente". `compareKeepPriority` is therefore a total order and returns 0 only
  for one tab compared with itself.
- **Why:** M3b.2 has to guarantee that exactly one tab survives, which needs an answer that does not
  change between two evaluations of the same pair. A tab id grows with time in both browsers, so
  this rule agrees with the age rule it stands in for whenever the tracker has nothing to compare —
  it is the same intention, decided on the only evidence left.

## M1.4 — `findDuplicateSets` leaves out facts, not policies

- **Context:** PLAN.md §8.3 also lists "Ignore empty tabs", "Ignore login/OAuth pages" and
  "Allow duplicates created intentionally", and §8.4.1 adds incognito, exemptions and the guard's
  mode. M1.4 asks only for a grouping that "excludes `hidden` tabs".
- **Decision:** `findDuplicateSets` excludes a `hidden` tab and a whitelisted URL, and nothing else.
  Every other exclusion of §8.3 and §8.4.1 is an exit filter of `resolveDuplicate` (M3b.1), and what
  Declutter leaves out of its list is Declutter's own business (M2.2).
- **Why:** those two are not opinions: a `hidden` tab is not on screen at all (PLAN.md §5.5), and a
  whitelisted URL is by definition allowed to have duplicates. The rest are settings, and a setting
  applied twice — once while grouping, once while deciding — is how the list the user reads and the
  tab the guard closes start to disagree.

## M1.4 — ages are injected as a map, and an age nobody knows decides nothing

- **Context:** rule 4 of §8.4.3 compares the tabs' age, and `TabInfo` has no `createdAt`:
  `TabActivity.createdAt` is the tracker's (PLAN.md §6.1), which M1.8 builds. `src/core/` may not
  read storage (TASKS.md §2.4).
- **Decision:** `KeepContext.createdAt` is an injected `Record<tabId, ms epoch>`, optional. When
  either tab is missing from it, the age rule returns "cannot tell them apart" and the next rule
  decides. A tab whose URL is still loading is keyed on its `pendingUrl` (`tabUrl()`), so the
  newly created tabs of Chrome are not all "the empty page".
- **Why:** a map is the smallest thing the comparator needs, and it lets the panel pass the activity
  store and the guard pass the two records it has in hand. Inventing an age for a tab without one
  (the clock, or `lastAccessed`, which is the last visit and not the birth) would make the rule
  answer confidently with evidence it does not have; falling through to the next rule is what the
  user would expect from "the first rule that tells them apart wins".

## M1.5 — the fixtures are generated from curated templates, and only `tabs-300` is labelled

- **Context:** M1.5 asks for 50, 300 and 1000 tabs that can be regenerated identically, with a
  hand-written `suggest`/`keep` label on the 300 (PLAN.md §6.5). Writing 1350 tabs by hand is not
  maintainable, and labelling 1350 of them by hand is not honest.
- **Decision:** `scripts/generate-fixtures.ts` combines a seeded PRNG (mulberry32) with curated
  *templates*: a page source (site pattern × subjects) and a set of *situations*, each situation
  carrying its own label and one-sentence rationale. `tabs-300.json` is the only labelled file
  (`labelled: true`); `tabs-50` and `tabs-1000` are shape and volume fixtures and carry no labels.
- **Why:** the judgement lives in the situations, where it is written once and can be read in one
  place, and the PRNG only decides which curated page is in which curated situation. So the labels
  are still human and reviewable (docs/MANUAL-CHECKS.md), while the files stay regenerable. A
  template's pages are spent without replacement unless the URL carries a unique number, so no two
  tabs are an accidental duplicate contradicting their own labels.

## M1.5 — the generator takes only types from `src/core/`

- **Context:** the generator has to run outside the bundler, and node's type stripping does not
  resolve extensionless ESM specifiers, which is how `src/core/` imports itself
  (`import { DAY } from './time'`). Importing `src/core/types.ts` for `NO_GROUP_ID` fails at
  runtime.
- **Decision:** `pnpm fixtures` runs `node --experimental-strip-types`; everything the generator
  takes from `src/core/` is an `import type`, erased before node sees it. The three runtime values
  it needs (`NO_GROUP_ID`, `DAY`, the default `staleDays`) are restated in
  `tests/fixtures/schema.ts` as `UNGROUPED`, `DAY_MS` and `FIXTURE_STALE_DAYS`, and
  `tests/unit/fixtures.test.ts` asserts each copy equals its original.
- **Why:** the alternative was a dev dependency whose only job is to run one script
  (AGENT-RULES.md: few dependencies). Three copied numbers guarded by three assertions cannot drift,
  and the fixture schema stays the single description of the fixture shape, used by the generator
  and by the test that validates the committed files.

## M1.5 — the fixtures are Chrome-shaped

- **Context:** `TabInfo.cookieStoreId` is Firefox's container (PLAN.md §5.5), and the same URL in
  two containers is not a duplicate.
- **Decision:** no fixture tab has `cookieStoreId`, and none is `incognito` or `hidden`.
- **Why:** containers change what a duplicate *is*, so mixing them into the duplicate clusters
  would make the hand-written labels ambiguous before anything can read them. The container case is
  M2's, with its own fixture; a tab without `cookieStoreId` is exactly what Chrome reports.

## M1.5 — the label distribution of `tabs-300.json`

- **Context:** M1.5 asks for the distribution to be recorded, because PLAN.md §6.5 measures
  precision against these labels and a later change to them must be visible.
- **Decision:** 300 tabs, **165 `suggest` / 135 `keep`**, by template:
  `search` 28/12, `github` 19/16, `docs` 9/24, `video` 20/12, `news` 18/7, `webapp` 0/22,
  `auth` 11/5, `blank` 10/5, `file-media` 9/6, `read-later` 9/6, `forgotten-trip` 13/1,
  `browser-internal` 6/1, `error` 6/1, `bootstrapped` 2/5, `active` 0/5, near-duplicate pairs 5/7.
  Also: 6 windows (1 forgotten, 14 tabs), 5 groups over 11 tabs, 10 pinned, 5 audible, 3 discarded,
  7 bootstrapped records, 62 openers, 14 URLs open more than once, 112 Italian and 162 English
  titles.
- **Why:** `keep` is deliberately over-represented against what a plain "old tab" rule would say
  (`docs` and `bootstrapped` are mostly `keep` despite being idle for weeks) because a false
  positive costs more than a false negative (PLAN.md §3.1). The labels were written before the
  scoring of §6.4 exists, so these counts are the target the scoring has to meet, not a description
  of it.

## M1.6 — the headline reason is its own vocabulary

- **Context:** PLAN.md §6.4 gives a priority list for the "primary reason" — duplicate, blank,
  transient, stale-unread, stale — which is coarser than the signals the score collects, and says
  nothing about tabs with no reason at all or about protected ones.
- **Decision:** `PrimaryReason` is a separate union from `ReasonCode`: `transient` stands for any
  already-consulted page (search, sign-in, browser page), `stale-unread` for the pair "old and
  never read", plus `protected` for step 1 and `review` for a tab that scored only on small
  additions. `primaryReasonOf` is the only place that priority is written down, and step 2 asks it
  too instead of naming its own. An `error` page adds its points but is never the headline.
- **Why:** the headline is one sentence in the row (§6.5) and the reasons are the "why" panel; they
  answer different questions, and forcing one type on both would have put `bookmarked` or
  `discarded` into the priority list, where the spec never puts them. "This page failed to load" is
  not a reason to close a tab, so `error` stays out of the sentence.

## M1.6 — the score answers for the windows in the same pass

- **Context:** §4.3 asks for a card like "Finestra con 12 schede non toccata da 3 settimane", and
  the condition it gives is "all the tabs of a window are to close".
- **Decision:** `scoreTabs` returns `{ tabs, windows }`, and each `ScoredWindow` carries
  `tabCount`, `closeCount`, `idleMs` and `forgotten`. `forgotten` is "every tab of the window has
  been untouched for longer than `staleDays`", which is also the condition of the
  `forgotten-window` addition; `closeCount` and `tabCount` are what the sentence needs.
- **Why:** taken literally the spec's condition can never hold — every window has an active tab and
  step 1 protects it — so the card needed a condition that can. Returning the roll-up from the same
  call keeps it O(n) and means the card and the per-tab reason can never disagree, which they would
  if the panel worked the window's state out for itself.

## M1.6 — an empty tab is nobody's duplicate

- **Context:** several `about:blank` or `about:newtab` tabs share one URL, so the duplicate rule
  would call them duplicates of each other (95 points, "another tab is showing this page").
- **Decision:** tabs classified `blank` are left out of both the duplicate and the near-duplicate
  rules, and are reached by the "empty and inactive" rule instead.
- **Why:** it is the exception the real-time guard already makes (`ignoreEmptyTabs`, PLAN.md §8.2),
  and "a duplicate of another tab" is the wrong thing to tell the user about a new tab page: three
  empty tabs are three empty tabs, not two copies of one.

## M1.6 — "empty and inactive" means the hour has passed

- **Context:** PLAN.md §6.4 words the rule as "empty and inactive tab = 90", without saying what
  inactive means for a tab with no page in it.
- **Decision:** the rule needs `idleMs` over `transientMinIdleMs` (1 hour), the same threshold the
  transient pages use. A younger empty tab falls through to step 3.
- **Why:** an empty tab the user opened minutes ago is the tab they are typing in. The labels agree:
  the `blank` tabs of `tabs-300.json` labelled `keep` are hours old but were used minutes ago. And
  reusing the transient threshold avoids inventing a second number for the same idea.

## M1.6 — step 2 sets the score and stops

- **Context:** PLAN.md §6.4 presents the strong rules as setting a score ("= 95", "= 90") and the
  additions as a sum, but does not say whether a strong rule then takes the group discount or picks
  up the small additions as well.
- **Decision:** neither. A duplicate scores exactly `duplicatePoints` and an abandoned empty tab
  exactly `blankPoints`, with that one reason and `multiplier: 1`.
- **Why:** both numbers were chosen to mean "certainly closeable", and a duplicate inside a group is
  still the same page open twice. Letting the additions pile on top would also break the promise of
  §6.5 that the reasons shown add up to the score.

## M1.6 — every tab group counts as the user's

- **Context:** the ×0.6 discount of §6.4 is for tabs the user filed in a group on purpose, but
  `TabInfo` only reports `groupId`: nothing says who created the group.
- **Decision:** any `groupId` other than `NO_GROUP_ID` earns the discount.
- **Why:** it is the only information available, and it errs the right way — a tab in a group is
  suggested less eagerly (PLAN.md §3.1). When M3 starts creating groups itself, it files tabs the
  user accepted a suggestion for, so the same reading still holds.

## M1.6 — `keepKey` uses the default comparison options

- **Context:** "Mantieni" (§10) and the optional bookmark signal are stores keyed by URL, while the
  user can change what counts as the same URL (`ignoreHash`, `ignoreAllParams`, …) at any time.
- **Decision:** `keepKey` normalises with `DEFAULT_MATCH_OPTIONS`, never with the user's settings,
  and is exported so that whoever writes those stores keys them the same way.
- **Why:** a keep is a promise about one page, and changing a comparison setting must not silently
  forget it, nor quietly widen it to a dozen other pages. The duplicate rules keep using the user's
  options, where the setting is what the user is actually asking about.

## M1.6 — a tab nothing is known about counts as touched now

- **Context:** `factsOf` reads the last use from the activity record and from the browser's
  `lastAccessed` (§6.1). A tab can have neither: no record yet, and a browser that does not report
  it.
- **Decision:** `lastActive` falls back to `now`, so the tab is idle for 0 ms and the grace period
  protects it.
- **Why:** the alternative, epoch 0, reads as "untouched since 1970" and would put a tab the
  extension simply has not seen yet at the top of the list — the expensive mistake of §3.1.

## M1.6 — protected sites match by domain, and the host is parsed only when there are any

- **Context:** §4.6 writes protected sites as domains, with examples such as `*.atlassian.net`, and
  does not define the matching.
- **Decision:** a pattern matches the domain itself and everything under it (`atlassian.net` covers
  `team.atlassian.net`), a leading `*.` is accepted and means the same, and an empty pattern or a
  URL with no host matches nothing. The URL is parsed only for a user who has protected sites at
  all.
- **Why:** suffix matching on the whole string would make `notatlassian.net` a match for
  `atlassian.net`. Parsing lazily saves a thousand URL parses per run for everyone who never opens
  that setting, which would be a sizeable part of the §11 budget spent on nothing.

## M1.6 — the measured precision and the time budget

- **Context:** M1.6 asks for precision ≥ 0.9 on the `close` bucket of `tabs-300.json` and a median
  under 15 ms for a thousand tabs, both recorded here.
- **Decision:** with `DEFAULT_SCORING_CONFIG` exactly as PLAN.md §6.4 specifies it — no tuning was
  needed — the score puts **100** of the 300 labelled tabs in `close`, **94** of them labelled
  `suggest`: **precision 0.940**, recall 0.570 (94 of the 165 `suggest` labels). All six
  disagreements are search-result pages the labels keep. The median of 11 runs over
  `tabs-1000.json`, after 5 warm-up runs, is **10.1 ms** (fastest 9.7).
- **Why:** the recall is deliberately the lower number: inactivity alone caps at 55 and so can never
  reach the `close` bucket by itself, which is what keeps the precision up (PLAN.md §3.1). The six
  search pages are the price of the +25 transient rule, and the labels were written to disagree in
  exactly that direction. `tests/unit/scoring.fixtures.test.ts` keeps both numbers under test, with
  a recall floor so that a later tuning cannot buy precision by suggesting almost nothing. The
  benchmark lives in that file too, but `vitest.config.ts` leaves V8 coverage on for every normal
  run and it makes the loop about 2.4× slower (24.1 ms), so the assertion there allows three times
  the budget and the user-facing number is measured with
  `npx vitest run tests/unit/scoring.fixtures.test.ts --coverage.enabled=false`.
