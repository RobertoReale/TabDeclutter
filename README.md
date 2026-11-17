# TabDeclutter

A Chrome and Firefox extension (MV3) that suggests which tabs to close, organizes the rest into
native tab groups, and blocks duplicate tabs in real time.

Nothing is closed without an explicit gesture, every suggestion comes with a readable reason, every
close can be undone, and no data ever leaves the device: no network requests, no analytics. The
optional on-device AI only improves group names.

## What it does

- **Declutter**: the open tabs ranked by how likely you are to be done with them, each with a
  plain reason. Close, keep, discard or protect a site, one by one or in bulk.
- **Organize**: native tab groups by site or by topic; on Chrome, the on-device model can improve
  the group names (optional).
- **Duplicate protection**: warns you, or closes the duplicate, the moment a tab becomes a copy of
  another. Whitelist, URL comparison rules and pause; it understands the pattern list of
  Duplicate Tabs Closer. If you still use that extension, turn it off to avoid conflicts.
- **Archive and undo**: closed tabs are kept for a while and can be restored.
- Badge with the number of suggestions, keyboard shortcuts (`Alt+Shift+D` opens the panel), light
  and dark theme, Italian and English.

Works on Chrome 121 or later (also Edge, Brave, Vivaldi) and Firefox 140 or later. Incognito
windows are not supported.

## Privacy

No data is collected or transmitted. See `docs/PRIVACY.md`. The permissions and why each is needed
are in `docs/PERMISSIONS.md`.

## Documents

| File                    | What it is                                                          |
| ----------------------- | ------------------------------------------------------------------- |
| `PLAN.md`               | The product spec.                                                   |
| `TASKS.md`              | The execution plan.                                                 |
| `CHANGELOG.md`          | What changed in each version.                                       |
| `docs/PRIVACY.md`       | The privacy policy linked from both stores.                         |
| `docs/PERMISSIONS.md`   | Every permission, per browser, with its warning and reason.         |
| `docs/STORE_LISTING.md` | The texts for the Chrome Web Store and AMO, in Italian and English. |
| `docs/AMO_REVIEW.md`    | How AMO reviewers rebuild the Firefox package.                      |
| `docs/DECISIONS.md`     | Every choice the spec left open.                                    |
| `docs/TEST-COVERAGE.md` | Where each item of the test strategy is tested.                     |

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
sources zip that AMO requires.

## Loading the build by hand

- **Chrome**: `chrome://extensions`, turn on "Developer mode", "Load unpacked", pick
  `.output/chrome-mv3`.
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
