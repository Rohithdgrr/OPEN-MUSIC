# Mobile Docs — TRANCE MUSIC

> Start here. This folder is the complete reference for the **mobile** surface
> (Android + iOS) of TRANCE MUSIC. The desktop app is documented in
> `docs/architecture.md`, `docs/PRD.md`, `docs/ui.md`.

| # | Document | What it answers |
| --- | --- | --- |
| 01 | [Tech Stack](01-tech-stack.md) | What is used, which version, why |
| 02 | [File & Folder Structure](02-file-folder-structure.md) | Where everything lives, what owns what |
| 03 | [Setup](03-setup.md) | Prerequisites + first mobile build (Android, iOS) |
| 04 | [Pipelines](04-pipelines.md) | CI, iOS workflow, Release workflow, local builds |
| 05 | [Versions](05-versions.md) | App version, IPC contract, config versions |
| 06 | [Features](06-features.md) | What mobile can do today (and what it can't) |
| 07 | [Changelog](07-changelog.md) | Mobile history per release |
| 08 | [Future Scope](08-future-scope.md) | Planned mobile work, explicitly out of scope |
| 09 | [Problems & Solutions](09-problems-solutions.md) | Known mobile bugs/gotchas + fixes |
| 10 | [Do's & Don'ts](10-dos-donts.md) | What to do / what not to do when touching mobile |

**Also relevant** (repo root / `docs/`):

- [Feature list — desktop vs mobile](../feature-list.md) — the full platform
  matrix, including everything mobile does *not* have.
- [Future scope](../future-scope.md) — cross-platform roadmap; mobile items are
  tiered alongside desktop ones.
- [Task plan](../task.md) — phase status covering Android (9) and iOS (10).

## Mobile in one paragraph

TRANCE MUSIC is a **Tauri 2** app. Desktop serves `app/src/index.html`;
mobile serves **`app/src/mobile/index.html`** (a separate hash-router shell with
its own screens). The same Rust core (`app/src-tauri/src/*.rs`) powers both,
with desktop-only plugins/commands gated by `#[cfg(desktop)]` /
`#[cfg(mobile)]`. Mobile configs are overlays:
`tauri.android.conf.json` + `tauri.ios.conf.json`. Android builds anywhere;
**iOS builds only on macOS runners** (`ios.yml`).

## Quick links

- App id: `com.openmusic.trancemusic` — `app/src-tauri/tauri.conf.json:4`
- Current version: `0.3.0` — `Cargo.toml:3`, `tauri.conf.json:4`, `package.json:4`
- IPC contract: `api_version() -> 1` — `app/src-tauri/src/lib.rs:290`
- Android project: `app/src-tauri/gen/android/` (generated, do not hand-edit)
- Mobile shell: `app/src/mobile/`
