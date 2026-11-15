// videoplan.js — the mobile Now Playing video *gate and plan* (pure).
//
// Why this file exists apart from `mobile/videobackdrop.js`: the rules that
// decide whether a video may play at all (off by default, never on metered
// data, honour reduced motion) must be testable without a DOM, and the plan
// must be assembled from the same matcher the P0 probe proved
// (`videomatch.js`). The DOM module only paints what this returns.
//
// Contract: docs/song-video.md §9 (render plane) and §12.2 (off by default).

import { classifyKind, pickBestCandidate, pickRendition } from "./videomatch.js";

/// Settings switch. Default is off: this feature is best-effort and data heavy.
export const VIDEO_PREF_KEY = "tm-np-video";

export function videoPrefOn(raw) {
  return raw === "1";
}

/// May the backdrop play right now? Every reason is explicit so the UI and the
/// tests can tell "user turned it off" from "the phone is on mobile data".
export function videoGate({ enabled, hasInvoke, cellular, saveData, reducedMotion } = {}) {
  if (!enabled) return { ok: false, reason: "off" };
  if (!hasInvoke) return { ok: false, reason: "no-backend" };
  if (reducedMotion) return { ok: false, reason: "reduced-motion" };
  if (saveData || cellular) return { ok: false, reason: "metered" };
  return { ok: true, reason: "" };
}

/// The honest candidate, or null. Ranking and the accept bar are the P0
/// matcher's job — this is only the step before the player handshake.
export function chooseCandidate(track, candidates) {
  return pickBestCandidate(track, candidates || []);
}

/// One progressive rendition under the ambient height cap (§7).
export function chooseRendition(formats, maxHeight = 720) {
  return pickRendition(formats || [], { maxHeight });
}

/// Full plan, given what the transport returned. Always returns an object —
/// a miss is `state: "none"`, never a throw.
export function planVideo(track, { candidates = [], formats = [], maxHeight = 720 } = {}) {
  const best = chooseCandidate(track, candidates);
  if (!best) {
    return { state: "none", reason: "no-candidate", videoId: "", itag: 0, url: "" };
  }
  const rendition = chooseRendition(formats, maxHeight);
  if (!rendition) {
    return {
      state: "none",
      reason: "no-rendition",
      videoId: best.candidate.videoId,
      itag: 0,
      url: "",
    };
  }
  return {
    state: "ready",
    reason: "",
    videoId: best.candidate.videoId,
    kind: classifyKind(track, best.candidate),
    confidence: Number(best.score.toFixed(4)),
    itag: rendition.itag,
    width: rendition.width,
    height: rendition.height,
    url: rendition.url,
  };
}
