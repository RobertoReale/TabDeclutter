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
