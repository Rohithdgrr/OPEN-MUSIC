import test from "node:test";
import assert from "node:assert/strict";

import { parseQueueSnapshot, hasRestorableQueue, queueSnapshot } from "../src/mobile/queue-persistence.js";

const track = (id, title) => ({ id, title, artist: "A" });

test("parseQueueSnapshot round-trips a snapshot it wrote", () => {
  const snap = queueSnapshot([track("a"), track("b")], 1, true, "all");
  const back = parseQueueSnapshot(JSON.stringify(snap));
  assert.equal(back.q[1].id, "b");
  assert.equal(back.i, 1);
  assert.equal(back.shuffle, true);
  assert.equal(back.repeat, "all");
});

test("parseQueueSnapshot rejects malformed payloads", () => {
  assert.equal(parseQueueSnapshot(null), null);
  assert.equal(parseQueueSnapshot(""), null);
  assert.equal(parseQueueSnapshot("not json"), null);
  assert.equal(parseQueueSnapshot("{}"), null);
  assert.equal(parseQueueSnapshot('{"q":[{"id":""}]}'), null);
  assert.equal(parseQueueSnapshot('{"i":1}'), null);
});

test("parseQueueSnapshot clamps a bogus index and drops id-less rows", () => {
  const back = parseQueueSnapshot('{"i": 99, "q": [{"id":"a"}, {"title":"no id"}]}');
  assert.ok(back);
  assert.deepEqual(back.q.map((t) => t.id), ["a"]);
  assert.equal(back.i, 0);
});

test("queueSnapshot drops id-less rows and honours cap", () => {
  const list = Array.from({ length: 250 }, (_, n) => track("t" + n));
  const snap = queueSnapshot([...list, { title: "no-id" }], 12, false, "off");
  assert.equal(snap.q.length, 200);
  assert.equal(snap.shuffle, false);
  assert.equal(snap.repeat, "off");
  assert.equal(snap.i, 12);
});

test("hasRestorableQueue is false for null/junk", () => {
  assert.equal(hasRestorableQueue(null), false);
  assert.equal(hasRestorableQueue("{}"), false);
  assert.equal(hasRestorableQueue('{"q":[{"id":"real"}]}'), true);
});
