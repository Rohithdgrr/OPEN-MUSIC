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
const IDS = [
  // header (the room code slot is filled only by a room_created frame)
  "btn-mode-solo", "btn-mode-social", "soc-room-chip", "soc-room-code", "soc-avatar",
  // artwork overlay + QR
  "np-trackline", "np-quality", "track-title-heading", "track-artist-heading",
  "track-fav-btn", "fav-icon", "np-download-btn", "np-add-btn", "np-share-btn",
  "np-album", "np-artist-tile", "np-length", "np-format", "spinning-vinyl-icon",
  "np-sleep", "np-speed", "np-room-members",
  "btn-qr", "qr-overlay", "qr-room-code", "qr-members-count",
  "btn-qr-copy", "btn-qr-close",
  // reactions + transport
  "reaction-bar", "reaction-note", "sync-clock-label", "soc-grace", "grace-timer",
  "btn-skip-vote", "skip-vote-label", "solo-prompt", "btn-activate-social",
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
