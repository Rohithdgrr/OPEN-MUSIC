// carousel.js — coverflow upgrade for home shelves (docs/mobile/11 §4).
//
// Vanilla-JS equivalent of the 21st.dev cover-flow / card-deck carousels:
// the shelf keeps its native touch scroll (feels like a real Android
// scroller), and a rAF-driven pass rotates/scales each card by its offset
// from the viewport centre — cards ahead tilt away, the centred card sits
// flat and largest. No dependencies, no synthetic drag: momentum, flings
// and edge rubber-banding all stay platform-native.
//
// Opt-in per shelf via `data-cf` on the `.h-scroll` container; initCarousels()
// runs after every render pass, so re-created DOM is picked up automatically.

const MAX_ANGLE = 24; // degrees at the shelf edges
const MAX_SQUASH = 0.1; // scale drop at the edges
const MAX_FADE = 0.16; // opacity drop at the edges

export function initCarousels() {
  if (typeof document === 'undefined') return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.querySelectorAll('.h-scroll[data-cf]').forEach(enhance);
}

function enhance(scroller) {
  if (scroller.dataset.cfReady === '1') return;
  scroller.dataset.cfReady = '1';
  scroller.classList.add('cf-on');

  let raf = 0;
  const cards = () => scroller.querySelectorAll(':scope > *');

  const update = () => {
    raf = 0;
    const view = scroller.getBoundingClientRect();
    const cx = view.left + view.width / 2;
    // Normalise against ~70% of the viewport so edge cards reach full tilt.
    const norm = Math.max(120, view.width * 0.7);
    for (const card of cards()) {
      const r = card.getBoundingClientRect();
      if (!r.width) continue;
      const off = r.left + r.width / 2 - cx;
      const n = Math.max(-1, Math.min(1, off / norm));
      const angle = (-n * MAX_ANGLE).toFixed(2);
      const scale = (1 - Math.abs(n) * MAX_SQUASH).toFixed(3);
      card.style.transform = `perspective(1100px) rotateY(${angle}deg) scale(${scale})`;
      card.style.zIndex = String(100 - Math.round(Math.abs(n) * 40));
      card.style.opacity = (1 - Math.abs(n) * MAX_FADE).toFixed(2);
    }
  };
  const schedule = () => {
    if (!raf) raf = window.requestAnimationFrame(update);
  };

  scroller.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  // Re-run once webfonts/art settle so first-paint rects aren't stale.
  window.setTimeout(update, 60);
  update();
}
