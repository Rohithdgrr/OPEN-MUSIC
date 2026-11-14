import assert from "node:assert/strict";
import test from "node:test";
import { runContracts } from "../scripts/check-upstream-contracts.mjs";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("upstream contract checker validates search, resolve, and lyrics shapes", async () => {
  const requests = [];
  const checks = await runContracts({
    mirrorBase: "https://mirror.example",
    lrclibBase: "https://lyrics.example/api",
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (String(url).includes("/api/search/songs")) {
        return jsonResponse({ data: { results: [{ id: "track_1" }] } });
      }
      if (String(url).includes("/api/songs/")) {
        return jsonResponse({ data: [{ downloadUrl: [{ quality: "320kbps" }] }] });
      }
      return jsonResponse([]);
    },
  });

  assert.deepEqual(checks.map(({ ok }) => ok), [true, true, true]);
  assert.equal(requests.length, 3);
  assert.ok(requests[1].endsWith("/api/songs/track_1"));
});

test("upstream contract checker reports malformed shapes without retaining bodies", async () => {
  const checks = await runContracts({
    mirrorBase: "https://mirror.example",
    lrclibBase: "https://lyrics.example/api",
    fetchImpl: async (url) => (
      String(url).includes("/api/search/songs")
        ? jsonResponse({ data: { results: [] } })
        : jsonResponse({ error: "private response details" }, 503)
    ),
  });

  assert.deepEqual(checks.map(({ ok }) => ok), [false, false, false]);
  assert.ok(checks.every(({ detail }) => !detail?.includes("private response details")));
});
