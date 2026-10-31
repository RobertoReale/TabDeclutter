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
