# TabDeclutter

A **Set & Forget** Chrome and Firefox extension (Manifest V3) that keeps your browser tidy
automatically: it organizes your browser windows without cluttering the tab strip with coloured tab
groups, closes old and abandoned tabs in the background (always saving them to a local Archive
first), and blocks duplicate tabs in real time by switching you back to the existing tab.

Every closed tab is archived locally and can be reopened at any time, active work is protected by
strict safety guardrails, and no data ever leaves your device: zero network requests, zero
analytics, zero cloud services.

---

## Key Features

### 1. Automatic Window Organization (Two Modes, No Coloured Tab Groups)

Instead of filling your tab bar with coloured tab group badges, TabDeclutter organizes your **Chrome
and Firefox windows** automatically in the background (or on demand with **"Organize windows
now"**). In the **Organize** tab you can switch at any time between two clear modes:

- **Merge and tidy into a single window** _(default)_
  - Automatically dissolves any coloured tab groups on the tab bar.
  - Consolidates tabs scattered across multiple windows into your primary window.
  - Sorts tabs side by side **by website** (recognizing major web apps on shared domains such as
    Gemini, Gmail, Google Docs, Drive, Calendar, YouTube Music, Outlook, and Teams as distinct apps)
    or **by topic** (fast local TF-IDF clustering that ignores URL noise and opaque page IDs).
  - If you were reading a tab in a secondary window that gets merged into the primary window, that
    tab stays active on screen so you never lose your place.
- **One window per topic or website**
  - Automatically dissolves any coloured tab groups.
  - Groups related tabs **by website** or **by topic** and places each cluster into its own
    dedicated browser window so every open window focuses on a single coherent topic or project.
  - The cluster containing the tab you are currently viewing always stays in your active window.
- **One-click Undo for windows**: every manual window organization shows an **Undo** bar that
  restores tabs (and any emptied windows) back to their previous layout and temporarily snoozes
  background auto-organize so your layout stays intact.
- **Experimental on-device AI** _(Chrome-only, off by default)_: local organization already runs
  instantly and offline without AI; if you want to experiment with Chrome's built-in Gemini Nano
  model for topic grouping, you can opt in under **Settings → Experimental**. Your choice is never
  reset automatically, and TabDeclutter warns you if Chrome's model is unavailable or falls back.

### 2. Autopilot & Declutter

- **Background Autopilot** _(enabled by default)_: quietly archives and closes abandoned empty tabs
  (untouched for over 1 hour), tabs you have not opened for more than your configured threshold
  (default: **7 days**), and forgotten background windows.
- **Manual Review & 1-Click Cleanup**: open the **Declutter** view to see tabs ranked by a readable
  reason (_"Not opened in 12 days"_, _"Already open in another tab"_, _"Search results you already
  looked at"_). Close all recommended tabs in one click, or **Go to**, **Keep**, or **Close**
  individual tabs directly from each row.

### 3. Real-Time Duplicate Protection

- The moment you open or navigate to a page that is already open in another tab, TabDeclutter closes
  the duplicate copy, keeps the older tab, and **automatically activates and focuses the existing
  tab** (even if it is in another window).
- **Smart URL comparison**: treats `http` and `https` as equivalent, ignores `www.`, ignores
  tracking parameters (`utm_source`, `fbclid`, `gclid`, etc.), and ignores `#hash` anchors while
  preserving SPA routes (`#/page`).
- **Quick controls**: click the **`Duplicates: ON`** chip in the header (or right-click the toolbar
  icon) to switch between _Close automatically_, _Warn only_, and _Off_, pause protection for 15
  minutes / 1 hour / until restart, close all open duplicates at once, or reopen the last closed
  duplicate.
- **Exceptions whitelist**: allow duplicates on specific sites using `*` wildcards or `/regex/`
  patterns.

### 4. Strict Safety Guardrails (Never Interrupts Active Work)

TabDeclutter is designed never to get in your way while you are working:

- **Never closes or moves**:
  - The **active tab** you are currently looking at
  - **Pinned** tabs
  - Tabs **playing audio or video** (`audible`)
  - Tabs that are still **loading**
  - **New Tab / blank pages** (`chrome://newtab`, `about:blank`) while you may be typing a URL or
    search query in the address bar
  - **Login, OAuth, and payment popups** (`accounts.google.com`, `/oauth/`, `/login`, `/signin`,
    etc.), so authentication flows are never broken
- **Never auto-closes in the background**:
  - **Local files** (`file://`) and **extension document viewers** (`chrome-extension://`,
    `moz-extension://`, such as Office `.xlsx`/`.docx` or PDF viewers)
  - **Local development servers** (`localhost`, `127.0.0.1`, `[::1]`)
  - **Newly opened tabs** within the grace period (default: **2 hours**)
  - Any web page or search tab that has **not genuinely exceeded your configured inactivity
    threshold** (e.g. 7 days)
  - Any domain listed in **Protected sites** (e.g. `mail.google.com`, `*.github.com`)
- **Startup grace period**: waits 15 seconds after browser startup so session restore is never
  interrupted.

### 5. Local Archive & Instant Undo

- Every tab closed by you, by Autopilot, or by Duplicate Protection is saved in the **Archive**
  before it closes (kept for **30 days** by default, configurable up to 365 days).
- Search archived tabs by title or URL, filter by date (_Today_, _Last 7 days_, _Older_) or by who
  closed them (_Closed by me_, _Duplicates closed automatically_), restore single tabs or bulk
  selections, or export the filtered list to your clipboard as Markdown links.

---

## Side Panel & Shortcuts

| Shortcut / Control | Action                                                                 |
| ------------------ | ---------------------------------------------------------------------- |
| `Alt+Shift+D`      | Open the TabDeclutter side panel                                       |
| `Alt+Shift+M`      | Pause or resume Duplicate Protection                                   |
| `Alt+Shift+X`      | Close all duplicate tabs now                                           |
| `↑` / `↓`          | Navigate rows and sections in the Declutter list                       |
| `Enter`            | Switch to the focused tab (or expand/collapse a section)               |
| `Delete`           | Close the selected or focused tab(s) (saved to Archive, `Ctrl+Z` undo) |
| `K`                | Mark the selected or focused tab(s) as **Keep**                        |

Supports **Italian** and **English** (switchable live in **Settings → Extension language**) and
automatically follows your system's **Light / Dark theme**. Works on Chrome 121+ (and Chromium
browsers such as Edge, Brave, Vivaldi) and Firefox 140+. Incognito windows are never touched.

---

## Privacy

No data is ever collected or transmitted. Everything runs locally on your device using browser
storage (`storage.local` and `storage.session`). See `docs/PRIVACY.md` for the full privacy policy
and `docs/PERMISSIONS.md` for every browser permission and why it is needed.

---

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

---

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

- **Chrome**: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and
  pick `.output/chrome-mv3`. Experimental on-device AI is off by default under **Settings →
  Experimental** so Chrome does not log warnings on browsers where Gemini Nano is disabled; if you
  opt in while Chrome's built-in AI is disabled, `chrome://extensions` may show two harmless
  browser-level notices under "Errors" (`On-device AI is disabled in Chrome settings…` and
  `The feature flag gating model execution was disabled`). You can enable Chrome's built-in AI at
  `chrome://settings/ai`.
- **Firefox**: open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and
  pick `.output/firefox-mv3/manifest.json`. A temporary add-on is removed when Firefox closes.

## Development

```sh
pnpm dev             # Chrome, with hot reload
pnpm dev:firefox     # Firefox
pnpm lint            # eslint + prettier --check
pnpm typecheck       # wxt prepare + tsc --noEmit
pnpm test            # unit & extension tests (vitest)
pnpm e2e             # Chromium E2E tests (Playwright)
pnpm e2e:firefox     # Firefox E2E tests (Puppeteer WebDriver BiDi)
pnpm perf            # the time budgets of PLAN.md §11, alone and without coverage
pnpm lint:firefox    # web-ext lint on the Firefox build (run pnpm build:firefox first)
```

## Licence

MIT, see `LICENSE`.
