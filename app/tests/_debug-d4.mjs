// temp: D4 pause-broadcast diagnosis v2 (deleted after run)
// Mirrors live-reverse-pair transport: adb forward + 127.0.0.1 join.
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const SDK = process.env.ANDROID_HOME || "C:/Users/rohit/AppData/Local/Android/Sdk";
const ADB = `${SDK}/platform-tools/adb`;
const PKG = "com.openmusic.trancemusic";
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

const dT = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const dPage = dT.find((t) => t.type === "page" && !/widget/i.test(t.url || ""));
const desk = await cdpClient(dPage.webSocketDebuggerUrl);
const dEval = desk.evalJs;

const pid = (adbTry("shell", "pidof", "-s", PKG) || "").trim();
if (!pid) { console.log("app not running"); process.exit(1); }
const unix = adb("shell", "cat /proc/net/unix");
const sock = [...unix.matchAll(/webview_devtools_remote_\d+/g)].map((m) => m[0]).pop();
adb("forward", "tcp:9223", `localabstract:${sock}`);
const mT = await (await fetch("http://127.0.0.1:9223/json/list")).json();
const mPage = mT.find((t) => t.type === "page");
const mob = await cdpClient(mPage.webSocketDebuggerUrl);
const mEval = mob.evalJs;

const audio = (fn) => fn('(() => { const a = document.getElementById("audio"); return a ? { paused: a.paused, t: +a.currentTime.toFixed(2) } : null; })()');

// hook invoke on BOTH sides to log room_playback / room_chat traffic
const hookInvoke = `(() => {
  if (window.__invLog) return "already";
  window.__invLog = [];
  const core = window.__TAURI__?.core;
  if (!core) return "no-core";
  const orig = core.invoke.bind(core);
  core.invoke = (cmd, args) => {
    try { window.__invLog.push({ cmd, playing: args && args.playing, track: args && args.trackId, at: Date.now() % 100000 }); } catch {}
    return orig(cmd, args);
  };
  return "hooked";
})()`;

// cleanup both
await mEval('window.__TAURI__.core.invoke("room_close").catch(()=>{})');
await dEval('window.__TAURI__.core.invoke("room_close").catch(()=>{})');
await delay(700);

// android hosts
await mEval(`(async () => { location.hash = "#/nowplaying"; await new Promise(r=>setTimeout(r,500));
  document.getElementById("modeToggleBtn")?.click(); await new Promise(r=>setTimeout(r,400)); })()`);
await mEval(`([...document.querySelectorAll("button")].find(b=>b.textContent.trim().startsWith("Start a Jam"))||{click(){}}).click()`);
const opened = await waitForCli(mob, `/^[2-9A-HJ-NP-Z]{8}$/.test(String(document.getElementById("jamBannerCode")?.textContent||"").replace(/[^A-Za-z0-9]/g,""))`, 8000);
const code = String(await mEval('document.getElementById("jamBannerCode")?.textContent') || "").replace(/[^A-Za-z0-9]/g, "");
console.log("host opened:", opened, code);
adb("forward", "tcp:8787", "tcp:8787");

await dEval(hookInvoke);
await mEval(hookInvoke);

// desktop joins through the forward (mirror of live-reverse-pair)
await dEval(`(async () => { if (!document.body.classList.contains("soc-social")) document.querySelector("#btn-mode-social")?.click(); await new Promise(r=>setTimeout(r,700));
  document.querySelector("#tab-btn-jam")?.click(); await new Promise(r=>setTimeout(r,300)); })()`);
await dEval(`(() => { const e = document.getElementById("room-join-invite"); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  set.call(e, "trancemusic://join?host=127.0.0.1&port=8787&code=${code}"); e.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
const enabled = await waitForCli(desk, `!document.getElementById("btn-room-join")?.disabled`, 4000);
await dEval('document.getElementById("btn-room-join").click()');
const joined = await waitForCli(desk, 'window.__TAURI__.core.invoke("room_info").then(i=>i.role).then(r=>r==="guest")', 12000);
console.log("desktop joined:", joined, "btn-enabled:", enabled);
const host2 = await waitForCli(mob, `document.getElementById("jamBannerCount")?.textContent === "2"`, 8000);
console.log("host sees 2:", host2);

// android plays (fresh search)
await mEval(`(async () => { location.hash = "#/search"; await new Promise(r=>setTimeout(r,600)); })()`);
await mEval(`(() => { const e = document.getElementById("search-input"); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; s.call(e, "aashiq banke"); e.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
const rowUp = await waitForCli(mob, `[...document.querySelectorAll("[data-sug-id]")].some(b => b.dataset.sugId)`, 12000);
if (rowUp) await mEval(`(() => { const b = [...document.querySelectorAll("[data-sug-id]")].find(b => b.dataset.sugId); if (b) b.click(); return !!b; })()`);
const mPlaying = await waitForCli(mob, `(() => { const a = document.getElementById("audio"); return a && !a.paused && a.currentTime > 0; })()`, 20000);
const dFollowed = await waitForCli(desk, `(() => { const a = document.getElementById("audio"); return a && !a.paused && a.currentTime > 0; })()`, 20000);
console.log("playing: mobile", mPlaying, "desktop followed", dFollowed);
console.log("mAudio:", JSON.stringify(await audio(mEval)), "dAudio:", JSON.stringify(await audio(dEval)));
console.log("m invLog:", await mEval('JSON.stringify(window.__invLog.slice(-6))'));
console.log("d invLog:", await dEval('JSON.stringify(window.__invLog.slice(-6))'));

// pause via master button
console.log("--- clicking pause ---");
await mEval(`document.getElementById("master-play-pause")?.click()`);
for (const ms of [800, 2000, 4000]) {
  await delay(ms);
  console.log(`t+${ms}: mAudio`, JSON.stringify(await audio(mEval)), "dAudio", JSON.stringify(await audio(dEval)));
}
console.log("m invLog tail:", await mEval('JSON.stringify(window.__invLog.slice(-4))'));
console.log("mAudio final:", JSON.stringify(await audio(mEval)));
console.log("desktop jam-sync note:", await dEval('document.getElementById("jam-sync-value")?.textContent'));
console.log("desktop room note:", await dEval('document.getElementById("room-note")?.textContent'));
console.log("desktop exc log:", await dEval('JSON.stringify(window.__excLog||[])'));

// cleanup
await mEval('window.__TAURI__.core.invoke("room_close").catch(()=>{})');
await delay(500);
await dEval('window.__TAURI__.core.invoke("room_close").catch(()=>{})');
desk.close(); mob.close();
process.exit(0);
