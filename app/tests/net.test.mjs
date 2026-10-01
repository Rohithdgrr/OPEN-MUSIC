// classify(): the network state machine behind the connection banner.
import test from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/net.js";

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
