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
  benchmark started out in that file, measured inside a run that keeps V8 coverage on, with an
  assertion that allowed three times the budget to absorb the instrumentation; M1.8 moved it to
  `tests/perf/` and holds it to the 15 ms instead (see the M1.8 entry below).

## M1.7 — two vitest projects, because one global `browser` fake would hide a real case
- **Context:** `fakeBrowser` is needed to test `src/platform/`, but WXT installs it with
  `vi.stubGlobal('browser', fakeBrowser)` for the whole run, and `tests/unit/i18n.test.ts` proves
  `t()` returns `''` when there is no `browser` at all. In WXT 0.21.5 the entry points are
  `wxt/testing/fake-browser` and `wxt/testing/vitest-plugin`; there is no `wxt/testing`.
- **Decision:** `vitest.config.ts` declares two projects. `unit` (`tests/unit/**`) runs with no
  extension API, as before; `extension` (`tests/ext/**`) carries `WxtVitest()`. Tests that need the
  fake go in `tests/ext/`. Coverage and its thresholds stay at the root, over the whole run.
- **Why:** the alternative was to weaken the "outside an extension context" test, which the gates
  exist to prevent. `passWithNoTests: false` can only be set for the whole run, so it lives at the
  root too.

## M1.7 — every item starts at `version: 1` with no `migrations`
- **Context:** `storage.defineItem` reads the item as soon as it is defined when `migrations` is
  passed, to compare the stored version with the declared one — seven extra reads at startup here.
- **Decision:** every item declares `version: 1` and no `migrations`, through one local helper,
  `defineVersioned`, which the module comment documents as the single place a future migration is
  added.
- **Why:** `@wxt-dev/storage` reads an item with no recorded version as version 1, so a value
  written now is exactly what a future `migrations: { 2: … }` will be handed; declaring the version
  today costs nothing and keeps that door open, while declaring an empty migration map costs a read
  per item per context.

## M1.7 — the archive is newest first, and the cap drops the tail
- **Context:** PLAN.md §10 caps the archive at 1000 entries (FIFO) and asks for one write per
  action, but does not say in which order the entries are stored.
- **Decision:** `addToArchive` puts the action's tabs in front of everything older, keeping the
  order it was given, then `slice(0, ARCHIVE_CAP)`. A batch larger than the cap keeps its own head.
- **Why:** the panel shows the most recently closed tabs first (PLAN.md §9), so the stored order is
  the displayed order and no sort is needed on read; cutting the tail is what makes the cap FIFO.

## M1.7 — one read-modify-write at a time per key
- **Context:** "one write per action" is only safe if two actions in the same context cannot both
  read the same archive and have the second write lose the first one's entries.
- **Decision:** a small per-key promise queue in `src/platform/storage.ts` serializes the helpers
  that read then write (archive, keeps, exemptions). A failed operation does not block its key.
- **Why:** no new dependency for something this small, and it covers the case that actually happens
  — two closes a few milliseconds apart in the background. Writes made by different contexts
  (PLAN.md §5.2) are not ordered by it, and no helper here is called from two contexts at once.

## M1.7 — keeps and exemptions are keyed with `keepKey`
- **Context:** both stores are keyed by URL, and the user can change the comparison options.
- **Decision:** `keepKey` from `src/core/scoring.ts` is the key function for `local:keeps` and the
  comparison for an exemption's URL. An exemption matches on tab id **or** URL.
- **Why:** the keys must not depend on a setting the user can change, or a keep would be silently
  forgotten (DECISIONS, M1.6). Either half of an exemption is enough because a restored tab comes
  back with a new id, while a tab that merely navigated keeps its id (PLAN.md §8.6).

## M1.7 — the settings are read with the defaults merged in, not migrated
- **Context:** a release that adds a setting finds the objects older releases stored without it.
- **Decision:** `readSettings` spreads `DEFAULT_SETTINGS`, `DEFAULT_GUARD_SETTINGS` and
  `DEFAULT_MATCH_OPTIONS` under the stored value and returns a fresh object; the panel saves the
  whole object back.
- **Why:** adding a setting is the common shape change, and a version bump plus a migration for each
  one is more machinery than it is worth; a reader that merges defaults cannot see `undefined`.
  Returning a fresh object also keeps the shared `DEFAULT_*` constants from being edited in place.

## M1.7 — the cleanup alarm is not part of this module
- **Context:** PLAN.md §10 asks for a 6 h alarm that drops expired archive entries, expired keeps
  and orphaned activity records.
- **Decision:** M1.7 ships `pruneKeeps` only, because "keeps with an expiry" is in its scope and an
  uncollected expiry grows without bound. Archive retention, orphaned activity and the alarm itself
  belong to the background's housekeeping.
- **Why:** the alarm needs `browser.alarms` and the background entry point, neither of which exists
  yet; reads here never write, so the collection can be added later without changing any caller.

## M1.8 — tabs are matched to saved records by exact URL, as a multiset
- **Context:** tab ids do not survive a restart, so PLAN.md §6.1 asks for a match by URL; two tabs
  on the same page make it ambiguous.
- **Decision:** `src/core/reconcile.ts` groups the records by their exact URL and hands them out to
  the tabs in window/index/id order, oldest record first. An empty URL matches nothing.
- **Why:** the exact URL, not `keepKey`, because the normalisation the user can configure must not
  change which history a tab inherits; ordering both sides makes the result stable from one restart
  to the next, so two tabs on the same page cannot swap histories. A tab whose URL the browser has
  not reported yet is not "the same page" as another one in the same state.

## M1.8 — an unmatched tab is given a record, an unmatched record is dropped
- **Context:** §6.1 says to initialise tabs that have no record and to mark them `bootstrapped`, and
  says nothing about records no tab claims.
- **Decision:** a tab with no record gets one dated `min(tab.lastAccessed, now)` or `now`, carrying
  `bootstrappedAt: now`; records no tab claimed are not kept. Same rule on `onInstalled`, which
  matches by id because ids are still valid there and an update must keep what was observed.
- **Why:** the store then always describes the tabs that exist, so every later event has something
  to update and nothing accumulates. `bootstrappedAt` rather than a `bootstrapped: true` flag
  because the grace period of §6.4 has to end, and a moment can say when; a flag could not.

## M1.8 — writes are debounced by 1 s, with a best-effort flush on `onSuspend`
- **Context:** §6.1 allows a 1–2 s debounce and §16 asks for a flush on `onSuspend`, but Chrome
  documents `onSuspend` for the event page and warns that work started there may not finish, and
  MDN records that Firefox only fires it from 106.
- **Decision:** 1 s, the short end of the range, and the `onSuspend` listener is registered on both
  browsers as a best effort rather than a guarantee.
- **Why:** on an MV3 service worker the flush cannot be relied on, so the quantity that actually
  bounds the loss is the debounce window; a second still turns a restored session of twenty tabs
  into one write.

## M1.8 — the foreground period is kept in `session:foreground`
- **Context:** charging a tab for its foreground time needs "which tab, since when", and invariant 6
  forbids holding that in a variable in the background.
- **Decision:** a new `session:foreground` item (`ForegroundPeriod | null`), not listed among the
  keys of PLAN.md §10 because it is not state the product keeps.
- **Why:** `storage.session` outlives the service worker and dies with the browser, which is exactly
  the lifetime of a foreground period: a period left over from the previous run would otherwise
  charge a tab for the whole night.

## M1.8 — on Firefox each record is also written next to its tab
- **Context:** §5.5 prefers `sessions.setTabValue`/`getTabValue` on Firefox, which restores the value
  with the tab and is better than matching by URL.
- **Decision:** the records are saved tab by tab inside the debounced write, only for the tabs that
  changed, and read back first at start-up, where they win over the URL match. A read or a write
  that fails is logged and skipped. Reads accept an object or a JSON string, because MDN documents
  that `setTabValue` stringifies anything that is not a string.
- **Why:** keeping the session values inside the same write is what stops them from becoming one
  call per event; a tab can close between an event and the write, so a failure there is normal and
  must not lose the rest of the store.

## M1.8 — the budget tests run alone, without coverage, against the real budget
- **Context:** the 1000-tab benchmark of M1.6 passed whenever it ran on its own (~10 ms per scoring
  run) and failed in three of three pre-merge runs of the full gate list (60-100 ms per run). It
  measures wall-clock time inside `pnpm test`, where V8 coverage instruments `src/core/` and the
  other test files run in parallel workers; the two files M1.8 added were enough to tip it over.
  Nothing about `score()` changed.
- **Decision:** every wall-clock budget of PLAN.md §11 gets a run of its own — `tests/perf/`,
  `vitest.perf.config.ts` (coverage off, `fileParallelism: false`, `retry: 0`, the verbose reporter
  so the measured number reaches the gate's log), `pnpm perf`, and a `perf budgets` gate right
  after `unit tests` in phasekit.json and in `.github/workflows/ci.yml`. The assertion is the
  plan's own number, 15 ms, with no allowance on top. The measuring code is one helper,
  `tests/perf/budget.ts`, because the budgets still to come use it too (M2.5's panel opening,
  M4.1's clustering): the median of 11 runs after 20 warm-up runs, the whole measurement repeated
  up to three times, failing only when every attempt is over budget, and every median printed. The
  precision assertions stay in `tests/unit/scoring.fixtures.test.ts`; both files now build their
  input from `tests/fixtures/scoring-input.ts`.
- **Why:** a budget measured while something else uses the CPU is not a measurement of this code,
  and the way to keep that gate honest is to make the measurement trustworthy rather than to widen
  the limit: 45 ms was already three times what the user is promised and it still flaked. Five
  warm-up runs turned out not to be a warm-up — the first attempt measured 17-21 ms and the next
  ones 12-14, V8 still tiering up the same code — while twenty put the first attempt at the steady
  state. Repeating the whole measurement costs a second on a machine that was busy for a moment and
  cannot hide a regression, since work that really got slower is over budget in all three attempts.
  Measured here, alone and without coverage: **median 11.0-11.3 ms** over three consecutive `pnpm
  perf` runs, and **11.55, 11.68, 13.53 and 13.69 ms** inside four consecutive runs of the whole
  gate list, each on the first attempt (M1.6 recorded 10.1 ms).

## M2.1 — two stylesheets, tokens and base, and nothing else

- **Context:** PLAN.md §5.3 lists exactly `styles/tokens.css` and `styles/base.css` for the panel,
  and §4.7 asks for tokens, a light/dark theme, a spacing scale and reduced motion.
- **Decision:** `tokens.css` declares custom properties only — one `:root` block, one
  `prefers-color-scheme: dark` override, one `prefers-reduced-motion` override of `--td-duration`;
  `base.css` has the reset, the typography, the focus ring and the shell classes, and reads values
  only through `var(--td-…)`. `main.tsx` imports tokens first.
- **Why:** a theme that lives in one file cannot drift from the file that uses it, and later tasks
  add components without touching either theme. No CSS-in-JS and no third stylesheet for three
  screens' worth of chrome (§3: the simplest thing that works).

## M2.1 — `--td-accent-text` exists because the accent is not AA on white

- **Context:** §4.7 fixes the accent at `#1a73e8` (light) and `#8ab4f8` (dark) and also requires
  WCAG AA, but `#1a73e8` on `#ffffff` is about 4.0:1 — under 4.5:1, which 13 px text needs.
- **Decision:** the accent stays exactly as specified for borders, fills and focus rings;
  accent-coloured *text* uses `--td-accent-text` (`#0b57d0` light, `#8ab4f8` dark, both AA).
- **Why:** both halves of §4.7 are then satisfied without repainting the accent. `#0b57d0` is the
  same hue one step darker, so nothing looks like a second accent.

## M2.1 — the navigation is buttons with `aria-current`, not a tablist

- **Context:** §4.2 wants Riordina / Organizza / Archivio navigation; the obvious ARIA pattern is
  `role="tablist"`.
- **Decision:** a `<nav aria-label>` of plain buttons carrying `aria-current="page"`, with `<main>`
  as the landmark for the view.
- **Why:** a conforming tablist owes the user arrow-key navigation and a roving tabindex, which is
  M2.3's work; claiming the role before the behaviour exists is worse for a screen reader than not
  claiming it. Buttons are correct at every stage, and the pattern survives M2.3 unchanged.

## M2.1 — what Riordina and the gear show before their own tasks land

- **Context:** the task says Organizza and Archivio get "a simple empty state" but does not say what
  Riordina shows before M2.2 builds the list, nor where the ⚙ leads before M6.1.
- **Decision:** Riordina shows `declutterEmpty` when the score suggests nothing and the
  `healthReview` section title ("N da rivedere") when it does; the gear is an `aria-pressed` toggle
  revealing a Settings heading. All four strings are PLAN.md's own words.
- **Why:** the header counts and the score are already live, so showing the number proves the state
  is wired end to end, and a control that leads nowhere is worse than one that leads to a heading
  M6.1 fills in. No `views/` or `components/` directory yet: the scope is "App, styles, state", and
  `EmptyState` is explicitly M2.2's.

## M2.1 — counted nouns come from four keys and `Intl.PluralRules`

- **Context:** "N schede · M finestre" needs agreement in both languages, and Chrome's i18n has no
  plural support at all (`i18n.getMessage` only substitutes `$1`…`$9`).
- **Decision:** `countTabsOne/Other` and `countWindowsOne/Other` in both catalogues, selected with
  `Intl.PluralRules(language)` and formatted with `Intl.NumberFormat(language)`, in a pure
  `sidepanel/format.ts` that takes `t` and the language as arguments.
- **Why:** both languages need only `one`/`other`, so four keys cover them, and the choice stays
  testable without a browser — which is why `format.ts` imports `../../platform/i18n` relatively:
  the `unit` vitest project runs without WXT's plugin and so without the `@/` alias. Noted while
  testing: Italian's CLDR sets `minimumGroupingDigits: 2`, so `1234` is deliberately ungrouped.

## M2.1 — the Tab-to-`TabInfo` mapping lives in the panel's state for now

- **Context:** `core/` may not touch `chrome.*` (invariant 4) and only `platform/` may (invariant
  5), but `platform/tabs.ts` does not exist yet: M3.1 creates it with the actions.
- **Decision:** `sidepanel/state/tabs.ts` queries `browser.tabs` and maps the result to `TabInfo`
  itself; the window count is derived from the tabs' distinct `windowId`s rather than from a second
  `windows.getAll()`.
- **Why:** PLAN.md §5.2 has the panel call `chrome.tabs` directly, so the panel is a platform
  caller by design, and one read is cheaper and cannot disagree with itself. M3.1 can lift the
  mapper into `platform/tabs.ts` when it needs it there too.

## M2.1 — one debounce window per burst, started by the first event

- **Context:** §5.2 asks for a 150 ms debounce on `tabs.on*`; a restartable debounce would postpone
  the read for as long as events keep arriving.
- **Decision:** the first event opens the window (`timer ??= setTimeout`) and the read happens when
  it closes; reads are queued so two cannot interleave, and a failed read does not block the queue.
- **Why:** it bounds the latency the user sees (a restored window of 30 tabs costs one read, 150 ms
  after the first tab, not after the last) and it is what `background/tracker.ts` already does.

## M2.1 — the `hello` key is gone

- **Context:** M0.3 added `hello` as the placeholder panel's only string, its own description
  saying "until the real panel exists".
- **Decision:** removed from both catalogues; the i18n parity test now asserts the exact key list
  the shipped code asks for, and the manual checks that read «Ciao» now read the navigation labels.
- **Why:** a key no code reads is a translation that cannot be wrong, which makes the parity test
  weaker rather than stronger.

## M2.1 — `fakeBrowser`'s gaps are worked around in the test, not in the code

- **Context:** three limitations of `@webext-core/fake-browser` 2.0.1 surfaced while testing the
  panel state: `tabs.onMoved/onAttached/onDetached/onReplaced.addListener` throw "not implemented";
  `reset()` leaves one tab behind; `tabs.remove` reads `windows.get(tabId)` and so only works when
  a tab's id happens to equal its window's.
- **Decision:** the test stubs those four `addListener`s and fires the captured listener itself,
  drains the leftover tabs in `beforeEach`, and replays a close as the panel sees it (the
  `onRemoved` event plus a `tabs.query` that no longer lists it).
- **Why:** the panel subscribes to all seven events because a real browser fires them; bending the
  product to the fake would be weakening a gate. The stubs turned the gap into coverage — there is
  now a test per event asserting it triggers exactly one read.

## M2.2 — the five sections of §4.3, and what goes in them

- **Context:** §4.3 names five sections; the scores name seven primary reasons (`protected`,
  `duplicate`, `blank`, `transient`, `stale-unread`, `stale`, `review`).
- **Decision:** `blank` joins "Pagine temporanee" and `protected` has no section at all;
  `sections.ts` maps the rest one to one, in §4.3's order. Listed is every tab the score did not
  put in `keep`, ordered by score descending and then by the browser's own tab order.
- **Why:** an empty tab left open for an hour is the most transient page there is, and §4.3's list
  of sections is closed at five. A protected tab scored 0 and has nothing to explain, so a section
  for it would be a list of things not to do. The tab order breaks ties the way the user's own
  window does, which keeps the list stable while they read it.

## M2.2 — a section is folded when none of its rows is to close

- **Context:** §4.3 asks for "«Da valutare» collapsed, «Da chiudere» expanded", which are buckets,
  not sections: a section can hold rows from both.
- **Decision:** `DeclutterSection.collapsed` is true when no row of that section is in the `close`
  bucket. "Da valutare" can only ever hold `review` rows, so it is always folded; a folded section
  renders no rows at all, and once the user has folded or unfolded one by hand their choice stands
  for as long as the panel is open.
- **Why:** it reads the spec's rule per section instead of guessing a second rule, and it is what
  §3 asks for — the panel opens showing what it is sure about and nothing else.

## M2.2 — the age is said once per row

- **Context:** a row carries a reason sentence and a set of chips (§4.3, §6.4), and the sentence
  for an inactive tab already contains the age ("Non la apri da 12 giorni").
- **Decision:** `chipsOf` leaves the age chip out when the primary reason is `stale` or
  `stale-unread`, and `format.ts` derives both the chip and the sentence from one `span()`, so they
  can never name different units for the same duration.
- **Why:** "Non la apri da 12 giorni · 12 gg fa" says the same thing twice in a 320 px panel.

## M2.2 — a whole-window card needs something to close in it

- **Context:** §4.3's card offers a forgotten window; `rollUpWindows` marks a window forgotten from
  its idle time alone.
- **Decision:** a card is drawn only when the window is forgotten *and* at least one of its tabs is
  in the `close` bucket.
- **Why:** a window can be untouched for weeks and hold nothing worth closing (every tab pinned,
  kept, or on a protected site). Offering to close it is the one thing §3 says costs most: a
  suggestion the user has to refuse.

## M2.2 — a row has two lines and one action

- **Context:** §4.3 describes a row with a favicon, title, domain, reason, chips and actions, and
  the panel is as narrow as 320 px. Selection and bulk actions are M2.3's.
- **Decision:** two lines — favicon, title and domain above; reason, chips and the actions below,
  revealed on hover or focus — and the only action is "Vai", which activates the tab and brings its
  window forward.
- **Why:** it is the whole of §4.3 that M2.2 owns, and it leaves the row's shape unchanged when the
  checkbox arrives: the second line already wraps.

## M2.2 — the avatar's colour is a custom property, not a style

- **Context:** §5.5's fallback favicon is the domain's initial over a colour derived from the
  domain, and the hue is computed in `platform/favicon.ts`.
- **Decision:** the row sets `--td-avatar-hue` only; saturation and lightness are tokens, and
  `base.css` composes the `hsl()`.
- **Why:** the avatar follows the theme (§4.7) without the hash knowing anything about light and
  dark, and the hue stays the one thing the domain decides.

## M2.2 — the health bar belongs to the Declutter view

- **Context:** §4.2 puts a health bar in the panel; the header already carries the counts.
- **Decision:** it is rendered by `DeclutterView`, above the sections, and reads
  `declutter.value.total` — the number of rows the list is actually showing.
- **Why:** it describes what Declutter is showing, so it has nothing to say on the other two views,
  and a count that disagreed with the rows below it would be worse than no bar. On an empty list
  there is no bar at all: a full bar beside "Tutto in ordine" would say the same thing twice.

## M2.2 — days hold until a fortnight, then weeks take over

- **Context:** one `span()` picks the unit for both the chip and the sentence, and PLAN.md's own
  examples are "Non la apri da 12 giorni" (§6.4) and "non toccata da 3 settimane" (§4.3).
- **Decision:** each unit has its own threshold: hours from an hour, days from a day, **weeks from
  a fortnight**, months from 30 days, years from 365. Below an hour it is always at least "1 min".
- **Why:** taking a unit as soon as one whole of it fits would make twelve days "1 settimana",
  which loses what the spec's own sentence says, and twelve days is exactly the age §6.4 writes
  out. Every unit still reads at least one whole, so the sequence never goes backwards.

## M2.2 — the Chromium E2E moves the panel's clock, not the records

- **Context:** the list has to be checked against aged tabs, and `scoring.ts` reads the later of
  the stored `lastActiveAt` and Chrome's own `tab.lastAccessed`, which is always a moment ago.
- **Decision:** the test seeds `local:activity` for what only storage knows (creation time,
  activations) and opens the panel with `Date.now` shifted twelve days ahead, after waiting for the
  background's debounced write to settle so the seed is not overwritten.
- **Why:** writing an old `lastActiveAt` alone changes nothing — `lastAccessed` wins — and the
  shift is what makes the idle ages, the section names and the real `Intl` output all observable in
  the browser. Firefox gets the duplicate section instead, which needs no clock: its panel cannot
  be given one (`evaluateOnNewDocument` does not run on `moz-extension://`).

## M2.2 — `platform/tabs.ts` arrives early, and the panel reads the tabs through it

- **Context:** M2.1 decided the Tab-to-`TabInfo` mapping could stay in `sidepanel/state/tabs.ts`
  until M3.1 created `platform/tabs.ts` with the actions. "Vai" is an action, and it is M2.2's.
- **Decision:** `platform/tabs.ts` exists now, with `asTabInfos`, `queryTabs` and `activateTab`;
  the panel's state calls `queryTabs()` instead of mapping tabs itself.
- **Why:** the alternative was a second `chrome.tabs` caller in the panel for one action and a
  mapper in a third place, and the module M3.1 would have created is the same one. The API is a
  parameter with a default, so both functions are tested without an extension context.

## M2.3 — the Declutter list is a `grid`, not a `listbox`

- **Context:** §4.8 leaves the choice open between `listbox`/`option` and `grid`, and asks for the
  task to record it.
- **Decision:** `grid` — one `div[role=grid]` named by `declutterList`, a `rowgroup` per section,
  and a `row` per section header and per tab, each with a single `gridcell`.
- **Why:** a row already holds a button ("Vai") and M3.2 adds a checkbox and three more actions,
  and ARIA forbids interactive descendants inside an `option`. The cost is the sections' `<h2>`:
  a grid's children must be rows or rowgroups, so the heading became the text of the header row.
  Its name and count are unchanged, and the panel still has exactly one `<h1>`.

## M2.3 — the section header is a row with `aria-expanded`, not a button

- **Context:** the sections fold, and §4.8 wants ↑/↓ to walk the whole list, headers included.
- **Decision:** the header is the rowgroup's first `row`, carrying `aria-expanded` and the fold's
  click; `Enter` on it folds and unfolds.
- **Why:** `aria-expanded` is allowed on `row` in ARIA 1.2, and a nested `<button>` would have been
  a second tab stop inside a list that is meant to be one. The row's own button is out of the tab
  order (`tabindex="-1"`) for the same reason: `Enter` on the row already goes to the tab.

## M2.3 — one tab stop for the whole list, by stop id, and no wrapping

- **Context:** a roving tabindex has to survive tabs closing, sections folding and the list being
  rebuilt from a signal on every tab event.
- **Decision:** the stops are identified by a string (`section:<id>`, `row:<tabId>`) held in
  `DeclutterView`, not by an index; when the chosen stop is gone the first stop takes the focus;
  ↑ at the top and ↓ at the bottom do nothing.
- **Why:** an index would move the focus to a different tab the moment a row above it disappeared.
  Not wrapping is the ARIA grid default and keeps `Tab` the way out of the list. The arithmetic is
  `sidepanel/keyboard.ts`, a pure module, so it is unit-tested without a browser.

## M2.3 — the focus ring uses `:focus`, and the counts are the live regions

- **Context:** §4.8 asks for a visible focus ring and `aria-live="polite"` on the counts.
- **Decision:** `.td-row`/`.td-section-toggle` draw the ring on `:focus`, not `:focus-visible`;
  the polite regions are the header's counts and the health bar's sentence.
- **Why:** these stops are reached only through the roving tabindex, which focuses them from
  script, and Chromium's `:focus-visible` heuristic drops the ring after a programmatic focus that
  followed a click — leaving a keyboard user with no idea where they are. Both counts change on
  their own as tabs open and close, which is what a polite region is for; the toasts §4.8 also
  mentions do not exist until M3.2.

## M2.4 — the badge counts the `close` bucket only, written plain

- **Context:** §4.1 asks for "how many tabs are to close" and gives `14` as the example, without
  saying what to do about a thousand tabs or about the `review` bucket.
- **Decision:** the count is the tabs whose bucket is `close`, and the text is `String(count)`:
  no `Intl` grouping, no `99+` cap, and nothing at all at 0.
- **Why:** the `review` bucket is "come and look", which is a reason to open the panel and not a
  number to act on, and §3 asks the extension to say one actionable thing. A cap would hide the
  only case where the number is itself the news; four digits is beyond any real tab count, and the
  browser truncates a badge of its own accord long before that.

## M2.4 — a neutral grey for the count, the accent for the flash

- **Context:** §4.1 asks for a "neutral colour" and §8.5 for a colour change lasting 1.5 s, neither
  of them named.
- **Decision:** the badge is `--td-text-muted` (`#5f6368`) with white text, and the flash is
  `--td-accent` (`#1a73e8`); both are re-asserted on every refresh.
- **Why:** a badge the user never asked for must not look like an alert, which rules out the accent
  for the resting state — and leaves it free to make the flash unmistakably a change. Re-asserting
  the pair costs two calls on a path that has already scored every tab, and it is what repairs a
  flash whose restore never ran because Chrome stopped the worker (invariant 6). The tests check
  that the resting colour is a grey and the flash is not, so the palette can be retuned without
  rewriting them.

## M2.4 — what asks the badge for a recompute, and nothing else

- **Context:** §11 forbids polling and names a 2 s debounce and a 30-minute alarm, without listing
  the events in between.
- **Decision:** `tabs.onCreated/onRemoved/onMoved/onUpdated/onActivated/onAttached/onDetached`
  (and `onReplaced` where it exists), a `storage.onChanged` on the five stored values a score
  reads, the alarm, and `runtime.onStartup`/`onInstalled`. All of them share one 2 s timer, and the
  "Mostra badge" setting is read before anything is counted.
- **Why:** this is exactly the set the panel follows, because the same rules read all of it: a keep
  being added or the tracker flushing its records changes the verdict with no tab having moved, and
  the settings reaching the badge through the same door is what makes "Mostra badge" take effect at
  once. Reading the setting first means a tab event costs no score at all when the badge is off,
  which is the cheapest the §11 budget can be. The badge writes nothing, so there is no loop.

## M2.4 — the 30-minute alarm is created only when it is missing

- **Context:** the alarm is asked for at the top level of the background, which runs again every
  time Chrome starts a new service worker — many times an hour on a busy browser.
- **Decision:** `alarms.get(name)` first, and `alarms.create` only if there is nothing there.
- **Why:** `alarms.create` with a name that already exists replaces the alarm and starts its
  countdown again, so an unconditional create would push the next refresh forever out of reach and
  the 30 minutes of §11 would never elapse. Alarms outlive the worker, so the read is almost always
  the whole of the work.

## M2.4 — `badge.ts` repeats the panel's snapshot read instead of sharing it

- **Context:** `sidepanel/state/tabs.ts` already reads the same seven things and calls `scoreTabs`
  over them; the badge needs one number out of the same answer.
- **Decision:** the read is written again inside `badge.ts`. M2.4's scope is `badge.ts`, its
  registration and its tests.
- **Why:** what invariant 9 asks is one definition of a verdict, and both callers get that from
  `core/scoring`; what is duplicated is the plumbing around it. The two contexts want different
  things of it — the panel wants every scored tab and its window roll-up, the badge wants a count
  and, unlike the panel, must not score at all when the setting is off — so the shared function
  would have grown options for both before it saved anything. Worth revisiting when a third caller
  appears: the guard of M3b.2 is the candidate.

## M2.4 — perf budgets are CPU time, not wall time

- **Context:** the `perf budgets` gate reds the sequence on a machine that is busy. `pnpm perf`
  measured the score at 9.8-12.5 ms on an idle machine and 16-69 ms with a browser and an editor
  on the same cores, with `src/core/scoring.ts` untouched; two merges of M2.4 failed on it.
- **Decision:** `tests/perf/budget.ts` measures the CPU time of the process — `process.cpuUsage()`,
  user plus system — around each run and asserts the median of that. The limit is still PLAN.md
  §11's 15 ms with no allowance on top, the warm-up is still 20 runs, the median is still over 11
  samples and the measurement is still repeated up to 3 times; `phasekit.json` is unchanged and so
  is the scoring code. The wall-clock median is measured too and printed beside the CPU one, for
  information only.
- **Why:** the budget is a claim about the code, and a wall clock also charges it for every
  millisecond the operating system gave to something else. CPU time counts only the intervals in
  which this process was running, which is the right question for `score()`: it is synchronous and
  single-threaded, so on a quiet machine the two numbers are the same thing (measured: 9.75 CPU
  against 9.91 wall) and under load the CPU figure is the one that still means something (measured:
  25 CPU against 166 wall).
- **Why a batch.** `process.cpuUsage()` reads in microseconds but is charged in scheduler ticks:
  on Windows it moves in steps of about 15.6 ms, so a single 10 ms run measures 0 or 15.6 and never
  10. Each sample is therefore a batch of runs divided by its size. The size is calibrated, not
  written down, so the helper stays honest for the much quicker budgets of M2.5 and M4.1 — but it
  is calibrated after the warm-up and never below 16 runs, because the first run of all and a
  calibration taken while the machine was busy both read far too high and would choose a batch of
  three, which is back to reporting ticks.
- **What it still cannot do.** CPU time counts time, not cycles, so it does not undo anything that
  makes the instructions themselves slower. Contention: with ten processes pinning the cores the
  same work costs 17-32 ms of charged CPU, because a hyperthread sibling and a saturated memory bus
  slow it down. Clock: with this laptop on battery and a third of it taken by other processes,
  Windows reported the CPU at 42-71% of its nominal frequency and the score cost 52-68 ms of CPU —
  five times the 9.75 ms the same tree measured on a quiet machine, and the 12.69 ms it measured
  again once the machine was quiet. So the gate still answers for the code *and* for the state of
  the machine: what is gone is only the failure caused by waiting for the scheduler.
- **Not for everything.** An operation that waits rather than computes uses no CPU while it waits,
  and `process.cpuUsage()` only ever sees this process. M2.5's panel opening turned out to be both
  — a browser does the work, and a third of the time goes on waiting for it — so it got the
  wall-clock mode this bullet anticipated: `measureWallBudget`, same medians, same three attempts,
  same battery rule, with the millisecond taken from the page instead of from `cpuUsage`.

## M2.4 — perf budgets are enforced on mains only; on battery they are measured and reported, not enforced

- **Context:** on battery Windows runs this laptop at about half its nominal frequency. The same
  commit measured 9.75 ms on mains and 29-68 ms on battery with the machine idle, so the gate
  stopped the unattended sequence over the power cable, not over the code — and the owner runs the
  sequence on battery.
- **Decision:** `tests/perf/budget.ts` asks `Win32_Battery.BatteryStatus` through a short
  `powershell -NoProfile` call before it measures anything (1 means discharging; anything else, no
  battery, a failed query or a platform that is not Windows all mean mains). On mains nothing
  changes: same limit, same runs, same three attempts, same failure. On battery the measurement
  still runs and still prints its medians, and if every attempt is over budget the test passes
  after printing `perf budget NOT ENFORCED: running on battery (CPU throttled)`. The budget,
  `phasekit.json` and the scoring code are untouched; `powerSourceFrom` is a pure function so the
  reading has a unit test (`tests/unit/perf-budget-power.test.ts`).
- **Why:** a budget in milliseconds asserted on a throttled CPU measures the machine. Not enforcing
  it there costs nothing, because a real regression is caught by the next run on mains — every
  merge the owner makes while plugged in, and any CI — while the number is in the log of every run
  either way, under a line that cannot be read as a pass.

## M2.5 — the panel budget is measured in a real browser, on 300 stubbed tabs, at the painted frame

- **Context:** PLAN.md §11 promises "panel open → list visible (300 tabs): ≤ 150 ms", and M2.5 left
  the method open: 300 real tabs in the E2E, or a harness rendering the panel on the fixture's data.
- **Decision:** a real Chromium, 300 stubbed tabs, timed by the page.
  `tests/perf/panel-opening.perf.test.ts` launches its own persistent context with the Chrome build,
  replaces `chrome.tabs.query` from an init script with `tests/fixtures/tabs-300.json` (timestamps
  shifted so the ages are the ones the fixture's labels describe), seeds the raw `activity` key the
  way `tests/e2e/` does, and then opens `sidepanel.html` in a fresh page nine times per attempt
  after two warm-up openings. What is timed is the page's own `performance.now()` at the animation
  frame following the mutation that puts the list in the DOM — navigation to painted rows, with
  nothing of Playwright's inside the interval. `measureWallBudget` in `tests/perf/budget.ts` does
  the medians, the three attempts and the battery rule, exactly as the CPU budgets do.
- **Why:** three of the four things the plan is promising — a document loading, a 167 KB module
  compiling, a frame painting — only happen in a browser, and they are most of the cost: an empty
  panel, zero rows, measured 122 ms of the 150 the budget allows. A jsdom harness would have
  measured jsdom. 300 *stubbed* tabs rather than real ones because 300 real tabs means 300
  renderers competing for the machine the measurement is reading, and the panel cannot tell the
  difference: it asks one question and gets the same answer. Each opening uses a fresh page because
  re-navigating one page drifted monotonically (262 → 660 ms) and that drift was the harness, not
  the panel.
- **Why it cannot be met by rendering less.** Every opening also reports the rows present when the
  clock was read and the rows present once settled, and the test requires them equal. Today the
  panel renders the list in one synchronous pass, so the first row and the last arrive together;
  if that ever became progressive, the mark would stop meaning "the list is visible" and the test
  fails instead of getting quietly faster.
- **The measured number.** On this laptop, on battery, the panel usually opens in **a median of
  250-280 ms** — best-of-three medians of 260.5, 269.3, 262.2 and 255.2 ms in four runs, with the
  29 openings behind the first of those spread 233-408 ms. Over the 150 ms budget, so printed and
  not enforced. But a fifth run, same code, measured **151.2 ms** in its middle attempt (265.2,
  151.2, 255.0): for nine openings Windows gave this machine its processor, and the panel came in
  at the budget. **No mains measurement was taken — this session never had the cable** — so that
  151 ms is the closest thing to one: it says the 270 ms is the machine's and not the panel's.
  Every median this session saw fell between 151 and 284 ms.
- **What the machine was doing while it was measured.** The scoring budget runs in the same
  `pnpm perf` and has a mains baseline written down: 9.75 ms (M1.6). It measured 48.81-61.56 ms in
  these runs, so the machine was three to five times slow. The panel's 270 ms over that factor is
  54-90 ms, which is why the budget is very probably met on mains with room to spare — but that is
  an inference from a calibration, not an observation, and the first run on mains is what settles
  it (docs/MANUAL-CHECKS.md, M2.5).
- **The gate.** The test lives in `tests/perf/` and runs in the existing `perf budgets` gate, which
  has no `retries` and runs one file at a time with coverage off. It is not in `tests/e2e/` because
  that gate retries the whole command once, and a measurement hidden behind a retry is what
  `vitest.perf.config.ts` exists to prevent; it does not use the `tests/e2e/` fixtures because those
  attach a console and request recorder to every page, and a measurement must not be instrumented
  by the suite containing it. `pnpm perf` now needs the Chrome build, so `perf budgets` was moved
  in the `gates` array to just after `build chrome`. Nothing else in `phasekit.json` changed.

## M2.5 — the panel's `Intl` formatters are built once per language, not once per row

- **Context:** the first measurement put the opening at 317 ms. Split by phase: 106 ms to load and
  compile the module, 26 ms for the seven reads, **174 ms** for scoring, sectioning and rendering
  206 rows, 11 ms to lay out and paint. 0.85 ms per row is far too much for twelve DOM nodes, and
  a CPU profile of one opening showed the app's own JavaScript was not where it went.
- **Decision:** `src/entrypoints/sidepanel/format.ts` keeps each `Intl` object in a small map
  (`reuse`), keyed by the arguments its constructor varies on — the language, plus the unit for
  `durationText`'s `style: 'unit'` formatter. `pluralRules` is exported so `reasons.ts` shares the
  same rules instead of building its own per row. The cache never evicts: the language is the
  panel's own and the units are six.
- **Why:** constructing an `Intl.NumberFormat`, `Intl.PluralRules` or `Intl.RelativeTimeFormat`
  resolves the locale's data and costs far more than formatting with one, and a row builds several.
  Five constructor calls sat on per-row paths. Memoising them took the row phase from 174 ms to
  128 ms and the whole opening from 317 ms to 277 ms, with no change to a single string: the
  formatters are immutable and keyed by everything they depend on.
- **What was ruled out.** Favicons: a run with the `_favicon/` images replaced by avatars measured
  315 ms against the baseline's 317, so the 206 image requests cost nothing measurable, and
  `content-visibility: auto` (M2.1) already keeps layout and paint at 11 ms. Virtualization: the
  task allows it only if nothing else is enough, and the remaining cost is not in the rows — an
  empty panel is 122 ms of the 277. Splitting `tldts` off the panel's critical path: PLAN.md §11
  already excludes it from the size budget, and the score needs normalised domains before the
  first row, so there is nothing to defer. Deferring rows past the first paint was rejected on
  purpose: it would move the mark rather than the cost.

## M3.1 — a close writes the archive first, and a failed batch is retried one tab at a time

- **Context:** PLAN.md §9 says a close archives and then removes. It does not say what happens when
  `tabs.remove` fails, and §8.6 only says to ignore the error. One `tabs.remove` with every id is
  one gesture for the browser, but Chrome fails the whole call when a single id is stale.
- **Decision:** `closeTabs` writes the archive entries first and removes afterwards. The removal is
  one call with every id; if that call rejects, each id is tried again on its own, and every failure
  is swallowed. The entries are returned either way, so an "Annulla" toast has something to undo.
- **Why:** invariant 3 is the one that cannot bend: a tab closed without an archive entry is a tab
  lost, while an archive entry whose tab survived is a harmless row the user can ignore. That fixes
  the order. The retry is what keeps one tab the user closed a second earlier from saving nineteen
  others from being closed — the batch call stays the normal path, and the loop only runs when
  something was already gone.

## M3.1 — a restore exempts the URL before the tab exists, and the tab id after

- **Context:** PLAN.md §8.6 wants every tab the extension opens recorded in the guard's exemptions.
  The guard reacts to `onCreated`, and the tab id is only known once the tab is there.
- **Decision:** `restoreTabs` writes one exemption per entry by URL **before** it creates or
  restores anything, and a second write with the new tab ids afterwards. Two writes per restore, not
  two per tab.
- **Why:** an exemption written after `tabs.create` is a race the guard can win, and it would close
  the tab the user just asked for — the worst failure this extension has. The URL is known in
  advance and is enough to recognise the tab; the id is written as well because a restored tab that
  navigates away keeps its id but not its URL. Batching both writes keeps an undo of twenty tabs at
  the "one write per action" of PLAN.md §10.

## M3.1 — the group is found by comparing titles ourselves, not with `tabGroups.query({ title })`

- **Context:** PLAN.md §5.5 has a restore look its group up by title, because group ids do not
  survive a restart and Firefox's `sessions` never reports one. Chrome has a `title` filter that
  looks like exactly the call to make.
- **Decision:** `restoreTabs` queries every group (`tabGroups.query({})`) and compares the titles in
  our own code, exactly. A group in the restored tab's window wins over one of the same name
  elsewhere; a title that matches nothing leaves the tab ungrouped.
- **Why:** Chrome documents that filter as a **pattern**, so a group the user called "Work \*" would
  be matched by the title "Work" and the tab would land in a group it never belonged to. Comparing
  here costs one query either way and cannot be fooled by a title containing `*` or `?`. Leaving the
  tab ungrouped is the honest answer for a group the user deleted: inventing it again would be a
  change they did not ask for.

## M3.1 — only the entries that came back leave the archive, and they come back inactive

- **Context:** §9 ends a restore by removing the entry from the archive. It does not say what to do
  with an entry that could not be restored, nor whether the restored tab should be focused.
- **Decision:** an entry is removed only once a tab exists for it; one that neither `sessions.restore`
  nor either `tabs.create` could bring back stays in the archive. Restored tabs are created with
  `active: false`.
- **Why:** removing an entry we failed to restore would turn a recoverable failure into a lost tab.
  And "Annulla" means "put back what was there": a restore of twenty tabs that stole the focus
  twenty times would be a second mistake on top of the one being undone.

## M3.1 — `platform/tabs.ts` is tested in the extension project, not the unit one

- **Context:** `tests/unit/tabs.test.ts` covered the `TabInfo` mapping and "Vai" with an injected
  API and no extension context. M3.1 makes `platform/tabs.ts` import `platform/storage.ts`.
- **Decision:** the file moved to `tests/ext/tabs.test.ts`, unchanged apart from its comment. The
  new `tests/ext/actions.test.ts` covers the actions, with the real storage behind them and an
  injected API for the tab calls.
- **Why:** defining a storage item makes `@wxt-dev/storage` read it immediately, so merely importing
  the storage module needs `browser.storage`, which the unit project does not have by design. Every
  other platform module that persists anything is already tested under `tests/ext/` for the same
  reason. The alternative — injecting the five storage functions into every action — would push the
  wiring onto every caller to keep a test file where it was.

## F.1 — perf budgets are judged against a reference workload run in the same conditions

- **Context:** the `perf budgets` gate stopped the unattended sequence three times with no code
  change: on parallel load (M1.8), on battery (M2.4) and on mains with the machine idle (M3.2),
  where the score measured 24-51 ms minutes after the same commit had measured 10.7-12.8 ms. CPU
  time instead of wall time (M2.4) removed the time the process was not running, but not this: an
  i7-12700H changes its own speed several-fold. Measured here, the score alone — no second workload
  anywhere in the process — goes from 9.75 ms to 29.31 ms after 1.5 s of nothing but scoring, and is
  still at 22.44 ms after 45 s of idle. A pure arithmetic loop that allocates nothing does the same,
  so it is not garbage, not the code, and not recovered by waiting: it is a saturating thread being
  moved to an E-core and left there. No clock can tell that apart from slower code, because a clock
  does not know how fast the machine was meant to be.
- **Decision:** every budget carries its own yardstick. `referenceWorkload` is fixed, deterministic,
  CPU-bound pure JavaScript — URL-shaped literals, a `Map` of sixty-four keys, an in-place sort — and
  deliberately not the scorer. It is measured interleaved with every sample batch, in the same unit
  as the measurement (CPU time for the CPU budgets, the page's own clock for the panel, where it runs
  inside the page between openings), so both land on the same core in the same state. What is
  enforced is `median ≤ budget × clamp(referenceMedian / REFERENCE_MS, 1, 8)`. The whole verdict is
  one pure function, `judgeBudget`, covered case by case in `tests/unit/perf-budget-verdict.test.ts`.
  The budget numbers of PLAN.md §11 are untouched: 15 ms for the score, 150 ms for the panel, 50 ms
  for the clustering.
- **Why:** `REFERENCE_CPU_MS` is 1.79 ms and `REFERENCE_PAGE_MS` is 3.48 ms — the best of several
  measurements on mains with the machine idle (1.786, 1.792, 1.792, 1.953 for the first; 3.48, 3.48,
  3.52, 4.92, 5.11, 5.14, 5.46, 5.89 for the second). The best and not the average, because
  `REFERENCE_MS` has to mean "this machine at its own best": at that speed the plan's number applies
  exactly, and a factor above 1 then says precisely how far below its best the machine is right now.
  Calibrated from a mediocre reading instead, every run would look faster than nominal, the factor
  would clamp to 1 forever and the gate would go on stopping the sequence. The 1.79 ms is the state
  in which the score itself measures the 10-12 ms the 15 ms budget was written against.
- **Why the factor is clamped:** never below 1, so a machine faster than this laptop — CI, or a later
  one — is never judged against more than the plan's number, and a reference that could not be
  measured at all (zero, negative, not a number) also reads as 1, the one answer that cannot hide a
  regression. Never above 8: past that the machine is not slow, it is a different machine, and an
  enlarged limit stops meaning anything, so the numbers are measured and printed and the gate passes
  saying `perf budget NOT ENFORCED: machine too slow (factor …)`. 8 rather than 4 at the owner's
  instruction: this laptop measures 5-6× on battery, and with a ceiling of 8 such a run is still
  judged against an enlarged limit instead of being excused outright. The battery rule is unchanged.
- **Why the reference batch is larger than the others:** the reference median is a divisor, so an
  error on it is an error on the limit. At the usual 120 ms floor a 2 ms reference was read to within
  about eight of Windows' 15.6 ms ticks, and the ratio between the score and the yardstick wandered
  between 4 and 23 across one run's eleven samples. At 400 ms it is twenty-five ticks, the ratio
  holds at 6-8, and the gate costs a few seconds more.
- **What it was checked against:** five consecutive green `pnpm perf` runs on mains, each printing
  its factor; a throwaway scorer made three times slower, which fails on mains at 62.50 ms against a
  32.70 ms limit with all three attempts over; and a run under six busy Node processes, verified
  alive on both sides of it, which passes with factor 1.74 at 18.56 ms against 26.09 ms.

## M3.2 — every close goes through `state/commands.ts`

- **Context:** the panel can now close tabs from six places: a row's own button, the selection bar,
  a section's "Chiudi tutti", a window card, `Del` and `Backspace`. PLAN.md §9 attaches two
  conditions to all of them (the question above 25 tabs, the question for the tab in use) and
  invariant 2 attaches a third (the archive).
- **Decision:** none of the six calls `src/platform/tabs.ts`. They call `requestClose(tabIds)` or
  `requestCloseWindow(windowId)` in `src/entrypoints/sidepanel/state/commands.ts`, which plans the
  close with `safeguardsFor` from `src/core/actions.ts`, asks if the plan says to, and only then
  closes. `keepTabs`, `discardTabs` and `undoClose` live there too, so a component never awaits
  anything: it names an intention and the module owns the promise, with one `catch` that logs.
- **Why:** a safeguard that each caller has to remember is a safeguard that the seventh caller will
  not have. With one door, M4.3's "Raggruppa" and §4.5's archive actions inherit §9 by calling it,
  and the components stay synchronous — which is also what keeps `DeclutterView`'s key handler a
  plain `switch` rather than a chain of awaits inside a DOM event.

## M3.2 — a close that needs confirming picks its tabs first, and asks in the bar

- **Context:** §9 wants the two confirmations inline and never through `confirm()`. It does not say
  where inline is.
- **Decision:** `gate()` sets a `PendingClose` on the `asking` signal and, before asking, calls
  `selectTabs` over exactly the tabs it is about to close. The sticky bar then renders `Confirm` in
  place of its three buttons: the question, [Conferma], [Annulla]. [Conferma] re-plans from the open
  tabs rather than trusting the plan it was given.
- **Why:** the question is "Chiudi 26 schede?" and the only honest answer to "which twenty-six?" is
  the rows themselves, ticked, with the question in the strip right under them. Putting it in the bar
  also means there is one place on screen where a close is pending, so a second close cannot be
  started behind the first. Re-planning on [Conferma] is because the browser does not wait for the
  answer: a tab closed by hand in the meantime is simply no longer in the list, and a window that
  stopped being whole no longer counts as a window.

## M3.2 — the active-tab question wins over the count question

- **Context:** `safeguardsFor` reports both `activeTab` and the bulk flag, and a close can trip both.
- **Decision:** one question is asked, and if the selection holds the tab in use it is that one
  ("Chiudi anche la scheda che stai usando?").
- **Why:** §9's two conditions are not equally surprising. Twenty-six tabs going is what the user
  just asked for; the page under their eyes going is not. Asking both in sequence would make the
  second question look like a refused answer to the first.

## M3.2 — `Escape` answers the question first, and [Annulla] keeps the selection

- **Context:** §4.8 gives `Escape` one job and does not say what it does while a confirmation is up.
- **Decision:** `Escape` cancels a pending question if there is one, and otherwise clears the
  selection — so it takes two presses to get from a question back to nothing. [Annulla] cancels the
  question and leaves the selection exactly as it was.
- **Why:** one press, one undoing of one thing, in the order the user built it. And a cancelled
  confirmation almost always means "not all of those" rather than "never mind": keeping the ticks
  lets the user unpick three rows and close the rest, which a selection wiped by [Annulla] would
  make them rebuild from scratch.

## M3.2 — a whole-window selection is still a close of tabs; only the card closes the window

- **Context:** `safeguardsFor` reports `wholeWindowIds`, so the bar can say "Chiudi 3 schede e la
  finestra" for a selection that happens to empty a window. `src/platform/tabs.ts` has both
  `closeTabs` and `closeWindow`, and they archive with different reasons.
- **Decision:** `PendingClose.windowId` is set only by `requestCloseWindow`, which §4.3's window card
  calls. A selection that empties a window goes through `closeTabs` all the same; the wording is
  honest either way, because Chrome closes a window whose last tab goes.
- **Why:** the archive is the record of why a tab went (§4.5), and the two gestures are not the same
  reason: "ho chiuso questa finestra dimenticata" is `window`, "ho chiuso queste schede" is `manual`,
  even when the outcome on screen is identical. Deciding by outcome would relabel the second as the
  first whenever a selection happened to be exhaustive.

## M3.2 — the selection keeps ids whose tabs have gone

- **Context:** tabs close, move between windows and are replaced while the panel is open, and the
  selection is a plain set of ids.
- **Decision:** nothing prunes it. `deselectTabs` is called after a close for the ids it closed, and
  that is the only housekeeping; a stale id simply never matches anything again.
- **Why:** every reader already starts from the open tabs — `safeguardsFor` filters its input by the
  live `tabs` array, and the bar's counts come out of that filter. A pruning watcher on top would be
  a second source of truth for "what is picked", and the one case it would change is a tab id Chrome
  reused, which it does not do within a session.

## M3.2 — the row picks the tab; the checkbox only shows it

- **Context:** §4.3 wants a selection, and the rows are already a grid with their own `Vai`,
  `Mantieni` and `Chiudi` buttons.
- **Decision:** a click anywhere on the row toggles it. The checkbox is rendered with no handler at
  all and `pointer-events: none`, so it is the state made visible and never a second target; the row
  actions `stopPropagation` so using one does not also pick the row.
- **Why:** a 16 px box is below §4.4's 24 px target, and offering both a box and a row means two
  gestures with the same meaning and one of them hard to hit. Keeping the `<input>` in the DOM is for
  the screen reader, which reads the row's `aria-label` with its checked state; `pointer-events: none`
  is what stops the click landing on the input and never reaching the row.

## M3.2 — one selection signal per row, and "Seleziona tutti" is its own component

- **Context:** §11 forbids re-rendering the list for a selection, and reading a signal during render
  subscribes the component that read it.
- **Decision:** `selectedSignal(tabId)` hands back a per-id computed, memoised in a `Map`, and that
  is the only thing a row reads. The section header's button was extracted into `SelectAllButton`
  because it has to read `allSelected(tabIds)`, which depends on the whole set.
- **Why:** without the extraction, picking one row invalidated `allSelected`, re-rendered `Section`
  and therefore re-rendered every `TabRow` under it — the exact cost §11 budgets against, at 300
  tabs. The `Map` is never pruned: one computed per tab id seen in a session is a few hundred
  objects, and dropping one while a row still holds it would silently stop that row updating.

## M3.2 — the section's select-all button changes its own label

- **Context:** the header has room for two actions beside the count.
- **Decision:** one button, labelled "Seleziona tutti" or "Deseleziona tutti" according to whether
  the section's rows are all picked, next to "Chiudi tutti (N)". `allSelected([])` is `false`, so an
  empty section keeps the first label.
- **Why:** a separate "Deseleziona" is dead most of the time and the pair doubles the header's width
  at a 320 px panel (§4.1). The label is the state, which is also what tells the user that the
  section is fully picked without a third indicator.

## M3.2 — the close buttons use the accent, not `--td-danger`

- **Context:** a close is destructive, and the token file has a red.
- **Decision:** `--td-danger` stays reserved for "Elimina definitivamente" in the archive (§4.5).
  The bar's close and [Conferma] get a new `.td-action-primary`, filled with `--td-accent`; every
  other close is a plain action button.
- **Why:** §4.5 is the only irreversible action in the product, and a red that also means "close 26
  tabs, undoable for 8 s" stops meaning "this does not come back". Making the bar's close the only
  filled button in the panel is enough to find it.

## M3.2 — the toast's region is in the document before there is a toast

- **Context:** §4.3 wants the toast announced, which means `aria-live`.
- **Decision:** `.td-toast-slot` is rendered always, with `role="status"` and `aria-live="polite"`,
  and the toast appears inside it. A first draft hid the empty slot with `:empty { display: none }`;
  that was removed and the spacing moved onto `.td-toast` itself.
- **Why:** a live region that is inserted together with its text is announced unreliably — the
  screen reader has to be watching the region before the text arrives. The whole footer is
  `pointer-events: none` with `pointer-events: auto` on its children, so the empty slot and the
  sticky strip never swallow a click meant for the last row.

## M3.2 — the window card got its close button here, not in M3.1

- **Context:** M3.1 rendered §4.3's forgotten-window card as a sentence. The card's action is the
  only place in the panel where a close takes the tab the user is looking at.
- **Decision:** the button belongs to M3.2, with the rest of the actions, and
  `tests/e2e/declutter.spec.ts` now asserts the sentence on `.td-window-text` rather than on the
  whole card.
- **Why:** it is an action, and until `commands.ts` existed there was nothing safe to wire it to.
  It is also the only reachable path to both halves of §9 that the E2E can exercise: `protectionOf`
  returns `active` for any active tab, so no list-driven selection can ever contain one or empty a
  window.

## M3.2 — the actions E2E ages its tabs with the clock alone and seeds nothing

- **Context:** `tests/e2e/declutter.spec.ts` seeds `local:activity` and then waits for the background
  tracker to stop rewriting it, which costs seconds and is the fiddliest part of that spec.
- **Decision:** `tests/e2e/actions.spec.ts` seeds no storage at all. It installs a `Date.now` twelve
  days ahead with `addInitScript` before loading the panel, opens its tabs with `chrome.tabs.create`,
  and takes the rendered row count as the signal that the list has settled. It reuses the window's
  first tab as the panel page instead of opening a new one.
- **Why:** `factsOf` takes the later of the stored `lastActiveAt` and Chrome's own `lastAccessed`,
  and `lastAccessed` is always seconds ago, so the clock shift alone makes every tab twelve days
  idle — past the two-hour grace, the one-day bootstrap grace and `staleDays` at once — and a tab
  with no record counts as never read, which is the tab these tests want anyway. No seed means no
  tracker race to wait out. Reusing the first tab keeps the panel its window's *active* tab, which
  is what makes the active-tab confirmation reachable and what lets every assertion here use a real
  `click()` instead of a dispatched event on a throttled background page.

## M3.3 — the date filter has a fourth option, and its days are calendar days

- **Context:** PLAN.md §4.5 names three date filters — "Oggi", "Ultimi 7 giorni", "Più vecchie" —
  and does not say what the view shows before one is chosen, nor whether a day is a calendar day
  or the last 24 hours.
- **Decision:** `ArchiveWhen` is `'any' | 'today' | 'week' | 'older'`, and `any` is the option the
  view opens on and can go back to. "Oggi" is from the local midnight before the snapshot's moment
  (`startOfDay`); "Ultimi 7 giorni" is from midnight six days before that, today included; "Più
  vecchie" is the exact complement of that same boundary, so the three are filters over one
  threshold and no entry is unreachable. All three are computed from `ArchiveData.at`, the moment
  the archive was read, not from a live clock.
- **Why:** without a fourth option the view would have to open on one of the three, and "Oggi"
  would hide the archive on a quiet day while "Più vecchie" would hide everything just closed. A
  calendar day is what the words mean: a tab closed at 23:50 is yesterday's once the clock passes
  midnight, and a rolling 24 hours would still call it today at nine the next morning. Judging
  against the snapshot rather than `Date.now()` is what keeps the list and each row's "2 giorni fa"
  describing one moment — a panel left open overnight is stale, not inconsistent.

## M3.3 — only the guard's own closes count as "Duplicati chiusi automaticamente"

- **Context:** §4.5's origin filter has two values and `ArchiveReason` has five (`manual`,
  `window`, `duplicate-auto`, `duplicate-manual`, `stale`).
- **Decision:** `originOf` maps `duplicate-auto` to `duplicates` and everything else to `mine`.
- **Why:** the filter exists to separate the closes the user made from the one close in the product
  they did not make tab by tab — §8's guard closing a duplicate as it opens. "Chiudi tutti i
  duplicati" (`duplicate-manual`) is a button they pressed, so it belongs with their own closes
  even though the word "duplicate" is in its reason.

## M3.3 — the export writes the clipboard from the button's own gesture, with no permission

- **Context:** §4.5 wants "Esporta (lista Markdown di link) negli appunti". PLAN.md §5.4 lists the
  permissions exactly, and invariant 8 forbids adding one.
- **Decision:** `copyArchived` calls `navigator.clipboard.writeText` inside the click handler's own
  task, with no `clipboardWrite` permission in either manifest. It returns a boolean, and the view
  shows "Copiato" in its live region only when that is `true`; a refusal is logged and nothing is
  claimed. It copies `shownArchive` — what the search and the filters left — and refuses an empty
  list outright.
- **Why:** an extension page writing the clipboard during a user gesture needs no permission in
  either browser, and `clipboardWrite` would be a permission in the store listing that buys
  nothing. The clipboard is the only action in this view the browser can refuse for a reason
  outside our control, so it is the only one that reports back instead of being fired and
  forgotten. Exporting the filtered rows is what makes the search useful for anything but reading:
  it is how §4.5 lets the user choose *which* links to export.

## M3.3 — the Markdown export escapes the title and the URL it is embedding

- **Context:** a title and a URL are a page's own text (invariant 7), and the export is pasted into
  somebody's document.
- **Decision:** `exportArchive` escapes `[`, `]` and `\` in the link text, and wraps a URL
  containing a space, a parenthesis or an angle bracket in `<…>` with those brackets
  percent-encoded. An entry with no title is named by its domain, and one with neither by its URL.
- **Why:** invariant 7 is about markup in the DOM, but the reasoning carries one layer out: a title
  ending in `](http://evil` would otherwise produce a link in the user's notes pointing somewhere
  the archive never recorded. Escaping costs nothing and the result is still plain Markdown.

## M3.3 — the archive is read when its view opens, and its actions live beside it

- **Context:** `state/tabs.ts` is started by the panel and followed for the panel's life. The
  archive is up to `ARCHIVE_CAP` (1000) entries, and PLAN.md §11 budgets the panel's opening.
- **Decision:** `startArchiveState` is called from `ArchiveView`'s `useEffect` and its `stop()`
  removes the `storage.onChanged` listener and any pending debounce; `archiveData` is `null` until
  the first read comes back, and the view renders nothing at all until then. The four actions
  (`restoreArchived`, `forgetArchived`, `emptyArchived`, `copyArchived`) live in
  `state/archive.ts`, not in `state/commands.ts`.
- **Why:** reading 1000 entries nobody asked for to show the Declutter list is exactly the cost
  §11 is written against, and the view is the one thing that knows whether they are wanted.
  Rendering nothing rather than an empty state for the first read is because an empty archive and
  an unread one look identical and mean opposite things. The actions are separate from
  `commands.ts` because that module is the single door to closing a tab — safeguards, confirmation,
  undo — and three of these cannot touch a tab at all; the one that can, a restore, calls
  `platform/tabs.ts`'s `restoreTabs`, the same function "Annulla" uses, so §9 keeps one definition
  of bringing a tab back.

## M3.3 — a row's "Elimina" acts, "Svuota archivio" asks, and an empty archive has no toolbar

- **Context:** §4.5 asks for an inline confirmation on "Svuota archivio" and §9 forbids
  `confirm()`. It says nothing about the per-row delete or the multiple one.
- **Decision:** "Elimina" on a row and "Elimina (N)" in the selection bar happen immediately.
  "Svuota archivio" sets `asking` and the question replaces the whole actions strip — select-all,
  export and empty all go, so nothing else there is pressable while it is open — with
  [Conferma] focused. An archive with no entries renders only the empty state: no search box, no
  filters, no actions.
- **Why:** the rows a delete takes are the ones the user is pointing at or has ticked, and the
  button says how many; the question would be asking them to confirm what they can see. "Svuota"
  is the one action whose scope is not on screen — it takes the 970 rows the filter is hiding too —
  which is why it says how many and why it asks. Replacing the strip rather than appearing beside
  it follows M3.2's confirmation in the bar: one place on screen where something is pending. And a
  search box over an empty archive is three controls that cannot change the answer.

## M3.3 — the archive list is an ARIA grid without a roving tab stop

- **Context:** §4.8 gives the Declutter list one roving tab stop, with ↑/↓ walking the rows across
  their section boundaries. The archive list is also rows with a checkbox and two buttons.
- **Decision:** `role="grid"` with `role="row"`/`role="gridcell"` for the structure, but every
  control is an ordinary tab stop: no `tabIndex` management, no key handler, and the checkbox has
  its own click handler so `Space` is the browser's own.
- **Why:** the roving tab stop exists in §4.8 because that list has sections a plain `Tab` order
  cannot express, and because its rows are a target the arrow keys must reach. The archive is one
  flat list under a search box, which is a form: `Tab` into the search, `Tab` through the rows is
  what a person expects there, and reimplementing arrow navigation would take `Space` and the
  text caret away from controls that already handle them.

## M3.3 — the cleanup sweeps at registration too, and keeps nothing in a variable

- **Context:** PLAN.md §10 asks for a cleanup "every 6 h" through `chrome.alarms`. An alarm only
  fires while the browser is running, and `alarms.create` with an existing name restarts the
  countdown.
- **Decision:** `registerCleanup` adds its three listeners (`alarms.onAlarm` filtered by the name
  `cleanup`, `runtime.onStartup`, `runtime.onInstalled`) synchronously, creates the 360-minute
  alarm only if `alarms.get` says there is none, and runs one sweep immediately. Every sweep reads
  the stores, decides and writes; `run()` chains, so two triggers cannot read the same store at
  once, and a failed sweep leaves the queue alive.
- **Why:** a profile that was off for a month must not wait another 6 h before honouring a 30-day
  retention, and a service worker that wakes every few minutes would push an unguarded `create`
  past the period forever, so the sweep would never fire. Nothing is held between sweeps
  (invariant 6): a worker that dies halfway leaves a store that is merely not yet swept, which the
  next alarm or the next startup finishes.

## M3.3 — retention is a strict boundary, and an "orphaned" record is one with no open tab

- **Context:** §10 names three things to sweep and §4.6 gives retention in days. Neither says what
  happens to an entry exactly 30 days old, nor what makes an activity record orphaned.
- **Decision:** `pruneArchiveEntries` keeps `closedAt > now - retentionDays * DAY`, so the boundary
  itself goes; retention is applied before the cap, and the cap keeps the newest by `closedAt` with
  the stored order breaking a tie. `sweepActivity` keeps a record only if its key is the id of a
  tab `tabs.query({})` reports *and* the value passes `isTabActivity`; everything else is dropped.
- **Why:** "conserva 30 giorni" is a promise about what is kept, so the entry that has used its
  thirty days up is not kept — and a strict comparison is the one a test can state exactly.
  Retention first because dropping month-old entries may bring the rest under the cap for free.
  The tracker deletes a record the moment its tab goes, so a record for a tab that does not exist
  means nobody was listening — a crashed worker, a forced restart — and a value that is not a
  record at all can only be dropped, because nothing downstream could score it.

## M3.3 — the archive E2E seeds `storage.local` and serves the pages it restores

- **Context:** "Done when" asks for a Chromium E2E over search, restore and empty. Search needs a
  ten-day-old entry, restore needs a URL that actually loads, and invariant 1 forbids any request
  leaving the extension.
- **Decision:** `tests/e2e/archive.spec.ts` writes three entries into the raw `archive` key from
  the panel page — with the browser's real `windowId`, and `closedAt` set to now and to now minus
  ten days — and their URLs are served by a `node:http` server the spec starts on `127.0.0.1`. It
  does not drive "Esporta".
- **Why:** a ten-day-old entry cannot be produced by closing a tab, and `archiveItem` is version 1
  with no migrations, so a raw `set` is read back by `readArchive` unchanged. Ten days and not
  eight because the boundary is a calendar day and a suite running near midnight must not land on
  it. The real `windowId` makes a restore take the ordinary `tabs.create({ windowId, index })` path
  instead of §9's fallback, which is the path worth covering. Local pages because a restore really
  opens them: `recorder.initiator()` does not attribute a restored tab's own loads to the
  extension, but a request to a real site would still be a request this suite must never make.
  "Esporta" is left to docs/MANUAL-CHECKS.md: granting clipboard permission to an extension origin
  in Playwright is a browser-configuration risk out of proportion to the three lines it would
  cover, and `copyArchived` is already covered with a stubbed clipboard in `tests/ext/`.

## M3.4 — "Consenti duplicati per questo sito" whitelists the host, not the registrable domain

- **Context:** PLAN.md §4.1 says the item adds `*://<domain>/*` to the duplicate whitelist, and
  does not say which "domain" — the tab's host, or the registrable domain "Proteggi sito" uses.
- **Decision:** `duplicateWhitelistPattern` builds the pattern from the URL's `host`, port
  included: `https://www.example.com/a` gives `*://www.example.com/*`, `http://localhost:3000/dev`
  gives `*://localhost:3000/*`, and a URL with no host (`about:blank`, `file:`, unparseable) gives
  nothing. `addDuplicateWhitelistPattern` stores the line trimmed but **not** lower-cased, and
  skips one it already has.
- **Why:** a whitelist line is matched against the tab's raw URL as a literal anchored at both
  ends, with `*` for any run of characters (`core/patterns.ts`), so `*://example.com/*` has nothing
  to match in `https://www.example.com/a` — a pattern built from the registrable domain would fail
  to whitelist the very tab the user right-clicked on, which is the one thing the item must do. The
  port is in the raw URL too, so dropping it would break the same way on a dev server. Narrower
  than the whole site is the recoverable error of the two: another right-click adds the sibling,
  while nothing in the UI would explain a whitelist entry that covers more than the user pointed
  at. No lower-casing because that list is matched case-sensitively and a line may be a regex, so
  re-casing what is written there would change what it matches.

## M3.4 — the `tab` context is a capability, and the items are created on `onInstalled`

- **Context:** PLAN.md §5.5 asks for the common contexts only, "`tab` (Firefox only, added when
  present)", and invariant 5 forbids application code from checking the browser name.
- **Decision:** a new capability, `caps.tabContextMenu`, is true when `contextMenus.ContextType`
  has a `TAB` member; `registerMenus` asks for `['page', 'tab']` when it does and `['page']`
  otherwise. The items are created in `runtime.onInstalled`, after one `removeAll()`, while the
  `onClicked` listener is registered synchronously at the top level.
  The namespace itself is looked up as `browser.menus ?? browser.contextMenus`, in both places,
  and a profile with neither logs once and leaves the rest of the background alone.
- **Why:** `ContextType` is each browser's own enum of the contexts it accepts, so reading it is
  feature detection rather than a browser name, and a browser that stopped exposing it would lose
  the tab strip entry and keep the page one instead of losing all three items — Chrome rejects the
  whole `create` call when a context it has no name for is named. `onInstalled` because menu items
  belong to the browser, which keeps them until the extension updates: a worker woken *by* a click
  cannot create them first, and `removeAll` covers the update that fires `onInstalled` with the
  previous version's items still installed, where `create` on an existing id is an error. And
  `menus` before `contextMenus` because Firefox only aliases the namespace as `contextMenus` for a
  profile that asked for the `contextMenus` permission, which this manifest does not: it asks for
  `menus` (PLAN.md §5.4). Reading `contextMenus` alone was `undefined` on Firefox, and the
  top-level `undefined.onClicked` took the whole background script — tracker, badge and cleanup
  included — down with it, which the Firefox E2E console check caught before this commit.

## F.1 — the perf-harness unit test burns CPU time instead of wall time

- **Context:** `tests/unit/perf-budget-power.test.ts` has to miss a 0 ms budget, and its workload
  spun until `performance.now()` had moved by 25 ms.
- **Decision:** the workload now loops until `process.cpuUsage()` has moved by 40 ms of user +
  system time, more than two of Windows' ~15.6 ms scheduler ticks.
- **Why:** the perf-harness unit test missed its 0 ms budget by wall time, so a saturated CPU could
  read 0 µs; it now burns CPU time. `tests/perf/budget.ts`, the budgets and the retries are
  unchanged: the miss is a property of the run rather than of the machine's load.

## M3.5 — the restart spec launches its own browsers and shares one recorder across both

- **Context:** §13's M3 acceptance asks for an archive that survives a browser restart. Every other
  Chromium spec takes its browser from the `context` fixture, which is one context per test and
  closes it afterwards; the auto-use `health` fixture is what checks the console and invariant 1.
- **Decision:** `launchExtension` and `extensionIdOf` were lifted out of the fixture file and
  exported, and `tests/e2e/restart.spec.ts` imports the base `@playwright/test` and launches two
  persistent contexts on one `testInfo.outputPath('profile')` itself. One `createRecorder()` is
  attached to both, and the spec asserts `takeConsoleErrors()` and `takeForeignRequests()` by hand
  at the end. Nothing is seeded: the entry is written by a real close through the first panel.
- **Why:** a restart is two contexts over one profile, which no per-test context fixture can
  express, and the alternative — a worker-scoped fixture that relaunches — would make every other
  spec pay for a case only this one has. One recorder because an error logged while the *second*
  browser boots is the failure this test is most likely to find, and that run would otherwise have
  nothing watching it; the readers drain what they return, so two contexts appending to the same
  lists read as one run. Seeding was rejected on purpose: a raw `set` would prove that
  `storage.local` persists, which is Chrome's job, not that a close followed by a shutdown leaves
  something behind. The restore afterwards is also the only E2E that takes §9's `tabs.create`
  fallback, because the window the tab was closed from no longer exists.

## M3.5 — the keep's expiry is simulated by rewriting `local:keeps`, read against the panel's clock

- **Context:** M3.5 asks that a kept tab come back "when the keep expires", and `DEFAULT_KEEP_MS`
  is seven days. The panel's own `Date.now` is already twelve days ahead (`actions.spec.ts`).
- **Decision:** the test clicks "Mantieni", reads the raw `keeps` key back, asserts it has exactly
  one entry whose key contains the page's path and whose value is within an hour of
  `now + KEEP_MS`, and then writes that same key back with an expiry an hour *before* the panel's
  shifted now. The row is expected to return without the tab count changing.
- **Why:** reading the key back instead of computing it keeps `keepKey`'s normalisation out of the
  test — the assertion is that the panel wrote a keep for *that page*, not that the test can
  reproduce the hashing. Rewriting the stored value is the only way to move an expiry: the clock
  is fixed at panel load and `readKeeps(now)` drops expired entries on the `storage.onChanged`
  refresh, so the past expiry makes the next read behave exactly as a real seven days later would.
  `keepsItem` is version 1 with no migrations, so a raw `set` is read back unchanged — the same
  reason the archive spec can seed `archive`.

## M3.5 — §14's undo is checked as sorted `url windowId` pairs across two windows

- **Context:** M3.5 asks that ten closed tabs come back "same URL, same window". A single window
  cannot show that the window is part of what is restored, and §9's three safeguards must not fire
  on the path being tested.
- **Decision:** ten distinct numbered pages, five in the panel's window and five in a second window
  opened with `windows.create({ focused: false })` whose *first* tab is an eleventh page. The test
  captures every served tab as `"<url> <windowId>"`, sorted, before the close, and asserts the same
  list after Annulla. It also asserts the bar says `barClose(10)` rather than `barCloseWithWindows`,
  and that no inline question is on screen.
- **Why:** comparing ids would be wrong — a restored tab is a new tab — while the URL and the window
  are what the user would notice, and sorting makes the comparison independent of the order
  `restoreTabs` happens to put them back in. The second window's first tab is its active tab and so
  protected whatever its age (§8.4): it has no row, it keeps §9's active-tab question out of the
  way, and it stops the close from emptying the window, which would have triggered the whole-window
  wording instead. Asserting that the safeguards are *absent* is the point: the three tests that
  drive them already exist in this file, and a 10-tab close that quietly turned into a confirmation
  would otherwise still pass. `bringToFront()` after `windows.create` because a new window takes the
  foreground whatever `focused: false` asks, and a background panel's clicks are not real clicks.

## M3.5 — Firefox's actions smoke test clicks in the document, and holds the toast with focus

- **Context:** §14 asks for a Firefox smoke test over close + undo. BiDi refuses
  `browsingContext.activate` on a privileged document, so the panel cannot be brought in front, and
  Playwright-style pointer input on a background `moz-extension://` page is not available.
- **Decision:** `tests/e2e-firefox/fixtures/panel.ts` gained `clickPanel`, `clickButton`,
  `focusPanel`, `panelText`, `openUrls` and `until`, all of which run inside the document
  (`element.click()`, `element.focus()`), and the duplicate-pair seed `declutter.spec.ts` had inline
  moved into the shared `openDuplicatePair`. The new `actions.spec.ts` picks the row, closes it from
  the bar, calls `focusPanel('.td-toast')` to hold the eight seconds, and undoes.
- **Why:** an in-document `click()` is a weaker check than a real pointer — it does not prove the
  element is reachable or unobscured — but that part is Chromium's test, and what this smoke test
  is for is the platform calls underneath: that `browser.tabs.remove` and the restore path behave
  the same on Gecko. `focusin` rather than a hover because `Toast.tsx` holds the undo window on
  either, and focus is the one of the two this harness can produce. The seed moved rather than being
  copied because it is ~60 lines of tracker-quiescence timing that two specs now need, and two
  copies would drift.

## M3b.1 — unit tests of the perf harness never depend on machine speed

- **Context:** F.1's harness judges a budget against the machine's own measured speed, and its unit
  tests had inherited that dependence: `perf-budget-verdict.test.ts:151` timed out at 5892 ms under
  the load of 33 vitest workers, red on a structural assertion, after M3.4 had already had to fix
  one such test.
- **Decision:** unit tests of the perf harness never depend on machine speed — generous timeouts
  (30 s) for the ones that run a workload or a measurement, verdicts decided by construction for
  the rest. `PAGE_REFERENCE_RUNS`, the global `testTimeout`, the budgets of PLAN.md §11 and
  `tests/perf/budget.ts` are unchanged.
- **Why:** none of these tests asserts how fast anything is — they assert the shape of the workload
  and the branches of `judgeBudget` — so wall time was gating them on something they do not claim.
  A generous timeout costs nothing on an idle machine and still catches a genuine hang.

## M3b.1 — the guard reads `TabInfo.active` and `navigatedTabIds`, not an `activeTabIds` set

- **Context:** PLAN.md §8.4's sketch of the decision's context lists an `activeTabIds` set.
- **Decision:** `GuardContext` has no such field. It extends `KeepContext`, so whether a tab is
  active comes from `TabInfo.active` and whether it got here by navigating from
  `KeepContext.navigatedTabIds`.
- **Why:** §8.4.3.2 keeps "the active tab the user navigated to a URL already open elsewhere", and
  a tab opened from a link in the foreground is active too — keeping that one would close the tab
  the user came from. The rule therefore needs *active and navigated*, both of which M1.4's
  comparator already reads. A third set would be a second place where "active" is recorded, and the
  guard's close could then disagree with the tab Declutter would have kept (TASKS.md §2.9).

## M3b.1 — a tab opened in the background is closed without moving the focus

- **Context:** §8.4.4's action after a close is "Attivala" or "Sposta e attiva", and §8.6 says a
  middle-click or Ctrl+click duplicate must not pull the user anywhere.
- **Decision:** when the tab being closed is the trigger, newly created and not active, the
  resolution's `after` is `none` whatever the setting says. It applies only to that tab: closing an
  *older* duplicate while a background tab survives still activates.
- **Why:** §8.4's result has no "move without focusing" value, and inventing one would be worse
  than `none` — "Sposta e attiva" exists to put the surviving tab under the user's eyes, so moving
  it silently would shuffle the tab strip for someone who is looking elsewhere. The restriction to
  the trigger matters because an event about an old tab is not a gesture the user made in the
  background.

## M3b.1 — `about:blank` is the only blank page "Ignora schede vuote" governs

- **Context:** §8.3 documents "Ignora schede vuote" as switchable but notes it is "always true for
  `chrome://newtab`". `classify` calls every entry of `BLANK_URLS` — `about:blank`, the new tab
  pages, the home and private-browsing pages — `blank`.
- **Decision:** a `blank` URL is closable only when the option is off *and* the canonical URL is
  exactly `about:blank`. Every other blank URL is never closed, like `browser-internal`.
- **Why:** reading the option as governing all of `BLANK_URLS` would make the note in §8.3 false;
  reading it as governing none would make the option dead, since every blank URL also carries an
  internal scheme. `about:blank` is the one of them that is a page the user can really have two of.

## M3b.1 — an exempt tab is neither closed nor a reason to close another

- **Context:** §8.6 exempts the tabs the extension itself opened or restored, for
  `EXEMPTION_TTL_MS`, so that an "Annulla" is not immediately undone by the guard.
- **Decision:** exemptions are filtered out of the candidate set as well as checked on the trigger,
  and an exemption naming neither a tab id nor a URL matches nothing rather than everything.
- **Why:** closing a new tab "because the restored one exists" undoes the undo just as surely as
  closing the restored tab, so the exemption has to remove the tab from the comparison entirely.
  Reading an empty exemption as matching everything would turn one malformed stored record into a
  guard that has silently stopped working.

## M3b.1 — the start-up grace period arrives as a deadline, not as a flag

- **Context:** §8.6 gives session restore a `STARTUP_GRACE_MS` window in which no automatic close
  may happen.
- **Decision:** `GuardContext.autoClosesAllowedFrom` is an optional ms epoch; absent means no grace
  period is running, and `now < autoClosesAllowedFrom` is the filter.
- **Why:** the core is pure and takes its `now` injected (TASKS.md §2.4), so a deadline is
  something it can decide about, while a boolean would have to be computed against a clock the
  background owns. It also makes the expiry a unit test rather than a timer.

## M3b.1 — "Duplica scheda" is recognized without asking which browser this is

- **Context:** §8.6's heuristic for Chrome's own "Duplica scheda" is a newly created tab, opened by
  one of the tabs it duplicates, sitting immediately after it, with its URL already set. The
  setting behind it is Chrome-only and hidden on Firefox (PLAN.md §5.5).
- **Decision:** `resolveDuplicate` applies the heuristic exactly when `allowIntentionalDuplicates`
  is on, and "newly created" is `!navigatedTabIds.has(id)`. It never looks at the browser.
- **Why:** TASKS.md §2.5 keeps browser checks out of `src/core/`, and the flag is enough: on
  Firefox the UI never turns it on, so the branch is simply not taken. The `url !== ''` condition
  is what separates a duplicated tab from one opened from a link, which arrives with an empty `url`
  and its address in `pendingUrl`.

## M3b.1 — one close per event, decided against the best candidate

- **Context:** §8.4.2 requires exactly one tab closed per event, while a set can hold three or more
  tabs on one page.
- **Decision:** `resolveDuplicate` picks the best candidate with M1.4's `chooseTabToKeep`, compares
  the trigger with that one tab, and closes the loser. The rest of the set is untouched.
- **Why:** the comparator is a total order (its last rule is the tab id), so a pair always has a
  winner and the function never has to reason about more than two tabs. Three tabs of one page
  converge to one through the events that arrive on their own account, which is also what keeps a
  single resolution small enough to be carried out without going stale.

## M3b.2 — the index holds tab ids, and every tab is read again before anything is done to it

- **Context:** PLAN.md §8.2 asks for a `Map<duplicateKey, Set<tabId>>` rebuilt on wake-up, and §11
  gives the event 50 ms with the worker running and 300 ms when it has to be woken. §8.6 lists "tab
  closed in the meantime" as a case to survive.
- **Decision:** the index stores ids and nothing else. Every step that needs a tab calls
  `getTab`: the trigger once per event, the candidates of its bucket in one `Promise.all`, and both
  ends of a resolution once more immediately before the close. An id that answers `null` is dropped
  from the index on the spot, and a missing *kept* tab cancels the close as surely as a missing
  target.
- **Why:** a `TabInfo` cached in the index would be a second copy of the browser's state that no
  event updates completely — `onUpdated` carries only what changed, pinning and audio arrive as
  events the guard does not listen for — and a close decided on a stale copy is a tab the user
  loses. Ids are cheap to keep and the re-read is the only thing that makes the decision true at
  the moment it is acted on. The re-read is also §8.6's answer for free: the burst that closed a
  tab a microsecond ago gets a `null` rather than an exception. The cost is one `tabs.get` per tab
  of the bucket, which for the pair or triple a duplicate set actually is stays well inside §11.

## M3b.2 — a tab is still arriving until it has an address, which is how Firefox is handled

- **Context:** §8.4.3.2 keeps "the active tab the user navigated", and the guard has to tell a
  navigation from a tab that is merely finishing being created. Chrome says so with `pendingUrl`;
  Firefox has none, and every tab there is created on `about:blank` with its real address arriving
  in the first `onUpdated` (PLAN.md §5.5).
- **Decision:** the index keeps two sets of ids: `navigated`, which the core reads through
  `GuardContext.navigatedTabIds`, and `awaiting`, the tabs whose last known URL was blank. An
  `onUpdated` for a tab in `awaiting` does **not** mark it navigated; `onCreated` clears the flag;
  the index built on wake-up marks every tab it finds as navigated. A blank tab also returns
  early, before any candidate is looked for, while "Ignora schede vuote" is on.
- **Why:** without `awaiting` the first `onUpdated` of a Firefox tab would look exactly like a
  navigation, so opening a link in the foreground onto a page already open would close the tab the
  link was in — the behaviour §8.4.3.2 exists to prevent — and the option it depends on is not
  Firefox-specific, so a `capabilities` check would not have fixed it. Tabs found by
  `tabs.query({})` count as navigated because a tab that was already open when this worker started
  is not a tab the user is in the middle of opening; treating a restored session as twenty fresh
  creations would make the newest tab win every tie. The early return for a blank tab is where the
  Chrome and Firefox paths rejoin: `about:blank` is nobody's duplicate yet, and the `onUpdated`
  that gives it an address brings it back here.

## M3b.2 — "Niente" and "Solo avvisi" cost no API call at all

- **Context:** §8.1's three modes, and §11's budget for a guard that runs on every navigation of
  every tab.
- **Decision:** `evaluate` awaits the settings and returns immediately unless the mode is `auto`.
  No index is built, no `tabs.get` is made, no session state is read. A change of mode arrives as
  `storage.onChanged` on `local:settings` or `local:duplicateWhitelist` and invalidates both the
  settings and the index.
- **Why:** two of the three modes close nothing, and in those two the cheapest correct guard is one
  that does nothing: the duplicates are still shown, by the panel, which reads the same rules over
  the list it already has (§8.1). Invalidating rather than re-reading on change keeps the cost on
  the next event instead of on the write, and the index goes with the settings because the key
  options are part of them — the same tabs filed under `ignoreAllParams` and without it are two
  different indexes.

## M3b.2 — one event at a time, with the badge flash deliberately outside the queue

- **Context:** §8.2 asks for a serial queue. §8.5 wants the badge to flash when the guard closes
  something, and that flash lasts 1.5 s.
- **Decision:** every listener hands its work to one `chain` of promises, so no two events are ever
  resolved at once; a step that closed a tab starts the flash **after** leaving the queue, and a
  flash already running is left to finish rather than queued behind itself. `settled()` waits for
  the chain and the flash both, and loops until neither moves.
- **Why:** the queue is what makes twenty simultaneous openings of one page leave one tab instead
  of none: each event sees an index the previous one has already had its close removed from.
  Awaiting a 1.5 s flash inside it would hold the next event up for thirty times the 50 ms §11
  allows and would turn a burst into half a minute of flashing, so the flash is a side effect of
  the burst rather than a step of it — one flash for the burst is also what the user can actually
  perceive. `settled()` exists for the tests and for the worker's own lifetime: the colour has to
  go back before the service worker may be torn down.

## M3b.2 — the pause is a deadline in `storage.session` and an alarm, and never touches the mode

- **Context:** §8.1's "Sospendi" offers 15 min, 1 h and "fino al riavvio". Invariant 6 forbids
  keeping anything in a variable, and the service worker dies long before any of those durations.
- **Decision:** `pause` writes `pausedUntil` and `resumeMode` to `session:guardState` and creates a
  `guard-resume` alarm; the stored `guard.mode` is left exactly as the user set it. "Fino al
  riavvio" gets a deadline a year out and **no** alarm. The alarm's handler goes through the same
  serial queue as the events, and `resume` clears both the state and the alarm.
- **Why:** rewriting the mode to `off` and back would make a pause indistinguishable from a
  setting, and a worker that died between the two writes would leave the guard switched off with
  nothing to switch it back on. A deadline in `storage.session` cannot survive the restart, which
  is exactly what "fino al riavvio" means — so that case needs no alarm, and the year is only there
  so the number is in the future for any session that reads it. The alarm is on the queue because
  the end of a pause must not land halfway through an event that read `pausedUntil` a moment
  earlier, which would close a tab under a guard that was still paused when the decision was made.

## M3b.2 — `getTab`, `moveTab` and `navigateTab` join `platform/tabs.ts`

- **Context:** the guard needs one tab by id, the move of "Sposta e attiva" (§8.4.4) and the reload
  of "Più vecchia ricaricata" (§8.4.3.4). Invariant 5 keeps browser calls in `src/platform/`.
- **Decision:** three functions beside the existing actions. `getTab` answers `TabInfo | null`,
  mapping Chrome's rejection, Firefox's `undefined` and a hidden tab onto the same `null`.
  `moveTab` takes `NO_WINDOW` for "only change the index" and returns a boolean. `navigateTab` is
  `tabs.update(id, { url })` — not `tabs.reload` — and returns a boolean too.
- **Why:** the guard is the first caller that acts on a tab it did not get from `queryTabs`, and
  letting it call `browser.tabs` itself would put the two browsers' disagreement about a missing tab
  into the background script. `null` for a hidden tab is the same rule `asTabInfos` already applies
  (§5.5), stated once. Booleans rather than exceptions because every one of these races the user:
  the tab, or the window it was going to, may be gone, and none of the three is worth abandoning
  the rest of the close for. `tabs.update` because the kept tab is being sent to a *different* URL —
  one that differs from its own only in a part the comparison ignores — which a reload would not do.

## M3b.2 — the guard takes a clock, the capabilities and the flash, and no browser

- **Context:** `registerBadge` and `registerTracker` take an injected API object; `fakeBrowser`
  implements most of what the guard needs and drops the fields a duplicate decision turns on
  (`cookieStoreId`, `openerTabId`, `index`, `windowId` on a created tab).
- **Decision:** `GuardOptions` has `now`, `capabilities` and `flash` only. Everything else goes
  through `platform/`'s own functions against the real `browser`, and `tests/ext/guard.test.ts`
  arranges the gaps by spying on `fakeBrowser.tabs.get` and `tabs.query` to add the missing fields
  back, firing `onAttached` and `onReplaced` itself because the fake's `addListener` throws for
  those two.
- **Why:** an injected tabs API would have meant the tests never exercising the index against real
  `onCreated`/`onUpdated` ordering, which is the half of the guard that cannot be unit-tested —
  `core/duplicate-guard.ts` already covers the rules. Decorating the fake's two read calls is a
  smaller lie than a hand-written browser: the events, the storage, the alarms and the closes are
  all real, and what the test invents is only what the browser would have reported about a tab.
  `flash` is injected because M3b.3 owns the badge's own queue and the guard must not reach into
  it; `capabilities` because the "Duplica scheda" heuristic has to be testable on both browsers
  from one run (invariant 10).

## M3b.3 — what "Chiudi tutti i duplicati" overrules, and what it does not

- **Context:** §8.7 says the sweep works in OFF and in "Solo avvisi" too, which leaves open how
  much else of §8.4 and §8.6 it is allowed to ignore.
- **Decision:** `resolveAllDuplicates` overrules the mode, the pause, the start-up grace and the
  "Duplica scheda" exception, and keeps every other filter: the whitelist, `hidden`, incognito, and
  empty, auth and browser-internal URLs. It applies no §8.4.4 after-action — no activate, no move,
  no reload — and archives with `reason: 'duplicate-manual'`.
- **Why:** mode, pause and grace are all answers to "should the guard act on its own", and the user
  pressing a key has already answered that; the intentional-duplicate heuristic is a guess at intent
  that an explicit gesture replaces. The rest are not about acting on its own: the whitelist is a
  standing instruction about a site, and a hidden or incognito tab is one the extension has no
  business touching whatever the user asks. No after-action because N closes would otherwise shuffle
  the tab strip N times and move the user somewhere they did not ask to be.

## M3b.3 — the gestures queue with the events, and only the last close is remembered

- **Context:** a sweep reads every tab, decides, and then closes — while `onCreated` and `onUpdated`
  may be doing the same for one tab. §8.7 says the undo for the shortcut goes through the icon menu.
- **Decision:** `GuardActions` (pause, toggle, closeAllDuplicates, reopenLastDuplicate) goes through
  the same serial queue as the events, and the sweep hands `rememberAutoClosed` its *last* archive
  entry, so "Riapri l'ultimo duplicato chiuso" reopens one tab and not the whole sweep.
- **Why:** a sweep running beside a live close lets two steps each pick the other's tab as the one
  to keep, and a set ends with zero tabs — invariant 2's worst failure. One id rather than a list
  because `GuardState` already holds `lastAutoClosedId` and widening it is a storage migration this
  task does not own; the whole sweep is undoable from the Archive view, which is where a batch
  belongs. A reopen leans on the exemption `restoreTabs` writes before it creates anything, so the
  guard does not close the tab again the moment it appears.

## M3b.3 — the icon menu is six items, with the pause as a parent

- **Context:** §4.1 asks for an icon menu with a reopen, a reopen-and-whitelist, and a pause of 15
  min / 1 h / until restart; §4.1 also assigns two shortcuts.
- **Decision:** `menus.ts` creates the six under `contexts: ['action']`, the three durations as
  children of a `pause-guard` parent, parent before children, and every child repeats
  `contexts: ['action']`. `toggle-duplicate-guard` pauses until restart and resumes if paused, and
  `registerCommands` tolerates a browser with no `commands` API by logging and carrying on.
- **Why:** three top-level pause items would be half the menu; a parent reads as one choice with
  three answers. The repeated `contexts` is Firefox's: it defaults an item that does not say to
  `['page']`, so the children would appear in the page menu instead, while Chrome inherits the
  parent's and does not mind being told. The toggle has no duration to offer, so it is the one
  pause that needs no alarm. The missing-API path is not hypothetical — two shortcuts nobody can
  press are not worth losing the tracker, the badge, the cleanup and the guard with them.
- **Not verified by hand:** that Chrome and Firefox really draw a `contexts: ['action']` item under
  the toolbar icon, and that a key the user assigns in `chrome://extensions/shortcuts` or
  `about:addons` reaches `onCommand` — neither browser exposes the icon's own menu or a global
  hotkey to a driver. Everything on this side of the API is covered: `tests/unit/manifest.test.ts`
  for the two declared commands, `tests/ext/commands.test.ts` for each command reaching its gesture,
  `tests/ext/menus.test.ts` for the six items, their titles, their parent and their `contexts`, and
  `tests/ext/guard.test.ts` for what each gesture does to the tabs.

## M3b.4 — the panel changes the guard by writing settings, and sweeps with its own hands

- **Context:** the chip of §4.2 changes the mode, pauses the protection and offers §8.7's "Chiudi
  tutti i duplicati", all of which the background also does — and §5.2 forbids the panel to send the
  background a message.
- **Decision:** `state/guard.ts` writes `local:settings` for a mode or an option, writes
  `session:guardState` for a pause, and performs the sweep itself with `resolveAllDuplicates` plus
  `closeTabs`. Every write is read-change-write (`readSettings()` at the moment of the change), never
  a snapshot the panel took when it opened. The chip's state comes back from storage rather than
  from a local copy.
- **Why:** §5.2 is binding, and the background already drops its cache on `storage.onChanged`, so a
  write is the message. Read-change-write because the background may have changed `pausedUntil` or
  `lastAutoClosedId` since the panel loaded, and a whole-object write would undo it. The sweep is
  `core/duplicate-guard.ts`'s own pure decision, so the count the menu shows and the closes it makes
  are one definition of "duplicate" (invariant 9).

## M3b.4 — the panel's sweep has no navigation index, and its pause sets no alarm

- **Context:** the background keeps a `navigatedTabIds` set and creates a `guard-resume` alarm; the
  panel has neither.
- **Decision:** the panel's `duplicateSweeps` passes no `navigatedTabIds`, so the one §8.4.3 rule
  that softens there is "keep the tab the user navigated"; and `pauseGuardFor` creates no alarm.
- **Why:** the index is built from `onUpdated` over the session and a panel that opened a second ago
  cannot reconstruct it — inventing an empty set is honest, while guessing is not, and the rule only
  decides which of two identical tabs survives. No alarm because every guard decision compares
  `pausedUntil` with the clock: a pause that nothing announces still ends on time, and the panel
  cannot be relied on to be open when it does. "Fino al riavvio" needs no alarm at all, since
  `storage.session` dies with the browser.

## M3b.4 — "until restart" is a deadline further out than a day, not a flag

- **Context:** the chip has to say "In pausa fino alle 15:40" for a timed pause and "In pausa fino al
  riavvio" for the other, but `GuardState` stores one `pausedUntil` for both (M3b.2's decision).
- **Decision:** `guardStateText` reads any deadline more than 24 h out as "until restart"
  (`PAUSE_UNTIL_RESTART_FROM_MS`), and anything closer as a time of day.
- **Why:** the alternative is a second field and a storage migration this task does not own. The two
  cases cannot be confused: the longest pause the UI offers is one hour, so a deadline a year out can
  only be the restart one, and a stale value from a future version still reads as a pause rather than
  as a wrong clock time.

## M3b.4 — the whitelist defaults are chosen by `sidebarAction`, not by the containers capability

- **Context:** §8.3 wants the list pre-filled with the pages the running browser has
  (`chrome://*`, `chrome-extension://*` on one side, `about:*`, `moz-extension://*` on the other),
  and invariant 5 forbids asking for the browser's name.
- **Decision:** `platform/whitelist.ts`'s `defaultWhitelist` branches on `capabilities.sidebarAction`.
- **Why:** `sidebarAction` is the one capability that is exactly "this is the Firefox build" and needs
  no permission: `containers` would have been the obvious reading of "Firefox", but it is detected
  through `contextualIdentities`, which PLAN.md §5.4 does not grant — so a Firefox without that
  permission would have been handed Chrome's list of pages that do not exist in it.

## M3b.4 — the options write themselves, the whitelist waits for a gesture

- **Context:** §8.3 is one page holding switches and a free-text list, and nothing in it says when
  either is saved.
- **Decision:** every switch and every `<select>` writes on change, and the page has no "Salva" of
  its own; the whitelist keeps its draft in the editor and saves on blur or on "Salva", with live
  validation and the "matches N open tabs" preview running on the draft all along.
- **Why:** a settings object is small and `storage.local` is cheap, so a switch that needs confirming
  is a switch that gets forgotten. A half-typed pattern is not a choice yet, though: saving per
  keystroke would hand the guard `https://exam` as a standing instruction and write `local:` once per
  character. Validating the draft rather than the stored list is what lets the user see a pattern is
  wrong before relying on it.

## M3b.4 — the mode is a menu of three in the chip, a `<select>` in the settings

- **Context:** the same four choices (mode, after-action, scope, which tab to keep) are offered in
  §4.2's chip menu and in §8.3's page.
- **Decision:** the chip's menu is `role="menu"` with the three modes as `menuitemradio` in a group,
  the tick drawn with a `::before` rather than with colour alone; the settings page uses a labelled
  `<select>` per choice, with `visibleGuardToggles(caps)` deciding which checkboxes exist at all.
- **Why:** a mode is one choice between three and `menuitemradio` is the role that says so, which a
  row of switches would not. In the page, four `<select>`s read as four questions in a column where
  twelve radio buttons would read as a wall; and an option the running browser cannot honour is left
  out entirely (§5.5), because a switch that does nothing is worse than no switch.
- **Not verified by hand:** that a screen reader announces the menu the way the roles promise.
  `tests/e2e/guard-ui.spec.ts` covers the roles, the names, `aria-checked` moving with the mode and
  Escape dismissing the menu, which is everything the markup can be held to; the announcement itself
  is the reader's.

## M3b.4 — "Importa da Duplicate Tabs Closer" explains instead of importing

- **Context:** §8.3 asks for an import from Duplicate Tabs Closer and §8.6 for coexistence with it.
- **Decision:** the button expands an explanation of how to copy the list across, and the note about
  turning the other extension off is always visible rather than conditional.
- **Why:** an extension cannot read another extension's storage, on either browser, so an "Import"
  that did anything would be a lie; the whitelist syntax is the same one, which is what makes a paste
  enough. The note is unconditional because the presence of another extension cannot be detected
  either — it can only be said, once, where the duplicate settings are.

## M3b.5 — §8.6's opener signal did not survive the browser: adjacency and a URL at creation did

- **Context:** PLAN.md §8.6 describes Chrome's own "Duplicate tab" as a copy whose `openerTabId` is
  the tab it copies, sitting right after it, arriving with its URL already set — and asks for that
  heuristic to be **verified empirically**, with instructions to record it here if a signal turns out
  to be unreliable.
- **Decision:** `isIntentionalDuplicate` no longer asks *which* tab the opener is. It asks that the
  copy have an opener at all, that it sit immediately after a tab on the same key in the same window,
  and that it already carry its URL.
- **Why:** measured on stable Chrome through `tabs.duplicate`, the copy's `openerTabId` is whichever
  tab was **active** when the command ran, not the tab being duplicated — so duplicating a background
  tab from the tab strip produced an opener pointing somewhere else entirely, and the exemption missed
  the gesture it exists for. The three remaining signals still tell the two gestures apart: a tab an
  extension makes with `tabs.create` has no opener at all, which is what keeps every tab this suite
  and the panel open under the guard; a tab opened from a link arrives with a `pendingUrl` and an
  empty `url`, which is what the URL condition excludes; and adjacency is Chrome's own placement
  (`index = source.index + 1`). Firefox has no such command and reports openers differently
  (§5.5), which is why the setting behind this is Chrome-only and hidden there — the core only honours
  the flag and never asks which browser it is on (invariant §2.5).

## M3b.5 — an `onUpdated` carrying the URL the tab already had is not a navigation

- **Context:** the guard's index marks a tab as "navigated here" on `onUpdated(changeInfo.url)`, which
  keep rule 2 (§8.4.3.2) and §8.6's exemption both read. Chrome announces a duplicated tab three
  times: `onCreated` with the URL already set, then `onUpdated` `loading` and `complete` on that same
  URL.
- **Decision:** the index remembers the URL it last filed each tab under (`knownUrl`), and
  `onUpdated` only sets the navigation flag when the URL actually changed.
- **Why:** without it, the second event turned the copy into a tab that "navigated" to the page, which
  cost it the §8.6 exemption and — when the copy was the active tab, which it is when you duplicate
  the tab you are looking at — made keep rule 2 close **the tab it was copied from**. The duplicated
  deep page survived and the original went, which is the worst possible reading of the gesture. A real
  navigation always changes the URL, so nothing is lost by requiring it.

## M3b.5 — §14's 300 ms is measured from `tabs.onCreated`, which is what "from event to close" says

- **Context:** PLAN.md §14 budgets the guard at "from event to close: ≤ 50 ms with the worker running,
  ≤ 300 ms when it has to be woken up", and §8's acceptance point says "the second opening closes in
  under 300 ms".
- **Decision:** the E2E measures the interval between `tabs.onCreated` for the duplicate and
  `tabs.onRemoved` for it (`reaction` in `tests/e2e/guard.spec.ts`), against the unchanged 300 ms.
- **Why:** timing from the `tabs.create` call instead adds work that is not the extension's and not in
  the budget. Measured on this machine, inside Playwright's persistent context: 57–174 ms pass between
  `tabs.create` and the browser's own `onCreated`, before the worker is handed anything. The guard's
  own share, read from marks the worker wrote, is 92 ms to the first settings-and-whitelist read that
  wakes it, then 5 ms to the index, 5 ms to `tabs.get` and 20 ms to the decision. A control run with
  the source changes stashed measured 539/531/261/206 ms end to end, two of them over budget — so the
  overshoot was the harness all along and raising the number would have hidden the one quantity §14
  actually names. The budget stands as written.

## M3b.5 — the mode, the settings and the pause are driven through storage; everything else by hand

- **Context:** the duplicate E2E has to put the guard in "Chiudi automaticamente", change §8.3's
  options, and pause it.
- **Decision:** those three go through `local:settings` and `session:guardState`; every other step —
  the tabs, the Ctrl+click, `tabs.duplicate`, the whitelist editor, the rows, the bar and the toast —
  is the real gesture.
- **Why:** §5.2 forbids the panel to message the background, so writing `local:settings` *is* what the
  chip's menu and the options page do, and `guard-ui.spec.ts` is what proves the UI writes it. A pause
  is only ever started by a keyboard command or the icon's context menu, neither of which Playwright
  can fire; the deadline in `storage.session` is the whole of a pause (M3b.2's decision), and
  `tests/ext/` covers the gestures that set it.

## M3b.5 — the login flow is served locally and matched by path, with the provider on `localhost`

- **Context:** §8.6 exempts auth pages, and M3b.5 asks for a multi-step login across hosts — site →
  identity provider → site — proven on both browsers. Invariant 1 forbids reaching the network.
- **Decision:** the suites serve the flow themselves and match it by path (`/sso/login`,
  `/oauth2/authorize`, `/auth/callback`, all tokens of `AUTH_PATH_TOKENS`), with the site on
  `127.0.0.1` and the provider on `localhost` — the same server, one more socket on `::1`, the same
  port.
- **Why:** `classify.ts` recognises an auth page by host *or* by path, and the hosts of `AUTH_HOSTS`
  are real ones nothing local can answer for. `localhost` and `127.0.0.1` are two different hosts to
  the browser and to `duplicateKey`, which is what makes the flow genuinely cross-origin without any
  name resolution; the second socket is there because Gecko and Chrome may resolve `localhost` to
  `::1`, and a machine with no IPv6 simply has nothing to bind and nothing to resolve.

## M3b.5 — Chrome's "Duplicate tab" is tested on Chromium only; Firefox gets the smoke and the login

- **Context:** M3b.5 asks for §8.6's "the duplicated tab is never closed" on the real browser command,
  and for the login flow on Chromium and Firefox.
- **Decision:** `tests/e2e/guard.spec.ts` drives `tabs.duplicate` on both gestures (a background tab
  and the tab in front, a home page and a deep page with a long query string, ten seconds each);
  `tests/e2e-firefox/guard.spec.ts` covers the guard closing a second tab on one URL and the login
  flow in one tab and in two.
- **Why:** `tabs.duplicate` is a Chromium API and the command behind it does not exist in Firefox, so
  there is no gesture there to exempt — which is also why `allowIntentionalDuplicates` is hidden on
  that browser. What can differ on Gecko is what the guard reads: `onCreated` carries no URL there, so
  the decision rests on the `onUpdated` that follows, and that is what the smoke proves. Both suites
  end on a control — a duplicate with no login in it, which is closed — so a test that passed because
  the guard was off cannot pass quietly.

## M4.1 — "Altro" is the proposal's `ungrouped` ids, not a ninth group

- **Context:** PLAN.md §7.2.6 names an "Altro" for the tabs no group earned, and §7.1/§7.2 cap a
  window at eight groups.
- **Decision:** `GroupProposal` carries `groups` and `ungrouped: readonly number[]`; nothing named
  "Altro" is ever proposed, and every tab appears in exactly one of the two.
- **Why:** a group made of leftovers would be created in the browser like any other and would have to
  be named in two locales; the panel can label the remainder itself, and the invariant that matters
  ("every eligible tab accounted for exactly once") is then checkable in one assertion.

## M4.1 — the clustering knobs are `ClusterOptions`, not new `Settings` fields

- **Context:** M4.1 asks for a configurable minimum of tabs per site and a ~0.25 threshold, and
  `Settings` is the stored, user-facing shape.
- **Decision:** `ClusterOptions` (all fields optional, `DEFAULT_CLUSTER_OPTIONS` beside it) is passed
  to `groupBySite`, `groupByTopic` and `proposeGroups`; `Settings` is untouched.
- **Why:** PLAN.md §10 does not list any of these in `local:settings`, and TASKS.md §2.4 wants the
  thresholds injected so `src/core/` stays pure. A later task that does expose one of them in the UI
  can map a setting onto the option without changing the core's signature.

## M4.1 — a site is its registrable domain, and one map answers for its name

- **Context:** §7.1 wants "readable names from a map", and tabs include `localhost`, bare IPs and
  `about:` pages that have no registrable domain at all.
- **Decision:** `siteKey` is `tldts`' registrable domain, falling back to the display host and then to
  `''`; `SITE_NAMES` is keyed by domain *or* by bare brand label, so `amazon.it` and `amazon.co.uk`
  both resolve through the label `amazon`; an unknown key becomes its label capitalised.
- **Why:** one map and one fallback keep the name of a site a pure function of the key, which is what
  makes the group titles stable across windows and runs. Keying by label as well covers a brand's
  country suffixes without a row per country.

## M4.1 — TF-IDF per window, `idf = ln(1 + N/df)`, and a domain token at half weight

- **Context:** §7.2.2 asks for TF-IDF with a domain token and does not fix the formula, the corpus or
  the weight.
- **Decision:** the corpus is the window being clustered; `idf = Math.log(1 + N / df)`; each tab gets
  one synthetic `site:<domain>` token weighed `domainWeight` (0.5); vectors are L2-normalised so
  cosine is a dot product.
- **Why:** clustering runs per window (§7.4), so the corpus has to be the window or the same tabs
  would cluster differently depending on what another window holds. `ln(1 + N/df)` is positive for a
  token every tab shares, which the plain `ln(N/df)` is not: a word in all 300 tabs would otherwise
  vanish and leave some tabs with no vector at all. At 0.5 the domain nudges same-site tabs together
  without making "by topic" a second "by site" — two tabs with identical words on different domains
  still reach ≈ 0.96 similarity.

## M4.1 — the groups of a window are ordered by size, biggest first

- **Context:** §7 does not say in which order the proposals are shown, and the eight-group limit has
  to drop *something*.
- **Decision:** candidates are sorted by tab count descending, ties by the position of their first
  tab; the limit cuts the tail, which goes to `ungrouped`.
- **Why:** §7.2.6 says the smallest clusters become "Altro", which settles the limit, and reusing the
  same comparator for the display order means the list the user sees and the cut the limit makes
  cannot disagree. The first-tab tie-break makes the order a function of the input alone.

## M4.1 — a topical group is named by one token unless the second earns its place

- **Context:** §7.2.5 wants a title of one or two words, and two clusters in a window can rank the
  same word first.
- **Decision:** the second token is appended ("Rust · Async") only when it weighs at least half the
  first; a title already taken in that window is replaced, in order, by the single name, then by
  "<token> · <dominant site>", then by the pairs further down the ranking.
- **Why:** a cluster about one thing should be called by that one thing, and the collision pass is
  what keeps two groups in the same window from arriving with one name — which the user would read as
  a bug. The site is the last resort because it is the only word left that is certainly true of the
  cluster.

## M4.1 — the colour of a group is a hash of its key, collisions included

- **Context:** §7.1 asks for a "stable colour from a hash" over Chrome's nine colours, and nine
  colours cannot cover eight groups plus a site palette without repeating.
- **Decision:** `colorFor` is FNV-1a over the key modulo `GROUP_COLORS.length`; no pass tries to avoid
  two groups sharing a colour.
- **Why:** stability is the property the plan asks for, and it is the one the user notices: the same
  site keeps its colour between runs, between windows and after a group is renamed. Avoiding
  collisions would make a group's colour depend on the other groups, so adding a tab could recolour
  everything.

## M4.1 — the benchmark measures the 300 tabs as six windows and as one

- **Context:** PLAN.md §11 budgets "clustering 300 tabs (without AI)" at 50 ms, while §7.4 clusters
  per window and the `tabs-300` fixture spreads those tabs over six.
- **Decision:** `tests/perf/cluster.perf.test.ts` measures by topic over the fixture's windows, by
  topic over the same 300 tabs collapsed into one window, and by site; pinned and grouped tabs are
  included so all 300 are clustered.
- **Why:** six windows of ~60 tabs never pay the quadratic linkage cost of §7.2.3 that the budget is
  about, so the single-window case is the number that has to hold; the fixture's own shape is kept
  because it is what the panel will usually ask for. Observed CPU medians: 18.6 ms, 27.4 ms and
  1.2 ms, all inside 50 ms before the machine factor.

## M4.1 — in-range index reads are written `as T`, not `?? fallback`

- **Context:** `noUncheckedIndexedAccess` types every `array[i]` as possibly undefined, and the
  house idiom so far has been a `??` or an `if (x === undefined) continue`. In the clustering loops
  that produced 43 branches no input can take, which alone put `src/core/` under the 95% branch
  threshold.
- **Decision:** in `cluster.ts`, a read whose index is bounded by the loop around it (or by a modulo
  of the array's own length) is written `as T` with a comment saying why; where a fallback is really
  possible it is a statement, not a branch. Nothing is marked `v8 ignore` and no threshold moved.
- **Why:** a branch no test can reach is not coverage that was lost, it is a branch that should not
  exist; writing it away keeps the gate honest and keeps a comparison out of the loops that have to
  finish inside 50 ms. `as` is used rather than `!` because `tseslint` bans the non-null assertion.

## M4.2 — the groups live in `src/platform/groups.ts`, and `attempt()` is shared from `tabs.ts`

- **Context:** PLAN.md §5.3 lists `src/platform/` as "thin, typed wrappers" without naming a file per
  API, and the "already gone is not an error" wrapper of §8.6 was private to `tabs.ts`.
- **Decision:** applying and undoing the groups is one module, `src/platform/groups.ts`, with its own
  injected `GroupsApi`; `Attempt<T>` and `attempt()` became exports of `tabs.ts` instead of being
  copied.
- **Why:** `tabs.ts` is already the largest file in `src/platform/` and these calls (`tabs.group`,
  `tabs.ungroup`, `tabGroups.*`) are the only ones a browser without native groups does not have, so
  they are easier to keep behind one capability check on their own. `attempt()` is shared because
  §7.4 asks groups to survive "a tab closed in the meantime", which is the same rule §8.6 states for
  closing: two copies could drift apart.

## M4.2 — the snapshot is read from the browser, and covers every tab of the affected windows

- **Context:** §7.4 asks for a `{tabId, windowId, index, groupId}` snapshot before applying, and the
  preview that produced the proposal may have been on screen for minutes.
- **Decision:** `applyGroups` queries the tabs itself and snapshots every live tab of every window a
  group lands in — not only the tabs named in the proposal — and records `pinned` next to `groupId`,
  plus the title, colour and collapsed state of the group each tab was in.
- **Why:** the indexes undo has to put back are the ones the tabs have the instant before they move,
  so taking them from the proposal would restore an order that no longer existed. Whole windows,
  because sorting by group slides tabs that are in no group at all. `pinned`, because grouping a
  pinned tab unpins it in both browsers: without it, undo would leave the tab unpinned after the
  user had turned "Lascia fuori le schede fissate" off.

## M4.2 — `skipped` counts only what the browser lost, and the message is a plural key pair

- **Context:** §7.4 wants partial failures "reported in one short message", and tabs also stay out of
  a group for two reasons that are not failures at all (pinned, already in one of the user's groups).
- **Decision:** `skipped` counts only the tabs the browser could not group — closed, moved to another
  window, or refused — and the options' exclusions are silent. `applyMessage` returns the
  `organizeSkippedOne` / `organizeSkippedOther` pair with the count, or `null`, and formats nothing.
- **Why:** a message saying four tabs "could not be grouped" when the user asked for the pinned ones
  to be left alone would read as a bug. One message and not one per group, because a window where a
  dozen tabs went while the preview was open would otherwise raise a dozen toasts for one gesture.
  The keys come back unformatted because invariant 11 puts the plural and the number in the panel's
  language, through `counted()`.

## M4.2 — undo runs in four passes, and a grouped tab is only ever moved by `tabGroups.move`

- **Context:** §4.4.5 wants "Annulla" to put the window back as it was, and the state to put back
  mixes membership, pinned tabs and indexes, which the browser couples: a tab cannot be regrouped
  while it is in another group, and moving a grouped tab to an index outside its group takes it out.
- **Decision:** ungroup everything we made, pin again what we unpinned, restore the membership, then
  restore the order last — walking each window in ascending index and moving a run of tabs that
  shared a group with one `tabGroups.move`, never a grouped tab on its own.
- **Why:** each pass needs the one before it to have happened, and the order restore has to be last
  because the earlier passes move tabs themselves. Ascending index with a clamp at the end of the
  strip is what makes the result right even when a tab was closed in the meantime: the tabs that are
  left come out in the order they were in. Moving whole groups is the only way the restore cannot
  break a group apart.

## M4.2 — a group the ungroup emptied is found by title, then built again from the snapshot

- **Context:** §5.5 says a group id does not survive a restart on Firefox and that `sessions` never
  reports one, so undo "uses the group title as a fallback"; and neither browser has a
  `tabGroups.create`.
- **Decision:** undo puts a tab back by group id when that group still exists, otherwise into a group
  of exactly the same title (the tab's own window first), otherwise into a group created by grouping
  the tabs and then naming it with the title, colour and collapsed state from the snapshot.
- **Why:** taking a tab out of one of the user's groups can leave it empty, and both browsers delete
  an empty group, so "restore the membership" has to be able to mean "build that group again" — which
  is only possible because the snapshot carries what the group looked like. The title is compared
  exactly rather than through `tabGroups.query({ title })`, which Chrome treats as a pattern.

## M4.2 — sorting by group places only the groups we made, after the pinned tabs

- **Context:** §4.4.4 offers "Ordina le schede nella finestra per gruppo" without saying what happens
  to everything else in the window.
- **Decision:** the groups just created are moved to the head of their window in the proposal's
  order, starting after the tabs that are still pinned; the user's own groups and the ungrouped tabs
  are never moved and only slide down.
- **Why:** the proposal's order is the order the preview showed, so the strip ends up looking like the
  list the user accepted. Pinned tabs cannot be preceded by anything, so the cursor starts after
  them — counting the ones that are *still* pinned, since a pinned tab the user chose to include is
  not pinned any more once it is in a group. Leaving everything else alone is what keeps §4.4's
  promise that the user's groups are not touched.

## M4.2 — what undo does not promise when the user changes things in between

- **Context:** undo works from a snapshot, and between the apply and the "Annulla" the user can group
  tabs themselves, and "include the user's groups" can take a tab out of a group it then rejoins.
- **Decision:** two gaps are accepted rather than papered over. A tab put back into a group that
  still exists is appended to it, not returned to its old slot inside it. A tab that was ungrouped in
  the snapshot and is in a group the user has made since is still moved back to its index, which the
  browser may read as taking it out of that group.
- **Why:** both would need state the browsers do not offer (an index inside a group; a way to move a
  tab without leaving its group), and both only appear after the user has edited the very thing being
  restored. The order and the groups are restored exactly in the case §4.4.5 is about, which is the
  user undoing what they just applied.

## M4.3 — the preview is a `computed` until the first edit, and pinned after it

- **Context:** §4.4.3 wants an editable preview, and the proposal it starts from is a function of
  the open tabs, which keep changing while the panel is open.
- **Decision:** `draft` is `edited.value ?? proposed.value`: it follows the browser while nothing has
  been edited, and the first edit writes the whole draft into `edited`, which from then on is what
  the view shows. A new scope, a new mode or a new option clears `edited`.
- **Why:** before the first edit there is nothing to lose, and a preview that quietly ignores a tab
  the user just opened would be lying about what "Applica" will do. After the first edit the rows
  are the user's answer, and a tab opening in another window must not renumber or rename them. A
  scope, a mode or an option is a different question, so the answer to the previous one goes.

## M4.3 — "Applica" pins the draft before it applies it

- **Context:** the toast of §4.4.5 names how many groups were created, and "Applica" can be pressed
  while the draft is still the unpinned `computed`.
- **Decision:** `applyDraft` writes the current draft into `edited` first, then applies it.
- **Why:** otherwise the preview could change under the toast, and "Annulla" would be offered next
  to a list that is no longer the one that was applied.

## M4.3 — "Altro" is a destination and never a source

- **Context:** §4.4.3 asks for "Sposta in…" without saying whether a tab outside every group can be
  moved into one.
- **Decision:** `moveTargets` answers `[]` for a tab in "Altro", so that row has no menu; every
  group's rows offer the other groups of the same window and "Altro".
- **Why:** "Altro" is what the clustering left over, not a group — it has no title and no colour,
  and it is not created. Letting a tab in and out of it both ways would make it look like one. A
  move across windows is refused for the same reason the proposal never spans windows: a native
  group lives in one window.

## M4.3 — a blank name falls back to the proposed one, and an emptied group disappears

- **Context:** the name is an ordinary text input, so it can be emptied, and "Sposta in…" can take
  the last tab out of a group.
- **Decision:** the input keeps exactly what was typed, including blank; what is applied is the
  trimmed name or, when that is empty, the name §7.1 proposed. A group left with no tabs is dropped
  from the draft.
- **Why:** a group has to have a title, and the browser would show an untitled one, so the fallback
  is the only answer that does not need an error. Keeping the raw text in the input is what lets the
  user clear the field and type, which a fallback written back into it would prevent. An empty group
  cannot be created, so showing it would promise something that will not happen.

## M4.3 — merging keeps the target's key, title and colour

- **Context:** §4.4.3's merge joins two groups and has to decide what the result is called.
- **Decision:** the group that was merged *into* keeps everything of its own and gains the other's
  tabs at the end; the other disappears.
- **Why:** the user picked the target from the menu, so that is the group they are keeping, and its
  name is the one they chose it by. Appending keeps the order each group was in.

## M4.3 — the Organize toast waits to be dismissed

- **Context:** the close toast of §4.3 clears itself after eight seconds (`state/undo.ts`), and
  §4.4.5's toast is written the same way.
- **Decision:** this one stays until "Annulla", "Chiudi" or the next apply replaces it.
- **Why:** a close is undoable from the archive after the toast is gone, so letting it expire loses
  nothing. A grouping is not: once the toast goes, "Annulla" is the only thing that would have put
  the window back in one gesture, and the user has just been handed a window that looks different.
- Not verified by hand: nothing of this view is on a manual checklist. The preview edits are in
  `tests/unit/organize.test.ts`, the "Raggruppa" handoff and the pinning in
  `tests/ext/organize-state.test.ts`, and the toast with its "Annulla" in
  `tests/e2e/organize.spec.ts`.

## M4.3 — Organize stays in the nav on a browser without tab groups

- **Context:** §5.5 says Firefox may not have `tabGroups`, and the nav of §4.2 is the same
  everywhere.
- **Decision:** the entry is always there and the view says, with `organizeNoGroups`, that this
  browser cannot group tabs.
- **Why:** a nav that changes shape per browser makes the missing feature a puzzle. A sentence in
  the place the feature would be is the explanation, and it needs no capability check in the shell.

## M4.3 — the Organize state is split in two modules, for §11's chunking

- **Context:** §4.3's "Raggruppa" is in the selection bar, which is in the panel's first chunk, and
  §11 wants the Organize view loaded with `import()` — but calling into `state/organize.ts` would
  pull `core/cluster.ts` and `platform/groups.ts` into that first chunk with it.
- **Decision:** the question (scope, mode, options, the brought selection, the edited draft) lives
  in `state/organize-request.ts`, which imports nothing heavy; `state/organize.ts` holds the
  clustering and the apply and re-exports the question, so the view still reads one module.
- **Why:** it is the only way the button and the view can share state without the button paying for
  the view. The build shows it works: `OrganizeView` is its own chunk.

## M4.4 — the cosine threshold stays at 0.25

- **Context:** §7.2.3 says "~0.25" and M4.4 allows tuning it if the review of `tabs-300` comes out
  "clearly poor". It did not, but the value had to be chosen on evidence rather than left alone by
  default.
- **Decision:** 0.25, unchanged. The review and the measurements are in `docs/CLUSTER-REVIEW.md`.
- **Why:** 0.20, 0.30 and 0.35 were run on the same 300 tabs. 0.20 over-merges (five tabs called
  "Tab": a Twitch stream with two New Tab pages; a monitor with a desk lamp). 0.30 and 0.35 lose
  exactly what topic mode exists for — the cross-site clusters, "Lisbona · Tram" among them, go
  back to "Altro" — and add groups formed on Jira ticket numbers. 0.25 is the only one of the four
  that keeps the cross-site clusters without making the over-merges.

## M4.4 — the bad clusters are a naming problem, and the tokenizer is left alone

- **Context:** of the five clusters judged wrong in the review, three group the right tabs under a
  name taken from a path id or a file extension ("Node · 1033", "Belem · G189158", "Jpg · 1064").
- **Decision:** `tokenize` is not changed. The observation is recorded in `docs/CLUSTER-REVIEW.md`
  instead, with the fix that was considered: drop tokens that contain no letter.
- **Why:** M4.4's scope is the review and the E2E tests, and dropping numeric tokens changes what
  every proposal in the product looks like — a change that wants its own task and its own unit
  tests. The harm is also the mildest kind: §4.4.3 lets the user retype the name inline before
  anything is applied, which is what the editable preview is for.

## M4.4 — M4's acceptance is covered by tests, not by a manual check

- **Context:** M4.4's "Done when" asks for a MANUAL-CHECKS entry ("leggere CLUSTER-REVIEW.md e
  provare Organizza per argomento sulle proprie schede"), and `docs/MANUAL-CHECKS.md` has been
  closed to new entries since the owner asked for no more manual checks (AGENT-RULES.md).
- **Decision:** no entry is added. §13's "apply and undo restore exactly the original order and
  groups" is asserted end to end instead: `tests/e2e/organize.spec.ts` snapshots every tab of the
  window — URL, index, pinned, and its group by title and colour — around an apply with
  "Ordina le schede nella finestra per gruppo" on, a pinned tab and a group made by hand, and
  requires the snapshot back after "Annulla". `tests/e2e-firefox/organize.spec.ts` is §14's Gecko
  smoke: organize by site, one native group, Annulla, no group left.
- **Why:** the two halves of the acceptance are different in kind. The order and the groups coming
  back is a fact about the browser, and a test states it better than a person can. Whether the
  clusters make sense is a judgement, and that is what `docs/CLUSTER-REVIEW.md` is — written down,
  with the evidence, so it can be disagreed with.
- Not verified by hand: the clusters were judged on the `tabs-300` fixture, not on the owner's own
  tabs. The fixture is built to look like a real hoarder's browser (`scripts/generate-fixtures.ts`)
  and is the input PLAN.md §13 names, but nobody has yet pressed "Organizza per argomento" on a
  browser they actually use.

## M5.1 — The model is asked for English names, and the user retypes them

- **Context:** PLAN.md §7.3 leaves open what to do about Italian group names: Gemini Nano is far
  better at English, and the Translator API would be another model to download and another thing
  to fail.
- **Decision:** v1 asks for English names (`SYSTEM_PROMPT` is in English and so is the prompt) and
  relies on the inline editing M4.3 already put in the preview. No Translator API, no translation
  pass, no second prompt. The names of §7.2 — the fallback — stay what they were.
- **Why:** an English name the model got right is more useful than an Italian one it got wrong, and
  nothing is applied until the user has looked at the preview, where a name is two clicks from
  being whatever they want. A translation step would double the ways the feature can be slow or
  unavailable to change a word the user can already change. It is reversible: a later task can add
  one, and the schema does not change.

## M5.1 — One budget for the whole run, and a partial answer is still an answer

- **Context:** §7.3 asks for a 20 s timeout and for batching, without saying whether the 20 s is per
  prompt or per run, nor what to do when the model answers some batches and not others.
- **Decision:** the 20 s is the budget of the whole run: `resolve()` turns it into a deadline
  (`now() + timeoutMs`) that every batch shares, and a batch that starts after it has passed is not
  asked at all. When at least one batch came back, the result is `source: 'ai'` and the batches
  that failed are grouped by §7.2 instead, with `fallbackReason` saying what went wrong; when none
  did, the §7.2 proposal is returned exactly as `groupByTopic` built it.
- **Why:** the user is waiting in front of a spinner, and what they are waiting for is the whole
  proposal, not one prompt of it; a per-prompt timeout on a 300-tab window could keep them there
  for minutes. Mixing the two sources is better than throwing good groups away, and §7.2 is a real
  answer rather than a placeholder. Returning the untouched `groupByTopic` proposal when nothing
  was answered is what makes the fallback testable: it is the same object the non-AI path builds.

## M5.1 — An answer with no usable group counts as a failure

- **Context:** validation can empty an answer out: every id invented, every group below
  `minClusterTabs`, or everything in "Other". The batch would then have an answer and no groups.
- **Decision:** that is `no-groups`, treated exactly like unparsable JSON — the batch falls back to
  §7.2. A group dropped for any reason releases its tabs to "Altro" rather than keeping them
  claimed, so the union of the groups and "Altro" is always the tabs that were asked about.
- **Why:** "the model answered and I have nothing to show" is a failure from where the user stands,
  and §7.2 has something to show. The release rule is the invariant the tests are built on: a tab
  the AI touched can be grouped differently, never lost.

## M5.1 — Batches are packed macro-clusters, and names merge within a window

- **Context:** §7.3 wants pre-clustering above ~40 tabs and batches of at most ~40, which leaves
  open how the clusters become batches and what happens when two batches of one window come back
  with the same group name.
- **Decision:** a window that fits in one batch is one prompt. Otherwise the §7.2 groups are the
  macro-clusters — cut into batch-sized pieces when one is bigger than a batch, and each "Altro"
  tab its own cluster — and they are packed greedily into batches up to `maxBatchTabs`. A batch
  never spans two windows. Groups are then merged by their lower-case name within a window,
  keeping the first spelling, and the window keeps at most `maxGroups` of them.
- **Why:** packing keeps the number of prompts near the minimum, which is the whole cost of the
  feature, while a batch of related tabs is also the batch the model names best. Merging is needed
  because two prompts about the same window cannot see each other: without it a 90-tab window
  comes back with "Rust" three times, and §7.4 could not apply that as one native group.

## M5.2 — The 20 s of §7.3 is a prompt's deadline, never the download's

- **Context:** `AiSession` has one timeout, and the same method both creates the session and runs
  the prompt. A session created for the first time may have to download the model, which is
  several gigabytes.
- **Decision:** `prompt()` and `measureInputUsage()` go through the per-call deadline
  (`DEFAULT_TIMEOUT_MS`, 20 s, aborting with a `TimeoutError`); `open()` — which is what
  `downloadModel()` calls — does not. The download is bounded only by the signal the caller
  passes, and the "Scaricamento del modello…" row is what the user watches instead.
- **Why:** the 20 s of §7.3 is about a user waiting in front of a spinner for a proposal. Applying
  it to the download would make turning the AI on fail on every machine where it takes longer than
  twenty seconds, which is all of them, and the failure would look like a broken feature rather
  than a long download. `tests/unit/llm.test.ts` holds a 120 s download open and asserts the
  creation's signal is still not aborted.

## M5.2 — Two deadlines, because they are about different things

- **Context:** M5.1 already gives the whole run a 20 s budget inside `groupByAi`. Adding one to
  `AiSession` means a prompt is under two of them.
- **Decision:** both stay. `groupByAi` owns the run — what the user is waiting for — and
  `AiSession` adds a per-call backstop around `create()` and `prompt()`.
- **Why:** the run budget is spent on batches and cannot notice a single call that never settles;
  a `create()` that hangs would leave the panel's spinner up with nothing counting down. The
  backstop is never the one that fires in normal use, because the run budget is the same length
  and starts earlier.

## M5.2 — The model's answer is pinned to the question it answered

- **Context:** the proposal of §4.4 is a `computed` that follows the browser. The model's is not:
  it costs seconds and a prompt, and it arrives after the question was asked.
- **Decision:** `state/organize.ts` keeps one `answer` — the scope, the mode, the options and the
  carried selection, serialised, plus the draft — and the preview uses it only while that question
  is still the one on screen. A run that fell back is recorded too, with `draft: null`. The order
  the preview resolves is the user's edits, then the model's answer, then §7.2's proposal.
- **Why:** an answer to a question nobody is asking any more is worse than no answer: changing the
  scope would otherwise leave the previous window's groups in the preview. Recording a fallback is
  what stops the same twenty seconds being spent again every time the view is re-entered, and the
  resolution order is the one §4.4.3 implies — an edited preview belongs to the user.

## M5.2 — The AI row is in the Organize view, and the settings row waits for M6.1

- **Context:** §4.6 lists "AI on-device" among the settings, and §5.5 lists it in the capability
  table. M5.2's scope is `llm.ts`, the Organize view, i18n and tests.
- **Decision:** `useOnDeviceAi` is read and written as a real setting (`state/ai.ts`), and the only
  control for it in this task is the row in Organize, shown where there is a model to use. The
  settings-page row of §4.6 is M6.1's, which builds that page.
- **Why:** the control belongs where the feature is used, and that is also where the user is when
  they find out there is a model to download — §7.3 asks for the download to happen on a click.
  Putting a second control in a page M6.1 has not built yet would mean building half of it here.

## M5.2 — Not verified by hand

- Not verified by hand: nobody has seen the real Gemini Nano answer in this extension. The machine
  the build runs on has no model, and `docs/MANUAL-CHECKS.md` is closed (AGENT-RULES.md). What is
  checked instead: `tests/unit/llm.test.ts` drives a `LanguageModel` of its own through every
  availability state, the download with its progress, the 20 s timeout, an outer abort and a
  pre-aborted signal; `tests/ext/ai-state.test.ts` checks the wiring, including that a browser
  without the Prompt API never loads the module; and `tests/e2e/organize-ai.spec.ts` opens the
  view in a real Chromium that has no model and requires §7.2's groups, no badge, no AI row and
  no console error. The download progress UI and the model's own answers remain unobserved.

## M6.1 — The language is a catalogue we load ourselves

- **Context:** §4.6 offers "Lingua: automatica / IT / EN", and `browser.i18n` cannot serve it:
  `getMessage` has no locale argument, the catalogue is resolved once from the browser's own UI
  language, and `getAcceptLanguages` only reports what the user reads.
- **Decision:** `platform/i18n.ts` keeps an optional override. "automatica" leaves `t` on
  `browser.i18n`; a chosen language makes `loadCatalogue` fetch
  `runtime.getURL('/_locales/<locale>/messages.json')` and `t` answer from it, with
  `i18n.getMessage`'s own substitution rules (named placeholders and `$1`…`$9`) reimplemented in
  `formatMessage`. `state/settings.ts` follows the setting in an effect and publishes the active
  tag in a `language` signal; `App.tsx` reads it, so one change re-renders every view and with it
  every date, count and duration. The document's `lang` and title are set from the same place.
- **Why:** the alternative is a second copy of every string inside the bundle, which would make
  the shipped `_locales/` and the panel's strings two things to keep in step. `runtime.getURL` is
  the extension's own origin, so the fetch is a read of our own package and invariant 1 holds —
  the E2E's `health` fixture, which fails on any request outside the extension's origin, is what
  keeps that true.

## M6.1 — The bookmarks permission is asked for inside the click, and given back

- **Context:** §5.4 declares `bookmarks` as an optional permission and §6.4 pays a bookmarked page
  +10. Both browsers grant `permissions.request` only from a user gesture, and the first `await`
  spends it.
- **Decision:** `setUseBookmarks` is not `async` and awaits nothing before calling
  `requestBookmarksPermission`; the setting is stored only once the answer is yes, a refusal sets
  `bookmarksDenied` and the page says so. Turning the row off writes `false` and calls
  `permissions.remove`. `platform/bookmarks.ts` walks `getTree()` once into a set of `keepKey`s and
  caches it, invalidated by the four bookmark events and by `permissions.onAdded/onRemoved`; a
  missing permission, a hidden API or a failed walk all give an empty set. `state/tabs.ts` passes
  the set to the score only while the setting is on, so the setting decides whether the signal
  counts and the permission whether there is anything to count.
- **Why:** a stored `useBookmarks: true` without the permission would promise a signal the score
  could never get. Caching is §11: the panel re-reads on every tab event, and a person with
  thousands of bookmarks must not pay for the walk each time. Giving the permission back is §12.1 —
  hold no access that is not being used.

## M6.1 — The values the fields offer, and one stored `ignoreHash`

- **Context:** §4.6 names the settings and their defaults but not the choices a `<select>` should
  offer, and it lists "ignora #fragment" both here and in §8.3's duplicate page.
- **Decision:** `settings-fields.ts` fixes the lists — stale 1/3/7/14/30 days, grace
  30 min/2 h/8 h/24 h, archive 7/30/90/365 days, language automatica/EN/IT — and a stored value the
  list does not offer is kept in its place rather than silently moved. The labels are written by
  `Intl` through `format.ts`, not by catalogue keys, so "7 giorni" needs no translation of its own.
  `ignoreHash` is one stored value shown in both pages.
- **Why:** lists are a reversible choice, and keeping an unlisted value visible means a setting
  written by an earlier version (or by hand) is never changed by merely opening the page. One
  stored value is the only reading of §4.6 and §8.3 that cannot show the user two switches that
  disagree.

## M6.1 — Not verified by hand

- Not verified by hand: nobody has seen Chrome's or Firefox's own permission prompt appear on the
  bookmarks toggle. `docs/MANUAL-CHECKS.md` is closed (AGENT-RULES.md), and a browser-chrome dialog
  is outside what Playwright can drive. What is checked instead: `tests/ext/settings-state.test.ts`
  requires `permissions.request` to be called synchronously, in the same turn as the click, with
  exactly `{ permissions: ['bookmarks'] }`, and requires the setting to be stored only on a grant
  and `permissions.remove` to be called when the row is turned off;
  `tests/ext/bookmarks.test.ts` covers every answer the browser can give. The prompt itself, and
  what it says, remain unobserved.

## M6.2 — "The first run is over" is an item of its own, not a setting

- **Context:** §17 asks for a single screen on first run, and something has to remember that it was
  answered. The obvious place is `Settings`, which is already one versioned storage item the panel
  reads and writes.
- **Decision:** `local:onboarded`, a boolean item of its own in `platform/storage.ts`, default
  `false`. `state/onboarding.ts` reads it once at boot into an `onboardingNeeded` signal that is
  tri-state: `null` until the read answers, and the panel renders nothing in that moment rather
  than a frame of Declutter. A failed read resolves to "answered", so a profile can never be stuck
  on the first run. `finishOnboarding` writes the two settings first and the flag second.
- **Why:** `Settings` is "the user's choices" and every field of it is something §4.6 offers to
  change; a flag nobody can see would be neither, and adding it would mean a settings migration for
  a value that is not a setting. The write order is the one that fails safely: a storage error after
  the answers are in makes the screen come back and be answered again, where the reverse would lose
  them silently.

## M6.2 — The first run asks §17's question in its own words, and "auto" is only preselected

- **Context:** §17.3 asks "Quando apri una scheda già aperta" with three answers, and §8.1 says
  the default guard mode is the one chosen in onboarding. The settings page already has three
  labels for the same three modes (`MODE_CHOICES`), and invariant 2 forbids closing a tab without
  an explicit gesture.
- **Decision:** `ONBOARDING_MODE_CHOICES` is its own list, in §17.3's order with `auto` first and
  preselected, with its own `onboardingGuard*` keys; `ONBOARDING_STALE_DAYS` is 3/7/14, a subset of
  §4.6's five. `DEFAULT_SETTINGS.guard.mode` stays `'warn'`: nothing is stored until "Inizia".
- **Why:** §17's wording is addressed to someone who has not met the extension yet ("Chiudila e
  torna a quella esistente"), and the settings page's is a label next to a stored value; sharing
  one list would force one of the two to read wrongly. Preselecting without storing is what keeps
  §8.1 and invariant 2 both true — a person who installs the extension and never opens the panel
  has a profile that closes nothing.

## M6.2 — The whitelist link finishes the first run on its way out

- **Context:** §17.3's "Hai una whitelist di Duplicate Tabs Closer?" link opens the editor of
  §8.3, which lives inside the settings page — a view that only exists once the shell does.
- **Decision:** `openWhitelistFromOnboarding` saves the answers given so far and stores the flag,
  exactly as "Inizia" does, and then calls `showSettings('duplicates')`. The screen does not come
  back afterwards.
- **Why:** the alternative — the editor on top of the first run, to be returned to — is a second
  way out of the screen and a state where the answers exist but are not stored. Someone who follows
  that link has made the two choices on screen (the preselected ones count); treating the click as
  an answer loses nothing and leaves the panel in one state instead of two.

## M6.2 — Every test profile but the first run's is already past it

- **Context:** a fresh Chromium profile is a fresh install, so from this task on the panel's first
  document is the onboarding screen. Every E2E spec and the panel-opening budget launch fresh
  profiles and look at the Declutter list.
- **Decision:** `tests/e2e/fixtures/extension.ts` writes `onboarded: true` through the service
  worker before any page exists, controlled by an `onboarded` test option that is `true` by default;
  `onboarding.spec.ts` is the one spec that sets `test.use({ onboarded: false })`.
  `tests/perf/panel-opening.perf.test.ts` writes the same key with the activity it seeds. The
  Firefox harness cannot reach its background at all (`tests/e2e-firefox/fixtures/panel.ts`), so
  `openPanel` writes the flag from the panel document and navigates the same page again — the same
  tab, because the header counts the tabs that are open.
- **Why:** the first run is one screen seen once, and a suite in which every test had to dismiss it
  would be testing the dismissal fifty times and the views once each. Writing the flag from the
  service worker, before the first panel document, means no panel ever reads it as `false` and then
  watches it change. The budget measures the panel a person opens every day, which is a panel whose
  first run is over.
