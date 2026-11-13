// media-ticker.test.mjs — the media surfaces' seek bar ticks: a native 1 s
// ticker advances the position and re-publishes PlaybackState + widget,
// and the widget layout actually has a progress bar to update.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "android-overlay");
const hub = readFileSync(join(root, "kotlin", "MediaHub.kt"), "utf8");
const widget = readFileSync(join(root, "res", "layout", "tm_widget.xml"), "utf8");

test("MediaHub runs a real ticker and starts it from init", () => {
  assert.ok(hub.includes("private fun startTick()"), "startTick");
  assert.ok(hub.includes("ticker"), "ticker var");
  assert.ok(hub.includes("startTick()\n  }"), "called from init");
  assert.ok(hub.includes("publishPlayback()"), "per-tick publish exists");
  assert.ok(hub.includes("publishPlayback()\n      s.isActive"), "publishSession calls the cheap publish");
  assert.ok(hub.includes("publishPlayback()\n            refreshWidgets()"), "ticker refreshes the widget too");
});

test("paused speed is 0.0 — playing 1.0", () => {
  assert.ok(hub.includes("if (playing) 1.0f else 0.0f"), "speed split");
  assert.ok(!/setState\(state, posMs, 1\.0f\)/.test(hub), "old always-1.0 form gone");
});

test("widget layout has the progress bar and bindWidget drives it", () => {
  assert.ok(widget.includes("tm_w_progress"), "layout id");
  assert.ok(widget.includes("progressBarStyleHorizontal"), "horizontal bar");
  assert.ok(hub.includes("R.id.tm_w_progress"), "bindWidget references it");
  assert.ok(hub.includes("setProgressBar"), "RemoteViews progress set");
  assert.ok(hub.includes("setViewVisibility"), "visibility gated on known duration");
});
