# Future Scope — TRANCE MUSIC

Consolidated roadmap across desktop and mobile. Mobile-specific detail lives in
[`mobile/08-future-scope.md`](mobile/08-future-scope.md); this file is the
single cross-platform view.

| | |
|---|---|
| Version | `0.3.0` |
| Companion docs | [feature-list](feature-list.md) · [task](task.md) · [architecture](architecture.md) |

**Legend:** 🔜 near · 📅 mid · 🔭 far · ⛔ explicitly out of scope

---

## 🔜 Near

### Desktop

- **Real DSP / EQ.** No `AudioContext` exists today; the "equalizer" glyphs in
  `index.html` are decorative. Web Audio `AudioContext` + `BiquadFilterNode`:
  bass boost (low-shelf +6 dB @ 100 Hz), vocal (band-pass 1–4 kHz), treble
  (high-shelf +6 dB @ 8 kHz), custom 5-band.
- **Crossfade on mobile.** Desktop already crossfades with a second `<audio>`
  (`playback.js:256`); mobile has no second element. Also worth making the
  desktop fade sample-accurate instead of `timeupdate`-discovered.
- **Visualiser.** `AnalyserNode` → canvas. The widget's 7-bar spectrum is decorative today.
- **Download pause / resume.** HTTP `Range` resume into `.part` files.
- **Drag-and-drop queue reorder.** The queue is a plain array — splice on drop.
- **Quality picker in the player.** `qualities[]` is already in the DTO; no UI surfacing it.
- **Light theme.** Flip the seven design tokens + `prefers-color-scheme`.
- **Search filters.** Year range, duration, language — backend returns the data.

### Shared (both platforms)

- **Lyrics translation.** The toggle exists and does nothing; needs LibreTranslate or equivalent.
- **Karaoke parity.** Word-level highlighting is mobile-only today — port to desktop.
- **Smart playlists.** "Top 50 last 30 days", "favourited but never downloaded". Data is in
  `localStorage` — needs a query, not a system.
- **Playlist import / export.** M3U, PLS, CSV in; M3U8 + JSON backup out.

### Mobile

- **Android CI workflow** — mirror `ios.yml`: smoke build + release APK/AAB on tags.
- **CI covers mobile JS** — extend `ci.yml` from `src/*.js` to `src/mobile/**/*.js`.
- **File export/import** — Storage Access Framework (Android) / document picker (iOS).
- **`open_external` on mobile** — Intent / `UIApplication.open`.
- **Signed Android releases** — keystore + signing config, internal → closed → production.
- **App-store metadata** — icons/splash per size, privacy policy, data-safety form.

---

## 📅 Mid

- **Gapless playback** — pre-buffer the next track, sample-accurate switch.
- **ReplayGain / loudness normalisation** — `ebur128` in Rust.
- **Discord Rich Presence** — `tauri-plugin-discord-rpc`.
- **Last.fm / ListenBrainz scrobbling** — at 50 % or 4 minutes, whichever first.
- **Album-art colour theming** — dominant colour extraction tinting widget accents.
- **Multi-select batch operations** — shift-click → download all / add to queue / remove.
- **Queue persistence across restarts** + "save queue as playlist".
- **Storage quota with LRU eviction** for the vault.
- **Podcast support** — JioSaavn exposes podcasts; the API shape is similar.
- **Mini-player window** — interactive always-on-top transport.
- **Multiple catalog adapters** behind one `Catalog` trait — Audius / Creative-Commons as a
  *legal* default alongside the main catalog.
- **Mobile background playback hardening** — audio focus, headset buttons, call ducking.
- **Mobile download manager UX** — pause/resume, Wi-Fi-only, per-track quality.
- **Spotify Canvas** — looping track video behind Now Playing art. Unofficial
  (`sp_dc` cookie, no OAuth path), keyed on ISRC from the Spotify import,
  cached in `moka`, mobile-first (metered-data toggle, album-art fallback).
  Full plan → [`mobile/08-future-scope.md`](mobile/08-future-scope.md).
- **Offline-first search/history** when the catalog is unreachable.

---

## 🔭 Far

- **Plugin system** for community source adapters.
- **Optional self-hosted catalog mode** — ship the MIT reference server.
- **Vocal removal / stem separation.**
- **Beat-matched transitions ("TRANCE mode")** — local audio analysis pipeline.
- **Collaborative queue / LAN mode / streamer mode.**
- **Crash + ANR reporting** (opt-in) with a vitals dashboard.
- **iOS signed `.ipa` releases** — requires Apple secrets in CI.
- **SQLite-backed library** — FTS5 full-text search over track metadata.

---

## ⛔ Explicitly out of scope

| Item | Why |
|---|---|
| **Tauri in-app updater on mobile** | The store owns install/update; `update_check` only notifies |
| **Global shortcuts, tray, single-instance, autostart writes on mobile** | OS-owned concepts; mobile uses notifications, intents and system settings |
| **Desktop widget window on mobile** | Replaced by the `nowplaying` screen + media notification |
| **DRM content** | Out of the project's purpose |
| **Accounts, login, subscriptions** | Logged-out by design |
| **Telemetry / analytics collection** | No data leaves the machine |
| **Hand-editing `gen/android` or the generated Xcode project** | Fix the overlay config / `Cargo.toml` gates / Rust `cfg()`s instead |
| **Central media relay** | Concentrates copyright exposure and bandwidth in one place — bytes always flow CDN → end user |

---

## How to promote an item

1. Add it to [`feature-list.md`](feature-list.md) when it lands, with a platform column.
2. Add a `CHANGELOG.md` entry under `[Unreleased]` if a user would notice.
3. Bump `api_version()` (`lib.rs:290`) if any command signature changed.
4. Move it from this file's tier to **shipped** in the same commit.
