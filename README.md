# TabDeclutter

A Chrome and Firefox extension (MV3) that suggests which tabs to close, organizes the rest into
native tab groups, and blocks duplicate tabs in real time.

Nothing is closed without an explicit gesture, every suggestion comes with a readable reason, every
close can be undone, and no data ever leaves the device: no network requests, no analytics. The
optional on-device AI only improves group names.

See `PLAN.md` for the product spec and `TASKS.md` for the execution plan.

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
