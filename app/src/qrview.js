// qrview.js — paint the Rust-encoded room QR symbol onto a canvas.
//
// The matrix comes from the `qr_symbol` command in app/src-tauri/src/qr.rs,
// which is covered by cargo test (including a decode round-trip). This file
// only rasterises it, so there is exactly one QR implementation in the app and
// no chance of the drawing disagreeing with what Rust encoded.
//
// core.js is resolved LAZILY (only on the desktop fallback below): a
// top-level `import … from "./core.js"` drags the whole desktop module graph
// (dom.js, library.js, settings.js, …) into the mobile shell, where dom.js's
// top-level `audio.volume` throws on a missing #audio and takes app.js down
// with it (seen on device 2026-10-07). The mobile shell passes its own
// invoke (shared.js) as `doInvoke`, so this path never runs on Android.

// The spec requires at least 4 modules of light margin on every side for a
// scanner to lock on. This is not decoration — dropping it is the single most
// common reason a "QR code" will not scan.
const QUIET = 4;

// Draw `text` as a QR symbol. Returns the symbol descriptor, or throws.
export async function paintQr(canvas, text, doInvoke) {
  const symbol = doInvoke
    ? await doInvoke("qr_symbol", { text })
    : await (await import("./core.js")).invoke("qr_symbol", { text });
  if (!symbol?.size || !Array.isArray(symbol.modules)) {
    throw new Error("qr_symbol returned an unusable symbol");
  }

  const total = symbol.size + QUIET * 2;

  // Render at device resolution so the module edges stay crisp on HiDPI
  // instead of being smeared by the browser's upscale.
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 3);
  const cssSize = canvas.clientWidth || 264;
  const px = Math.max(1, Math.round(cssSize * dpr));

  canvas.width = px;
  canvas.height = px;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");

  const cell = px / total;

  // Quiet zone: paint the whole plate white first, so the quiet zone is white
  // by construction rather than by whatever is behind the canvas.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, px, px);

  ctx.fillStyle = "#0a0a0a";
  for (let r = 0; r < symbol.size; r += 1) {
    for (let c = 0; c < symbol.size; c += 1) {
      if (!symbol.modules[r * symbol.size + c]) continue;
      // Round each cell to whole device pixels. Without this, fractional cell
      // sizes leave hairline seams between modules that hurt scan reliability.
      const x = Math.round((c + QUIET) * cell);
      const y = Math.round((r + QUIET) * cell);
      const w = Math.round((c + 1 + QUIET) * cell) - x;
      const h = Math.round((r + 1 + QUIET) * cell) - y;
      ctx.fillRect(x, y, w, h);
    }
  }

  return symbol;
}