// savelocal.js — "Save to local": put the song file in the device's own
// storage so other players see it. Distinct from "Download", which vaults
// into the app-private folder only OpenMusic can read.
//
// Pipeline: vault ledger first (already saved → instant) → downloadTrack for
// the rest (the existing progress pipeline) → hand the vaulted file's path
// + metadata to the Android bridge (TmBridge.saveLocal → MediaStore,
// Music/OpenMusic/). Pure pieces (file name, bridge result parser) are
// exported for tests; the wired entry point resolves shared.js lazily so
// importing this module never drags the mobile runtime graph into a test.

export const SAVED_DIR = "Music/OpenMusic";

let sharedPromise = null;
async function sharedMod() {
  sharedPromise ||= Promise.resolve(import("./shared.js"));
  return sharedPromise;
}

/// `Artist - Title.ext` — the MediaStore display name. Kotlin re-applies the
/// identical sanitizer as defense in depth, so dedupe compares the same final
/// string on both sides. Windows-hostile separators share the strip with
/// Android's (`\ / : * ? " < > |`), control chars → space.
export function localFileName({ title, artist, path } = {}) {
  const strip = /[\\/:*?"<>|]/g; // separators only — control chars strip below, rule-safe
  const t = typeof title === "string" ? title.trim() : "";
  const aFull = typeof artist === "string" ? artist.trim() : "";
  // Lead artist only: a six-way collaboration would otherwise mint a 100+
  // char "A, B, C, D, E, F - Title" stem (observed live, 2026-10-24).
  const a = aFull.split(",")[0].trim() || aFull;
  const raw = a ? (t ? `${a} - ${t}` : a) : t || "song";
  let ctrlClean = "";
  for (const ch of raw) ctrlClean += ch.charCodeAt(0) < 32 ? " " : ch;
  const stem = ctrlClean
    .replace(strip, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .replace(/[ -]+$/, "");
  const ext = /\.([a-z0-9]{2,5})$/i.exec(String(path || "")) || [];
  const use = (ext[1] || "").toLowerCase();
  return `${stem || "song"}.${use === "m4a" || use === "opus" ? use : "m4a"}`;
}

/// TmBridge.saveLocal returns a small line protocol: `ok <name>` /
/// `same <name>` (already on the device) / `err: …`.
export function bridgeResult(res) {
  const s = String(res || "").trim();
  if (s.startsWith("ok ")) return { status: "ok", name: s.slice(3).trim() };
  if (s.startsWith("same ")) return { status: "same", name: s.slice(5).trim() };
  if (s === "same") return { status: "same", name: "" };
  return { status: "err", message: s.replace(/^err:\s*/, "") || "unknown bridge response" };
}

export function saveLocalBridge() {
  try {
    return typeof window !== "undefined" && window.TMNative ? window.TMNative : null;
  } catch {
    return null;
  }
}

async function vaultEntryFor(id, doInvoke) {
  try {
    const r = await doInvoke("list_downloads");
    const hit = ((r && r.entries) || []).find((e) => e && String(e.id) === String(id));
    if (hit && hit.path) return hit;
  } catch {}
  return null;
}

/// One shot: make sure the bytes are in hand (vaulted or downloaded), find
/// the ledger entry, and hand the file to the native bridge. Resolves to
/// {status:"ok"|"same", name, dir} or throws with the user-facing message.
/// `deps` overrides everything for tests.
export async function saveTrackLocal(track, deps = {}) {
  const real = deps.invoke ? { invoke: deps.invoke, downloadTrack: deps.downloadTrack } : await sharedMod();
  const doInvoke = real.invoke;
  const download = real.downloadTrack;
  const bridge = deps.bridge || saveLocalBridge();

  if (!track || !track.id) throw new Error("Pick a track first");
  if (!bridge) throw new Error("Save to local needs the Android app");
  if (!doInvoke) throw new Error("Save needs the app backend");

  let entry = await vaultEntryFor(track.id, doInvoke);
  if (!entry) {
    const out = await download(track, null, false); // progress toasts ride along
    if (!out || !out.path) throw new Error("Download failed — check connection");
    entry = (await vaultEntryFor(track.id, doInvoke)) || {
      id: String(track.id),
      title: track.title || "",
      artist: track.artist || "",
      album: track.album || "",
      duration_secs: Number(track.duration_secs) || 0,
      path: out.path,
    };
  }

  const display = localFileName({ title: entry.title || track.title, artist: entry.artist || track.artist, path: entry.path });
  let res;
  try {
    res = await bridge.saveLocal(
      JSON.stringify({
        path: entry.path,
        display,
        title: entry.title || track.title || "",
        artist: entry.artist || track.artist || "",
        album: entry.album || track.album || "",
      }),
    );
  } catch (e) {
    throw new Error(`Native bridge: ${e && e.message ? e.message : e}`, { cause: e });
  }
  const parsed = bridgeResult(res);
  if (parsed.status === "err") throw new Error(parsed.message);
  return { status: parsed.status, name: parsed.name || display, dir: SAVED_DIR };
}
