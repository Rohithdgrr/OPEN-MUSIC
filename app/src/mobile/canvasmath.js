// canvasmath.js — pure Canvas format policy (no imports, mobile-boot-safe).
//
// docs/spotify-android-canvas.md §17: the official Apple cut is cropped to the
// Spotify-Canvas shape (9:16, at least 720×1280) and played as a 6 s window
// with a 0.6 s crossfade. This module is the single source of truth for both
// numbers, so Rust's rendition picker and the WebView renderer cannot drift.

export const LOOP_SECONDS = 6;
export const LOOP_FADE = 0.6;
export const CANVAS_MIN_W = 720;
export const CANVAS_MIN_H = 1280;

/// Largest centred 9:16 box inside a source. 1078×1438 → 808×1438;
/// 830×1106 → 622×1106; 768×768 → 432×768; 1920×1080 → 607×1080.
export function cropBox(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  let cw;
  let ch;
  if (w * 16 >= h * 9) {
    cw = Math.floor((h * 9) / 16);
    ch = h;
  } else {
    cw = w;
    ch = Math.floor((w * 16) / 9);
  }
  return {
    x: Math.floor((w - cw) / 2),
    y: Math.floor((h - ch) / 2),
    w: cw,
    h: ch,
  };
}

export function meetsCanvasFloor(width, height) {
  const box = cropBox(width, height);
  return box.w >= CANVAS_MIN_W && box.h >= CANVAS_MIN_H;
}

/// The 6 s window plus its 0.6 s pre-roll and 0.6 s tail. A source shorter
/// than 7.2 s cannot host the crossfade; it loops whole with a hard cut. The
/// renderer only uses this for real Apple cuts (20–30 s), but the policy is
/// total so a short file can never produce a negative pre-roll.
///
/// `base` is the first frame the media element can actually present. It is not
/// always 0: Apple's Canvas fMP4 carries a ~10 s edit-list offset, so a seek to
/// 0 lands in an empty edit and the first `playing` frame is at ~10.03 s. With
/// a fixed 0.6 s plan that frame is already past the window end and the two
/// videos crossfade forever (the 2026-10-23 live probe caught exactly that).
/// The renderer feeds the observed first-playable time in; `base` is additive
/// and the default 0 keeps every normal file on the original contract.
export function loopPlan(duration, base = 0) {
  const d = Number(duration);
  const b = Number(base);
  const anchor = Number.isFinite(b) && b > 0 ? b : 0;
  const end = Number.isFinite(d) && d > 0 ? d : anchor + LOOP_SECONDS + 2 * LOOP_FADE;
  const usable = Math.max(0, end - anchor);
  if (usable >= LOOP_SECONDS + 2 * LOOP_FADE) {
    return { start: anchor + LOOP_FADE, seconds: LOOP_SECONDS, fade: LOOP_FADE, base: anchor };
  }
  return {
    start: anchor,
    seconds: Math.max(1, Math.min(LOOP_SECONDS, usable)),
    fade: 0,
    base: anchor,
  };
}
