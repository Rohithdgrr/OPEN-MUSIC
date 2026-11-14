import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleRoomMembers } from "../src/mobile/jam-roster.js";

test("the Home roster is empty outside an active room, even if stale members remain", () => {
  const staleMembers = [{ id: "guest-1", name: "Guest" }];
  assert.deepEqual(visibleRoomMembers("idle", staleMembers), []);
  assert.deepEqual(visibleRoomMembers("joining", staleMembers), []);
});

test("active-room roster keeps only named members and does not mutate room state", () => {
  const members = [
    { id: "host", name: "Host", host: true },
    null,
    { id: "blank", name: "  " },
    { id: "guest", name: "Guest", host: false },
  ];
  const before = structuredClone(members);
  assert.deepEqual(visibleRoomMembers("host", members), [members[0], members[3]]);
  assert.deepEqual(visibleRoomMembers("guest", members), [members[0], members[3]]);
  assert.deepEqual(members, before);
  assert.deepEqual(visibleRoomMembers("guest", null), []);
});
