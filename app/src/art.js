// art.js — artwork URL helpers and painting
// Split from main.js (Phase 4 M1).
import { esc } from "./core.js";

// --------------------------------------------------------------- artwork ---
// The API only ships 150px thumbs (`…-150x150.jpg`, often over plain http),
// which smear as soon as a card renders them at 300px+. Ask the same CDN for
// the 500px master instead — the size token lives in the filename.
export const ART_RENDS = [
  ["-50x50x100", "-500x500"],
  ["-150x150x100", "-500x500"],
  ["-50x50", "-500x500"],
  ["-150x150", "-500x500"],
  ["50x50", "500x500"],
  ["150x150", "500x500"],
];

export function hqArt(url, target = "500x500") {
  if (typeof url !== "string" || !url) return "";
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
  let out = url;
  if (host === "saavncdn.com" || host.endsWith(".saavncdn.com")) {
    for (const [small, big] of ART_RENDS) out = out.split(small).join(big);
    if (target !== "500x500") out = out.split("500x500").join(target);
    out = out.startsWith("http://") ? "https://" + out.slice(7) : out;
  }
  return proxied(out);
}

// L3: route images through the relay's /art cache (RAM -> disk -> upstream),
// so a cover is downloaded once no matter how many views render it. Before
// boot has fetched `proxy_base` the direct CDN url is used instead.
function proxied(url) {
  const base = window.__tmBase;
  if (!base || !url) return url;
  return `${base}/art?u=${encodeURIComponent(url)}`;
}

/// The platform logo — a local file, so it paints with no network at all.
/// Every artwork ladder that runs out of rungs ends here.
export const LOGO = "logo.png";

// `src` + provenance + error hook for every <img> written into a template.
// The original URL is kept so a missing master can fall back instead of
// blanking the card. No URL at all goes straight to the platform logo.
export function art(url) {
  const raw = typeof url === "string" ? url : "";
  if (!raw) return `src="${LOGO}"`;
  return `src="${esc(hqArt(raw))}" data-art-orig="${esc(raw)}" onerror="window.artFail(this)"`;
}

// Programmatic counterpart for the hero, player covers and detail headers.
export function paintArt(img, url, target) {
  if (!img || !url) return;
  img.setAttribute("data-art-orig", url);
  img.removeAttribute("data-art-step");
  img.classList.remove("hidden");
  img.style.display = "";
  img.onerror = () => window.artFail(img);
  img.src = hqArt(url, target);
}

/// The fallback ladder for one image: the URL as painted, the raw original,
/// then the smaller size tokens. Deduped — a non-CDN URL (artist defaults,
/// for instance) has one form only, so it fails over straight to the logo.
/// A relayed URL is unwrapped first so the rungs stay one hop from the CDN.
function artSteps(raw) {
  let orig = raw || "";
  const base = window.__tmBase;
  if (base && orig.startsWith(`${base}/art?u=`)) {
    try {
      orig = new URL(orig).searchParams.get("u") || orig;
    } catch {}
  }
  if (!orig) return [];
  const list = [];
  // SaavnCDN tops out at exactly 500x500 — the 1000/1500 variants all 404
  // (verified) — so the ladder starts there; a doomed 1500 rung only added
  // a failed round-trip before the 500 master could paint.
  for (const step of ["500x500", null, "150x150", "50x50"]) {
    const u = step ? hqArt(orig, step) : proxied(orig);
    if (u && !list.includes(u)) list.push(u);
  }
  return list;
}

// Walks the ladder one rung per failure; when every rung is spent the
// platform logo takes over — a local file, so the card never blanks even
// fully offline. Returns true once the image has landed (logo or artwork).
window.artFail = function (img) {
  const steps = artSteps(img.getAttribute("data-art-orig") || "");
  let idx = Number(img.getAttribute("data-art-step") || "0");
  while (idx < steps.length) {
    const next = steps[idx++];
    img.setAttribute("data-art-step", String(idx));
    if (img.getAttribute("src") !== next) {
      img.setAttribute("src", next);
      return false;
    }
  }
  img.setAttribute("src", LOGO);
  img.classList.remove("hidden");
  return true;
};

// Inline `onerror` only runs when the CSP allows it, so the same hook is
// wired here too: `error` does not bubble, but it is seen in the capture
// phase. Only stamped artwork is touched — anything else (local chrome art)
// keeps the browser's default handling.
document.addEventListener(
  "error",
  (e) => {
    const img = e.target;
    if (img && img.tagName === "IMG" && img.hasAttribute("data-art-orig")) window.artFail(img);
  },
  true,
);

// ------------------------------------------------------ Now Playing cover -
// The stage renders ~542 CSS px (max-w-[1180px], lg:col-span-6) and up to
// ~2x that on HiDPI, but Saavn's CDN tops out at exactly 500x500 — drawing
// the raw master straight into a bigger box is bilinear mush, i.e. the
// blur. So the 500px source is redrawn to the stage's real device-pixel
// size with high-quality smoothing and an unsharp pass, then swapped in as
// a blob (instant plain paint first, upgrade when ready).
const SHARP_MAX = 1024;

function unsharp(ctx, w, h, amount) {
  const frame = ctx.getImageData(0, 0, w, h);
  const d = frame.data;
  const out = new Uint8ClampedArray(d);
  const row = w * 4;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * row + x * 4;
      for (let c = 0; c < 3; c++) {
        const p = d[i + c];
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const r = i + dy * row + c;
          sum += d[r - 4] + d[r] + d[r + 4];
        }
        out[i + c] = p + amount * (p - sum / 9);
      }
    }
  }
  frame.data.set(out);
  ctx.putImageData(frame, 0, 0);
}

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = src;
  });
}

async function sharpCoverUrl(raw, el) {
  const im = await loadImg(hqArt(raw, "500x500"));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const css = el?.clientWidth || 542;
  const size = Math.min(SHARP_MAX, Math.max(500, Math.round(css * dpr)));
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(im, 0, 0, size, size);
  if (size > 500) unsharp(ctx, size, size, 0.45);
  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.92));
  if (!blob) throw new Error("cover encode failed");
  return URL.createObjectURL(blob);
}

/// Paint `raw` into an <img> with the sharp pipeline above. Same contract
/// as paintArt (data-art-orig + artFail ladder on failure), so a CORS
/// block, a taint or an encode failure simply degrades to the plain URL.
export function paintSharpCover(img, raw) {
  if (!img) return;
  img.removeAttribute("data-art-step");
  img.classList.remove("hidden");
  img.style.display = "";
  if (img._sharpBlob) {
    URL.revokeObjectURL(img._sharpBlob);
    img._sharpBlob = null;
  }
  if (!raw) {
    img.setAttribute("src", LOGO);
    return;
  }
  img.setAttribute("data-art-orig", raw);
  img.onerror = () => {
    window.artFail(img);
  };
  const best = hqArt(raw, "500x500");
  img.src = best;
  sharpCoverUrl(raw, img)
    .then((url) => {
      // Swap only if this request is still the current paint.
      if (img.getAttribute("data-art-orig") !== raw || img.getAttribute("src") !== best) {
        URL.revokeObjectURL(url);
        return;
      }
      img._sharpBlob = url;
      img.src = url;
    })
    .catch(() => {});
}

