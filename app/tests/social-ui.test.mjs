// Social Now Playing shell: markup ↔ CSS contract.
// See docs/social-nowplaying.md (class inventory, id contract, visibility contract).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const html = fs.readFileSync(path.join(src, "index.html"), "utf8");
const css = fs.readFileSync(path.join(src, "styles.css"), "utf8");

// Elements Phase 3 wires up; renaming any of these breaks social.js.
// Removed on request (docs/social-nowplaying.md §6b): the bitstream pill
// (#np-badge) and the Solo invitation box (solo-prompt, btn-activate-social).
// The Room QR surface came back in §6c — a real symbol, not a glyph.
const IDS = [
  // header (the room code slot is filled only by a room_created frame)
  "btn-mode-solo", "btn-mode-social", "soc-room-chip", "soc-room-code", "soc-avatar",
  // artwork overlay
  "np-trackline", "np-quality", "track-title-heading", "track-artist-heading",
  "track-fav-btn", "fav-icon", "np-download-btn", "np-add-btn", "np-share-btn",
  "np-album", "np-artist-tile", "np-length", "np-format", "spinning-vinyl-icon",
  "np-sleep", "np-speed", "np-room-members",
  // room QR
  "btn-qr", "qr-overlay", "qr-canvas", "np-qr-empty", "qr-room-code",
  "qr-members-count", "btn-qr-copy", "btn-qr-close",
  // reactions + transport
  "reaction-bar", "reaction-note", "sync-clock-label", "soc-grace", "grace-timer",
  "btn-skip-vote", "skip-vote-label",
  // deck + queue
  "tab-btn-lyrics", "tab-btn-queue", "tab-btn-chat", "tab-btn-jam",
  "jam-member-pill", "queue-lock-badge", "btn-undo-crdt", "btn-lock-queue",
  "input-add-song", "btn-submit-song",
  // chat
  "np-panel-chat", "chat-messages-container", "chat-empty", "chat-input",
  "btn-chat-send", "btn-chat-quote", "chat-typing", "chat-online-count",
  "chat-rate-note",
  // jam
  "np-panel-jam", "jam-room-id", "jam-mode-label", "jam-session-mode",
  "jam-sync-value", "jam-vote-ratio", "jam-sidecar", "jam-sidecar-note", "jam-ua",
  "auto-level-toggle", "jam-members", "jam-members-note",
  "btn-open-room", "btn-copy-invite", "btn-leave-room",
];

test("every social / artwork-overlay class in index.html has a styles.css rule", () => {
  const used = new Set();
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    for (const cls of m[1].split(/\s+/)) {
      if (/^(soc-|np-art-|np-qr-)/.test(cls)) used.add(cls);
    }
  }
  assert.ok(used.size > 40, `expected the social markup, found ${used.size} classes`);
  const missing = [...used].filter((cls) => !css.includes(`.${cls}`));
  assert.deepEqual(missing, [], `classes without a CSS rule: ${missing.join(", ")}`);
});

test("the documented element ids exist exactly once", () => {
  const missing = IDS.filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, [], `ids missing from index.html: ${missing.join(", ")}`);
  const dupes = IDS.filter((id) => html.split(`id="${id}"`).length > 2);
  assert.deepEqual(dupes, [], `duplicate ids: ${dupes.join(", ")}`);
});

test("visibility contract is in place (body.soc-social gates both directions)", () => {
  assert.ok(css.includes("body:not(.soc-social) .soc-social-only"), "social-only gate missing");
  assert.ok(css.includes("body.soc-social .soc-solo-only"), "solo-only gate missing");
  assert.match(html, /<div class="[^"]*soc-social-only/, "no social-only markup");
  assert.match(html, /<div class="[^"]*soc-solo-only/, "no solo-only markup");
});

test("solo mode is the default and both modes are reachable from the header", () => {
  assert.match(html, /class="soc-mode-btn active" id="btn-mode-solo"/, "Solo must start active");
  assert.ok(html.includes('id="btn-mode-social"'), "Social button missing");
  assert.ok(!html.includes('body class="soc-social"'), "must not boot into Social mode");
});

test("counts stay honest: one member, zero reactions, sidecar not connected", () => {
  assert.match(html, />1 \(you\)</, "member count must start at 1 (you)");
  assert.equal((html.match(/soc-reaction-count">0</g) || []).length, 6, "six reactions, all at 0");
  assert.ok(html.includes("Not connected"), "sidecar state must be reported truthfully");
  assert.match(html, /id="btn-qr-copy"[^>]*\sdisabled/, "invite copy must stay disabled");
  assert.ok(!/SongDNA|song-dna/i.test(html), "SongDNA is explicitly out of scope");
});

test("the removed artwork chrome stays removed", () => {
  // Regression guard: these were pulled on request (§6b). A future "restore"
  // must be deliberate, not an accident of re-adding a stray block.
  for (const id of ["np-badge", "solo-prompt", "btn-activate-social"]) {
    assert.ok(!html.includes(`id="${id}"`), `${id} should be gone from index.html`);
  }
  assert.ok(!css.includes(".np-stream-pill"), "no .np-stream-pill rule should remain");
  assert.ok(!css.includes(".soc-solo-prompt"), "no .soc-solo-prompt rule should remain");
  // @keyframes np-pulse must survive: .soc-live-dot still animates with it.
  assert.ok(css.includes("@keyframes np-pulse"), "np-pulse keyframes are still used by .soc-live-dot");
  assert.ok(css.includes("animation: np-pulse"), "a live dot must still animate");
});

test("the room QR is a real symbol encoded in Rust, not a glyph", () => {
  // The surface used to draw a Material Symbols `qr_code_2` icon, which cannot
  // be scanned. Guard the three things that make it real now.
  const social = fs.readFileSync(path.join(src, "social.js"), "utf8");
  const qrview = fs.readFileSync(path.join(src, "qrview.js"), "utf8");
  const rust = fs.readFileSync(path.join(src, "..", "src-tauri", "src", "qr.rs"), "utf8");

  assert.match(qrview, /import \{ invoke \} from "\.\/core\.js";/, "the renderer must go through Tauri IPC");
  assert.match(qrview, /invoke\("qr_symbol"/, "the matrix must come from the Rust command");
  assert.match(social, /paintQr\(canvas, code\)/, "opening the surface must paint the symbol");
  assert.match(rust, /QrCode::with_error_correction_level\(text, EcLevel::M\)/, "Rust owns the encoding");
  assert.match(rust, /rqrr/, "the Rust tests must round-trip the symbol through a decoder");

  // An empty state, so a roomless app never shows a scannable-looking plate.
  assert.match(html, /id="np-qr-empty"/, "the surface needs an honest empty state");
  assert.match(social, /if \(!code\)/, "no code must mean no symbol, not a blank one");

  // No CDN QR library: the app is offline-first and has no bundler.
  assert.ok(!/cdn|unpkg|jsdelivr/i.test(qrview + rust), "QR must not depend on a CDN");
});

test("four deck tabs map to four panels", () => {
  for (const tab of ["lyrics", "queue", "chat", "jam"]) {
    assert.ok(html.includes(`data-np-tab="${tab}"`), `missing tab: ${tab}`);
  }
  for (const panel of ["lyrics-card", "np-panel-queue", "np-panel-chat", "np-panel-jam"]) {
    assert.ok(html.includes(`id="${panel}"`), `missing panel: ${panel}`);
  }
  const main = fs.readFileSync(path.join(src, "main.js"), "utf8");
  for (const panel of ["np-panel-chat", "np-panel-jam"]) {
    assert.ok(main.includes(`"${panel}"`), `main.js deck switcher must know ${panel}`);
  }
});

// ---------------------------------------------------------------- Phase 3 -
test("main.js boots the social shell", () => {
  const main = fs.readFileSync(path.join(src, "main.js"), "utf8");
  assert.match(main, /import \{ initSocial \} from "\.\/social\.js";/, "social.js not imported");
  assert.match(main, /initSocial\(\);/, "initSocial() never called");
});

test("social.js is local-only: no network, no innerHTML", () => {
  const social = fs.readFileSync(path.join(src, "social.js"), "utf8");
  for (const api of ["fetch(", "WebSocket", "EventSource", "XMLHttpRequest", "sendBeacon"]) {
    assert.ok(!social.includes(api), `social.js must not use ${api} until the sidecar lands`);
  }
  assert.ok(!/\.innerHTML\s*=/.test(social), "chat/queue DOM must be built with createElement + textContent");
  assert.match(social, /const MEMBERS = 1;/, "member count must be a room of one");
});

test("chat composer appends text nodes, never markup", () => {
  const social = fs.readFileSync(path.join(src, "social.js"), "utf8");
  assert.match(social, /body\.textContent = text/, "chat body must be assigned as text");
  assert.match(social, /audio\.addEventListener\("pause", showGrace\)/, "grace window must track real pauses");
  assert.match(social, /new MutationObserver/, "reactions must reset when the track changes");
});

// ---------------------------------------------------------------- Phase 4a -
test("no fabricated room codes or PINs remain in the markup", () => {
  assert.ok(!html.includes("TRNC-8241"), "room codes come from room_created only");
  assert.ok(!html.includes("0451"), "the preview PIN was a fabrication; the protocol has none");
  // #qr-room-code went with the QR surface in §6b and returned in §6c; the two
  // surviving room-code slots carry the same "starts empty, filled only by
  // room_created" rule.
  assert.match(html, /id="qr-room-code">NO ROOM</, "QR code must start empty");
  assert.match(html, /id="jam-room-id">NO ROOM</, "jam room id must start empty");
  assert.match(html, /id="soc-room-code">NO ROOM</, "header room chip must start empty");
  assert.match(html, /id="btn-open-room"[^>]*\sdisabled/, "room creation needs a live connection");
});

test("social.js drives the sidecar bridge instead of opening sockets itself", () => {
  const social = fs.readFileSync(path.join(src, "social.js"), "utf8");
  assert.match(social, /import \{ createSidecar, readPort, STATUS \} from "\.\/sidecar\.js";/);
  assert.match(social, /startSidecar\(\);/, "entering Social must probe for the sidecar");
  assert.match(social, /stopSidecar\(\);/, "leaving Social must tear the sidecar down");
  assert.match(social, /#btn-open-room"\)\?\.addEventListener\("click", openRoom\)/);
  assert.match(social, /#btn-copy-invite"\)\?\.addEventListener\("click", copyInvite\)/);
  for (const api of ["fetch(", "WebSocket", "EventSource", "XMLHttpRequest", "sendBeacon"]) {
    assert.ok(!social.includes(api), `social.js must not use ${api}; the bridge lives in sidecar.js`);
  }
});

test("sidecar bridge is loopback-only and fails closed", () => {
  const bridge = fs.readFileSync(path.join(src, "sidecar.js"), "utf8");
  assert.match(bridge, /const LOOPBACK = "127\.0\.0\.1";/, "loopback constant missing");
  // every URL is built from LOOPBACK — no other host may appear after a scheme
  assert.ok(
    !/(https?|wss?):\/\/(?!127\.0\.0\.1|\$\{LOOPBACK\})/.test(bridge),
    "sidecar.js must address 127.0.0.1 only",
  );
  assert.ok(!/\.innerHTML\s*=/.test(bridge), "no innerHTML in the bridge");
  // A room code may only exist once the server sent one.
  assert.match(bridge, /case "room_created"/, "room codes must come from the server frame");
  assert.match(bridge, /state\.roomCode = room\.roomCode;/);
});

test("the ws scheme is in the Tauri CSP, health probes were already allowed", () => {
  const conf = fs.readFileSync(
    path.join(src, "..", "src-tauri", "tauri.conf.json"),
    "utf8",
  );
  assert.match(conf, /connect-src[^;]*ws:\/\/127\.0\.0\.1:\*/, "ws:// loopback missing from connect-src");
  assert.match(conf, /connect-src[^;]*http:\/\/127\.0\.0\.1:\*/, "http:// loopback missing from connect-src");
});

// ------------------------------------------------- ANJI / T-106 slot table -
// Spec: docs/social-nowplaying.md §3b-i (slot table) + §6 (truthfulness).
//
// Gap this closes: the file above already asserted the slots *start* as
// NO ROOM, but never that social.js's own ROOM_SLOTS list agrees with the
// markup. A renamed or dropped slot was therefore a silent dead write — the
// JS would keep painting an element that no longer exists, and no test failed.

const ROOM_SLOT_IDS = ["soc-room-code", "qr-room-code", "jam-room-id"];

function roomSlotsFromSocial() {
  const social = fs.readFileSync(path.join(src, "social.js"), "utf8");
  const decl = social.match(/const ROOM_SLOTS = \[([^\]]*)\]/);
  assert.ok(decl, "ROOM_SLOTS list not found in social.js");
  return [...decl[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

test("social.js drives every room-code slot from one list with one fallback", () => {
  const social = fs.readFileSync(path.join(src, "social.js"), "utf8");
  assert.match(
    social,
    /const text = code \|\| "NO ROOM";/,
    "all slots must share a single NO ROOM fallback, so a refusal blanks every one",
  );
  assert.deepEqual(
    roomSlotsFromSocial().slice().sort(),
    [...ROOM_SLOT_IDS].sort(),
    "the §3b-i slot table and social.js must name the same ids",
  );
});

test("every id in social.js's slot list exists in the markup (no dead writes)", () => {
  for (const id of roomSlotsFromSocial()) {
    assert.ok(
      html.includes(`id="${id}"`),
      `ROOM_SLOTS paints "${id}" but index.html has no such id — a silent dead write`,
    );
  }
});

test("every room-code slot starts as the literal NO ROOM", () => {
  for (const id of ROOM_SLOT_IDS) {
    assert.match(
      html,
      new RegExp(`id="${id}">NO ROOM<`),
      `${id} must start empty and be filled only by a server frame`,
    );
  }
});

test("§6: the typing indicator stays hidden until a real peer exists", () => {
  assert.match(
    html,
    /class="soc-typing hidden" id="chat-typing"[^>]*aria-hidden="true"/,
    "chat-typing must ship hidden + aria-hidden; a peer may only reveal it",
  );
});

test("§3b: invite copy ships disabled and no code is ever prefilled", () => {
  assert.match(html, /id="btn-copy-invite"[^>]*\sdisabled/, "invite copy must start disabled");
  assert.match(html, /id="btn-qr-copy"[^>]*\sdisabled/, "QR copy must start disabled");
  assert.match(html, /id="btn-open-room"[^>]*\sdisabled/, "room creation needs a live connection");
  // A preview code would make an unconnected app look like it has a room.
  for (const fake of ["TRNC-", "NO ROOM7", "12345678", "PIN "]) {
    assert.ok(!html.includes(fake), `markup must not contain a placeholder code: ${fake}`);
  }
});

test("§6: no fabricated listener counts anywhere in the visible markup", () => {
  // Strip tags first: this must judge *rendered text*, not class names.
  // A naive /html/ scan matches Tailwind's own `bg-neutral-300 peer-focus:`
  // (the "peer" variant), which is a false positive, not a listener count.
  const visibleText = html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  assert.ok(
    !/\b\d+\s*(listeners?|people|peers?)\b/i.test(visibleText),
    "a rendered listener/peer number would be decoration, not a server fact",
  );
  // The honest defaults must still be the ones §6 names.
  assert.match(visibleText, /1 \(you\)/, "member count must read 1 (you) with no room");
  assert.match(visibleText, /Not connected/, "sidecar must read Not connected with no bridge");
  assert.ok(!/SongDNA|song-dna/i.test(html), "SongDNA is explicitly out of scope");
});

test("§3b's documented timeouts still match sidecar.js (doc-drift guard)", () => {
  // These are the numbers a reader trusts to predict behaviour. If a constant
  // moves and the prose does not, the doc starts lying — so assert both sides.
  const bridge = fs.readFileSync(path.join(src, "sidecar.js"), "utf8");
  const doc = fs.readFileSync(path.join(src, "..", "..", "docs", "social-nowplaying.md"), "utf8");

  assert.match(bridge, /probe:[^,\n]*1500/, "health probe timeout must stay 1500 ms");
  assert.match(bridge, /ping:[^,\n]*15000/, "keepalive ping interval must stay 15000 ms");
  assert.match(bridge, /handshake:[^,\n]*5000/, "handshake deadline must stay 5000 ms");

  assert.match(doc, /1\.5 s/, "§3b must document the 1.5 s health probe");
  assert.match(doc, /every 15 s/, "§3b must document the 15 s keepalive");
  assert.match(doc, /\*\*5 s\*\*/, "§3b must document the 5 s handshake deadline");
});

test("§3b: the app reports its own UA and never alters it", () => {
  const social = fs.readFileSync(path.join(src, "social.js"), "utf8");
  assert.match(social, /navigator\.userAgent/, "#jam-ua must show the real UA");
  for (const f of ["social.js", "sidecar.js", "main.js", "room.js"]) {
    const body = fs.readFileSync(path.join(src, f), "utf8");
    assert.ok(
      !/setUserAgent|\buserAgent\s*=/.test(body),
      `${f} must never alter the user agent — the operator's ua_policy.json reads the real one`,
    );
  }
});
