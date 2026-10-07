// Temporary on-device verification probe — DELETED after the run.
// Verifies the current working-tree edits on the emulator over CDP:
//   recommend.js (Made For You shelves), searchkit.js (parsed filters +
//   labels + highlight), albumgroup.js (New Releases grouping), the
//   jiosaavn junk-filter streaming path, canvas.rs (dormant commands),
//   and the Settings storage controls (m-quota / m-prefetch).
//
//   node tests/_verify.mjs        (emulator running + debug APK installed)
//
// Plumbing copied from tests/live-android-emulator.mjs (cold start, socket
// discovery, adb forward, minimal CDP client).

import { execFileSync } from "node:child_process";

const SDK = process.env.ANDROID_HOME || "C:/Users/rohit/AppData/Local/Android/Sdk";
const ADB = `${SDK}/platform-tools/adb`;
const PKG = "com.openmusic.trancemusic";
const CDP_PORT = 9223;

const adb = (...args) =>
  execFileSync(ADB, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const adbTry = (...args) => {
  try {
    return adb(...args);
  } catch {
    return "";
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const out = [];
const check = (name, ok, detail) =>
  out.push(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` :: ${detail}` : ""}`);
const info = (name, detail) => out.push(`INFO ${name} :: ${detail}`);

function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const evalErrs = [];
    ws.addEventListener("open", () =>
      resolve({
        evalJs: (expression) =>
          new Promise((res) => {
            const id = ++seq;
            pending.set(id, (msg) => {
              if (msg.result?.exceptionDetails) {
                // An exception is data here: recorded, reported, never thrown
                // into waitFor (a thrown error would read as "not ready yet").
                evalErrs.push(String(msg.result.exceptionDetails.exception?.description || "?").slice(0, 200));
                res(null);
              } else res(msg.result?.result?.value);
            });
            ws.send(
              JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }),
            );
          }),
        evalErrs,
        close: () => ws.close(),
      }),
    );
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    });
    ws.addEventListener("error", reject);
  });
}

async function coldStart() {
  adb("shell", "am", "force-stop", PKG);
  adb("forward", "--remove-all");
  await wait(1500);
  adbTry("logcat", "-c");
  adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1");
  for (let i = 0; i < 30; i++) {
    await wait(1000);
    if (Number(adbTry("shell", "grep -c webview_devtools_remote /proc/net/unix")) > 0) return;
  }
  throw new Error("the app never came up with a devtools socket");
}

async function main() {
  await coldStart();
  const pid = adb("shell", "pidof", PKG).split(/\s+/)[0];
  check("app running on emulator", !!pid, `pid=${pid}`);
  const unix = adb("shell", "cat /proc/net/unix");
  const sock = [...unix.matchAll(/webview_devtools_remote_\d+/g)].map((m) => m[0]).pop();
  check("WebView devtools socket (debug build)", !!sock, sock);
  adb("forward", `tcp:${CDP_PORT}`, `localabstract:${sock}`);
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const page = targets.find((t) => t.type === "page");
  check("CDP page target", !!page, page?.url);
  const app = await cdp(page.webSocketDebuggerUrl);

  const waitFor = async (expr, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await app.evalJs(expr)) return true;
      await wait(250);
    }
    return false;
  };
  const js = (expr) => app.evalJs(expr);

  // ------------------------------------------------------------- boot ------
  check("real Tauri IPC (not a stub)", await waitFor("!!window.__TAURI__?.core"));
  const href = await js("location.href");
  check("app page loaded (no devUrl load-failure)", !/error|failed/i.test(String(href)), href);
  await waitFor('!!document.querySelector("#screen h1, main h1")', 15000);

  // --------------------------------------------------- home / recommend ---
  const greeting = await js('document.querySelector("#screen h1, main h1")?.textContent || ""');
  check("home greeting rendered (mountHome)", /Good (morning|afternoon|evening)/.test(String(greeting)), String(greeting).slice(0, 40));

  const shelves = await js(`(()=>{
    const secs=[...document.querySelectorAll('[data-shelf^="tm-shelf-mfy-"]')];
    return JSON.stringify({n:secs.length,
      items:secs.slice(0,4).map(s=>({id:s.dataset.shelf,title:s.querySelector("h2")?.textContent||"",
        rows:s.querySelectorAll("[data-list][data-idx]").length,
        why:s.querySelector("p")?.textContent||""}))});
  })()`);
  const sh = JSON.parse(shelves || "{}");
  const plays = await js(`(JSON.parse(localStorage.getItem("tm-plays")||"[]")||[]).length`);
  if (sh.n > 0) {
    const empty = (sh.items || []).filter((x) => !x.rows);
    check("Made For You shelves rendered (recommend.js)", empty.length === 0, `${sh.n} shelves, first: "${sh.items?.[0]?.title}" x${sh.items?.[0]?.rows} rows${sh.items?.[0]?.why ? ` (${sh.items[0].why})` : ""}`);
  } else if (!plays) {
    info("Made For You", `0 shelves on a fresh profile (profile.tracks empty -> shelfPlan correctly returns []) — plays=${plays}`);
  } else {
    check("Made For You shelves rendered (recommend.js)", false, `0 shelves despite plays=${plays}`);
  }

  const rel = await js(`(()=>{
    const s=document.querySelector('[data-shelf="tm-shelf-albums"]');
    return s?String(s.querySelectorAll("[data-list][data-idx], a, button").length):"";
  })()`);
  if (rel && Number(rel) > 0) info("New Releases shelf (albumgroup.js)", `${rel} cards`);
  else info("New Releases shelf (albumgroup.js)", "not rendered (home_feed offline or empty) — non-blocking");

  // ------------------------------------------------ search: searchkit.js --
  await js('location.hash = "#/search?q=kesariya 2022"');
  const statusOk = await waitFor('!!document.querySelector("[data-sm-status]")', 25000);
  const status = await js('document.querySelector("[data-sm-status]")?.textContent || ""');
  check("search status line (statusHTML)", statusOk && !!String(status).trim(), String(status).slice(0, 90));
  check("parseSearch filter understood (year 2022 in labels)", /2022/.test(String(status)), String(status).slice(0, 90));
  const rows = await js('document.querySelectorAll("#screen [data-list][data-idx]").length');
  check("search results ranked + rendered (rankForQuery)", Number(rows) > 0, `${rows} rows`);

  // Suggest dropdown highlight (`<mark>` from searchkit.highlight) — best
  // effort: the dropdown needs a server answer, so absence is INFO not FAIL.
  await js(`(()=>{
    const i=document.getElementById("search-input");
    if(!i) return false;
    const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value");
    d.set.call(i,"kesariya");
    i.dispatchEvent(new Event("input",{bubbles:true}));
    return true;
  })()`);
  await wait(3000);
  const mk = await js('document.querySelectorAll("[role=option] mark").length');
  const sug = await js('document.querySelectorAll("[role=option]").length');
  if (Number(sug) > 0) check("suggest dropdown + highlight (searchkit.highlight)", Number(mk) > 0, `${sug} options, ${mk} <mark> hits`);
  else info("suggest dropdown", "no options (server suggest idle/offline) — highlight untested here");

  // ------------------------------------- playback: junk-filter streaming ---
  await js('location.hash = "#/search?q=kesariya"');
  await waitFor('document.querySelectorAll("#screen [data-list][data-idx]").length > 0', 25000);
  await js('document.querySelector("#screen [data-list][data-idx]")?.click()');
  const npOk = await waitFor('location.hash.startsWith("#/nowplaying")', 10000);
  check("row click -> NowPlaying", npOk, await js("location.hash"));
  const a1 = await js(`(()=>{const a=document.querySelector("#audio");return a?JSON.stringify({src:String(a.src).slice(0,90),rs:a.readyState,t:a.currentTime,paused:a.paused,err:a.error?a.error.code+":"+a.error.message:null}):"none"})()`);
  const gotAudio = await waitFor('(()=>{const a=document.querySelector("#audio");return a&&a.readyState>=3&&!a.error})()', 20000);
  await wait(2000);
  const a2 = await js(`(()=>{const a=document.querySelector("#audio");return a?JSON.stringify({rs:a.readyState,t:a.currentTime,err:a.error?a.error.code:null}):"none"})()`);
  const A1 = JSON.parse(a1 || "{}"), A2 = JSON.parse(a2 || "{}");
  check("streaming: readyState>=3, no media error (jiosaavn dedup path)", gotAudio && !A2.err, `start=${a1} end=${a2}`);
  check("playhead advances", Number(A2.t) > Number(A1.t || 0), `${A1.t} -> ${A2.t}`);

  // ------------------------------------------------- canvas.rs (dormant) ---
  const cfg = await js('window.__TAURI__?.core?.invoke("canvas_configured")');
  check("canvas_configured wired (dormant=false)", cfg === false, `value=${JSON.stringify(cfg)}`);
  const fc = await js('(async()=>{try{const r=await window.__TAURI__.core.invoke("fetch_canvas",{title:"x",artist:"y"});return "OK:"+JSON.stringify(r)}catch(e){return "ERR:"+String(e)}})()');
  check("fetch_canvas fails gracefully when unconfigured", String(fc).startsWith("ERR:") && /Canvas not configured/.test(String(fc)), String(fc).slice(0, 110));

  // ------------------------------------------- settings storage controls ---
  await js('location.hash = "#/settings"');
  const setOk = await waitFor('!!document.getElementById("m-quota") && !!document.getElementById("m-prefetch")', 15000);
  const quotaOpts = await js('[...document.querySelectorAll("#m-quota option")].map(o=>o.value+(o.selected?"*":"")).join(",")');
  check("Settings: vault quota select + prefetch switch injected", setOk, `quota opts=[${String(quotaOpts).slice(0, 60)}]`);
  const quotaWired = await js(`(()=>{
    const q=document.getElementById("m-quota");
    if(!q||!q.options.length) return "no select";
    const v=[...q.options].map(o=>o.value).find(x=>x&&x!==q.value)||q.value;
    q.value=v; q.dispatchEvent(new Event("change",{bubbles:true}));
    return "set "+v;
  })()`);
  await wait(1200);
  const toast = await js('String(document.getElementById("tm-toast-stack")?.textContent||"").slice(0,90)');
  check("quota change fires its handler (toast)", /Vault capped|unlimited/i.test(String(toast)), `${quotaWired} -> "${String(toast).trim()}"`);

  // --------------------------------------------------- console exception ---
  const log = adbTry("logcat", "-d");
  const cons = log.split(/\r?\n/).filter((l) => /CONSOLE/.test(l));
  const bad = cons.filter((l) => /Uncaught|TypeError|ReferenceError|SyntaxError|Error:/i.test(l));
  check("no uncaught console exceptions since cold start", bad.length === 0, bad.length ? bad.slice(0, 3).join(" | ").slice(0, 300) : `${cons.length} console lines, 0 errors`);
  if (app.evalErrs.length) info("CDP eval exceptions", app.evalErrs.slice(0, 3).join(" | ").slice(0, 300));

  app.close();
  const fails = out.filter((l) => l.startsWith("FAIL")).length;
  console.log(out.join("\n"));
  console.log(`\n${out.filter((l) => l.startsWith("PASS")).length} pass / ${fails} fail`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.log(out.join("\n"));
  console.error("PROBE ERROR:", e.message);
  process.exit(2);
});
