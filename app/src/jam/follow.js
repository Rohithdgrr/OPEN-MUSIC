// jam/follow.js — guest track resolution pipeline: local → catalog → mirror.
//
// The pipeline every surface shares (docs/listen-together.md §12/§13):
//   1. local — the live queue, play history, favourites and the vault
//   2. catalog — the guest's own backend resolves the host's id
//      (`resolve_song`), so a fresh device can follow a deep cut
//   3. mirror — §4.5 honesty: metadata only, never claim to be playing it
//
// Dependency-injected by design: `invoke` arrives from the caller (the
// surface's own capture of the Tauri bridge). This module must stay
// DOM-free and import-free so it can sit in the mobile shell's graph and
// run under `node --test` — a static `../core.js` import here once killed
// the whole mobile app.js module graph (mobile 09 P-stray), and a dynamic
// one would still drag dom.js's top-level side effects into the page.

/// Find the id in local state: the live queue first (with its index, so the
/// caller can jump instead of re-append), then the caller's extra rows
/// (history, favourites, vault). Returns `{ track, index, source }` or null.
export function findLocalTrack(id, queue, localTracks) {
  if (!id) return null;
  const queueIdx = (queue || []).findIndex((q) => q && q.track && q.track.id === id);
  if (queueIdx >= 0) {
    return { track: queue[queueIdx].track, index: queueIdx, source: "queue" };
  }
  const hit = (localTracks || []).find((t) => t && t.id === id);
  if (hit) return { track: hit, index: -1, source: "local" };
  return null;
}

/// Step 2: ask the guest's backend to resolve the id. `invoke` is injected.
/// Returns `{ track }` or `{ error }` — never throws.
export async function resolveFromCatalog(playbackFrame, deps = {}) {
  const { invoke, quality } = deps;
  if (!invoke) return { error: "no invoke" };
  const id = playbackFrame && playbackFrame.trackId;
  if (!id) return { error: "invalid_frame" };
  try {
    const info = await invoke("resolve_song", quality ? { id, quality } : { id });
    if (!info || info.range_status === "dead" || !info.proxy_url) {
      return { error: "Track not available" };
    }
    return {
      track: {
        id,
        title: playbackFrame.title || info.title || id,
        artist: playbackFrame.artist || info.artist || "",
        image: playbackFrame.image || info.image || "",
        // Mark catalog-resolved so a surface may badge it differently.
        _catalogResolved: true,
      },
      source: "catalog",
    };
  } catch (err) {
    return { error: String(err).slice(0, 160) };
  }
}

/// The full pipeline. Returns:
///   `{ track, index, source }` — playable now (index ≥ 0 means queue hit)
///   `{ mirror, error }`        — §4.5 metadata mirror, nothing playable
export async function resolveGuestTrack(playbackFrame, queue, localTracks, deps = {}) {
  const { trackId, title, artist, image } = playbackFrame || {};
  if (!trackId) return { mirror: "No track ID", error: "invalid_frame" };

  const local = findLocalTrack(trackId, queue, localTracks);
  if (local) return local;

  const catalog = await resolveFromCatalog(playbackFrame, deps);
  if (catalog.track) {
    return {
      track: {
        ...catalog.track,
        title: title || catalog.track.title,
        artist: artist || catalog.track.artist,
        image: image || catalog.track.image,
      },
      source: catalog.source,
      index: -1, // not in the queue — the caller appends and jumps
    };
  }

  const mirrorText = title
    ? `Host is on "${title}" by ${artist || "unknown"} — not on this device.`
    : `Host is on track ${trackId} — not on this device.`;
  return { mirror: mirrorText, error: catalog.error || "Track not available" };
}

/// Single-flight wrapper: rapid host track changes must not stack resolves —
/// a stale completion is reported as `{ superseded: true }` and dropped by
/// the caller.
export function createResolver(deps = {}) {
  let generation = 0;
  return async function resolve(playbackFrame, queue, localTracks) {
    const myGen = ++generation;
    const result = await resolveGuestTrack(playbackFrame, queue, localTracks, deps);
    if (myGen !== generation) return { superseded: true };
    return result;
  };
}
