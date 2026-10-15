// ai-lyrics.test.mjs — Gemini fallback core: key store, cache, and the
// API contract against stubbed fetch. No network, no DOM beyond the
// localStorage stub (ai-lyrics.js is DOM-free by design).
import { test } from "node:test";
import assert from "node:assert/strict";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => void mem.set(k, String(v)),
  removeItem: (k) => void mem.delete(k),
};

const ai = await import("../src/mobile/ai-lyrics.js");
const TRACK = { id: "t1", title: "Kesariya", artist: "Arijit Singh", album: "Brahmastra" };

const okFetch = (text) => async (url, opts) => {
  assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[^/]+:generateContent\?key=/);
  const body = JSON.parse(opts.body);
  assert.match(body.contents[0].parts[0].text, /Kesariya/);
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) };
};

test("key round-trips trimmed, missing key throws a settings hint", async () => {
  ai.setGeminiKey("  AIza-test  ");
  assert.equal(ai.getGeminiKey(), "AIza-test");
  assert.equal(ai.hasGeminiKey(), true);
  ai.setGeminiKey("");
  assert.equal(ai.hasGeminiKey(), false);
  await assert.rejects(ai.fetchAiLyrics(TRACK, { fetchFn: okFetch("x") }), /Settings/);
  ai.setGeminiKey("AIza-test");
});

test("lyrics resolve and are cached per track", async () => {
  let calls = 0;
  const counting = async (...a) => (calls++, okFetch("line one\nline two")(...a));
  const first = await ai.fetchAiLyrics(TRACK, { fetchFn: counting });
  assert.equal(first.text, "line one\nline two");
  assert.equal(first.cached, false);
  const second = await ai.fetchAiLyrics(TRACK, { fetchFn: counting });
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
});

test("UNKNOWN and empty responses throw readable errors", async () => {
  await assert.rejects(ai.fetchAiLyrics({ ...TRACK, id: "t2" }, { fetchFn: okFetch("UNKNOWN") }), /doesn't know/);
  await assert.rejects(ai.fetchAiLyrics({ ...TRACK, id: "t3" }, { fetchFn: okFetch("  ") }), /empty/);
});

test("bad keys and transport failures explain themselves", async () => {
  const denied = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "API key not valid" } }) });
  await assert.rejects(ai.fetchAiLyrics({ ...TRACK, id: "t4" }, { fetchFn: denied }), /rejected the key/);
  const down = async () => {
    throw new Error("boom");
  };
  await assert.rejects(ai.fetchAiLyrics({ ...TRACK, id: "t5" }, { fetchFn: down }), /connection/);
});

test("a fully retired chain (404 everywhere) says to update the app, and the default chain starts live", async () => {
  const gone = async () => ({ ok: false, status: 404, json: async () => ({ error: { message: "models/gemini-2.5-flash is not found" } }) });
  await assert.rejects(ai.fetchAiLyrics({ ...TRACK, id: "t6" }, { fetchFn: gone }), /update the app/);
  let seen = "";
  await ai.fetchAiLyrics(
    { ...TRACK, id: "t7" },
    { fetchFn: async (url, opts) => (seen = url, okFetch("la la")(...[url, opts])) },
  );
  assert.match(seen, /models\/gemini-flash-latest:generateContent/);
});

test("an overloaded (503) or quota-limited (429) model falls through to the next id", async () => {
  for (const status of [503, 429]) {
    const seen = [];
    let n = 0;
    const flaky = async (url, opts) => {
      seen.push(url);
      n += 1;
      if (n === 1) {
        return { ok: false, status, json: async () => ({ error: { message: status === 503 ? "high demand" : "quota exceeded" } }) };
      }
      return okFetch("rescued line")(url, opts);
    };
    const got = await ai.fetchAiLyrics({ ...TRACK, id: `adv-${status}` }, { fetchFn: flaky });
    assert.equal(got.text, "rescued line");
    assert.equal(seen.length, 2, `status ${status} should fall through exactly once`);
    assert.match(seen[0], /models\/gemini-flash-latest:generateContent/);
    assert.match(seen[1], /models\/gemini-2\.5-flash:generateContent/);
  }
});

test("every model down surfaces the provider message", async () => {
  const down = async () => ({ ok: false, status: 503, json: async () => ({ error: { message: "high demand from provider" } }) });
  await assert.rejects(ai.fetchAiLyrics({ ...TRACK, id: "t10" }, { fetchFn: down }), /high demand from provider/);
});

test("a pinned model is the only id tried", async () => {
  const seen = [];
  const gone = async (url) => (seen.push(url), { ok: false, status: 404, json: async () => ({ error: { message: "not found" } }) });
  await assert.rejects(
    ai.fetchAiLyrics({ ...TRACK, id: "t11" }, { fetchFn: gone, model: "gemini-2.0-flash" }),
    /update the app/,
  );
  assert.equal(seen.length, 1);
  assert.match(seen[0], /models\/gemini-2\.0-flash:generateContent/);
});

test("cache never grows without bound", async () => {
  for (let i = 0; i < 120; i += 1) {
    await ai.fetchAiLyrics({ ...TRACK, id: `cap-${i}` }, { fetchFn: okFetch(`song ${i}`) });
  }
  const raw = JSON.parse(mem.get("tm-ai-lyrics"));
  assert.ok(Object.keys(raw).length <= 100, `cache size ${Object.keys(raw).length}`);
});
