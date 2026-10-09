// T7 Step 3 — REAL LAN join: emulator guest dials ws://<pc-lan-ip>:8787 with
// adb reverse/forward removed. Covers Review Focus 1 + chat both ways +
// playback follow (D1 catalog path) + the Task-6 open question (guest rejoin
// after host bye: does the backend refuse "Leave the current room..."? — D5,
// fixed 2026-10-08; this probe is its regression gate).
// Part of the standing two-device gate: docs/listen-together.md §10.
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const SDK = process.env.ANDROID_HOME || "C:/Users/rohit/AppData/Local/Android/Sdk";
const ADB = `${SDK}/platform-tools/adb`;
const PKG = "com.openmusic.trancemusic";
let fails = 0;
const assert = (ok, name, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!ok) fails++;
};
const adb = (...a) => execFileSync(ADB, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const adbTry = (...a) => { try { return adb(...a); } catch { return ""; } };

// ---------- generic CDP ----------
function cdpClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
    ws.addEventListener("open", () => resolve({
      evalJs: (expression) => new Promise((res, rej) => {
        const id = ++seq;
        pending.set(id, (m) => m.result?.exceptionDetails ? rej(new Error(m.result.exceptionDetails.exception?.description || "eval err")) : res(m.result?.result?.value));
        ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
      }),
      close: () => ws.close(),
    }));
    ws.addEventListener("error", reject);
  });
}
const waitForCli = async (cli, expr, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await cli.evalJs(expr)) return true; } catch { /* not ready */ }
    await delay(250);
  }
  return false;
};

// ---------- desktop host ----------
const dTargets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const dPage = dTargets.find((t) => t.type === "page" && !/widget/i.test(t.url || ""));
const desk = await cdpClient(dPage.webSocketDebuggerUrl);
const dEval = (expr) => desk.evalJs(expr);
const roomInfo = () => dEval('window.__TAURI__.core.invoke("room_info").then(i=>JSON.stringify(i))').then(JSON.parse);
const atD = (id) => dEval(`(document.getElementById("${id}")||{}).textContent`);

async function deskOpenRoom() {
  await dEval(`(async () => { const a = document.querySelector('a[data-path="now-playing"]'); if (a && document.querySelector("[data-view]:not(.hidden)")?.getAttribute("data-view") !== "now-playing") a.click(); await new Promise(r=>setTimeout(r,400));
    if (!document.body.classList.contains("soc-social")) document.querySelector("#btn-mode-social").click(); await new Promise(r=>setTimeout(r,700));
    document.querySelector("#tab-btn-jam")?.click(); await new Promise(r=>setTimeout(r,300));
    const b = document.querySelector("#btn-open-room"); if (b && !b.disabled) b.click(); await new Promise(r=>setTimeout(r,1500)); })()`);
  return roomInfo();
}
async function deskLeave() {
  await dEval(`(async () => { document.querySelector("#tab-btn-jam")?.click(); await new Promise(r=>setTimeout(r,300));
    document.querySelector("#btn-leave-room")?.click(); await new Promise(r=>setTimeout(r,800)); })()`);
}

// ---------- android guest ----------
// Remove ALL adb tunnels first — the whole point of Review Focus 1.
adbTry("reverse", "--remove-all");
adbTry("forward", "--remove-all");
const pid = (adbTry("shell", "pidof", "-s", PKG) || "").trim();
if (!pid) { console.log("FAIL app not running on emulator"); process.exit(1); }
const unix = adb("shell", "cat /proc/net/unix");
const sock = [...unix.matchAll(/webview_devtools_remote_\d+/g)].map((m) => m[0]).pop();
adb("forward", "tcp:9223", `localabstract:${sock}`);
const mTargets = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const mPage = mTargets.find((t) => t.type === "page");
const mob = await cdpClient(mPage.webSocketDebuggerUrl);
const mEval = (expr) => mob.evalJs(expr);
const atM = (id) => mEval(`(document.getElementById("${id}")||{}).textContent`);
const roomInfoM = () => mEval('window.__TAURI__.core.invoke("room_info").then(i=>JSON.stringify(i))').then(JSON.parse);

async function mobileJoin(addr, code) {
  await mEval(`(async () => { location.hash = "#/nowplaying"; await new Promise(r=>setTimeout(r,500));
    document.getElementById("modeToggleBtn")?.click(); await new Promise(r=>setTimeout(r,400));
    const b = [...document.querySelectorAll("button")].find(b=>/Join a Jam/.test(b.textContent)); if (b) b.click();
    await new Promise(r=>setTimeout(r,500)); })()`);
  const hasCard = await waitForCli(mob, '!!document.getElementById("jam-join-invite")', 5000);
  if (!hasCard) return { ok: false, why: "no-join-card" };
  // One pasted link, canonical form (A): both layers parse it.
  const [host, port] = addr.includes(":") ? addr.split(":") : [addr, "8787"];
  const uri = `trancemusic://join?host=${host}&port=${port}&code=${code}`;
  await mEval(`(() => { const e=document.getElementById("jam-join-invite"); e.value=${JSON.stringify(uri)}; e.dispatchEvent(new Event("input",{bubbles:true})); return "ok"; })()`);
  await mEval(`document.getElementById("jam-join-go")?.click()`);
  return { ok: true };
}

console.log("== setup: desktop hosts a room ==");
const room1 = await deskOpenRoom();
assert(room1.role === "host", "desktop room open", JSON.stringify({ code: room1.code, urls: room1.urls }));
const lanUrl = (room1.urls || [])[0]; // default-route LAN IP (lan_urls preference)
const lanHost = String(lanUrl || "").replace(/^ws:\/\//, "");
assert(/^[\d.]+:\d+$/.test(lanHost), "room advertises LAN dial address", lanUrl);
// Reachability from the DEVICE first (clear diagnosis if join fails).
const reach = adbTry("shell", `toybox nc -z -w 2 ${lanHost.split(":")[0]} ${lanHost.split(":")[1]}; echo RC=$?`);
assert(/RC=0/.test(reach), "device can reach host LAN address", `nc said: "${reach}"`);

console.log("== step: emulator guest joins over REAL LAN (no adb tunnels) ==");
const j1 = await mobileJoin(lanHost.split(":")[0], room1.code);
assert(j1.ok, "join sheet filled", JSON.stringify(j1));
const hostSees2 = await waitForCli(desk, `document.getElementById("chat-online-count")?.textContent === "2 online"`, 12000);
const mState = JSON.stringify({ badge: await atM("jamRoleBadge"), banner: await atM("jamBannerCode"), note: await atM("jam-join-note"), ri: await roomInfoM() });
assert(hostSees2, "HOST sees guest over real LAN (Review Focus 1)", `host=${await atD("chat-online-count")} guest-side=${mState}`);
const guestJoined = (await roomInfoM()).role === "guest";
assert(guestJoined, "guest backend role=guest", mState);

console.log("== chat: guest -> host ==");
if (guestJoined) {
  await mEval(`(async () => { const i = document.getElementById("jamChatInput"); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;
    set.call(i, "lan-guest-" + Date.now()); i.dispatchEvent(new Event("input",{bubbles:true}));
    document.getElementById("jamChatSend")?.click(); await new Promise(r=>setTimeout(r,900)); })()`);
  const hostText = String(await atD("chat-messages-container") || "");
  assert(/lan-guest-/.test(hostText), "host rendered guest chat line", hostText.slice(-60));

  console.log("== chat: host -> guest ==");
  await dEval(`(async () => { const i = document.getElementById("chat-input"); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;
    set.call(i, "lan-host-" + Date.now()); i.dispatchEvent(new Event("input",{bubbles:true}));
    document.getElementById("btn-chat-send")?.click(); await new Promise(r=>setTimeout(r,900)); })()`);
  const mText = String(await atM("jamChatList") || "");
  assert(/lan-host-/.test(mText), "guest rendered host chat line", mText.slice(-60));
}

console.log("== playback follow (host plays -> guest applies, D1 catalog path) ==");
// Desktop: search + click a result row (real UI path to playTrack).
await dEval(`(async () => { const a = document.querySelector('a[data-path="search"]'); if (a) a.click(); await new Promise(r=>setTimeout(r,400));
  const s = document.getElementById("search-input"); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;
  set.call(s, "aashiq banke"); s.dispatchEvent(new Event("input",{bubbles:true})); })()`);
const rowFound = await waitForCli(desk, 'document.querySelectorAll("[data-track-id]").length > 0', 15000);
let played = false;
if (rowFound) {
  played = await dEval(`(() => { const r = document.querySelector("[data-track-id]"); if (!r) return false; r.click(); return true; })()`);
}
const deskPlaying = await waitForCli(desk, `(() => { const a = document.getElementById("audio"); return a && !a.paused && a.currentTime > 0; })()`, 15000);
assert(played && deskPlaying, "host is playing a track", `rows=${rowFound} playing=${deskPlaying}`);
// Guest follows: its own <audio> starts (D1: fresh device -> resolve_song fallback).
const guestFollowed = await waitForCli(mob, `(() => { const a = document.getElementById("audio"); return a && !a.paused && a.currentTime > 0; })()`, 20000);
const drift = await atM("jamBannerDrift");
assert(guestFollowed, "guest followed playback (own audio running)", `drift=${drift}`);

console.log("== shared queue (§4.7: guest sees the host's up-next) ==");
const gList0 = String((await mEval('document.getElementById("jamQueueList")?.innerText || ""')));
const gHead0 = await atM("queueHeaderLabel");
assert(/HOST'S QUEUE/.test(gHead0), "guest queue header names the host list", gHead0);
assert(gList0.trim().length > 0, "guest renders host up-next rows", gList0.slice(0, 120));
// Host NEXT → the guest's list updates and still excludes the now-playing track.
await dEval('(document.getElementById("bar-next")||{}).click?.()');
await delay(5000);
const gList1 = String((await mEval('document.getElementById("jamQueueList")?.innerText || ""')));
const hostNow = String((await dEval('(document.getElementById("bar-title")||{}).textContent')) || "").trim();
assert(gList1.trim().length > 0 && gList1 !== gList0, "guest up-next updated on host next", `${gList0.slice(0, 60)} -> ${gList1.slice(0, 60)}`);
assert(!hostNow || !gList1.includes(hostNow), "now-playing stays out of the guest up-next", `playing=${hostNow} list=${gList1.slice(0, 120)}`);

console.log("== open question: host leaves -> guest rejoin ==");
await deskLeave();
const byeApplied = await waitForCli(mob, `document.getElementById("jamBannerCode")?.textContent === "NO ROOM" || document.getElementById("jamRoleBadge")?.textContent !== "GUEST"`, 8000);
const mAfterBye = JSON.stringify({ banner: await atM("jamBannerCode"), badge: await atM("jamRoleBadge"), ri: await roomInfoM() });
assert(byeApplied, "guest UI applied bye (idle chrome)", mAfterBye);
const riAfterBye = await roomInfoM();
console.log("INFO guest backend after bye: " + JSON.stringify(riAfterBye));

// Host reopens with a NEW code; guest tries to join again.
const room2 = await deskOpenRoom();
assert(room2.role === "host" && room2.code !== room1.code, "desktop reopened fresh room", room2.code);
const j2 = await mobileJoin(lanHost.split(":")[0], room2.code);
const rejoinOk = await waitForCli(desk, `document.getElementById("chat-online-count")?.textContent === "2 online"`, 12000);
const mRejoin = JSON.stringify({ badge: await atM("jamRoleBadge"), banner: await atM("jamBannerCode"), note: await atM("jam-join-note"), toast: await mEval(`document.querySelector(".toast, #toast, [role=status]")?.textContent || ""`), ri: await roomInfoM() });
assert(rejoinOk, "GUEST REJOINED after host bye (open question -> OK)", mRejoin);
if (!rejoinOk) console.log("DEFECT-CANDIDATE join-after-bye detail: " + mRejoin);

console.log("== cleanup ==");
await deskLeave();
await delay(1200);
const finalD = JSON.stringify({ room: await atD("jam-room-id"), mode: await atD("jam-mode-label") });
const finalM = JSON.stringify({ banner: await atM("jamBannerCode"), ri: await roomInfoM() });
console.log("final desktop: " + finalD + " | final mobile: " + finalM);
try { mob.close(); desk.close(); } catch {}
console.log(`LAN-JOIN exit=${fails ? 1 : 0}`);
process.exit(fails ? 1 : 0);
