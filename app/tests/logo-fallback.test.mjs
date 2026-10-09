// logo-fallback.test.mjs — fallback-artwork contract
// (docs/branding/trance-music-guide.md, "Fallback artwork contract").
//
// The platform logo is the default artwork: idle covers, artless tracks, and
// every exhausted thumbnail ladder end here. Since 2026-10-10 (contract v2)
// logo.png is no longer a byte copy of icon.png — it is the derived
// mark-only crop (dark tile keyed to alpha, square-padded, caption gone),
// and the shell CSS only backs it with black; the zoom is baked into the
// bytes. This gate pins the mobile half (the desktop half was reverted to
// HEAD 2026-10-09): identical bytes on both surfaces, a square crop that
// provably differs from the icon, the local boot default, and the backing
// rule without the old transform.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = path.join(root, "app", "src");
const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");

test("logo bytes: one mark-crop on both surfaces, provably not the icon", () => {
  const icon = fs.readFileSync(path.join(src, "..", "src-tauri", "icons", "icon.png"));
  const desk = fs.readFileSync(path.join(src, "logo.png"));
  const mob = fs.readFileSync(path.join(src, "mobile", "logo.png"));
  assert.ok(icon.length > 1000, "icon.png is a real file");
  assert.ok(desk.equals(mob), "app/src/logo.png and app/src/mobile/logo.png are byte-identical");
  assert.ok(!desk.equals(icon), "logo.png is the derived mark crop, not the icon tile");
  // PNG IHDR: width/height big-endian at offsets 16/20. The crop is square
  // and smaller than the 512 icon (tile + caption were keyed out).
  const w = desk.readUInt32BE(16);
  const h = desk.readUInt32BE(20);
  assert.equal(w, h, "crop canvas is square (object-cover tiles assume it)");
  assert.ok(w >= 256 && w < 512, `crop is zoomed mark-only (got ${w}x${h})`);
});

test("mobile now-playing art boots on the local logo", () => {
  const html = read(src, "mobile", "screens", "nowplaying.html");
  const np = html.match(/id="np-art"[^>]*src="([^"]*)"/);
  assert.ok(np, "#np-art exists");
  assert.equal(np[1], "logo.png", "mobile art boots on the local logo");
});

test("backing rule ships; the old zoom-crop transform does not", () => {
  const css = fs.readFileSync(path.join(src, "mobile", "index.html"), "utf8");
  assert.ok(css.includes('img[src$="logo.png"]'), "backs the logo with black");
  assert.ok(
    !css.includes("transform: scale(1.18)"),
    "no CSS zoom — the crop is baked into the bytes (contract v2)",
  );
});

test("mobile artwork ladder ends at LOGO", () => {
  const mob = read(src, "mobile", "shared.js");
  assert.ok(/export const LOGO = "logo\.png"/.test(mob), "mobile LOGO");
  assert.ok(/img\.setAttribute\("src", LOGO\)/.test(mob), "mobile artFail lands on LOGO");
});
