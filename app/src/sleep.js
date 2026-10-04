// sleep.js — one-shot sleep timer shared by both shells: pause playback after
// N minutes, fading the volume out over the last FADE_MS so it never cuts off
// mid-word. Re-arming replaces the timer; "Off" cancels and restores volume.

export const PRESETS = [0, 15, 30, 60, 90];
export const FADE_MS = 15000;

/// Volume multiplier for the last FADE_MS of the countdown: 1 while there is
/// time, ramping linearly to 0. Pure, so the ramp is unit-tested without a DOM.
export function ramp(msLeft) {
  return msLeft >= FADE_MS ? 1 : Math.max(0, msLeft / FADE_MS);
}

let timer = 0;
let endAt = 0;
let base = 1; // volume before the fade, restored when the timer ends/cancels

/// Arm the timer for `mins` minutes (0 / junk cancels). `audio` only needs
/// `.volume` and `.pause()`. `on({ left, mins, done })` fires every second —
/// shells use it to repaint, not to drive state. Returns the armed duration in
/// ms, or 0 when cancelled.
export function arm(mins, audio, on = () => {}) {
  cancel(audio);
  const total = Number(mins) * 60000;
  if (!(total > 0)) return 0;
  base = audio.volume;
  endAt = Date.now() + total;
  timer = setInterval(() => {
    const left = endAt - Date.now();
    if (left <= 0) {
      clearInterval(timer);
      timer = 0;
      endAt = 0;
      audio.pause();
      audio.volume = base;
      on({ left: 0, mins, done: true });
      return;
    }
    audio.volume = base * ramp(left);
    on({ left, mins, done: false });
  }, 1000);
  return total;
}

/// Cancel an armed timer and put the volume back. No-op when nothing is armed,
/// so callers can cancel unconditionally.
export function cancel(audio) {
  if (!timer) return;
  clearInterval(timer);
  timer = 0;
  endAt = 0;
  if (audio) audio.volume = base;
}

/// Milliseconds left on the armed timer (0 when off).
export function remaining() {
  return Math.max(0, endAt - Date.now());
}

/// Is a timer armed right now?
export function armed() {
  return timer !== 0;
}