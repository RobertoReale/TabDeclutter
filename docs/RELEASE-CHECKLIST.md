# Release checklist — 0.1.0

PLAN.md §14's release checklist, run on 2026-11-17 (task M7.6) on the code of commit `987f9e6`
(the M7.6 commit changes only documents and `.github/workflows/ci.yml`). Every box has its status
and the evidence: the command that was run and what it printed. "Met" means the evidence below
proves the box; anything it does not prove is said in the row. What a person still has to do
before the first submission is at the bottom.

How each box is proved in general, test by test, is `docs/TEST-COVERAGE.md`, "Release checklist".

## The gates on this tree

`pnpm gates`, all twelve gates of `phasekit.json`, green (run in three parts, because a full run
outlasts the shell's ten minutes):

| Gate | Result |
|---|---|
| `install` | pass |
| `lint` | pass (eslint + prettier) |
| `typecheck` | pass |
| `unit tests` | 53 files, 1460 tests passed; statements 99.91%, lines 99.89% |
| `build chrome` | pass, `.output/chrome-mv3` 509.42 kB |
| `perf budgets` | 3 files, 5 tests passed (medians below) |
| `build firefox` | pass, `.output/firefox-mv3` 509.59 kB |
| `web-ext lint` | errors 0, notices 0, warnings 2 (box 2) |
| `permissions docs` | pass |
| `e2e chromium` | 60 passed |
| `e2e firefox` | 7 files, 24 tests passed |
| `bundle size` | 4 passed, 0 failed (sizes below) |

The time budgets of PLAN.md §11, as `pnpm perf` printed them. Each one is the plan's number times
a factor measured in the same run on a reference workload, so a slower or throttled machine does
not fail a budget the code meets (`docs/DECISIONS.md`, "F.1 — perf budgets are judged against a
reference workload run in the same conditions"):

- scoring 1000 tabs: CPU median 54.63 ms against 15 ms × 4.77 = 71.59 ms;
- opening the panel with 300 tabs: wall median 292.7 ms against 150 ms × 4.48 = 671.9 ms;
- clustering 300 tabs by site: CPU median 1.46 ms against 50 ms × 4.09 = 204.70 ms;
- clustering 300 tabs by topic, 1 window: CPU median 26.38 ms against 50 ms × 4.91 = 245.72 ms;
- clustering 300 tabs by topic, 6 windows: CPU median 18.56 ms against 50 ms × 5.05 = 252.27 ms.

The JS budgets, gzip, measured without tldts (`docs/DECISIONS.md`, M7.2):

- Chrome panel 35 124 B and Firefox panel 35 122 B, budget 60 000 B;
- Chrome background 17 530 B and Firefox background 17 535 B, budget 18 000 B.

## The checklist

### 1. Chrome and Firefox builds generated from the same commit, same version — Met

- `pnpm zip` and then `pnpm reproducible` (which runs `pnpm zip:firefox`), one after the other on
  the same working tree: `.output/tabdeclutter-0.1.0-chrome.zip` (187 322 bytes),
  `.output/tabdeclutter-0.1.0-firefox.zip` (187 385 bytes),
  `.output/tabdeclutter-0.1.0-sources.zip` (563 960 bytes).
- `unzip -p <zip> manifest.json`: `"version": "0.1.0"` in both packages.
- `build/manifest.ts` declares no `version`, so WXT writes the `version` of `package.json` into
  both manifests. No test checks this. The evidence is the two manifests above, read from the
  packages themselves. On GitHub, `.github/workflows/release.yml` builds both packages from the
  tagged commit and fails if the tag differs from the `package.json` version.

### 2. `web-ext lint` with 0 errors; `data_collection_permissions` and `gecko.id` present — Met

- `pnpm lint:firefox` on `.output/firefox-mv3`: errors 0, notices 0, warnings 2. The two warnings
  are `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` and `UNSAFE_VAR_ASSIGNMENT` (Preact's
  renderer, `chunks/sidepanel-*.js`), both assessed in `docs/DECISIONS.md`, "M0.1 — The two
  `web-ext lint` warnings, assessed".
- The manifest inside `tabdeclutter-0.1.0-firefox.zip`: `browser_specific_settings.gecko` is
  `{"id":"tabdeclutter@robertoreale","strict_min_version":"140.0","data_collection_permissions":{"required":["none"]}}`.
  The id still has to be confirmed by the owner before the first AMO submission (bottom of this
  file).

### 3. AMO sources zip without minified files; reproducible build verified — Met

- `pnpm reproducible` (`tools/verify-reproducible.mjs`) passed. It refuses a sources zip with
  build output, dependencies, tests, a `*.min.*` file, a line over 1000 characters or a file git
  does not track, then rebuilds from the zip in a fresh temporary folder. It printed
  `REPRODUCIBLE: the 16 files rebuilt from .output\tabdeclutter-0.1.0-sources.zip are identical to
  .output\tabdeclutter-0.1.0-firefox.zip.` (61 s together with `pnpm zip`).
- How a reviewer does the same is `docs/AMO_REVIEW.md`.

### 4. All flows verified on Chrome **and** Firefox — Met by the automated suites

- Gate `e2e chromium` (Playwright, the real Chromium with the built extension) and gate
  `e2e firefox` (the real Firefox with the built add-on), numbers above. Which flow each spec
  covers is `docs/TEST-COVERAGE.md`.
- The checks done by hand in the earlier phases are the ticked entries of `docs/MANUAL-CHECKS.md`.
  Not done by hand: the test with 1000 tabs in 10 windows that PLAN.md §13 (M7) asks for, on
  either browser (see `docs/DECISIONS.md`, "M7.6 — What the release checklist could not prove by
  hand"). The budgets for 1000 tabs are measured by gate `perf budgets`.

### 5. Zero network requests — Met on Chrome at run time; on Firefox by the build's content

- Chrome: every spec of gate `e2e chromium` ends by asserting that no extension context (the panel
  and the service worker) made a request outside `chrome-extension://<id>/`
  (`tests/e2e/fixtures/recorder.ts`, proved to fire by `tests/e2e/recorder.spec.ts`).
- Both builds, read for every way of reaching the network:
  `grep -o -E "fetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts|https?://"`
  over the `.js`, `.html` and `.json` of `.output/chrome-mv3` and `.output/firefox-mv3`. No
  `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `EventSource` or `importScripts`. The only `fetch`
  calls are Vite's module preload of the extension's own chunks and `src/platform/i18n.ts`
  reading the packaged `/_locales/<language>/messages.json` through `runtime.getURL`. The only
  URLs are strings that are never requested (WXT's documentation links and the w3.org namespaces of
  SVG).
- Firefox: there is no request recorder for a `moz-extension://` page (WebDriver BiDi does not see
  it, `tests/e2e-firefox/fixtures/panel.ts`). Site icons, the one place a request could come from,
  are never loaded from the network (`src/platform/favicon.ts`, `tests/unit/favicon.test.ts`).
- Not done: the look at DevTools → Network by hand that §14 names.

### 6. Permissions = those of section 5.4, each one justified — Met

- `tests/unit/manifest.test.ts`, "the Chrome manifest" and "the Firefox manifest", "is exactly
  what PLAN.md §5.4 asks for".
- Gate `permissions docs` (`tools/check-permissions.mjs`) checks that the tables of
  `docs/PERMISSIONS.md` name exactly the permissions of each built manifest. Each row of those
  tables carries the warning the browser shows and the justification.
- Chrome: `tabs`, `tabGroups`, `storage`, `sidePanel`, `alarms`, `favicon`, `sessions`,
  `contextMenus`. Firefox: `tabs`, `tabGroups`, `storage`, `alarms`, `sessions`, `menus`. Both:
  `bookmarks` optional, no host permissions, `incognito: "not_allowed"`.

### 7. Performance budgets met — Met

- Gate `perf budgets` and gate `bundle size`, numbers above.

### 8. No console errors/warnings — Met, with one warning that Chrome itself writes

- Errors: every spec of both E2E gates fails on a console error or an uncaught exception from an
  extension page or the service worker (`tests/e2e/fixtures/recorder.ts`,
  `tests/e2e-firefox/fixtures/panel.ts`, proved to fire by `tests/e2e/recorder.spec.ts` and
  `tests/e2e-firefox/console.spec.ts`).
- Warnings: the suites do not watch them, so they were measured once for this checklist. A
  temporary, uncommitted change made both collectors write every warning to a file
  (Chrome: `console` messages of type `warning`; Firefox: lines starting with `console.warn` or
  `JavaScript warning: moz-extension`), and `pnpm e2e` and `pnpm e2e:firefox` were run.
  - Chromium: 60 passed, 11 warnings, all the same:
    `sidepanel.html: Unable to create a text session because the service is not running.` Chrome
    writes it when the panel asks `LanguageModel.availability()` (PLAN.md §7.3) in a browser
    whose on-device model service is not running, as in the test browser. The extension's own
    code writes nothing (`docs/DECISIONS.md`, "M7.6 — Chrome's Prompt API warning, assessed").
  - Firefox: 24 passed, 0 warnings.

### 9. en/it i18n complete — Met

- Gate `unit tests`: `tests/unit/i18n.test.ts` (the two catalogues have the same keys and the
  same placeholders) and `tests/unit/i18n-usage.test.ts` (no key the code uses is missing, no key
  the catalogues ship is unused).

### 10. axe clean — Met

- Gate `e2e chromium`: `tests/e2e/a11y.spec.ts`, "axe finds nothing serious in any view", in both
  themes and on the first-run screen.

### 11. PRIVACY.md, PERMISSIONS.md, STORE_LISTING.md and AMO_REVIEW.md ready, with 1280×800 screenshots for both stores — Met for the documents and screenshots

- `docs/PRIVACY.md`, `docs/PERMISSIONS.md`, `docs/STORE_LISTING.md` and `docs/AMO_REVIEW.md`
  exist and were checked against the code in M7.6. `tests/unit/store-docs.test.ts` holds
  PERMISSIONS.md to the manifests (and gives every permission a warning and a justification),
  STORE_LISTING.md to the message catalogues, and AMO_REVIEW.md to `.nvmrc`, the `packageManager`
  of `package.json` and the Firefox permissions. Only the existence of PRIVACY.md is tested.
- Screenshots: `docs/store/screenshots/chrome/` holds `1-declutter.png`, `2-organize.png`,
  `3-duplicate-protection.png`, `4-archive.png` and `5-dark-theme.png`; `file` reports each one
  as `PNG image data, 1280 x 800`. They are taken on Chrome, in English, and serve both stores
  (`docs/DECISIONS.md`, M7.4).
- Not part of this box but asked for by PLAN.md §12.2: the 440×280 small promo tile for the
  Chrome Web Store does not exist yet (bottom of this file).

## PLAN.md §13, M7 acceptance

"The release checklist fully ticked. Packages ready to submit." The checklist is above. The three
packages are made by `pnpm zip` and `pnpm zip:firefox`, or by a `v*` tag through `release.yml`.
They are ready to submit once the steps below are done.

## Left before submission

These need a person and an account, so no task can do them. They are the open `(setup)` entries of
`docs/MANUAL-CHECKS.md`, plus one asset:

- Confirm the Firefox id `tabdeclutter@robertoreale` in `build/manifest.ts`. It cannot change after
  the first AMO submission. `docs/MANUAL-CHECKS.md` (setup).
- Create the developer accounts (Chrome Web Store, AMO) and make the first submission by hand
  (PLAN.md §12.2, §12.3).
- After the repository is published on GitHub, check that CI is green.
- On Firefox, with the signed build, check that tabs are not "new" again after a restart.
- Make the 440×280 small promo tile (PLAN.md §12.2), which the Chrome Web Store asks for.
- Look at the five screenshots before uploading them (they were never reviewed by hand).
