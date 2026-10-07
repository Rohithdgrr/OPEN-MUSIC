// jam/controller.js — Shared Jam (Listen Together) controller.
//
// Single source of truth for room state management, guest following, and host
// ticking. Used by both desktop (social.js) and mobile (jam.js) to eliminate
// code duplication and prevent regression divergence.
//
// Responsibilities:
//   - Room lifecycle: open, join, leave, reconnect
//   - Host tick: broadcast playback state at 1s intervals
//   - Guest follow: resolve + enqueue + sync with host playhead
//   - Drift measurement and reporting
//   - Lock guest transport controls
//
// Does NOT handle DOM rendering - that remains in the shell (social.js / jam.js).

import { invoke } from "../core.js";
import { createRoomState, reduceRoom, syncDecision } from "../room.js";
import { resolveGuestTrack, createResolver } from "./follow.js";

export const HOST_TICK_MS = 1000;
export const NO_ROOM = "NO ROOM";

/// Create a Jam controller instance with all necessary dependencies injected.
///
/// Dependencies (injected to avoid circular imports and enable testing):
///   - getAudio: () => HTMLAudioElement
///   - getPlayerSnapshot: () => { id, paused, position }
///   - getQueue: () => Track[]
///   - getLocalTracks: () => Track[] (history, favs, vault)
///   - getQuality: () => string
///   - playQueueItem: (index) => Promise<void>
///   - enqueueTrack: (track) => void
///   - onStateChange: (state) => void (render callback)
///   - onError: (error) => void
///   - onDiag: (label, success, message) => void
export function createJamController(deps) {
  let state = createRoomState();
  let tickTimer = 0;
  let lastDrift = null;
  let guestMirror = "";
  let guestApplied = "";
  let joining = false;
  
  // Single-flight resolver to prevent resolution storms
  const resolver = createResolver();
  
  /// Notify listeners that state changed
  function notifyChange() {
    deps.onStateChange(state);
  }
  
  /// Broadcast current playback state to all room members (host only).
  async function broadcastPlayback() {
    if (state.role !== "host") return;
    
    const snap = deps.getPlayerSnapshot();
    if (!snap.id) return;
    
    try {
      await invoke("room_playback", {
        trackId: snap.id,
        positionMs: Math.round((snap.position || 0) * 1000),
        playing: !snap.paused,
        title: snap.title || "",
        artist: snap.artist || "",
        image: snap.image || "",
      });
    } catch (err) {
      deps.onDiag("room broadcast", false, String(err).slice(0, 160));
    }
  }
  
  /// Host tick: send playback state every 1s while playing
  function hostTick() {
    if (state.role !== "host") return;
    const snap = deps.getPlayerSnapshot();
    if (snap.id && !snap.paused) {
      broadcastPlayback();
    }
  }
  
  /// Start the host tick timer
  function startHostTick() {
    if (tickTimer) return;
    tickTimer = setInterval(hostTick, HOST_TICK_MS);
  }
  
  /// Stop the host tick timer
  function stopHostTick() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = 0;
  }
  
  /// Guest: resolve and play the host's track (with P0 catalog resolution fix)
  async function followHostTrack(pb) {
    const queue = deps.getQueue();
    const localTracks = deps.getLocalTracks();
    const quality = deps.getQuality();
    
    const result = await resolver(pb, queue, localTracks, quality);
    
    // Check if superseded by a newer resolution
    if (result.superseded) {
      return;
    }
    
    // Failed to resolve - show mirror message
    if (result.mirror) {
      guestMirror = result.mirror;
      guestApplied = "";
      lastDrift = null;
      notifyChange();
      return;
    }
    
    // Successfully resolved - play it
    guestMirror = "";
    const { track, index, source } = result;
    
    deps.onDiag("room follow", true, `${source}: ${track.title}`);
    
    if (index >= 0) {
      // Already in queue
      const snap = deps.getPlayerSnapshot();
      if (snap.id !== pb.trackId) {
        await deps.playQueueItem(index);
      }
    } else {
      // Enqueue and play
      deps.enqueueTrack(track);
      const newQueue = deps.getQueue();
      await deps.playQueueItem(newQueue.length - 1);
    }
    
    notifyChange();
  }
  
  /// Guest tick: apply host playhead, measure drift, report
  function guestTick() {
    if (state.role !== "guest" || !state.playback) return;
    
    const pb = state.playback;
    const snap = deps.getPlayerSnapshot();
    const audio = deps.getAudio();
    const key = `${pb.at}:${pb.trackId}:${pb.positionMs}:${pb.playing}`;
    
    // Different track - resolve once per frame
    if (snap.id !== pb.trackId) {
      const applyKey = `follow:${key}`;
      if (guestApplied !== applyKey) {
        guestApplied = applyKey;
        followHostTrack(pb).catch((e) => 
          deps.onDiag("room follow", false, String(e).slice(0, 160))
        );
      }
      return;
    }
    
    // On the right track - clear mirror message
    guestMirror = "";
    
    // Apply play/pause state
    if (pb.playing && audio.paused) {
      audio.play().catch(() => {});
    }
    if (!pb.playing && !audio.paused) {
      audio.pause();
    }
    
    // Measure drift and seek if needed
    const { driftMs, seekToSec } = syncDecision(state, audio.currentTime);
    if (seekToSec !== null) {
      audio.currentTime = seekToSec;
      deps.onDiag("room sync", true, `seek ${seekToSec.toFixed(2)}s (drift ${driftMs}ms)`);
    }
    
    // Report drift to host
    if (driftMs !== null) {
      lastDrift = driftMs;
      invoke("room_report", { driftMs }).catch(() => {});
    }
    
    notifyChange();
  }
  
  /// Start the guest tick timer
  function startGuestTick() {
    if (tickTimer) return;
    tickTimer = setInterval(guestTick, HOST_TICK_MS);
  }
  
  /// Process incoming room frame
  function applyFrame(frame) {
    if (!frame || typeof frame.t !== "string") return;
    
    const prevRole = state.role;
    state = reduceRoom(state, frame);
    
    // Role changed - manage tickers
    if (state.role !== prevRole) {
      stopHostTick();
      if (state.role === "host") {
        startHostTick();
        // Send immediate playback on join
        setTimeout(broadcastPlayback, 100);
      } else if (state.role === "guest") {
        startGuestTick();
      }
    }
    
    // Handle specific frame types
    switch (frame.t) {
      case "refresh":
        // Host: someone joined, send fresh state
        if (state.role === "host") {
          broadcastPlayback();
        }
        break;
        
      case "joined":
        joining = false;
        break;
        
      case "hosted":
        joining = false;
        break;
        
      case "bye":
        stopHostTick();
        guestMirror = "";
        guestApplied = "";
        lastDrift = null;
        break;
    }
    
    notifyChange();
  }
  
  /// Public API
  return {
    // State access
    get state() { return state; },
    get mirror() { return guestMirror; },
    get drift() { return lastDrift; },
    get joining() { return joining; },
    
    // Room lifecycle
    async open(name, port) {
      if (state.role !== "idle") {
        throw new Error("Already in a room");
      }
      
      try {
        const result = await invoke("room_open", { name, port });
        
        // Synthesize hosted frame (Rust doesn't send one)
        applyFrame({
          t: "hosted",
          selfId: "host",
          code: result.code,
          urls: result.urls || [],
          members: [{ id: "host", name, host: true }],
        });
        
        deps.onDiag("room", true, `host ${result.code}`);
        return result;
      } catch (err) {
        deps.onError(String(err));
        throw err;
      }
    },
    
    async join(addr, code, name) {
      if (state.role !== "idle") {
        throw new Error("Already in a room");
      }
      
      joining = true;
      notifyChange();
      
      try {
        await invoke("room_join", { addr, code, name });
        // joined frame will arrive via room://msg
      } catch (err) {
        joining = false;
        notifyChange();
        deps.onError(String(err));
        throw err;
      }
    },
    
    async leave() {
      if (state.role === "idle") return;
      
      try {
        await invoke("room_close");
        stopHostTick();
        state = createRoomState();
        guestMirror = "";
        guestApplied = "";
        lastDrift = null;
        notifyChange();
      } catch (err) {
        deps.onError(String(err));
        throw err;
      }
    },
    
    async sendChat(text) {
      if (state.role === "idle") return;
      
      try {
        await invoke("room_chat", { text });
      } catch (err) {
        deps.onError(String(err));
        throw err;
      }
    },
    
    // Frame processing
    onFrame(frame) {
      applyFrame(frame);
    },
    
    // Host actions
    onTrackChange() {
      if (state.role === "host") {
        broadcastPlayback();
      }
    },
    
    onPlayPause() {
      if (state.role === "host") {
        broadcastPlayback();
      }
    },
    
    onSeek() {
      if (state.role === "host") {
        broadcastPlayback();
      }
    },
    
    // Cleanup
    destroy() {
      stopHostTick();
    },
  };
}

/// Check if a control should be locked for guests
export function isGuestLocked(controlId, role) {
  if (role !== "guest") return false;
  
  const lockedControls = [
    "bar-play", "bar-prev", "bar-next", "bar-shuffle", "bar-repeat",
    "play-pause-btn", "prev-btn", "next-btn", "shuffle-btn", "repeat-btn",
  ];
  
  return lockedControls.includes(controlId);
}
