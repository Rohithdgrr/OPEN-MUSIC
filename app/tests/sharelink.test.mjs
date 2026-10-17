// sharelink.test.mjs — pure builders (docs/share-deep-links.md §1, §6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  PLAY_PAGE,
  playUrl,
  deepUri,
  parseDeepUri,
  smallArtUrl,
  escapeVcardText,
  foldVcardLine,
  vcf,
  bytesToB64,
} from "../src/sharelink.js";

test("playUrl encodes id/title/artist and needs an id", () => {
  assert.equal(playUrl({}), null);
  assert.equal(playUrl({ id: 42 }), null); // id must be a string
  assert.equal(
    playUrl({ id: "43k5J4YX" }),
    `${PLAY_PAGE}?t=43k5J4YX`,
  );
  assert.equal(
    playUrl({ id: "a/b", title: "Tum Hi Ho", artist: "Arijit Singh" }),
    `${PLAY_PAGE}?t=a%2Fb&n=Tum%20Hi%20Ho&a=Arijit%20Singh`,
  );
});

test("deepUri + parseDeepUri round-trip the scheme form", () => {
  assert.equal(deepUri(""), "");
  const uri = deepUri("43k5J4YX");
  assert.equal(uri, "openmusic://t/43k5J4YX");
  assert.deepEqual(parseDeepUri(uri), { id: "43k5J4YX" });
});

test("parseDeepUri keeps the scheme form's identity when hints ride along", () => {
  // Android `am start -a VIEW -d "openmusic://t/<id>?n=…&a=…"` keeps the data
  // string verbatim — only the id segment is identity; n/a are display hints.
  assert.deepEqual(
    parseDeepUri("openmusic://t/43k5J4YX?n=Believer&a=Imagine%20Dragons"),
    { id: "43k5J4YX", title: "Believer", artist: "Imagine Dragons" },
  );
  assert.deepEqual(parseDeepUri("openmusic://t/43k5J4YX?n=Believer"), { id: "43k5J4YX", title: "Believer" });
  assert.deepEqual(parseDeepUri("openmusic://t/43k5J4YX"), { id: "43k5J4YX" });
});

test("parseDeepUri accepts the https page form with display hints", () => {
  const link = playUrl({ id: "a/b", title: "Gehra Hua", artist: "Jubin Nautiyal" });
  const parsed = parseDeepUri(link);
  assert.equal(parsed.id, "a/b");
  assert.equal(parsed.title, "Gehra Hua");
  assert.equal(parsed.artist, "Jubin Nautiyal");
  assert.equal(parseDeepUri(`${PLAY_PAGE}?n=x`), null); // required ?t=
  assert.equal(parseDeepUri("https://example.com/other?t=x"), null); // wrong path
  assert.equal(parseDeepUri("not a url"), null);
  assert.equal(parseDeepUri(null), null);
});

test("parseDeepUri walks Chrome intent URLs via browser_fallback_url", () => {
  const fb = encodeURIComponent(`${PLAY_PAGE}?t=IDX123&n=Probe`);
  const intent = `intent://t/IDX123#Intent;scheme=openmusic;package=com.openmusic.trancemusic;S.browser_fallback_url=${fb};end`;
  assert.deepEqual(parseDeepUri(intent), { id: "IDX123", title: "Probe" });
  const intent2 = "intent://t/REC999#Intent;scheme=openmusic;package=com.openmusic.trancemusic;end";
  assert.deepEqual(parseDeepUri(intent2), { id: "REC999" });
});

test("smallArtUrl only rewrites saavncdn 500x500 renders", () => {
  const art = "https://saavncdn.com/albums/abc_2025100101010101_500x500.jpg";
  assert.equal(smallArtUrl(art), "https://saavncdn.com/albums/abc_2025100101010101_150x150.jpg");
  assert.equal(smallArtUrl("http://saavncdn.com/a_2025100101010101_500x500.jpg"), "https://saavncdn.com/a_2025100101010101_500x500.jpg".replace("500x500", "150x150"));
  assert.equal(smallArtUrl("https://lh3.googleusercontent.com/xyz=w500-h500"), ""); // foreign host
  assert.equal(smallArtUrl("https://saavncdn.com/a_2025010101010101.jpg"), ""); // no large render to swap
  assert.equal(smallArtUrl(""), "");
});

test("escapeVcardText escapes the RFC 2426 set", () => {
  assert.equal(escapeVcardText("a\\b;c,d\ne"), "a\\\\b\\;c\\,d\\ne");
  assert.equal(escapeVcardText(null), "");
});

test("foldVcardLine folds over 75 with continuation space and no surrogate split", () => {
  const folded = foldVcardLine("x".repeat(80));
  assert.equal(folded, "x".repeat(75) + "\r\n " + "x".repeat(5));
  const emoji = "👍".repeat(50); // 100 code units, 50 pairs
  const f2 = foldVcardLine(emoji);
  const unfolded = f2.replace(/\r\n /g, "");
  assert.equal(unfolded.length, 100);
  assert.equal([...unfolded].length, 50); // every pair intact end to end
  assert.equal(foldVcardLine("short"), "short");
});

test("vcf carries the canonical url, note, and a folded inline PHOTO", () => {
  const b64 = "aJ1b3g=="; // JPEG prologue markers, deliberately tiny in tests
  const card = vcf({
    title: "Believer; Part 1",
    artist: "Imagine Dragons",
    url: playUrl({ id: "6DN9AmgT", title: "Believer; Part 1" }),
    photoB64: b64,
  });
  const lines = card.split("\r\n");
  assert.equal(lines[0], "BEGIN:VCARD");
  assert.equal(lines[1], "VERSION:3.0");
  assert.ok(lines.some((l) => l === 'N:;"Believer\\; Part 1";;;'));
  assert.ok(lines.some((l) => l === "FN:Believer\\; Part 1 — Imagine Dragons (OpenMusic)"));
  assert.ok(lines.some((l) => l.startsWith("URL:") && l.includes(playUrl({ id: "6DN9AmgT" }).slice(PLAY_PAGE.length + 1))));
  assert.ok(lines.some((l) => l === "PHOTO;TYPE=JPEG;ENCODING=BASE64:aJ1b3g=="));
  const tailLines = card.trimEnd().split("\r\n");
  assert.equal(tailLines.at(-1), "END:VCARD");
  // folded photo: long base64 must be folded, join whitespace-free
  const long = vcf({ title: "x", photoB64: "A".repeat(200) });
  const unfolded = long.replace(/\r\n /g, "");
  const photoLine = unfolded.split("\r\n").find((l) => l.startsWith("PHOTO"));
  assert.equal(photoLine.replace(/^(PHOTO;TYPE=JPEG;ENCODING=BASE64:)/, "").length, 200);
});

test("vcf omits PHOTO when there is no artwork", () => {
  const card = vcf({ title: "Solo", artist: "no art" });
  assert.ok(!card.includes("PHOTO"));
  assert.ok(card.includes("FN:Solo — no art (OpenMusic)"));
});

test("bytesToB64 chunks Uint8Array into one base64 string", () => {
  const bytes = new Uint8Array(0x8005).map((_, i) => (i * 7) & 0xff);
  const b64 = bytesToB64(bytes);
  assert.ok(b64.length > 10_000);
  assert.equal(b64, Buffer.from(bytes).toString("base64"));
  assert.equal(bytesToB64(new Uint8Array(0)), "");
});
