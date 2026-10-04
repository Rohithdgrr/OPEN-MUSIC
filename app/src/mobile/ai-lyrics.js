// ai-lyrics.js — Gemini fallback for songs the LRCLIB/JioSaavn cascade
// doesn't know. DOM-free by design (localStorage + injected fetch) so
// `node --test` can import it directly.
//
// The key is the user's own (Settings → paste from Google AI Studio) and
// lives only in localStorage — it is never synced, logged, or sent anywhere
// except Google's generateContent endpoint. Results are cached per track so
// a song costs one API call, ever. AI output is always labeled and may be
// inaccurate; it never overwrites real synced lyrics, it only fills the gap
// when the cascade returns nothing.
export const GEMINI_KEY = "tm-gemini-key";
export const AI_LYRICS_KEY = "tm-ai-lyrics";
const AI_MODEL = "gemini-2.0-flash";
const CACHE_CAP = 100;

export function getGeminiKey() {
  try {
    return (localStorage.getItem(GEMINI_KEY) || "").trim();
  } catch {
    return "";
  }
}

export function setGeminiKey(v) {
  try {
    localStorage.setItem(GEMINI_KEY, String(v || "").trim());
    return true;
  } catch {
    return false;
  }
}

export function hasGeminiKey() {
  return getGeminiKey().length > 0;
}

function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(AI_LYRICS_KEY) || "null");
    return c && typeof c === "object" ? c : {};
  } catch {
    return {};
  }
}

export function readAiCache(id) {
  if (!id) return "";
  try {
    const t = loadCache()[String(id)];
    return t && typeof t.text === "string" ? t.text : "";
  } catch {
    return "";
  }
}

function writeAiCache(id, text) {
  try {
    const c = loadCache();
    c[String(id)] = { text, ts: Date.now() };
    const keys = Object.keys(c);
    if (keys.length > CACHE_CAP) for (const k of keys.slice(0, keys.length - CACHE_CAP)) delete c[k];
    localStorage.setItem(AI_LYRICS_KEY, JSON.stringify(c));
  } catch {}
}

function promptFor(track) {
  const title = (track && track.title) || "this song";
  const artist = (track && (track.artist || track.subtitle)) || "unknown artist";
  const album = track && track.album ? ` from the album "${track.album}"` : "";
  return `Provide the complete song lyrics for "${title}" by ${artist}${album}. Output ONLY the lyrics, preserving line breaks. Do not add commentary, headers, numbering, or disclaimers. If you do not know this song, reply with exactly: UNKNOWN`;
}

function extractText(data) {
  try {
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return "";
    return parts
      .map((p) => (p && typeof p.text === "string" ? p.text : ""))
      .join("")
      .trim();
  } catch {
    return "";
  }
}

/// Returns { text, cached }. Throws with a human-readable message when the
/// key is missing, the song is unknown, or the API call fails. Pass a stub
/// fetchFn in tests; production uses the global fetch (CSP allowlists the
/// generativelanguage endpoint in tauri.android.conf.json).
export async function fetchAiLyrics(track, { fetchFn, model } = {}) {
  const key = getGeminiKey();
  if (!key) throw new Error("Add your Gemini API key in Settings → AI lyrics first");
  const id = track && track.id ? String(track.id) : "";
  if (id) {
    const hit = readAiCache(id);
    if (hit) return { text: hit, cached: true };
  }
  const run = fetchFn || fetch;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model || AI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  let res;
  try {
    res = await run(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: promptFor(track) }] }] }),
    });
  } catch {
    throw new Error("Couldn't reach Gemini — check your connection");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res || !res.ok) {
    const msg = data?.error?.message || `HTTP ${res ? res.status : "?"}`;
    if (res && (res.status === 400 || res.status === 403)) {
      throw new Error("Gemini rejected the key — check it in Settings");
    }
    throw new Error(`Gemini error: ${String(msg).slice(0, 120)}`);
  }
  const text = extractText(data);
  if (!text) throw new Error("Gemini returned empty lyrics");
  if (/^unknown\.?$/i.test(text)) throw new Error("Gemini doesn't know this song either");
  if (id) writeAiCache(id, text);
  return { text, cached: false };
}

export function aiCopyright() {
  return "AI-generated with Gemini — may be inaccurate";
}
