// sharecode.js — the TRANCE-SHARE v1 playlist codec. DOM-free by design so
// `node --test` can import it directly: a playlist becomes a compact JSON
// envelope, base64url-encoded after a TRANCE-SHARE: prefix. Full track
// objects ride along, so an import plays, queues and downloads like local.
const PREFIX = "TRANCE-SHARE:";
const VERSION = 1;

export function sharePrefix() {
  return PREFIX;
}

function b64urlEncode(s) {
  const b64 = btoa(unescape(encodeURIComponent(s)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  let b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return decodeURIComponent(escape(atob(b64)));
}

export function slimTrack(t) {
  if (!t) return null;
  return {
    id: t.id || "",
    title: t.title || "",
    artist: t.artist || t.subtitle || "",
    album: t.album || "",
    image: t.image || "",
    duration: t.duration || "",
    duration_secs: t.duration_secs || 0,
    page_url: t.page_url || "",
    album_id: t.album_id || "",
    artist_ids: t.artist_ids || [],
  };
}

export function encodePlaylist(pl) {
  if (!pl) return "";
  const tracks = (Array.isArray(pl.tracks) ? pl.tracks : []).map(slimTrack).filter((t) => t && t.id);
  if (!tracks.length) return "";
  const env = { v: VERSION, name: pl.title || pl.name || "Shared mix", tracks };
  return PREFIX + b64urlEncode(JSON.stringify(env));
}

export function decodeShared(text) {
  try {
    const s = String(text || "").trim();
    const i = s.indexOf(PREFIX);
    if (i < 0) return null;
    const env = JSON.parse(b64urlDecode(s.slice(i + PREFIX.length).trim().split(/\s/)[0]));
    if (!env || env.v !== VERSION || !Array.isArray(env.tracks) || !env.tracks.length) return null;
    const tracks = env.tracks.filter((t) => t && t.id).slice(0, 500);
    if (!tracks.length) return null;
    return { name: String(env.name || "Shared mix").slice(0, 80), tracks };
  } catch {
    return null;
  }
}
