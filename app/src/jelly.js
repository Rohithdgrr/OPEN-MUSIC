// jelly.js — deforms an element while its OS window is dragged, then
// springs it back with a jelly wobble. Rust emits `tm:window-moved` on
// every WindowEvent::Moved; we convert the position stream into a
// velocity-based squash, and when movement stops the CSS transition's
// overshoot does the settling wobble. Shared by the widget card and the
// main window.
let last = null;
let settleTimer = 0;
// Direct deformation while moving is chased quick; settling back uses a
// bouncy overshoot so the shape reads as jelly.
const CHASE = "transform .12s ease-out";
const SETTLE = "transform .5s cubic-bezier(.34,1.56,.64,1)";

export function wireJelly(getTarget) {
  const listen = window.__TAURI__?.event?.listen;
  if (!listen) return;
  listen("tm:window-moved", (ev) => {
    const pos = ev?.payload;
    if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number") return;
    const target = typeof getTarget === "function" ? getTarget() : getTarget;
    if (!target) return;
    const now = performance.now();
    // Initialise one-time style; re-apply per call since renders can
    // replace the element (widget mini/max toggle swaps the card).
    target.style.transformOrigin = "center";
    if (last) {
      const dt = Math.max(1, now - last.t);
      const dx = Math.abs(pos.x - last.x) / dt;
      const dy = Math.abs(pos.y - last.y) / dt;
      const v = Math.min(0.07, (dx + dy) * 0.9);
      const a = 1 + v;
      const b = Math.max(0.9, 1 - v * 0.6);
      target.style.transition = CHASE;
      target.style.transform =
        dx >= dy ? `scaleX(${a}) scaleY(${b})` : `scaleX(${b}) scaleY(${a})`;
    }
    last = { x: pos.x, y: pos.y, t: now };
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      target.style.transition = SETTLE;
      target.style.transform = "";
    }, 180);
  });
}
