# TabDeclutter

A Chrome and Firefox extension (MV3) that keeps your browser tidy automatically: it closes old and
temporary tabs in the background (always saving them to a local Archive first), organizes your
browser windows automatically without cluttering the tab bar with coloured tab groups, and blocks
duplicate tabs in real time.

Every suggestion comes with a plain reason, every closed tab is archived and can be restored at any
time, and no data ever leaves your device: no network requests, no analytics.

## What it does

- **Autopilot & Declutter**: automatically closes expired temporary pages, unused stale tabs, and
  forgotten background windows (or lets you review and close them in one click). Pinned tabs,
  audible tabs, active tabs, and protected domains are never touched, and every closed tab is
  saved to the Archive first.
- **Window Organization (two modes, no coloured tab groups)**: keeps your browser windows organized
  automatically by website or by topic, with an instant switch between two modes:
  - **Merge and tidy into a single window** _(default)_: removes coloured tab groups, consolidates
    scattered windows into one clean window, and sorts related tabs side by side.
  - **One window per topic or website**: removes coloured tab groups and places each website or
    topic cluster into its own dedicated window.
- **Duplicate protection**: warns you, or closes the duplicate automatically, the moment a tab
  becomes a copy of another. Whitelist with `*` wildcards and `/regex/` patterns, URL comparison
  rules, and pause controls.
- **Archive and undo**: every tab closed manually or by Autopilot is kept in the local Archive and
  can be searched, exported, or reopened anytime.
- Badge with the number of suggestions, keyboard shortcuts (`Alt+Shift+D` opens the panel), light
  and dark theme, Italian and English.

Works on Chrome 121 or later (also Edge, Brave, Vivaldi) and Firefox 140 or later. Incognito
windows are not supported.

## Privacy

No data is collected or transmitted. See `docs/PRIVACY.md`. The permissions and why each is needed
are in `docs/PERMISSIONS.md`.

## Documents

| File                        | What it is                                                           |
| --------------------------- | -------------------------------------------------------------------- |
| `PLAN.md`                   | The product spec.                                                    |
| `TASKS.md`                  | The execution plan.                                                  |
| `CHANGELOG.md`              | What changed in each version.                                        |
| `docs/PRIVACY.md`           | The privacy policy linked from both stores.                          |
| `docs/PERMISSIONS.md`       | Every permission, per browser, with its warning and reason.          |
| `docs/STORE_LISTING.md`     | The texts for the Chrome Web Store and AMO, in Italian and English.  |
| `docs/store/`               | The 1280×800 store screenshots (`pnpm screenshots`).                 |
| `docs/AMO_REVIEW.md`        | How AMO reviewers rebuild the Firefox package.                       |
| `docs/RELEASE-CHECKLIST.md` | The release checklist of PLAN.md §14, with the evidence of each box. |
| `docs/DECISIONS.md`         | Every choice the spec left open.                                     |
| `docs/TEST-COVERAGE.md`     | Where each item of the test strategy is tested.                      |
| `docs/MANUAL-CHECKS.md`     | The checks done by hand, and the ones left for publication.          |
| `docs/CLUSTER-REVIEW.md`    | A review of the topic groups on the 300-tab fixture.                 |

## Building from source

Reproducing the published build (the instructions AMO review relies on, PLAN.md §12.3):

- Operating system: any one supported by Node; the published builds are made on Windows 11.
- Node **24.13.0** (the exact version is in `.nvmrc`).
- pnpm **11.17.0** (the exact version is in `package.json`, field `packageManager`).

```sh
pnpm install --frozen-lockfile
pnpm build           # Chrome  → .output/chrome-mv3
pnpm build:firefox   # Firefox → .output/firefox-mv3
```

`pnpm zip` and `pnpm zip:firefox` produce the store packages; the Firefox one also produces the
sources zip that AMO requires. `pnpm reproducible` makes the Firefox packages, rebuilds the add-on
from the sources zip in a temporary folder and fails unless every file is identical. A `v*` tag runs
the same checks on GitHub (`.github/workflows/release.yml`) and attaches the three zips to a GitHub
Release; nothing is submitted to the stores.

## Loading the build by hand

- **Chrome**: `chrome://extensions`, turn on "Developer mode", "Load unpacked", pick
  `.output/chrome-mv3`. On-device AI is off by default so Chrome does not log warnings on browsers
  where Gemini Nano is disabled; if you enable "Use on-device AI when available" in TabDeclutter's
  settings while Chrome's built-in AI is disabled, `chrome://extensions` may show two harmless
  browser-level notices under "Errors" (`On-device AI is disabled in Chrome settings…` and `The
feature flag gating model execution was disabled`). You can enable on-device AI at
  `chrome://settings/ai`.
- **Firefox**: `about:debugging#/runtime/this-firefox`, "Load Temporary Add-on", pick
  `.output/firefox-mv3/manifest.json`. A temporary add-on is removed when Firefox closes.

## Development

```sh
pnpm dev             # Chrome, with hot reload
pnpm dev:firefox     # Firefox
pnpm lint            # eslint + prettier --check
pnpm typecheck       # wxt prepare + tsc --noEmit
pnpm test            # unit tests (vitest)
pnpm perf            # the time budgets of PLAN.md §11, alone and without coverage
pnpm lint:firefox    # web-ext lint on the Firefox build (run pnpm build:firefox first)
```

## Licence

MIT, see `LICENSE`.
