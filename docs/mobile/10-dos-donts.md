# 10 — Mobile Do's & Don'ts

## Do

- **Do** keep `version` in sync: `Cargo.toml` + `tauri.conf.json` + `package.json`
  (+ bump `api_version()` when IPC breaks).
- **Do** put desktop-only deps under
  `[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]`
  and desktop-only commands under `#[cfg(desktop)]` — with a mobile stub or an
  explicit mobile `Err`, never a silent no-op that looks like success
  (except `start_drag` / `unminimize`, which intentionally no-op).
- **Do** run the full verify before pushing mobile changes:
  `OP_OFFLINE=1 cargo test`, `cargo fmt --check`,
  `cargo clippy --all-targets -- -D warnings`, `npm run lint`, `npm test`,
  plus `node --check` on every `src/mobile/**/*.js` you touched.
- **Do** route mobile UI through the existing handlers/painters
  (`togglePlay`, `step`, `playQueueItem`, …) so bar / now-playing / notification
  can never disagree.
- **Do** keep entity/kebab taps **before** the row-play fallback in `app.js`
  delegation, and keep `esc()` on every interpolated string (attributes included).
- **Do** add new screens as `screens/<name>.html + <name>.js`, register the key
  in `router.js` `SCREENS` (+ `TAB_OF` if it belongs to a tab), and strip
  fragment-owned bottom navs (the shell injects the canonical one).
- **Do** respect safe-area insets (`pt-safe` / `pb-safe` + the `main.pt-*`
  compensation rule) and keep `loading="lazy"` / `decoding="async"` on art.
- **Do** update the mobile overlay CSP hash list when you add inline scripts —
  copy the exact `sha256-*` the WebView reports.
- **Do** log mobile entries in `docs/mobile/07-changelog.md` under Unreleased.

## Don't

- **Don't** import desktop shell modules (`app/src/*.js`) from mobile —
  mobile is a separate shell; share only `html.js`-style pure helpers.
- **Don't** add `eval` / `new Function` / remote `<script>` to mobile screens.
- **Don't** hand-edit `src-tauri/gen/android` (or the generated Xcode project) —
  fix configs, gates, and Rust `cfg()`s; regenerate with `tauri android/ios init`.
- **Don't** use hardcoded localhost ports — the relay binds an **ephemeral**
  `127.0.0.1:0` port before the window loads (`lib.rs:setup`) and the frontend
  reads it via `proxy_base`.
- **Don't** block the boot on update checks or network probes — fire-and-forget
  with daily cadence + failure tolerance (`app.js` bottom).
- **Don't** promise desktop concepts on mobile: updater installs, tray,
  global shortcuts, autostart writes, widget reparenting, Save/Open dialogs.
  Return the existing explicit mobile errors or route to the OS (settings /
  share sheet / store).
- **Don't** invent licence/terms copy — read it off `Cargo.lock` / registry
  manifests, and keep the "not legal advice / not reviewed by a lawyer" footer.
- **Don't** commit without checking `git status` — `gen/apple/build`,
  `target/`, `archives/`, and `.part` files must never be committed.
