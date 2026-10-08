# vendor/

Third-party files committed verbatim — this frontend has no bundler, so
JS/CSS are served as-is (`AGENTS.md` project facts).

## jsQR.cjs

- **Source:** <https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js>
  (fetched 2026-10-08, unmodified webpack UMD dist; SHA of the npm tarball
  content is whatever jsdelivr served that day — re-fetch against the pinned
  version `jsqr@1.4.0` if provenance ever matters).
- **Project:** <https://github.com/cozmo/jsQR>
- **License:** Apache-2.0 — full text in `jsQR.LICENSE.txt` (the dist file
  itself carries no header; that is why the LICENSE ships beside it).
- **Named `.cjs` on purpose:** `app/package.json` has `"type": "module"`, so
  a `.js` file would be parsed as ESM in node and the UMD wrapper would break
  (no `module`, `this` undefined at module scope). `.cjs` is always CommonJS
  in node → `import jsQR from "./vendor/jsQR.cjs"` interops for the decode
  round-trip unit test, while browsers load it via a classic `<script>` tag
  (extension irrelevant) and get `window.jsQR`.
- **Why it exists:** `BarcodeDetector` is non-functional in the Tauri Android
  WebView — it advertises `qr_code` but `detect()` returns empty on every
  input shape (spike record: `docs/mobile/09-problems-solutions.md` **P38**,
  design decision: `docs/jam-upgrade.md` §4.1).
- **Not an npm dependency:** `package.json` is untouched; this file is the
  entire integration surface (§4.2 AC "no new npm dependency").
