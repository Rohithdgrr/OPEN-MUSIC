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
- **Loaded via classic `<script>`** (`<script src="../vendor/jsQR.js">` in
  `mobile/index.html`) → exposes `window.jsQR`. It is **not** imported as a
  module: `app/package.json` has `"type": "module"`, so node would parse a
  `.js` file as ESM and the UMD wrapper breaks (no `module`, `this` undefined
  at module scope). The decode round-trip unit test therefore loads the file
  by reading its text and evaluating it through a `Function("module",
  "exports", …)` wrapper — plain CommonJS scope, `module.exports` path taken,
  no package-type ambiguity and no MIME guessing in the browser.
- **Why it exists:** `BarcodeDetector` is non-functional in the Tauri Android
  WebView — it advertises `qr_code` but `detect()` returns empty on every
  input shape (spike record: `docs/mobile/09-problems-solutions.md` **P38**,
  design decision: `docs/jam-upgrade.md` §4.1).
- **Not an npm dependency:** `package.json` is untouched; this file is the
  entire integration surface (§4.2 AC "no new npm dependency").
