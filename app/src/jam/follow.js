// jam/follow.js — Guest track resolution with catalog fallback.
//
// The P0 fix: guests can now play tracks they don't have locally by resolving
// through the catalog. Resolution path: local → resolve_song → mirror fallback.
//
// Contract: returns { track, source } or { mirror, error }.
// - track: ready to enqueue and play
// - source: "queue" | "local" | "catalog"
// - mirror: metadata-only display string (honest "not playable")
// - error: reason why resolve failed

import { invoke } from "../core.js";

/// Find track in local state: queue, history, favorites, vault.
/// Returns { track, index } where index >= 0 means it's in queue.
export function findLocalTrack(id, queue, localTracks) {
  if (!id) return null;
  
  // Check live queue first
  const queueIdx = queue.findIndex((q) => q.track && q.track.id === id);
  if (queueIdx >= 0) {
    return { track: queue[queueIdx].track, index: queueIdx, source: "queue" };
  }
  
  // Check history / favorites / vault
  const hit = localTracks.find((t) => t.id === id);
  if (hit) {
    return { track: hit, index: -1, source: "local" };
  }
  
  return null;
}

/// Resolve track through catalog when not found locally (the key P0 fix).
/// This makes Jam work on fresh devices or when host plays unfamiliar tracks.
async function resolveViaCatalog(id, quality) {
  try {
    const info = await invoke("resolve_song", { id, quality });
    if (!info || info.range_status === "dead" || !info.proxy_url) {
      return { error: "Track not available" };
    }
    
    // Convert resolve_song response to a Track structure
    // Note: metadata should ideally come from search_songs or be cached,
    // but for Jam we can use the playback frame's metadata as fallback
    return {
      track: {
        id,
        title: info.title || id,
        artist: info.artist || "",
        image: info.image || "",
        // Mark this as catalog-resolved so UI can show it differently if needed
        _catalogResolved: true,
      },
      source: "catalog",
    };
  } catch (err) {
    return { error: String(err).slice(0, 160) };
  }
}

/// Complete resolution pipeline: local → catalog → mirror.
/// This is the single source of truth for guest track resolution.
///
/// Parameters:
///   - playbackFrame: the host's playback frame with trackId, title, artist, image
///   - queue: current playback queue
///   - localTracks: fn returning history/favs/vault
///   - quality: stream quality setting
///
/// Returns:
///   Success: { track, source, index }
///   Failure: { mirror, error }
export async function resolveGuestTrack(playbackFrame, queue, localTracks, quality) {
  const { trackId, title, artist, image } = playbackFrame;
  
  if (!trackId) {
    return { mirror: "No track ID", error: "invalid_frame" };
  }
  
  // Step 1: Try local resolution
  const local = findLocalTrack(trackId, queue, localTracks);
  if (local) {
    return local;
  }
  
  // Step 2: Try catalog resolution (P0 fix - this was missing!)
  const catalog = await resolveViaCatalog(trackId, quality);
  if (catalog.track) {
    // Enrich with metadata from the playback frame
    return {
      track: {
        ...catalog.track,
        title: title || catalog.track.title,
        artist: artist || catalog.track.artist,
        image: image || catalog.track.image,
      },
      source: catalog.source,
      index: -1, // Not in queue yet
    };
  }
  
  // Step 3: Mirror metadata (honest failure - docs/listen-together.md §4.5)
  const mirrorText = title
    ? `Host is on "${title}" by ${artist || "unknown"} — not on this device.`
    : `Host is on track ${trackId} — not on this device.`;
    
  return {
    mirror: mirrorText,
    error: catalog.error || "Track not available",
  };
}

/// Single-flight resolver to prevent resolution storms when host changes tracks rapidly.
/// Tracks the in-flight trackId and cancels stale resolutions.
export function createResolver() {
  let currentId = null;
  let generation = 0;
  
  return async function resolve(playbackFrame, queue, localTracks, quality) {
    const myGen = ++generation;
    const trackId = playbackFrame.trackId;
    
    // Cancel if a newer resolution started
    if (currentId !== trackId) {
      currentId = trackId;
    }
    
    const result = await resolveGuestTrack(playbackFrame, queue, localTracks, quality);
    
    // Discard if superseded
    if (myGen !== generation) {
      return { superseded: true };
    }
    
    currentId = null;
    return result;
  };
}
