// jam-ui.test.mjs — mobile Listen Together contract (ROOM.md C-6, docs/listen-together.md §12/§13.2).
//
// The mobile screen is generated from a design export that shipped *demo*
// values — a room code, a listener count, a ping, a bitrate, two chat messages
// and four tracks that never existed. §8 forbids showing any of them, so this
// gate asserts both halves: the real ids are present, and the demo values are
// gone. It also pins the pieces `jam.js` must keep doing (same commands, same
// reducer, no fabricated counts) and the legacy ids `binders.js` needs to paint
// the real player.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const html = fs.readFileSync(path.join(src, "mobile", "screens", "nowplaying.html"), "utf8");
const screenJs = fs.readFileSync(path.join(src, "mobile", "screens", "nowplaying.js"), "utf8");
const jam = fs.readFileSync(path.join(src, "mobile", "jam.js"), "utf8");
const settingsHtml = fs.readFileSync(path.join(src, "mobile", "screens", "settings.html"), "utf8");
const app = fs.readFileSync(path.join(src, "mobile", "app.js"), "utf8");
const binders = fs.readFileSync(path.join(src, "mobile", "binders.js"), "utf8");

// ROOM.md C-6 — the social-only ids. Renaming one breaks jam.js silently, which
// is exactly the failure this list exists to catch.
// `artworkCollabTag` was retired 2026-10-10 (clean-art batch): the artwork is
// art-only now, and jam.js's setText no-ops on the missing node.
const C6 = [
  // chrome
  "modeToggleBtn", "headerSubtitle", "headerTitle", "headerModeDot",
  "jamSessionBanner", "copyUriBtn", "skipVoteBadge", "tabBar",
  "view-queue", "view-chat", "view-jam-data", "view-lyrics",
  "queueTabLabel", "queueSyncBadge", "queueHeaderLabel", "chatTabBtn", "jamDataTabBtn",
  // jam set
  "jamBannerCode", "jamBannerCount", "jamBannerDrift", "jamBannerMembers",
  "jamMemberValue", "jamQueueList", "jamAppendInput", "jamAppendBtn",
  "jamChatList", "jamChatInput", "jamChatSend", "jamChatUnread", "jamRoleBadge", "jamRoomTitle",
  "jamInviteUri", "jamInviteCopy", "jamDriftValue", "jamMemberRow", "jamLeaveBtn", "jamEndBtn",
];

// Additions this milestone documents (docs/listen-together.md §13.2): the room
// member list, the chat/append status lines and the local paint hooks.
const ADDED = [
  "jamMembersList", "jamChatState", "jamAppendNote", "jamTransportNote",
  "np-title", "np-artist", "np-album", "np-art", "more-options-btn",
];

// binders.js paints/wires the real player through these; the design export
// renamed them (mainPlayBtn/scrubberTrack/favoriteBtn), which freezes the screen.
const LEGACY = [
  "master-play-pause", "play-pause-icon", "scrubber-container", "scrubber-bar",
  "scrubber-needle", "elapsed-time", "remaining-time", "favorite-btn",
  "favorite-icon", "shuffle-btn", "repeat-btn",
];

test("the C-6 id contract exists exactly once on the mobile screen", () => {
  for (const id of [...C6, ...ADDED, ...LEGACY]) {
    assert.ok(html.includes(`id="${id}"`), `${id} is missing from nowplaying.html`);
    assert.equal(
      html.split(`id="${id}"`).length,
      2,
      `${id} appears more than once — every slot is painted by id`,
    );
  }
});

test("the transport row keeps the ids binders.js paints", () => {
  for (const label of ["Previous", "Next", "Play / pause"]) {
    assert.ok(html.includes(`aria-label="${label}"`), `binders.js keys off aria-label="${label}"`);
  }
  // The design's play/pause and scrubber ids must NOT come back: binders.js
  // would silently stop painting, leaving a static mock UI.
  for (const stale of ["mainPlayBtn", "playIcon", "scrubberTrack", "favoriteBtn", "favoriteIcon"]) {
    assert.ok(!html.includes(`id="${stale}"`), `${stale} was renamed — binders.js cannot paint it`);
  }
});

test("no fabricated design values survive on the screen", () => {
  const visibleText = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
  const fabrications = [
    "#OM-904", "OM-904", "<14ms", "DEMOCRATIC NTP", "1.4 KB/s", "0.02 ms",
    "94%", "2 / 4", "Listeners Active", "5.0 seconds", "15ms", "RTT",
    "Madhosh", "Tanishk", "Faheem", "Neon Horizons", "Crystalline",
    "Kaelen", "Aura Sound", "Lossless master stream", "Sound stage depth",
  ];
  for (const value of fabrications) {
    assert.ok(!visibleText.includes(value), `the export's placeholder "${value}" is still rendered`);
  }
  // The honest empty states must be there instead.
  assert.ok(visibleText.includes("NO ROOM"), "the banner must say NO ROOM before a room exists");
  assert.ok(visibleText.includes("Not playing"), "the header must not invent a track");
  assert.ok(visibleText.includes("No room"), "Jam Data must say there is no room");
});

test("social chrome ships hidden: Solo is the default state", () => {
  // `hidden` may sit anywhere in the class list, and other attributes may sit
  // between class and id — read the whole opening tag.
  const tagFor = (id) => {
    const at = html.indexOf(`id="${id}"`);
    if (at < 0) return "";
    return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at));
  };
  for (const id of ["jamSessionBanner", "chatTabBtn", "jamDataTabBtn", "skipVoteBadge", "queueSyncBadge"]) {
    const tag = tagFor(id);
    assert.ok(tag, `#${id} does not exist`);
    assert.match(tag, /\bhidden\b/, `#${id} must ship hidden — Solo cannot show room chrome`);
  }
  assert.match(html, /id="jamAppendInput" disabled/, "the append row ships disabled");
  assert.match(html, /id="jamAppendBtn" disabled/, "the append button ships disabled");
  assert.ok(html.includes("no room append frame"), "the append row must state why it is disabled");
});

test("the Social view offers an explicit create/join entry point", () => {
  // The report: "no UI in Social for create room / join room; create shows no
  // QR". The screen now carries its own CTA with real buttons, and creating a
  // room lands on the invite QR.
  const tagFor = (id) => {
    const at = html.indexOf(`id="${id}"`);
    if (at < 0) return "";
    return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at));
  };
  for (const id of ["jamNoRoomCta", "jamCreateBtn", "jamJoinBtn"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} is missing from nowplaying.html`);
    assert.equal(html.split(`id="${id}"`).length, 2, `${id} appears more than once`);
  }
  assert.match(tagFor("jamNoRoomCta"), /\bhidden\b/, "the CTA ships hidden — Solo is the default");
  assert.match(jam, /createBtn\.addEventListener\("click", \(\) => void startRoom\(\)\)/, "Create must open a room");
  assert.match(jam, /joinBtn\.addEventListener\("click", \(\) => promptJoin\(\)\)/, "Join must open the paste/scan sheet");
  assert.match(jam, /show\(el\("jamNoRoomCta"\), social && !inRoom, "flex"\)/, "the CTA shows only in Social with no room");
  assert.match(jam, /switchTab\("jam-data"\)/, "creating a room must reveal the invite QR");
});

test("display name copy names Home and Jam", () => {
  assert.match(settingsHtml, /Home greeting and as your name in a Jam/);
});

test("jam.js is the mobile twin of the desktop glue", () => {
  for (const cmd of ["room_open", "room_join_uri", "room_chat", "room_playback", "room_report", "room_close", "room_info"]) {
    assert.ok(jam.includes(`"${cmd}"`), `jam.js never calls ${cmd}`);
  }
  assert.match(jam, /from "\.\.\/room\.js"/, "jam.js must share the desktop reducer, not fork one");
  assert.match(jam, /reduceRoom\(room, frame\)/, "frames must be reduced, not interpreted ad hoc");
  assert.match(jam, /memberCount\(room\)/, "member counts come from the reducer");
  assert.match(jam, /inviteText\(room\)/, "the invite line comes from the reducer");
  assert.match(jam, /syncDecision\(room,/, "drift must use the shared measurement");
  assert.match(jam, /listen\("room:\/\/msg"/, "frames must arrive through the room://msg event");
  assert.match(jam, /roomDisplayName/, "Jam roster name comes from Settings tm-name");
  assert.match(jam, /roomName\("Host"\)/, "reload-adopt must use the profile name, not the literal Host");
  assert.match(jam, /roomTickKind/, "chat frames must not reset the host/guest tick");
  assert.match(jam, /shouldRetryJoinAfterError/, "dial-fail during rejoin must retry, first join must not");
  assert.match(jam, /isStaleLocalBye/, "late room_close bye must not idle a live guest");
  assert.match(jam, /shouldKeepRejoinAfterBye/, "cleanup bye must not cancel a lost-socket redial");
  assert.match(jam, /Still connecting/, "chat while joining must not local-echo");
  assert.match(jam, /Array.isArray\(info.urls\)/, "host adopt uses room_info urls, not loopback");
  assert.match(jam, /"ended"/, "auto-advance must broadcast immediately");
  assert.ok(!/key !== hostKey \|\| !st\.paused/.test(jam), "paused host must still heartbeat");
  // No socket of its own: Rust owns both ends.
  for (const api of ["new WebSocket", "EventSource", "XMLHttpRequest", "fetch(\""]) {
    assert.ok(!jam.includes(api), `jam.js must not open a socket (${api})`);
  }
});

test("jam.js builds messages as text nodes, never as interpolated markup", () => {
  // Static template markup is fine (the join sheet); anything interpolated must
  // go through textContent so a peer's chat line can never be markup.
  assert.ok(
    !/innerHTML\s*=\s*[^;]*\$\{/.test(jam),
    "an interpolated innerHTML assignment is an injection point",
  );
  assert.match(jam, /text\.textContent = entry\.text;/, "chat bodies must be text");
  assert.match(jam, /btn\.textContent = row\.label;/, "sheet rows must be text");
  assert.match(jam, /head\.textContent = title;/, "sheet titles must be text");
});

test("the generated screen script keeps only the tab switcher", () => {
  assert.match(screenJs, /function switchTab\(targetTab\)/, "switchTab is what the tab buttons call");
  for (const demo of ["isPlaying", "isFav", "copyBtn.innerHTML", "applyMode"]) {
    assert.ok(!screenJs.includes(demo), `the export's demo script (${demo}) must stay removed`);
  }
});

test("app.js boots the jam layer before the queued first mount", () => {
  assert.match(app, /import \{ initJam \} from "\.\/jam\.js";/);
  const call = app.indexOf("initJam();");
  const flush = app.indexOf("onSmount({ detail: pendingSmount })");
  assert.ok(call > 0, "initJam is never called");
  assert.ok(flush > 0, "the queued-mount flush moved — this test needs updating");
  assert.ok(call < flush, "a deep link into NowPlaying would mount with no jam bindings");
});

test("a guest's transport is locked with a stated reason", () => {
  assert.match(jam, /const GUEST_LOCK = \["master-play-pause", "shuffle-btn", "repeat-btn"\]/);
  assert.match(jam, /node\.disabled = locked;/);
  assert.match(jam, /aria-label="Previous"/, "the skip buttons are keyed by aria-label, like binders.js");
  assert.match(jam, /show\(el\("jamTransportNote"\), locked\)/, "the reason must be visible");
  assert.ok(html.includes("The host controls playback in this room."), "that note needs real copy");
});

test("the queue tab is binders.js's real queue, not a second one", () => {
  // One list: [data-upnext-list] is where binders.js paints the local queue, and
  // in a host's session that queue *is* the room queue (§12).
  assert.match(html, /data-upnext-list id="jamQueueList"/);
  assert.match(binders, /\[data-upnext-list\]/);
});

test("the mobile screen binds to the ids binders.js now paints by id", () => {
  for (const id of ["np-title", "np-artist", "np-album"]) {
    assert.ok(binders.includes(`document.getElementById("${id}")`), `binders.js should paint #${id}`);
  }
});

// ---- B-T2 scan-to-join (docs/jam-upgrade.md §4.1–4.2, P38) ----------------

test("scan-to-join: one button, real overlay ids, decoder loaded, same join path", () => {
  const idx = fs.readFileSync(path.join(src, "mobile", "index.html"), "utf8");
  assert.ok(jam.includes('id="jam-scan-btn"'), "the join sheet needs the Scan QR button");
  assert.ok(jam.includes('id="jam-scanner-video"'), "the scanner preview video is missing");
  assert.ok(jam.includes('id="jam-scanner-status"'), "the scanner status line is missing");
  assert.ok(jam.includes('id="jam-scanner-cancel"'), "the scanner needs Cancel — paste stays the fallback");
  assert.match(jam, /import \{ startScanner \} from "\.\/scanner\.js";/, "jam.js must import the scanner");
  assert.match(
    jam,
    /onScan: \(\{ uri \}\) => \{[\s\S]*?void joinRoom\(uri\)/,
    "a scan hit must join through the same room_join_uri path as a paste",
  );
  assert.match(idx, /<script src="\.\.\/vendor\/jsQR\.js"><\/script>/, "mobile/index.html must load the vendored decoder");
  assert.ok(
    idx.indexOf("vendor/jsQR.js") < idx.indexOf('type="module" src="app.js"'),
    "the decoder must be a classic script before the module graph runs",
  );
});

test("P38: BarcodeDetector must not come back — it looks available and decodes nothing", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(js|html|mjs)$/.test(entry.name) && !full.includes(`${path.sep}vendor${path.sep}`)) {
        if (fs.readFileSync(full, "utf8").includes("new BarcodeDetector")) offenders.push(full);
      }
    }
  };
  walk(src);
  assert.deepEqual(offenders, [], "no source file may construct BarcodeDetector (silent empty results, P38)");
});
