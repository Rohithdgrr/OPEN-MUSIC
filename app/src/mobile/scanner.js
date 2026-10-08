// scanner.js — scan-to-join: camera preview + jsQR frame decoding (B-T2).
//
// Why jsQR and not `BarcodeDetector`: the spike (B-T1) proved that the API
// in the real Tauri Android WebView *advertises* `qr_code` but `detect()`
// returns empty on every input shape — silent, no console error. Camera
// permission, by contrast, works once `CAMERA` is in the manifest
// (docs/mobile/09-problems-solutions.md P38; design: docs/jam-upgrade.md §4.1).
//
// Pipeline: getUserMedia -> <video> -> offscreen canvas every ~200 ms ->
// jsQR -> extractInviteFromScan (canonical-only) -> the caller joins through
// the exact same `room_join_uri` path the paste field uses. A frame that is
// not our invite (someone else's QR) is ignored — the scanner keeps looking.
//
// jsQR is a classic <script> (`window.jsQR`), not an import: this frontend
// has no bundler. Missing decoder -> `decoder-missing`, camera never opens,
// the caller keeps the paste field as the honest fallback.

import { parseInvite } from "../room.js";

const POLL_MS = 200;

/// Validate scanned text as an invite. Canonical-only by design: our QR
/// surfaces (A) always encode `trancemusic://join?…`, so a scanned legacy
/// `ws://… · CODE` line or any foreign text is not an invite from us.
/// Returns `{ addr, code }` (Rust's view of the string) or `null`.
export function extractInviteFromScan(text) {
  const t = String(text == null ? "" : text).trim();
  if (!t.startsWith("trancemusic://")) return null;
  return parseInvite(t);
}

/// Open the camera and decode frames until an invite is found, `stop()` is
/// called, or something fails. Returns `{ stop }` (idempotent).
///
/// `video`   — the preview element (caller sets playsinline/muted).
/// `canvas`  — offscreen frame-grab target, never added to the DOM.
/// `onScan({ uri, addr, code })` — called exactly once, after the camera
///                                 has already been stopped.
/// `onStatus({ type, detail })`  — `starting | live | decoded | denied |
///                                 nocamera | decoder-missing | error`.
export function startScanner({ video, canvas, onScan, onStatus }) {
  let stream = null;
  let timer = 0;
  let stopped = false;

  const status = (s) => {
    try {
      onStatus?.(s);
    } catch {
      /* the sheet was torn down — nothing to report */
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = 0;
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    try {
      video.pause();
      video.srcObject = null;
    } catch {
      /* element already detached */
    }
  };

  if (typeof window === "undefined" || typeof window.jsQR !== "function") {
    status({ type: "decoder-missing" });
    return { stop: () => {} };
  }

  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const tick = () => {
    if (stopped || !video.videoWidth) return; // no frame yet
    try {
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.drawImage(video, 0, 0, w, h);
      const frame = ctx.getImageData(0, 0, w, h);
      const hit = window.jsQR(frame.data, w, h);
      if (!hit || typeof hit.data !== "string") return;
      const parsed = extractInviteFromScan(hit.data);
      if (!parsed) return; // not our invite — keep scanning
      stop();
      status({ type: "decoded" });
      try {
        onScan?.({ uri: hit.data.trim(), addr: parsed.addr, code: parsed.code });
      } catch {
        /* sheet teardown race — camera already stopped, nothing else to do */
      }
    } catch (e) {
      fail("error", String((e && e.message) || e));
    }
  };

  const fail = (type, detail) => {
    status({ type, detail });
    stop();
  };

  status({ type: "starting" });
  navigator.mediaDevices
    .getUserMedia({ video: { facingMode: { ideal: "environment" } } })
    .then((s) => {
      if (stopped) {
        for (const track of s.getTracks()) track.stop();
        return undefined;
      }
      stream = s;
      video.srcObject = s;
      return video.play();
    })
    .then(() => {
      if (stopped) return;
      status({ type: "live" });
      timer = setInterval(tick, POLL_MS);
    })
    .catch((e) => {
      const name = e && e.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        fail("denied", String((e && e.message) || e));
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        fail("nocamera", String((e && e.message) || e));
      } else {
        fail("error", String((e && e.message) || e));
      }
    });

  return { stop };
}
