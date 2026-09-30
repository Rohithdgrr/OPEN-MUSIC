# TRANCE MUSIC

A desktop music player for Windows, built on [Tauri 2](https://tauri.app) with a
Rust core and a no-build-step vanilla-JS front end. It streams from JioSaavn,
keeps an offline vault on disk, and plays back through a local byte-range relay
so the WebView never talks to a third-party CDN directly.

> **Status: active development.** Not packaged or signed yet — `bundle.active`
> is `false` in `tauri.conf.json`, so there is no installer. Run it from source.

---

## Contents

- [Requirements](#requirements)
- [Running it](#running-it)
- [Tests](#tests)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [How streaming actually works](#how-streaming-actually-works)
- [Known limitations](#known-limitations)
- [License](#license)

---

## Requirements

| Tool | Version | Notes |
| --- | --- | --- |
| Rust | **1.77+** | `rust-version` in `Cargo.toml`. Verified on 1.98.1. |
| Node.js | **18+** | Only used to invoke the Tauri CLI. |
| MSVC build tools | — | Windows: `x86_64-pc-windows-msvc` toolchain + WebView2 runtime (preinstalled on Win 10/11). |

The app is Windows-first. The Rust side is written to keep compiling on other
targets, but there is no macOS/Linux packaging configured and it has not been
tested there.

## Running it

```bash
cd app
npm install
npm run tauri dev      # hot-reloading dev window
npm run tauri build    # release binary -> app/src-tauri/target/release/
```

There is no separate frontend build. `tauri.conf.json` points `frontendDist`
straight at `app/src`, and `index.html` loads `main.js` as an ES module. Edit
the HTML/JS/CSS and reload the window.

> Tailwind and the icon font are loaded from a **CDN at runtime**. The app needs
> network access on first paint; `styles.css` re-declares the critical
> utilities in plain CSS so the layout survives if the CDN is unreachable, but
> it will not look identical.

## Tests

```bash
cd app/src-tauri
cargo test              # 62 unit tests, no network required
cargo check             # fast type/borrow check
```

The Rust suite is the only automated coverage in the repo — it covers JSON
parsing, DES-ECB media-url decryption, quality selection, range qualification,
the proxy's byte handling, and the lyrics source order.

**The front end has no automated tests.** `main.js` is ~3,900 lines of
imperative DOM wiring with no test runner in `package.json`; UI changes have
been verified by running the app. See [Known limitations](#known-limitations).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ WebView (app/src)                                          │
│   index.html  — 8 views, one <audio> element, Tailwind CDN  │
│   main.js     — all state, DOM wiring, IPC calls            │
│   styles.css  — vanilla fallback layer + dialog backdrop     │
└────────────────────────────┬───────────────────────────────┘
                             │ Tauri IPC (invoke)
┌────────────────────────────▼───────────────────────────────┐
│ Rust core (app/src-tauri/src)                               │
│                                                             │
│  lib.rs      — command surface + window/proxy lifecycle     │
│  official.rs — JioSaavn first-party adapter (primary)       │
│  jiosaavn.rs — community mirrors (fallback) + parsing       │
│  proxy.rs    — axum range relay on 127.0.0.1 + offline vault│
│  lyrics.rs   — LRCLIB, then JioSaavn, then LRCLIB search    │
└─────────────────────────────────────────────────────────────┘
```

**One rule the modules enforce on themselves:** nothing but `proxy.rs` knows
about HTTP servers, and nothing but `official.rs`/`jiosaavn.rs` knows about
catalog endpoints. Each file states this in its module doc comment.

**19 Tauri commands** connect the two halves: `search_songs`,
`search_entities`, `search_suggestions`, `recommend_songs`, `resolve_song`,
`qualify_url`, `proxy_base`, `home_feed`, `playlist_tracks`, `album_tracks`,
`artist_tracks`, `artist_overview`, `get_lyrics`, `download_song`,
`list_downloads`, `remove_download`, `reveal_download`, `reveal_vault`.

### The eight views

`home` · `search` · `downloads` · `now-playing` · `playlists` · `library` ·
`history` · `detail` (album / artist / playlist screens)

## Repository layout

```
.
├── app/                    ← the application (this is the product)
│   ├── src/                front end: index.html, main.js, styles.css
│   └── src-tauri/          Rust core: src/*.rs, Cargo.toml, tauri.conf.json
├── docs/                   product + architecture documentation
│   ├── architecture.md     ← read this first
│   ├── PRD.md
│   ├── ui.md
│   ├── wireframes.md
│   ├── task.md
│   └── unlimited-streaming.md
├── design/                 Stitch design exports (tracked)
│   ├── screens/            per-screen DESIGN.md + code.html + screen.png
│   └── reference/          static HTML reference snapshots
├── archives/               original .zip downloads (git-ignored)
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE
└── README.md
```

`docs/architecture.md` is the reference for the streaming design, the two-client
rule, and the ephemeral proxy port. The Rust source cites it by section.

## How streaming actually works

This is the part that is not obvious, so it is worth stating plainly:

1. **Catalog.** `official.rs` calls `www.jiosaavn.com/api.php` — the same API
   JioSaavn's own web player uses, so there is no community rate limit and real
   pagination. Five community mirrors are tried in order if it fails
   (`jiosaavn.rs`).

2. **Media URLs arrive encrypted.** `encrypted_media_url` is base64 over
   DES-ECB with a fixed 8-byte key. Decrypting yields the CDN path of the
   **96 kbps** rendition; the other four qualities are derived by suffix swap.
   So every track resolves to a complete file, not a preview.

3. **Playback goes through a local relay.** `proxy.rs` binds an ephemeral port
   on `127.0.0.1` *before the window loads* — no hardcoded port, no collision,
   no startup race — and forwards `Range` headers verbatim. The WebView
   therefore only ever fetches from localhost, and upstream status codes
   (including failures) are relayed unchanged. The relay is a pass-through, not
   a policy engine.

4. **The honesty badge is earned, not decorative.** `qualify_url` runs a
   three-probe range qualification before playback is promised, which is what
   lets the UI claim bit-perfect delivery.

5. **Offline vault.** `download_song` writes into
   `~/Downloads/TRANCE MUSIC`; the Downloads view lists, plays, reveals and
   deletes from there.

## Known limitations

- **No front-end tests.** See [Tests](#tests). This is the biggest gap.
- **CDN dependency at runtime** for Tailwind and the Material icon font.
- **No installer or code signing.** `bundle.active` is `false`.
- **Not a "bit-perfect" claim in the strict audiophile sense.** The badge means
  the range probe passed; it is not a measurement of the output device.
- **The radio / endless-playback backend (`recommend_songs`) is not wired to the
  UI.** The Rust side exists and is tested, but nothing in `main.js` calls it
  yet. Tracked in [CHANGELOG.md](CHANGELOG.md).
- **Not verified on macOS or Linux.** The code keeps compiling (target-gated
  dependencies), but there is no packaging for those platforms.
- Some sections of the UI are still Stitch placeholders (telemetry counts,
  "master stream" copy) rather than live data.

## License

[MIT](LICENSE) — see the file. If you intend a different license, change it
before publishing; the copyright line is a placeholder.
