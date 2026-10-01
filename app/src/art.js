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
  if (host !== "saavncdn.com" && !host.endsWith(".saavncdn.com")) return url;
  let out = url;
  for (const [small, big] of ART_RENDS) out = out.split(small).join(big);
  if (target !== "500x500") out = out.split("500x500").join(target);
  return out.startsWith("http://") ? "https://" + out.slice(7) : out;
}

// `src` + provenance + error hook for every <img> written into a template.
// The original URL is kept so a missing master can fall back instead of
// blanking the card.
export function art(url) {
  const raw = typeof url === "string" ? url : "";
  return `src="${esc(hqArt(raw))}" data-art-orig="${esc(raw)}" onerror="window.artFail(this)"`;
}

// Programmatic counterpart for the hero, player covers and detail headers.
export function paintArt(img, url, target) {
  if (!img || !url) return;
  img.setAttribute("data-art-orig", url);
  img.removeAttribute("data-art-tried");
  img.classList.remove("hidden");
  img.style.display = "";
  img.onerror = () => window.artFail(img);
  img.src = hqArt(url, target);
}

// Tries the original URL once; hides the image only when that fails too.
// Returns true once the image is finished (hidden).
window.artFail = function (img) {
  const orig = img.getAttribute("data-art-orig");
  if (orig && img.getAttribute("src") !== orig && !img.hasAttribute("data-art-tried")) {
    img.setAttribute("data-art-tried", "");
    img.setAttribute("src", orig);
    return false;
  }
  img.classList.add("hidden");
  return true;
};

