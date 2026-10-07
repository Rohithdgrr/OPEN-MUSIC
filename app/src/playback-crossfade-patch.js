// PATCH for playback.js - Disable crossfade in Jam rooms
//
// Add this check to the startFade function (around line 307):

async function startFade(nextIndex, xf, remain) {
  const item = queue[nextIndex];
  if (!item) return;
  
  // NEW: Disable crossfade while in a Jam room to prevent desync
  if (window.jamController && window.jamController.state.role !== "idle") {
    cancelFade();
    return;
  }
  
  // Offline: a CDN resolve can only hang for the backend's timeouts — skip
  // the attempt and let the ended path (which has the fast-path gate) pick
  // up; a vaulted track still resolves and crossfades from disk.
  if (netMode() === "offline" && !isDownloaded(item.track.id)) {
    cancelFade();
    return;
  }
  
  // ... rest of function unchanged
}
