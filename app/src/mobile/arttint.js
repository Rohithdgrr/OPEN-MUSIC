// arttint.js — the Now Playing background follows the artwork (light theme).
//
// The artwork is served by the app's own relay (same-origin
// `http://127.0.0.1:<port>/art`), so the canvas is never tainted and the
// pixels can be read back. The colour maths is pure so it can be tested
// without a canvas (2026-11-13).

/// Average the sampled pixels, preferring the ones that carry colour: a cover
/// that is mostly grey would tint the whole page grey, which reads as
/// "broken" rather than "themed". When NO pixel carries colour (a dark or
/// grey cover), the overall average is used instead — the page should still
/// follow the artwork. Returns null only when there is nothing to sample.
export function tintFromPixels(data, { satMin = 0.12, satBoost = 1.25 } = {}) {
  if (!data || data.length < 4) return null;
  let r = 0, g = 0, b = 0, n = 0;
  let ar = 0, ag = 0, ab = 0, an = 0;
  // Skip every other pixel: the art is sampled at a small size anyway.
  for (let i = 0; i < data.length; i += 8) {
    const pr = data[i], pg = data[i + 1], pb = data[i + 2];
    if (data[i + 3] < 8) continue; // transparent
    ar += pr; ag += pg; ab += pb; an += 1;
    const max = Math.max(pr, pg, pb);
    const min = Math.min(pr, pg, pb);
    const sat = max === 0 ? 0 : (max - min) / max;
    if (max < 24 || sat < satMin) continue; // near-black or near-grey
    r += pr; g += pg; b += pb; n += 1;
  }
  if (!n) {
    // No colourful pixel: fall back to the cover's overall tone, unless the
    // cover is essentially black (the brand mark) — that has no colour to
    // follow and would only grey the page out.
    if (!an) return null;
    r = Math.round(ar / an); g = Math.round(ag / an); b = Math.round(ab / an);
    if (Math.max(r, g, b) < 20) return null;
  } else {
    r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
  }
  // Push the saturation up a little: the average of a cover is muted, and
  // the page tint should read as the album's colour, not as its fog.
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const lum = (max + min) / 2;
  const sat = max === min ? 0 : (max - min) / (255 - Math.abs(255 - 2 * lum) || 1);
  const boost = 1 + (satBoost - 1) * sat;
  const mix = (c) => Math.round(Math.max(0, Math.min(255, lum + (c - lum) * boost)));
  return { r: mix(r), g: mix(g), b: mix(b) };
}

/// The page tint: the album colour over the light surface, soft enough to
/// keep the text readable.
export function tintCss(rgb, alpha = 0.16) {
  if (!rgb) return "";
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

/// Sample the artwork and hand the colour to `onColor`.
///
/// The artwork is served by the app's relay, which is a **different origin**
/// than the page (`http://tauri.localhost` vs `http://127.0.0.1:<port>`), so
/// drawing the `<img>` taints the canvas and `getImageData` throws a
/// SecurityError. The bytes are therefore **fetched** instead — the relay
/// answers `access-control-allow-origin` for the app origin — and a blob is
/// same-origin, so the canvas stays readable (2026-11-13).
///
/// Any failure (no canvas, a refused fetch, a broken image) reports nothing
/// and leaves the page on its plain background.
export function applyArtTint(img, onColor, { size = 24, alpha = 0.16 } = {}) {
  if (!img || typeof onColor !== "function") return;
  const sample = async () => {
    try {
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) return;
      const url = img.currentSrc || img.src;
      if (!url) return;
      const res = await fetch(url);
      if (!res.ok) return;
      const bitmap = await createImageBitmap(await res.blob());
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = Math.max(1, Math.round((size * bitmap.height) / bitmap.width));
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const rgb = tintFromPixels(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
      if (rgb) onColor(tintCss(rgb, alpha), rgb);
    } catch (e) {
      // A tainted canvas or a refused fetch: no tint, no crash.
    }
  };
  if (img.complete && img.naturalWidth) sample();
  else img.addEventListener("load", () => sample(), { once: true });
}
