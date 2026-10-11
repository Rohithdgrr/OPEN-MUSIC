# Changelog

Notable changes to OPEN MUSIC. [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · [SemVer](https://semver.org/spec/v2.0.0.html).

Platforms shipped: **Windows** (MSI + NSIS), **Linux** (deb + AppImage), **Android** (APK). macOS and iOS are not released as of v0.5.0.

## [0.5.0] — 2026-10-11

### Added
- **Listen Together (Jam)** on desktop and mobile: open a room, share one invite link (`trancemusic://join?…`) or QR, guests follow the host's playhead with drift correction; transport is host-only. Room chat with unread badges, shared up-next queue, up to 16 guests.
- **Jam resilience**: multi-address invites with try-every-candidate dialing (a dead first address — VPN, emulator NAT, dock NIC — no longer fails the join), guest auto-rejoin, host tick 250 ms.
- **Download pause/resume** (desktop): paused downloads keep their `.part` file and resume with an HTTP Range request.
- **Smart playlists** (desktop): `Top 50 · Last 30 Days` and `Favourited, Not Downloaded` auto-cards.
- **Lyrics offset adjust** (mobile): ±100 ms per-track correction with reset.
- **Exportify CSV import** (mobile Settings) and quota/LRU eviction for the offline vault.

### Fixed
- **Mobile played silently** (P36): CORS-tainted WebAudio graph — the audio relay now reflects the app origin and mobile loads media with `crossOrigin="anonymous"`.
- **Room chat tab showed nothing** (P41): a missing `</div>` nested the chat view inside a hidden panel.
- **Guest could never rejoin after a host closed a room** (D5): the guest pump now ends on the server's `bye` and reverts mode before the UI reacts.
- **Guests couldn't play tracks missing from their device**: catalog fallback via `resolve_song` instead of stalling.
- **Jam joins survive dead addresses both ways** (D6): verified live emulator-host→desktop-guest (518 ms) and the reverse (524 ms).
- Home mix rows show every track (was: one card per shelf).
- Android launcher icon is the TRANCE MUSIC mark, edge-to-edge on black.
- Desktop Now Playing metadata card is transparent (blur removed); eyebrow/quality chrome removed.
- Search box double border; search failure shows one classified line instead of a URL dump; junk catalog rows dropped on album pages.
- Desktop widget: corners, transport centering, volume slider; Spotify sign-in persists (keyring feature was missing).
- Debug APK under 50 MiB (dev-profile strip + legacy jniLibs packaging).

### Changed
- Brand is **OPEN MUSIC** across both surfaces (user-facing strings only; data-format ids intentionally unchanged to protect backups and saved logins).
- Now Playing (mobile) shows clean full-bleed artwork; miniplayer truncates long titles.
- Download size: Windows installers ~4.85 MiB (release profile: LTO, `opt-level="s"`, stripped).

### CI/CD
- Tag-driven release pipeline builds Windows (MSI+NSIS) and Linux (deb+AppImage), verifies updater-manifest URLs, and publishes the GitHub release with assets.
- macOS and iOS workflows removed from the release and test matrices.

## [0.4.0] — 2026-10-05

- Cross-platform pipelines (Windows, Linux, macOS, iOS, Android).
- UI: cleaner Now Playing lyrics, redesigned desktop mini-widget, unified hover states, mobile header/settings polish.
- Full detail in git history (`CHANGELOG.md` at tag `v0.4.0`).

## [0.3.0] — 2026-10-0x

First mobile-capable release: mobile shell (13 screens), Android APK + iOS CI workflow, vault relocation with legacy migration, SQLite download ledger, cache budget controls, backup/CSV/M3U export, Caps Lock Hyper shortcuts, system tray, widget pinning, fuzzy search, network status machine, CSP hardening.

## [0.1.0] — 2026-09-30

First packaged release: signed MSI + NSIS installers, Settings (profile, autostart, language/region), desktop widget, notifications, track-credits dialog, honest-UI cleanup pass (decorative telemetry removed). A `V0.2.0` tag exists in git but never had a changelog section.
