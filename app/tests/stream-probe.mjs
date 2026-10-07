// stream-probe.mjs — cold-path streaming diagnostic (run by hand: `node
// tests/stream-probe.mjs`, not part of `npm test`).
// Wipes app data (`pm clear`), launches the app, dismisses onboarding, plays
// a song, and reports WHERE the chain breaks:
//   relay base -> resolve_song -> audio.src -> media load -> playhead.
// Also captures CDP Network failures + logcat chromium console lines.
// Record for P30 (docs/mobile/09-problems-solutions.md): click→src ~1s,
// click→playhead ~6.8s, zero loading failures = healthy.

import { execFileSync } from "node:child_process";

const SDK = process.env.ANDROID_HOME || "C:/Users/rohit/AppData/Local/Android/Sdk";
const ADB = `${SDK}/platform-tools/adb`;
const PKG = "com.openmusic.trancemusic";
const CDP_PORT = 9223;

const adb = (...args) => execFileSync(ADB, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const adbTry = (...args) => {
  try {
    return adb(...args);
  } catch {
    return "";
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const out = [];
const log = (k, v) => out.push(`${k}: ${v}`);

async function main() {
  // ---- launch (COLD: wipe data first — the user's install was wiped too)
  adbTry("shell", "am", "force-stop", PKG);
  adb("forward", "--remove-all");
  adbTry("logcat", "-c");
  const cleared = adbTry("shell", "pm", "clear", PKG);
  log("pm clear", cleared || "(failed)");
  await wait(1200);
  adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1");
  let sock = "";
  for (let i = 0; i < 30 && !sock; i++) {
    await wait(1000);
    sock = [...(adbTry("shell", "cat /proc/net/unix") || "").matchAll(/webview_devtools_remote_\d+/g)].map((m) => m[0]).pop() || "";
  }
  if (!sock) throw new Error("no devtools socket — app not running?");
  adb("forward", `tcp:${CDP_PORT}`, `localabstract:${sock}`);
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const page = targets.find((x) => x.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const events = [];
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method) events.push(m);
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const js = async (expr) => {
    const m = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    return m.result?.exceptionDetails
      ? "EXC " + String(m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text || "?").slice(0, 300)
      : m.result?.result?.value;
  };

  await send("Network.enable");
  await send("Runtime.enable");

  for (let i = 0; i < 25; i++) {
    if (await js("!!window.__TAURI__?.core && location.href.startsWith('http')")) break;
    await wait(1000);
  }

  // Fresh data lands on onboarding — dismiss it the real way.
  if (await js('!!document.querySelector("[data-ob-start]")')) {
    await js('document.querySelector("[data-ob-start]").click()');
    log("onboarding", "dismissed via Start listening");
    await wait(800);
  } else {
    log("onboarding", "not shown");
  }

  log("href", await js("location.href"));
  log("netMode", await js("localStorage.getItem('tm-netmode') || '(unset)'"));
  log("relay base (__tmBase)", await js("window.__tmBase || '(EMPTY)'"));
  log("navigator.onLine", await js("navigator.onLine"));
  log("streamQ pref", await js("localStorage.getItem('tm-stream-quality') || '(default)'"));

  // Device-side internet check (Rust resolve needs it).
  const ping = adbTry("shell", "curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://www.jiosaavn.com || echo CURL_FAIL");
  log("device->jiosaavn.com", ping);

  // ---- search + play (first search after cold start may return 0 rows —
  // backend warming; retry the way a user would, by retyping the query)
  await js('location.hash = "#/search?q=kesariya"');
  const rowCount = () => js('document.querySelectorAll("#screen [data-list][data-idx]").length');
  for (let i = 0; i < 30; i++) {
    if ((await rowCount()) > 0) break;
    await wait(1000);
  }
  let rows = await rowCount();
  if (!rows) {
    log("search rows first try", "0 (backend warming) — retrying");
    await wait(3000);
    await js('(()=>{const i=document.querySelector("#search-input");if(i){i.value="kesariya";i.dispatchEvent(new Event("input",{bubbles:true}));}})()');
    for (let i = 0; i < 30; i++) {
      rows = await rowCount();
      if (rows > 0) break;
      await wait(1000);
    }
  }
  log("search rows", rows);
  const t0 = Date.now();
  await js('document.querySelector("#screen [data-list][data-idx]")?.click()');
  for (let i = 0; i < 20; i++) {
    if (await js('location.hash.startsWith("#/nowplaying")')) break;
    await wait(500);
  }
  log("route", await js("location.hash"));
  log("badge", await js('document.querySelector("[data-badge]")?.textContent || "(none)"'));

  // ---- watch the audio element for 8 s
  const snap = () =>
    js(`(()=>{const a=document.querySelector("#audio");return a?JSON.stringify({src:String(a.src).slice(0,110),rs:a.readyState,ns:a.networkState,paused:a.paused,t:Number(a.currentTime.toFixed(2)),vol:a.volume,err:a.error?a.error.code+":"+a.error.message:null}):"NO AUDIO EL"})()`);
  let firstSrc = 0;
  let firstPlay = 0;
  for (let s = 0; s < 8; s++) {
    const raw = await snap();
    try {
      const a = JSON.parse(raw);
      if (!firstSrc && a.src) firstSrc = ((Date.now() - t0) / 1000).toFixed(1);
      if (!firstPlay && !a.paused && a.t > 0) firstPlay = ((Date.now() - t0) / 1000).toFixed(1);
    } catch {}
    log(`audio t+${s}s`, raw);
    await wait(1000);
  }
  log("click→src / click→playhead", `${firstSrc || ">8"}s / ${firstPlay || ">8"}s`);

  // ---- network failures observed
  const fails = events.filter((e) => e.method === "Network.loadingFailed").map((e) => `${e.params.type}:${e.params.errorText}${e.params.blockedReason ? ":" + e.params.blockedReason : ""}`);
  const streamReqs = events.filter((e) => e.method === "Network.requestWillBeSent" && /\/stream|\/art|127\.0\.0\.1/.test(e.params.request.url)).map((e) => e.params.request.url.slice(0, 90));
  log("relay requests", streamReqs.length ? streamReqs.slice(0, 6).join(" | ") : "(none)");
  log("loading failures", fails.length ? [...new Set(fails)].slice(0, 8).join(" | ") : "(none)");

  // ---- logcat console
  const lc = adbTry("logcat", "-d");
  const cons = lc.split(/\r?\n/).filter((l) => /CONSOLE|chromium/i.test(l));
  const bad = cons.filter((l) => /error|Uncaught|failed|ERR_/i.test(l));
  log("logcat console lines", cons.length);
  log("logcat errors", bad.length ? bad.slice(-6).map((l) => l.slice(0, 220)).join("\n  ") : "(none)");

  ws.close();
  console.log(out.join("\n"));
}

main().catch((e) => {
  console.log(out.join("\n"));
  console.error("DIAG ERROR:", e.message);
  process.exit(2);
});
