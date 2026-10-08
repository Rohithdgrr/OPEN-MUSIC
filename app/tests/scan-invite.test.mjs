// scan-invite.test.mjs — B-T2 scan-to-join, browser-free half
// (docs/jam-upgrade.md §4.2).
//
// Two things are proven here, both in plain `npm test`:
//   1. extractInviteFromScan is canonical-only — a scanned invite parses to
//      Rust's view { addr, code }, everything else is null (so the scanner
//      never dials a foreign QR).
//   2. The decoder and the app's ONE QR encoder agree: the fixture matrix is
//      live output of the Rust `qr_symbol` command (app/src-tauri/src/qr.rs,
//      generated via CDP — see the fixture's `source` field), rasterised the
//      way qrview.js paints it (quiet zone 4), decoded by the vendored jsQR,
//      byte-compared, then pushed through extractInviteFromScan. If the
//      invite format ever changes, the last assertion fails and forces a
//      fixture regen (the fixture note says how).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractInviteFromScan } from "../src/mobile/scanner.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..", "src");

// jsQR ships as a UMD classic script (window.jsQR in the app). package.json
// says "type": "module", so node would parse the file as ESM and the UMD
// wrapper breaks — evaluate the text in a plain function scope instead,
// which takes the CommonJS branch. (Why the browser side is a classic
// <script>: src/vendor/README.md.)
function loadJsQR() {
  const file = path.join(src, "vendor", "jsQR.js");
  const mod = { exports: {} };
  new Function("module", "exports", fs.readFileSync(file, "utf8"))(mod, mod.exports);
  const fn = typeof mod.exports === "function" ? mod.exports : mod.exports.default;
  assert.equal(typeof fn, "function", "jsQR did not evaluate to a decoder");
  return fn;
}
const jsQR = loadJsQR();

const fixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "invite-qr.json"), "utf8"));

/// Rasterise a qr_symbol matrix exactly like qrview.js paints it: light
/// background, dark modules, QUIET = 4 modules of margin, `scale` px/module.
function rasterize(matrix, size, quiet = 4, scale = 8) {
  const dim = (size + quiet * 2) * scale;
  const rgba = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!matrix[y * size + x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        const py = (y + quiet) * scale + dy;
        for (let dx = 0; dx < scale; dx++) {
          const i = ((py * dim) + (x + quiet) * scale + dx) * 4;
          rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
        }
      }
    }
  }
  return { data: rgba, width: dim, height: dim };
}

test("extractInviteFromScan: canonical invite parses to Rust's view", () => {
  const parsed = extractInviteFromScan(
    "  trancemusic://join?host=192.168.1.5&port=8787&code=ABCD2345 \n",
  );
  assert.deepEqual(parsed, { addr: "192.168.1.5:8787", code: "ABCD2345" });
});

test("extractInviteFromScan: canonical-only — everything else is null", () => {
  // A scanned legacy line is NOT accepted: our QR surfaces only ever encode
  // the canonical link (A), so anything else is a foreign code.
  assert.equal(extractInviteFromScan("ws://192.168.1.5:8787 · ABCD2345"), null);
  assert.equal(extractInviteFromScan("192.168.1.5:8787 ABCD2345"), null);
  assert.equal(extractInviteFromScan("https://example.com/whatever"), null);
  assert.equal(extractInviteFromScan("hello"), null);
  assert.equal(extractInviteFromScan(""), null);
  assert.equal(extractInviteFromScan("   \n"), null);
  assert.equal(extractInviteFromScan(null), null);
  assert.equal(extractInviteFromScan(undefined), null);
  // Well-formed link, bad room code — still not joinable.
  assert.equal(extractInviteFromScan("trancemusic://join?host=1.2.3.4&port=8787&code=AB"), null);
  // Well-formed link, non-numeric port.
  assert.equal(extractInviteFromScan("trancemusic://join?host=1.2.3.4&port=abc&code=ABCD2345"), null);
});

test("decode round-trip: jsQR reads the Rust qr_symbol fixture byte-identically", () => {
  assert.ok(fixture.size >= 21, "fixture has no matrix");
  assert.equal(fixture.modules.length, fixture.size * fixture.size, "fixture matrix is not square-flat");
  const { data, width, height } = rasterize(fixture.modules, fixture.size);
  const hit = jsQR(data, width, height);
  assert.ok(hit, "jsQR found no code in the fixture raster — decoder/encoder disagreement");
  assert.equal(hit.data, fixture.payload, "decoded bytes differ from the canonical invite");
});

test("decode round-trip payload survives extractInviteFromScan (format staleness guard)", () => {
  const parsed = extractInviteFromScan(fixture.payload);
  assert.deepEqual(
    parsed,
    { addr: "192.168.1.5:8787", code: "ABCD2345" },
    "invite format changed — regenerate app/tests/fixtures/invite-qr.json " +
      "(the fixture's `source` field documents how)",
  );
});
