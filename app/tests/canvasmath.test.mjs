// canvasmath.test.mjs — pure Canvas format policy (docs §17).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANVAS_MIN_H,
  CANVAS_MIN_W,
  LOOP_FADE,
  LOOP_SECONDS,
  cropBox,
  loopPlan,
  meetsCanvasFloor,
} from "../src/mobile/canvasmath.js";

test("the Canvas constants are the Spotify-Canvas contract", () => {
  assert.equal(LOOP_SECONDS, 6);
  assert.ok(LOOP_SECONDS >= 3 && LOOP_SECONDS <= 8, "loop must be 3-8 s");
  assert.equal(LOOP_FADE, 0.6);
  assert.ok(LOOP_FADE > 0 && LOOP_FADE < LOOP_SECONDS);
  assert.equal(CANVAS_MIN_W, 720);
  assert.equal(CANVAS_MIN_H, 1280);
});

test("cropBox returns the centred 9:16 box", () => {
  assert.deepEqual(cropBox(1078, 1438), { x: 135, y: 0, w: 808, h: 1438 });
  assert.deepEqual(cropBox(830, 1106), { x: 104, y: 0, w: 622, h: 1106 });
  assert.deepEqual(cropBox(768, 768), { x: 168, y: 0, w: 432, h: 768 });
  assert.deepEqual(cropBox(1920, 1080), { x: 656, y: 0, w: 607, h: 1080 });
  assert.deepEqual(cropBox(720, 1280), { x: 0, y: 0, w: 720, h: 1280 });
  assert.deepEqual(cropBox(0, 0), { x: 0, y: 0, w: 0, h: 0 });
});

test("meetsCanvasFloor gates on the 9:16 crop, not the source width", () => {
  // The measured real-world trap: 830x1106 is "wide enough" at 830 but its
  // 9:16 crop is 622 wide.
  assert.equal(meetsCanvasFloor(830, 1106), false);
  assert.equal(meetsCanvasFloor(1078, 1438), true);
  assert.equal(meetsCanvasFloor(1080, 1440), true);
  assert.equal(meetsCanvasFloor(720, 1280), true);
  assert.equal(meetsCanvasFloor(768, 768), false);
  assert.equal(meetsCanvasFloor(1920, 1080), false);
});

test("loopPlan uses the 6 s window with a pre-roll when the source allows", () => {
  assert.deepEqual(loopPlan(20), { start: 0.6, seconds: 6, fade: 0.6, base: 0 });
  assert.deepEqual(loopPlan(30), { start: 0.6, seconds: 6, fade: 0.6, base: 0 });
  assert.deepEqual(loopPlan(8), { start: 0.6, seconds: 6, fade: 0.6, base: 0 });
  assert.deepEqual(loopPlan(7.2), { start: 0.6, seconds: 6, fade: 0.6, base: 0 });
});

test("loopPlan anchors to the first presentable frame (Apple fMP4 edit-list offset)", () => {
  const p = loopPlan(30, 10.033);
  assert.equal(p.base, 10.033);
  assert.ok(Math.abs(p.start - 10.633) < 1e-9, `start ${p.start}`);
  assert.equal(p.seconds, 6);
  assert.equal(p.fade, 0.6);
  // A later anchor with less than the 7.2 s a crossfade needs hard-cuts at the
  // anchor instead of pretending a pre-roll exists.
  assert.deepEqual(loopPlan(30, 25), { start: 25, seconds: 5, fade: 0, base: 25 });
  // A bad anchor is ignored, never NaN or negative.
  assert.deepEqual(loopPlan(20, NaN), { start: 0.6, seconds: 6, fade: 0.6, base: 0 });
  assert.deepEqual(loopPlan(20, -3), { start: 0.6, seconds: 6, fade: 0.6, base: 0 });
});

test("short sources loop whole with a hard cut instead of a negative pre-roll", () => {
  assert.deepEqual(loopPlan(5), { start: 0, seconds: 5, fade: 0, base: 0 });
  assert.deepEqual(loopPlan(3), { start: 0, seconds: 3, fade: 0, base: 0 });
  assert.deepEqual(loopPlan(1), { start: 0, seconds: 1, fade: 0, base: 0 });
  assert.deepEqual(loopPlan(0), { start: 0.6, seconds: 6, fade: 0.6, base: 0 });
  assert.deepEqual(loopPlan(NaN), { start: 0.6, seconds: 6, fade: 0.6, base: 0 });
});
