// sharelink.js — the pure share/deep-link/vCard builders (docs/share-deep-links.md).
//
// Zero imports by design: mobile shells may import this statically from the
// src root only because the module graph stays dependency-free (the
// 2026-10-07 `#audio2` lesson). Every Tauri/browser side effect lives at
// the call sites (menus.js, app.js, main.js).

export const PLAY_PAGE = "https://rohithdgrr.github.io/OPEN-MUSIC/play.html";
export const SCHEME = "openmusic";

/// The canonical share URL, or null when there is no track id to point at.
export function playUrl({ id, title = "", artist = "" } = {}) {
  if (!id || typeof id !== "string") return null;
  const parts = [`t=${encodeURIComponent(id)}`];
  if (title) parts.push(`n=${encodeURIComponent(title)}`);
  if (artist) parts.push(`a=${encodeURIComponent(artist)}`);
  return `${PLAY_PAGE}?${parts.join("&")}`;
}

/// The app scheme form: openmusic://t/<id>
export function deepUri(id) {
  if (!id || typeof id !== "string") return "";
  return `${SCHEME}://t/${encodeURIComponent(id)}`;
}

/// Parse any of the share shapes into a play target.
/// Accepts: openmusic://t/<id>, https://…/play.html?t=<id>[&n=][&a=],
/// and Chrome intent: URLs (falls back to their S.browser_fallback_url).
/// Returns { id, title?, artist? } or null.
export function parseDeepUri(uri) {
  if (typeof uri !== "string" || !uri.trim()) return null;
  const raw = uri.trim();

  if (raw.toLowerCase().startsWith("intent:")) {
    const fb = /S\.browser_fallback_url=([^#;]+)/.exec(raw);
    if (fb) {
      let decoded = fb[1];
      try { decoded = decodeURIComponent(decoded); } catch { /* keep raw */ }
      const inner = parseDeepUri(decoded);
      if (inner) return inner;
    }
    // intent://t/<id>#Intent;scheme=openmusic;… — the data uri itself.
    const dataUri = /^intent:\/\/([^?#]*)/.exec(raw);
    if (dataUri && dataUri[1]) {
      const seg = dataUri[1].split("/").filter(Boolean);
      if (seg[0] === "t" && seg[1]) return { id: seg[1] };
    }
    return null;
  }

  if (raw.toLowerCase().startsWith(`${SCHEME}:`)) {
    const rest = raw.slice(`${SCHEME}:`.length).replace(/^\/+/, "");
    // Query/hints may ride along (am start / app links keep them verbatim) —
    // only the t/<id> segment is identity, ?n/&a/#… are display hints.
    const m = /^t\/([^/?#]+)/i.exec(rest);
    if (!m) return null;
    let id;
    try { id = decodeURIComponent(m[1]); } catch { id = m[1]; }
    const out = { id };
    const qi = raw.indexOf("?");
    const hi = raw.indexOf("#");
    const qEnd = qi !== -1 && hi > qi ? hi : undefined;
    if (qi !== -1) {
      const q = new URLSearchParams(raw.slice(qi + 1, qEnd));
      const n = q.get("n");
      const a = q.get("a");
      if (n) out.title = n;
      if (a) out.artist = a;
    }
    return out;
  }

  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!/\/play\.html$/i.test(url.pathname)) return null;
  const id = url.searchParams.get("t");
  if (!id) return null;
  const out = { id };
  const n = url.searchParams.get("n");
  const a = url.searchParams.get("a");
  if (n) out.title = n;
  if (a) out.artist = a;
  return out;
}

/// The small proven thumbnail: swap the 500x500 render for the CDN's own
/// <target> render — only for hosts the app already treats as art origins,
/// since only those may be fetched through the relay /art route.
export function smallArtUrl(url, target = "150x150") {
  if (typeof url !== "string" || !url || !target) return "";
  let host;
  try { host = new URL(url.includes("//") ? url : `https://${url}`).hostname.toLowerCase(); } catch { return ""; }
  const isSaavn = host === "saavncdn.com" || host.endsWith(".saavncdn.com");
  if (!isSaavn) return "";
  if (!url.includes("500x500")) return "";
  return url.split("500x500").join(target).replace(/^http:\/\//i, "https://");
}

// ---------------------------------------------------------------- vCard 3.0 --

/// RFC 2426 basic escaping for text values: backslash, ; , and newlines.
export function escapeVcardText(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n/g, "\\n")
    .replace(/\r|\n/g, "\\n");
}

/// Fold one logical line to ≤ width chars, continuations "CRLF SP".
/// ASCII-safe for base64; guards surrogate pairs in text values.
export function foldVcardLine(line, width = 75) {
  const s = String(line ?? "");
  if (s.length <= width) return s;
  const chunks = [];
  let i = 0;
  let first = true;
  while (i < s.length) {
    const budget = first ? width : width - 1; // every continuation pays 1 SP
    let end = Math.min(i + budget, s.length);
    if (end < s.length) {
      // never split inside a surrogate pair
      const code = s.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff && s.charCodeAt(end) >= 0xdc00 && s.charCodeAt(end) <= 0xdfff) end -= 1;
    }
    chunks.push((first ? "" : " ") + s.slice(i, end));
    first = false;
    i = end;
  }
  return chunks.join("\r\n");
}

/// Build the vCard 3.0 text. photoB64 is the relay-fetched artwork, plain
/// base64 (no data: prefix); when absent the card simply has no PHOTO.
export function vcf({ title = "", artist = "", url = "", photoB64 = "" } = {}) {
  const lines = ["BEGIN:VCARD", "VERSION:3.0"];
  lines.push(`N:;"${escapeVcardText(title || "Shared track")}";;;`);
  const base = [title, artist].filter(Boolean).join(" — ") || "Shared track";
  lines.push(`FN:${escapeVcardText(`${base} (OpenMusic)`)}`);
  lines.push("ORG:OpenMusic");
  if (url) lines.push(`URL:${escapeVcardText(url)}`);
  lines.push(
    `NOTE:${escapeVcardText(
      [
        "Tap the URL to play in OpenMusic.",
        "No app yet? The link offers the download.",
        `${title}${artist ? ` — ${artist}` : ""} (OpenMusic)`,
      ]
        .filter(Boolean)
        .join(" "),
    )}`,
  );
  const b64 = String(photoB64 ?? "").replace(/[^A-Za-z0-9+/=]/g, "");
  if (b64) lines.push(`PHOTO;TYPE=JPEG;ENCODING=BASE64:${b64}`);
  lines.push("END:VCARD");
  return lines.map((l) => foldVcardLine(l)).join("\r\n") + "\r\n";
}

/// Uint8Array → base64 in one string. The chunk step is a multiple of 3 so
/// padding only ever appears after the LAST chunk — mid-stream '=' padding is
/// treated as a terminator by atob/Buffer decoders and silently drops the
/// remainder (caught by tests).
export function bytesToB64(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return "";
  let out = "";
  const step = 0x6000; // 24576 = 3 × 8192
  for (let i = 0; i < bytes.length; i += step) {
    out += btoa(String.fromCharCode(...bytes.subarray(i, Math.min(i + step, bytes.length))));
  }
  return out;
}
