# Changelog

All notable changes to TabDeclutter are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). One version number serves both stores.

## [Unreleased]

### Added

- Optional **Close liked YouTube videos** feature (off by default in **Settings → YouTube**, sharing `optional_host_permissions: ["https://www.youtube.com/*"]`): detects which open and suspended/discarded YouTube video tabs you have already liked using your active YouTube browser session (without waking suspended tabs, OAuth setup, or extra permissions) via a 2-tier check (`playlist?list=LL` fast path + streaming `/watch` `likeStatusEntity` fallback with Base64 video-ID verification). Available both as a 1-click **Close liked videos now** card in **Declutter** (with live progress, Cancel, standard Undo toast, and Archive) and periodically (every 15 min) when **Autopilot** is enabled, with an opt-in checkbox to include or protect active/audio-playing tabs while always keeping pinned, protected-site, and kept tabs untouched.
- One-click **Save as tab group** buttons on every cluster and **Save all as tab groups** in **Organize → Windows and topics**: converts organized site or topic clusters into native Chrome/Firefox tab groups (gathering cross-window tabs into the cluster's primary window, reusing already-saved groups when new tabs arrive, and offering lossless 1-click Undo) while keeping existing native tab groups protected from background Autopilot and window organization.
- Optional **YouTube video duration sorting** (off by default in **Settings → YouTube video sorting**, behind `optional_host_permissions: ["https://www.youtube.com/*"]`): sorts open and suspended/discarded YouTube video tabs (standard videos, Shorts, `youtu.be`, `m.youtube.com`, `music.youtube.com`, and ended live VODs) shortest-to-longest or longest-to-shortest without waking suspended tabs, caching durations locally in `local:ytDurations`. Available both as a 1-click in-place sorter for the current window (with live progress and Undo) and automatically integrated into window organization and background Autopilot.

### Fixed

- Hardened on-device AI grouping for large (100+ tab) sessions: prevented single generic words (`"History"`, `"Philosophy"`) from chain-merging into compound mega-groups (`"Philosophy & History"`), reduced AI batch size from 35 to 20 tabs without truncating pre-clusters #9+, added a word-cohesion guardrail that splits hallucinated multi-host umbrella dumps via local TF-IDF, switched side-panel multi-batch runs to per-batch timeout budgets with live `batch i/N` progress, and added fast single-prompt incremental AI classification for 1–8 newly arrived tabs.
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
