// _uiverify.mjs — acceptance probe for the Android UI parity batch
// (docs/mobile/06-features.md). TEMP — kept out of `npm test` by the `_`
// prefix; run by hand after installing a build: `node tests/_uiverify.mjs`.
//
// Checks: streaming still works, NowPlaying metadata (STEREO DIRECT +
// quality chip + QUALITY cell), the full three-dots menu is visible
// WITHOUT scrolling (the 40vh clip fix), widget art/title painted, and no
// broken thumbnail images. Takes two screenshots for visual review.

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const SDK = process.env.ANDROID_HOME || "C:/Users/rohit/AppData/Local/Android/Sdk";
const ADB = `${SDK}/platform-tools/adb`;
const PKG = "com.openmusic.trancemusic";
const CDP_PORT = 9224;
const SHOT_DIR = process.env.TEMP || ".";

const adb = (...a) => execFileSync(ADB, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const adbTry = (...a) => {
  try {
    return adb(...a);
  } catch {
    return "";
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const pass = (n) => results.push(`PASS ${n}`);
const fail = (n, d) => results.push(`FAIL ${n}${d ? ` :: ${d}` : ""}`);

async function main() {
  adbTry("shell", "am", "force-stop", PKG);
  adb("forward", "--remove-all");
  adbTry("logcat", "-c");
  await wait(1000);
  adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1");
  let sock = "";
  for (let i = 0; i < 30 && !sock; i++) {
    await wait(1000);
    sock =
      [...(adbTry("shell", "cat /proc/net/unix") || "").matchAll(/webview_devtools_remote_\d+/g)]
        .map((m) => m[0])
        .pop() || "";
  }
  if (!sock) throw new Error("no devtools socket — app not running?");
  adb("forward", `tcp:${CDP_PORT}`, `localabstract:${sock}`);
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const page = targets.find((x) => x.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  const exceptions = [];
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", rej);
  });
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method === "Runtime.exceptionThrown") {
      exceptions.push(String(m.params.exceptionDetails.text || "exception").slice(0, 160));
    }
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
  await send("Runtime.enable");
  for (let i = 0; i < 25; i++) {
    if (await js("!!window.__TAURI__?.core")) break;
    await wait(1000);
  }
  if (await js('!!document.querySelector("[data-ob-start]")')) {
    await js('document.querySelector("[data-ob-start]").click()');
    await wait(600);
  }

  // ---- 1. search + play
  await js('location.hash = "#/search?q=kesariya"');
  for (let i = 0; i < 30; i++) {
    if ((await js('document.querySelectorAll("#screen [data-list][data-idx]").length')) > 0) break;
    await wait(1000);
  }
  const rows = await js('document.querySelectorAll("#screen [data-list][data-idx]").length');
  rows > 0 ? pass(`search rows (${rows})`) : fail("search rows", "0");
  const t0 = Date.now();
  await js('document.querySelector("#screen [data-list][data-idx]")?.click()');
  for (let i = 0; i < 20; i++) {
    if (await js('location.hash.startsWith("#/nowplaying")')) break;
    await wait(500);
  }
  (await js('location.hash.startsWith("#/nowplaying")')) ? pass("row → NowPlaying") : fail("row → NowPlaying");

  // ---- 2. streaming still works
  let played = "";
  for (let i = 0; i < 25 && !played; i++) {
    const s = await js(
      '(()=>{const a=document.querySelector("#audio");return a&&a.src&&a.readyState>=3&&!a.paused&&a.currentTime>0.2?String(a.currentTime.toFixed(1)):""})()',
    );
    if (s) played = s;
    await wait(1000);
  }
  played ? pass(`streaming (t=${played}s after ${((Date.now() - t0) / 1000).toFixed(1)}s)`) : fail("streaming", "no playhead movement in 25s");

  // ---- 3. NowPlaying metadata (desktop parity)
  const trackline = await js('document.getElementById("np-trackline")?.textContent || ""');
  /TRACK \d/.test(trackline) && trackline.includes("STEREO DIRECT")
    ? pass(`np-trackline "${trackline}"`)
    : fail("np-trackline", JSON.stringify(trackline));
  let qchip = "";
  for (let i = 0; i < 20 && !qchip; i++) {
    const v = await js(
      '(function(){const c=document.getElementById("np-qchip");return c&&!c.classList.contains("hidden")&&c.textContent?c.textContent:""})()',
    );
    if (v) qchip = v;
    await wait(1000);
  }
  qchip ? pass(`quality chip "${qchip}"`) : fail("quality chip", "stayed hidden for 20s");
  const qcell = await js('document.getElementById("np-quality")?.textContent || ""');
  qcell && qcell !== "—" ? pass(`QUALITY cell "${qcell}"`) : fail("QUALITY cell", JSON.stringify(qcell));
  const len = await js('document.getElementById("np-length")?.textContent || ""');
  len && len !== "—" ? pass(`LENGTH cell "${len}"`) : fail("LENGTH cell", JSON.stringify(len));
  const album = await js('document.getElementById("np-album")?.textContent || ""');
  const shot1 = `${SHOT_DIR}/_ui-nowplaying.png`;
  adb("shell", "screencap", "-p", "/sdcard/_s.png");
  adb("pull", "/sdcard/_s.png", shot1);

  // ---- 4. three-dots menu: full list, visible without scrolling
  await js('document.getElementById("more-options-btn")?.click()');
  for (let i = 0; i < 20; i++) {
    if (await js('!!document.getElementById("tm-options-sheet")')) break;
    await wait(250);
  }
  const labels = (await js(
    'Array.from(document.querySelectorAll("#tm-options-sheet [data-tm-list] button")).map(b=>b.textContent.trim())',
  )) || [];
  const labelList = Array.isArray(labels) ? labels : [];
  const required = ["Track Details", "Go to Artist", "Add to Queue", "Add to Playlist", "Download", "Share Track"];
  const missing = required.filter((r) => !labelList.includes(r));
  missing.length === 0 ? pass(`menu has required items (${labelList.length} total)`) : fail("menu items", `missing ${JSON.stringify(missing)}; have ${JSON.stringify(labelList)}`);
  const dupes = [...new Set(labelList.filter((l, i) => labelList.indexOf(l) !== i))];
  dupes.length === 0 ? pass("menu has no duplicate items") : fail("menu duplicates", JSON.stringify(dupes));
  const hasAlbum = album && album !== "—";
  if (hasAlbum) {
    labelList.includes("View Album") ? pass("menu View Album (track has album)") : fail("menu View Album", `album="${album}" but item absent`);
  } else {
    results.push(`INFO View Album skipped — nowplaying album cell is "${album}" (no album on this track)`);
  }
  const visible = await js(`(function(){
    const list=document.querySelector("#tm-options-sheet [data-tm-list]");
    if(!list) return "NO LIST";
    const lr=list.getBoundingClientRect();
    const req=${JSON.stringify(required)};
    const hidden=req.filter(t=>{const b=Array.from(list.querySelectorAll("button")).find(x=>x.textContent.trim()===t);if(!b)return false;const r=b.getBoundingClientRect();return r.bottom>lr.bottom+1||r.top<lr.top-1;});
    return JSON.stringify({hidden,scrollH:list.scrollHeight,clientH:list.clientHeight});
  })()`);
  try {
    const v = JSON.parse(visible);
    v.hidden.length === 0
      ? pass(`all required items visible without scrolling (list ${v.scrollH}/${v.clientH}px)`)
      : fail("menu clipping", `not visible: ${JSON.stringify(v.hidden)} (${v.scrollH}/${v.clientH}px)`);
  } catch {
    fail("menu clipping", visible);
  }
  const shot2 = `${SHOT_DIR}/_ui-menu.png`;
  adb("shell", "screencap", "-p", "/sdcard/_s.png");
  adb("pull", "/sdcard/_s.png", shot2);
  await js('document.querySelector("#tm-options-sheet [data-tm-dismiss]")?.click()');
  await wait(400);

  // ---- 5. widget (mini-player): art painted + metadata visible
  await js('location.hash = "#/"');
  await wait(1500);
  const w = await js(`(function(){
    const w=document.getElementById("tm-widget");
    if(!w||w.classList.contains("hidden")) return JSON.stringify({state:"hidden"});
    const img=document.getElementById("tm-w-art");
    const title=document.getElementById("tm-w-title");
    const artist=document.getElementById("tm-w-artist");
    return JSON.stringify({state:"shown",src:img?String(img.src).slice(-60):"",ok:img?!!(img.complete&&img.naturalWidth>0):false,
      title:title?title.textContent.trim():"",artist:artist?artist.textContent.trim():""});
  })()`);
  try {
    const v = JSON.parse(w);
    if (v.state === "hidden") fail("widget", "hidden on home with a track playing");
    else {
      v.ok && v.src ? pass(`widget art painted (${v.src})`) : fail("widget art", JSON.stringify(v));
      v.title && v.title !== "Nothing playing"
        ? pass(`widget metadata "${v.title}" / "${v.artist}"`)
        : fail("widget metadata", JSON.stringify({ title: v.title, artist: v.artist }));
    }
  } catch {
    fail("widget", w);
  }

  // ---- 6. thumbnails: no broken images anywhere on home
  await wait(1500);
  const imgs = await js(`(function(){
    const all=Array.from(document.querySelectorAll("img[data-art-orig], img[src]"));
    const done=all.filter(i=>i.complete);
    const broken=done.filter(i=>i.naturalWidth===0&&i.getAttribute("src")&&!i.getAttribute("src").endsWith("logo.png"));
    return JSON.stringify({total:all.length,loaded:done.filter(i=>i.naturalWidth>0).length,broken:broken.map(i=>String(i.src).slice(0,80))});
  })()`);
  try {
    const v = JSON.parse(imgs);
    v.broken.length === 0 && v.loaded > 0
      ? pass(`thumbnails (${v.loaded}/${v.total} loaded, 0 broken)`)
      : fail("thumbnails", JSON.stringify(v));
  } catch {
    fail("thumbnails", imgs);
  }

  exceptions.length === 0 ? pass("0 console exceptions") : fail("console exceptions", exceptions.slice(0, 3).join(" | "));

  ws.close();
  console.log(results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log(`\n${results.filter((r) => r.startsWith("PASS")).length} pass / ${failed} fail`);
  console.log(`screenshots: ${shot1} , ${shot2}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log(results.join("\n"));
  console.error("UIVERIFY ERROR:", e.message);
  process.exit(2);
});
