// Unit tests for the Now Playing art tint (pure colour maths).
import { test } from "node:test";
import assert from "node:assert/strict";
import { tintFromPixels, tintCss } from "../src/mobile/arttint.js";

test("a coloured cover yields that colour", () => {
  const px = new Uint8ClampedArray(64);
  for (let i = 0; i < 64; i += 4) {
    px[i] = 200; px[i + 1] = 40; px[i + 2] = 40; px[i + 3] = 255;
  }
  const rgb = tintFromPixels(px);
  assert.ok(rgb, "a red cover must produce a tint");
  assert.ok(rgb.r > rgb.g && rgb.r > rgb.b, `expected red-dominant, got ${JSON.stringify(rgb)}`);
});

test("a grey cover still tints (the page should follow the artwork)", () => {
  const px = new Uint8ClampedArray(64);
  for (let i = 0; i < 64; i += 4) {
    px[i] = 128; px[i + 1] = 128; px[i + 2] = 128; px[i + 3] = 255;
  }
  const rgb = tintFromPixels(px);
  assert.ok(rgb, "a grey cover must still produce a tint");
  assert.ok(Math.abs(rgb.r - 128) < 40, `expected a grey tint, got ${JSON.stringify(rgb)}`);
});

test("a near-black cover produces no tint", () => {
  const px = new Uint8ClampedArray(64);
  for (let i = 0; i < 64; i += 4) {
    px[i] = 4; px[i + 1] = 4; px[i + 2] = 6; px[i + 3] = 255;
  }
  assert.equal(tintFromPixels(px), null);
});

test("empty or short input is handled", () => {
  assert.equal(tintFromPixels(null), null);
  assert.equal(tintFromPixels(new Uint8ClampedArray(2)), null);
  assert.equal(tintFromPixels(new Uint8ClampedArray(0)), null);
});

test("the css value is an rgba string with the requested alpha", () => {
  assert.equal(tintCss({ r: 10, g: 20, b: 30 }, 0.16), "rgba(10, 20, 30, 0.16)");
  assert.equal(tintCss(null), "");
});
