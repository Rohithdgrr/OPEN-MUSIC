// sleep.test.mjs — the sleep timer's countdown + fade, with no DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PRESETS, FADE_MS, ramp, arm, cancel, remaining, armed } from "../src/sleep.js";

const fakeAudio = (vol = 0.8) => ({
  volume: vol,
  paused: false,
  pause() {
    this.paused = true;
  },
});

test("ramp holds full volume then falls to silence over the fade window", () => {
  assert.equal(ramp(10 * 60000), 1, "no fade before the window");
  assert.equal(ramp(FADE_MS), 1, "still full at the window edge");
  assert.equal(ramp(FADE_MS / 2), 0.5, "half way down");
  assert.equal(ramp(0), 0, "silent at zero");
  assert.equal(ramp(-5000), 0, "never negative (overrun)");
});

test("arming fades, pauses at the end, and restores the volume", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const audio = fakeAudio(0.8);
  const ticks = [];
  const total = arm(1, audio, (s) => ticks.push(s));
  assert.equal(total, 60000);
  assert.ok(armed());
  assert.ok(remaining() > 0);

  t.mock.timers.tick(60000 - FADE_MS - 1000);
  assert.equal(audio.volume, 0.8, "untouched outside the fade");
  assert.equal(audio.paused, false);

  t.mock.timers.tick(FADE_MS / 2);
  assert.ok(audio.volume > 0 && audio.volume < 0.8, `mid-fade: ${audio.volume}`);

  t.mock.timers.tick(FADE_MS / 2 + 1000);
  assert.equal(audio.paused, true, "paused once the countdown ends");
  assert.equal(audio.volume, 0.8, "volume handed back, not left silent");
  assert.equal(armed(), false);
  assert.equal(remaining(), 0);
  assert.equal(ticks.at(-1).done, true);
});

test("0 / junk cancels and re-arming replaces the pending timer", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const audio = fakeAudio(0.5);
  assert.equal(arm(0, audio), 0, "Off is not a timer");
  assert.equal(armed(), false);

  arm(15, audio);
  t.mock.timers.tick(60000);
  assert.equal(armed(), true, "the 15 min timer survived 1 min");

  arm(15, audio); // re-arm
  t.mock.timers.tick(60000);
  assert.equal(armed(), true);
  assert.equal(audio.paused, false);

  cancel(audio);
  assert.equal(armed(), false);
  assert.equal(audio.volume, 0.5, "cancel restores the pre-timer volume");
  t.mock.timers.tick(15 * 60000);
  assert.equal(audio.paused, false, "a cancelled timer never fires");
});

test("presets are ordered so the mobile button cycles sensibly", () => {
  assert.deepEqual(PRESETS, [0, 15, 30, 60, 90]);
  assert.equal(PRESETS[0], 0, "the cycle starts on Off");
});