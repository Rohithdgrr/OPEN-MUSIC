import {
  mobileVisualizerAnalyser,
  onPaint,
  playerState,
  releaseMobileVisualizer,
} from "./player.js";

let canvas = null;
let context = null;
let resizeObserver = null;
let intersectionObserver = null;
let frame = 0;
let visible = false;
let warnedUnavailable = false;
let spectrum = null;
let reducedMotion = false;

function resizeCanvas() {
  if (!canvas || !context) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width === width && canvas.height === height) return;
  canvas.width = width;
  canvas.height = height;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function clearCanvas() {
  if (!canvas || !context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
}

function stopVisualizer() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  spectrum = null;
  releaseMobileVisualizer();
  clearCanvas();
}

function detachVisualizer() {
  stopVisualizer();
  resizeObserver?.disconnect();
  intersectionObserver?.disconnect();
  window.removeEventListener("resize", resizeCanvas);
  document.removeEventListener("visibilitychange", updateVisualizer);
  canvas = null;
  context = null;
  visible = false;
}

function drawFrame() {
  frame = 0;
  if (!canvas || !canvas.isConnected || !visible || document.hidden) {
    stopVisualizer();
    return;
  }

  const state = playerState();
  if (!state.track || state.paused) {
    stopVisualizer();
    return;
  }

  const analyser = mobileVisualizerAnalyser();
  if (!analyser) {
    stopVisualizer();
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.warn("The mobile visualizer is unavailable for this audio session.");
    }
    return;
  }

  if (!spectrum || spectrum.length !== analyser.frequencyBinCount) {
    spectrum = new Uint8Array(analyser.frequencyBinCount);
  }
  analyser.getByteFrequencyData(spectrum);
  resizeCanvas();

  const rect = canvas.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  context.clearRect(0, 0, width, height);
  context.fillStyle = getComputedStyle(canvas).color;
  const bars = Math.min(28, spectrum.length);
  const gap = 3;
  const barWidth = Math.max(1, (width - gap * (bars - 1)) / bars);
  for (let i = 0; i < bars; i += 1) {
    const from = Math.floor((i * spectrum.length) / bars);
    const to = Math.max(from + 1, Math.floor(((i + 1) * spectrum.length) / bars));
    let energy = 0;
    for (let bin = from; bin < to; bin += 1) energy += spectrum[bin];
    const amplitude = energy / (to - from) / 255;
    const barHeight = Math.max(2, amplitude * height);
    const x = i * (barWidth + gap);
    context.globalAlpha = 0.35 + amplitude * 0.65;
    context.fillRect(x, (height - barHeight) / 2, barWidth, barHeight);
  }
  context.globalAlpha = 1;

  if (!reducedMotion) frame = requestAnimationFrame(drawFrame);
}

function updateVisualizer() {
  if (!canvas || !canvas.isConnected) {
    detachVisualizer();
    return;
  }
  const state = playerState();
  const shouldDraw = visible && !document.hidden && !!state.track && !state.paused;
  if (!shouldDraw) {
    stopVisualizer();
    return;
  }
  if (!frame) drawFrame();
}

export function mountVisualizer(target) {
  detachVisualizer();
  if (!target) return;
  canvas = target;
  context = canvas.getContext("2d");
  if (!context) {
    console.warn("The mobile visualizer canvas has no 2D context.");
    detachVisualizer();
    return;
  }

  const motionQuery = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
  reducedMotion = !!(motionQuery && motionQuery.matches);
  resizeCanvas();
  if (typeof IntersectionObserver === "function") {
    intersectionObserver = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      updateVisualizer();
    });
    intersectionObserver.observe(canvas);
  } else {
    visible = true;
  }
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(resizeCanvas);
    resizeObserver.observe(canvas);
  }
  window.addEventListener("resize", resizeCanvas, { passive: true });
  document.addEventListener("visibilitychange", updateVisualizer);
  updateVisualizer();
}

onPaint(updateVisualizer);
document.addEventListener("smount", (event) => {
  if (!event.detail || event.detail.dir !== "nowplaying") detachVisualizer();
});
