# Changelog

All notable changes to TabDeclutter are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). One version number serves both stores.

## [Unreleased]

### Added

- Optional **YouTube video duration sorting** (off by default in **Settings → YouTube video sorting**, behind `optional_host_permissions: ["https://www.youtube.com/*"]`): sorts open and suspended/discarded YouTube video tabs (standard videos, Shorts, `youtu.be`, `m.youtube.com`, `music.youtube.com`, and ended live VODs) shortest-to-longest or longest-to-shortest without waking suspended tabs, caching durations locally in `local:ytDurations`. Available both as a 1-click in-place sorter for the current window (with live progress and Undo) and automatically integrated into window organization and background Autopilot.

### Fixed

- Kept `autoDeclutter` and `autoOrganize` disabled until onboarding completes (including ignoring `runtime.onInstalled` `'install'` events) and updated store/privacy documentation to match.
- Unified AI batch packing (`packClusterBatches`) and proposal assembly (`assembleAiProposal`) between the background service worker and side panel so background refreshes pre-cluster via TF-IDF, split on `QuotaExceededError`, merge equivalent topic names, and preserve overflow tabs in `ungrouped`.
- Serialized post-AI background window organization inside the autopilot queue (`enqueue`), re-checking live guard/snooze/focus state and passing `proposalSignature` so `resolveWindowProposal` does not fall back unexpectedly.
- Kept `matchIgnoreHash` and `windowUseTabGroups` visible in `SettingsView` whenever native tab groups are off.

## [0.1.0]

First version, for Chrome (121 and later) and Firefox (140 and later).

### Added

- **Declutter**: the open tabs ranked by an explainable score, each with a plain reason; close,
  keep, discard or protect a site, one by one or in bulk, with an undo.
- **Organize**: automatic window organization (_Merge and tidy into a single window_ or _One window
  per topic or website_) with one-click Undo, instant incremental placement of newly opened tabs
  into existing thematic windows, and optional native tab groups by site, by topic without AI, or
  by topic with Chrome's on-device Gemini Nano AI (with 0-token session warmup, 40 s VRAM
  keep-alive, background Service Worker AI refresh, resilient JSON parsing, and live stage
  telemetry).
- **Duplicate protection** in real time: warn only or close automatically, priority rules, scope,
  URL comparison rules, a whitelist with `*` and `/regex/` patterns, pause, and an import of the
  Duplicate Tabs Closer list.
- **Archive** of closed tabs with restore and a retention period.
- A badge with the number of suggested tabs, keyboard shortcuts, context menu items, light and
  dark themes, Italian and English, and keyboard and screen-reader accessibility.
- Store documents: privacy policy, permissions, store listings, notes for AMO review.
- Store packages for Chrome and Firefox, with a Firefox sources zip that rebuilds the add-on
  identically (`pnpm reproducible`), and a release workflow on `v*` tags.

### Privacy

- No data is collected or transmitted: no network requests, no analytics, no remote code.

[Unreleased]: https://github.com/RobertoReale/TabDeclutter/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/RobertoReale/TabDeclutter/releases/tag/v0.1.0
