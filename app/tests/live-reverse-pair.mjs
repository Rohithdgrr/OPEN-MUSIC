// T7 Step 4 — REVERSE direction: Android HOST + Windows desktop GUEST.
// Real apps both sides; transport = adb forward (device's room server is only
// reachable from the host through it). Covers: desktop joins over the forward,
// chat both ways, playback follow, **D4 pause-broadcast regression**, and the
// **D5 bye->idle->rejoin regression on the desktop-guest side**.
// Part of the standing two-device gate: docs/listen-together.md §10.
//
//   node %TEMP%\opencode\reverse-pair.mjs
//
// Requires: dev app running with CDP :9222, emulator with debug APK running.
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
const waitForCli = async (cli, expr, ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await cli.evalJs(expr)) return true; } catch {} await delay(250); }
  return false;
};

// ---------- desktop (guest this time) ----------
const dT = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const dPage = dT.find((t) => t.type === "page" && !/widget/i.test(t.url || ""));
const desk = await cdpClient(dPage.webSocketDebuggerUrl);
const dEval = (expr) => desk.evalJs(expr);
const roomInfoD = () => dEval('window.__TAURI__.core.invoke("room_info").then(i=>JSON.stringify(i))').then(JSON.parse);
const atD = (id) => dEval(`(document.getElementById("${id}")||{}).textContent`);
const deskAudio = () => dEval('(() => { const a = document.getElementById("audio"); return a ? { paused: a.paused, t: a.currentTime } : null; })()');

// ---------- android (host this time) ----------
const pid = (adbTry("shell", "pidof", "-s", PKG) || "").trim();
if (!pid) { console.log("FAIL app not running on emulator"); process.exit(1); }
const unix = adb("shell", "cat /proc/net/unix");
const sock = [...unix.matchAll(/webview_devtools_remote_\d+/g)].map((m) => m[0]).pop();
adb("forward", "tcp:9223", `localabstract:${sock}`);
const mT = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const mPage = mT.find((t) => t.type === "page");
const mob = await cdpClient(mPage.webSocketDebuggerUrl);
const mEval = (expr) => mob.evalJs(expr);
const roomInfoM = () => mEval('window.__TAURI__.core.invoke("room_info").then(i=>JSON.stringify(i))').then(JSON.parse);
const atM = (id) => mEval(`(document.getElementById("${id}")||{}).textContent`);
const mobAudio = () => mEval('(() => { const a = document.getElementById("audio"); return a ? { paused: a.paused, t: a.currentTime } : null; })()');

const setVal = (side, id, v) => side(`(() => { const e = document.getElementById(${JSON.stringify(id)}); if (!e) return "no-elon"; const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; set.call(e, ${JSON.stringify(v)}); e.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);

async function mobStartJam() {
  await mEval(`(async () => { location.hash = "#/nowplaying"; await new Promise(r=>setTimeout(r,500));
    document.getElementById("modeToggleBtn")?.click(); await new Promise(r=>setTimeout(r,400)); })()`);
  await mEval(`([...document.querySelectorAll("button")].find(b=>b.textContent.trim().startsWith("Start a Jam"))||{click(){}}).click()`);
  const ok = await waitForCli(mob, `(() => { const c = document.getElementById("jamBannerCode")?.textContent || ""; return /^[2-9A-HJ-NP-Z]{8}$/.test(String(c).replace(/[^A-Za-z0-9]/g,"")) && String(c).replace(/[^A-Za-z0-9]/g,"").length === 8; })()`, 8000);
  const code = String(await atM("jamBannerCode") || "").replace(/[^A-Za-z0-9]/g, "");
  return { ok, code };
}
async function mobEndJam() {
  await mEval(`location.hash = "#/nowplaying"`).catch(() => {});
  await delay(400);
  await mEval('document.getElementById("jamEndBtn")?.click()');
  await delay(800);
  await mEval(`([...document.querySelectorAll("button")].find(b=>/^(End|Confirm|Yes)/.test(b.textContent.trim()))||{click(){}}).click()`);
  return waitForCli(mob, `document.getElementById("jamBannerCode")?.textContent === "NO ROOM"`, 5000);
}
async function deskJoin(addr, code) {
  await dEval(`(async () => { if (!document.body.classList.contains("soc-social")) document.querySelector("#btn-mode-social")?.click(); await new Promise(r=>setTimeout(r,700));
    document.querySelector("#tab-btn-jam")?.click(); await new Promise(r=>setTimeout(r,300)); })()`);
  // One pasted link, canonical form (A): both layers parse it.
  const [host, port] = addr.includes(":") ? addr.split(":") : [addr, "8787"];
  await setVal(dEval, "room-join-invite", `trancemusic://join?host=${host}&port=${port}&code=${code}`);
  const enabled = await waitForCli(desk, `!document.getElementById("btn-room-join")?.disabled`, 4000);
  if (!enabled) return { ok: false, why: "join-btn-disabled" };
  await dEval(`document.getElementById("btn-room-join").click()`);
  return { ok: true };
}
async function deskLeave() {
  await dEval(`(async () => { if (!document.body.classList.contains("soc-social")) document.querySelector("#btn-mode-social")?.click(); await new Promise(r=>setTimeout(r,500));
    document.querySelector("#tab-btn-jam")?.click(); await new Promise(r=>setTimeout(r,300));
    document.querySelector("#btn-leave-room")?.click(); await new Promise(r=>setTimeout(r,800)); })()`);
}

// ---------- setup: both sides to a clean Solo ----------
const dRole0 = (await roomInfoD()).role;
if (dRole0 !== "idle") {
  console.log("INFO desktop was in " + dRole0 + " — closing before probe");
  await dEval('window.__TAURI__.core.invoke("room_close").catch(()=>{})');
  await delay(800);
  // Backend-only close leaves the reducer stale; a reload re-adopts the now-
  // idle snapshot so joinRoom's role gate is honest (and audio resets).
  await dEval('location.reload()').catch(() => {});
  await waitForCli(desk, '!!window.__TAURI__?.core && document.readyState === "complete"', 12000);
  await dEval('location.hash = "#/home"').catch(() => {});
}
const mRole0 = (await roomInfoM()).role;
if (mRole0 !== "idle") {
  console.log("INFO mobile was in " + mRole0 + " — ending before probe");
  if (mRole0 === "host") await mobEndJam();
  else { await mEval('window.__TAURI__.core.invoke("room_close").catch(()=>{})'); await delay(800); }
}
assert((await roomInfoD()).role === "idle", "desktop starts idle", dRole0);
assert((await roomInfoM()).role === "idle", "mobile starts idle", mRole0);

// ---------- host: android opens a room ----------
console.log("== android hosts ==");
const j1 = await mobStartJam();
assert(j1.ok && /^[2-9A-HJ-NP-Z]{8}$/.test(j1.code), "android opened a room", j1.code);
const invite = String(await atM("jamInviteUri") || "");
const port = Number((invite.match(/:(\d{2,5})/) || [])[1] || 8787);
assert(port > 0, "invite carries a dialable port", invite);
adb("forward", `tcp:${port}`, `tcp:${port}`);

// ---------- guest: desktop joins through the forward ----------
console.log("== desktop joins as GUEST ==");
const dj = await deskJoin("127.0.0.1", j1.code);
assert(dj.ok, "desktop join submitted", JSON.stringify(dj));
const deskIsGuest = await waitForCli(desk, `window.__TAURI__.core.invoke("room_info").then(i=>i.role === "guest")`, 12000);
const dState = JSON.stringify({ ri: await roomInfoD(), mode: await atD("jam-mode-label"), note: await atD("room-join-note") });
assert(deskIsGuest, "desktop backend role=guest", dState);
const hostSees2 = await waitForCli(mob, `document.getElementById("jamBannerCount")?.textContent === "2"`, 8000);
assert(hostSees2, "android host sees 2 members", await atM("jamBannerCount"));

// ---------- chat both ways ----------
console.log("== chat ==");
await mEval(`(async () => { const i = document.getElementById("jamChatInput"); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;
  set.call(i, "rev-guest-" + Date.now()); i.dispatchEvent(new Event("input",{bubbles:true}));
  document.getElementById("jamChatSend")?.click(); await new Promise(r=>setTimeout(r,900)); })()`);
const dChat = String(await atD("chat-messages-container") || "");
assert(/rev-guest-/.test(dChat), "desktop guest rendered android-host chat line", dChat.slice(-60));
await dEval(`(async () => { const i = document.getElementById("chat-input"); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;
  set.call(i, "rev-host-" + Date.now()); i.dispatchEvent(new Event("input",{bubbles:true}));
  document.getElementById("btn-chat-send")?.click(); await new Promise(r=>setTimeout(r,900)); })()`);
const mChat = String(await atM("jamChatList") || "");
assert(/rev-host-/.test(mChat), "android host rendered desktop-guest chat line", mChat.slice(-60));

// ---------- playback follow: android host plays ----------
console.log("== playback follow (android host plays) ==");
await mEval(`(async () => { location.hash = "#/search"; await new Promise(r=>setTimeout(r,600)); })()`);
await setVal(mEval, "search-input", "aashiq banke");
const rowUp = await waitForCli(mob, `[...document.querySelectorAll("[data-sug-id]")].some(b => b.dataset.sugId)`, 12000);
let mPlayed = false;
if (rowUp) mPlayed = await mEval(`(() => { const b = [...document.querySelectorAll("[data-sug-id]")].find(b => b.dataset.sugId); if (!b) return false; b.click(); return true; })()`);
const mPlaying = await waitForCli(mob, `(() => { const a = document.getElementById("audio"); return a && !a.paused && a.currentTime > 0; })()`, 20000);
assert(mPlayed && mPlaying, "android host is playing", `rows=${rowUp} playing=${mPlaying}`);
const dFollowed = await waitForCli(desk, `(() => { const a = document.getElementById("audio"); return a && !a.paused && a.currentTime > 0; })()`, 20000);
assert(dFollowed, "desktop guest followed playback", JSON.stringify(await deskAudio()));

// ---------- D4 regression: host pauses -> guest pauses ----------
console.log("== D4: pause broadcast ==");
const before = await mobAudio();
await mEval(`document.getElementById("master-play-pause").click()`);
const mPaused = await waitForCli(mob, `document.getElementById("audio")?.paused === true`, 4000);
const dPaused = await waitForCli(desk, `document.getElementById("audio")?.paused === true`, 6000);
assert(mPaused && dPaused, "D4: host pause reached the guest", `hostBefore=${JSON.stringify(before)} guest=${JSON.stringify(await deskAudio())}`);
const dPauseT = (await deskAudio())?.t;
await mEval(`document.getElementById("master-play-pause").click()`);
const mResumed = await waitForCli(mob, `(() => { const a = document.getElementById("audio"); return a && !a.paused; })()`, 4000);
const dResumed = await waitForCli(desk, `(() => { const a = document.getElementById("audio"); return a && !a.paused; })()`, 6000);
assert(mResumed && dResumed, "D4: host resume reached the guest", `pauseT=${dPauseT}`);

// ---------- D5 regression: host ends -> guest backend idle -> rejoin ----------
console.log("== D5: host ends jam, guest must revert + rejoin ==");
const ended = await mobEndJam();
assert(ended, "android room closed", await atM("jamBannerCode"));
const dIdle = await waitForCli(desk, `window.__TAURI__.core.invoke("room_info").then(i=>i.role === "idle")`, 8000);
const dAfterBye = JSON.stringify({ ri: await roomInfoD(), mode: await atD("jam-mode-label"), note: await atD("room-join-note") });
assert(dIdle, "D5: desktop guest BACKEND reverted to idle after host bye", dAfterBye);

const j2 = await mobStartJam();
assert(j2.ok && j2.code && j2.code !== j1.code, "android reopened a fresh room", j2.code);
adb("forward", `tcp:${port}`, `tcp:${port}`);
const dj2 = await deskJoin("127.0.0.1", j2.code);
const dRejoin = await waitForCli(desk, `window.__TAURI__.core.invoke("room_info").then(i=>i.role === "guest")`, 12000);
const mSees2 = await waitForCli(mob, `document.getElementById("jamBannerCount")?.textContent === "2"`, 8000);
assert(dj2.ok && dRejoin && mSees2, "D5: desktop REJOINED the fresh room after bye", JSON.stringify({ ri: await roomInfoD(), count: await atM("jamBannerCount") }));

// ---------- cleanup ----------
console.log("== cleanup ==");
await deskLeave();
await delay(800);
await mobEndJam();
await delay(800);
const fin = JSON.stringify({ d: await roomInfoD(), m: await roomInfoM() });
console.log("final: " + fin);
assert((await roomInfoD()).role === "idle" && (await roomInfoM()).role === "idle", "both sides back to idle", fin);

try { mob.close(); desk.close(); } catch {}
console.log(`REVERSE-PAIR exit=${fails ? 1 : 0}`);
process.exit(fails ? 1 : 0);
