// classify() + mode(): the network state machine behind the connection
// banner, the header badge and the offline routing gate.
import test from "node:test";
import assert from "node:assert/strict";
import { classify, mode, netMode, setModePref } from "../src/net.js";

test("offline is always lost", () => {
  assert.equal(classify({ onLine: false }), "lost");
});

test("one failed probe reconnects, two declare loss", () => {
  assert.equal(classify({ ok: false, fails: 1 }), "reconnecting");
  assert.equal(classify({ ok: false, fails: 2 }), "lost");
});

test("a fast successful probe is online", () => {
  assert.equal(classify({ ms: 120 }), "online");
});

test("a slow round trip is slow", () => {
  assert.equal(classify({ ms: 1500 }), "slow");
  assert.equal(classify({ ms: 90, rtt: 400 }), "slow");
});

test("rtt of zero is no evidence, not slow", () => {
  assert.equal(classify({ ms: 90, rtt: 0 }), "online");
});

test("mode maps the four banner states onto three routing modes", () => {
  assert.equal(mode("online"), "online");
  assert.equal(mode("slow"), "degraded");
  assert.equal(mode("reconnecting"), "degraded");
  assert.equal(mode("lost"), "offline");
});

test("recovery needs three clean probes", () => {
  assert.equal(classify({ ms: 120, oks: 0 }), "reconnecting");
  assert.equal(classify({ ms: 120, oks: 2 }), "reconnecting");
  assert.equal(classify({ ms: 120, oks: 3 }), "online");
  // a full streak never hides a genuinely slow link
  assert.equal(classify({ ms: 1500, oks: 3 }), "slow");
});

test("metered save-data counts as degraded, never lost", () => {
  assert.equal(classify({ ms: 120, saveData: true }), "slow");
  assert.equal(classify({ onLine: false, saveData: true }), "lost");
});

test("a forced mode overrides the classification", () => {
  setModePref("offline");
  assert.equal(netMode(), "offline");
  setModePref("online");
  assert.equal(netMode(), "online");
  setModePref("auto");
  assert.equal(netMode(), "online"); // probe state is healthy by default
  setModePref(null); // leave no force behind for later tests
  assert.equal(netMode(), "online");
});
