// PATCH for shortcuts.js - Add guest transport locks
//
// Add this check at the top of the ACTIONS object handlers:

// At the top of the file, import the jam controller check:
// import { isGuestLocked } from "./jam/controller.js";

// Then modify the ACTIONS object to check guest locks:

const ACTIONS = {
  "shortcut:play": () => {
    // Check if guest-locked
    if (window.jamController && window.jamController.state.role === "guest") {
      toast("The host controls playback in this room", "info", 2000);
      return;
    }
    togglePlay();
  },
  
  "media-play-pause": () => {
    if (window.jamController && window.jamController.state.role === "guest") {
      toast("The host controls playback in this room", "info", 2000);
      return;
    }
    togglePlay();
  },
  
  "media-next": () => {
    if (window.jamController && window.jamController.state.role === "guest") {
      toast("The host controls playback in this room", "info", 2000);
      return;
    }
    step(1);
  },
  
  "media-prev": () => {
    if (window.jamController && window.jamController.state.role === "guest") {
      toast("The host controls playback in this room", "info", 2000);
      return;
    }
    step(-1);
  },
  
  // Other shortcuts remain unchanged...
};

// Also update wireInAppKeys to check guest locks:

function wireInAppKeys() {
  window.addEventListener("keydown", (e) => {
    if (e.repeat || e.defaultPrevented || document.querySelector("dialog[open]")) return;
    
    const ctrl = e.ctrlKey || e.metaKey;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    
    // Check if guest before allowing transport controls
    const isGuest = window.jamController && window.jamController.state.role === "guest";
    
    if (ctrl && !e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
      if (typingTarget(e)) return;
      if (isGuest) {
        toast("The host controls playback in this room", "info", 2000);
        return;
      }
      e.preventDefault();
      step(e.key === "ArrowRight" ? 1 : -1);
      return;
    }
    
    if (!plain || typingTarget(e)) return;
    
    if (e.key === " ") {
      if (e.target instanceof HTMLElement && e.target.closest("button, a, summary, label")) return;
      if (isGuest) {
        toast("The host controls playback in this room", "info", 2000);
        return;
      }
      e.preventDefault();
      togglePlay();
    }
    
    // L key (like) is allowed for guests - it's local only
    else if (e.key.toLowerCase() === "l") {
      const t = currentTrack();
      if (t) toggleFavTrack(t);
      else toast("Nothing is playing yet — start a track first.", "info");
    }
  });
}
