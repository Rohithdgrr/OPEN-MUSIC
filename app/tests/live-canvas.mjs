// canvas-live-probe.mjs — live verification for docs/spotify-android-canvas.md §14.
//
// PARKED 2026-10-24 (docs/spotify-android-canvas.md §18): the Canvas is
// unwired from the Android app, so M4/M5/M7/M8 (UI + renderer paths) will
// fail until revives comment-marker surgery per §18.3. M1's direct invoke
// still works — the Rust backend was left registered.
//
// Runs against the REAL debug APK on the emulator over CDP :9223
// (adb forward tcp:9223 localabstract:webview_devtools_remote_<pid> first).
// No stubs: the real command, the real relay, a real <video>, and the real
// renderer path (search -> trusted touch -> nowplaying -> #np-canvas).
//
// Asserts:
//   M0  mobile shell boots (lazily-mounted screens are fine)
//   M1  fetch_canvas("After Hours") -> relay URL (id 16 hex + token 64 hex)
//   M2  the relay serves 200 + video/mp4, a Range request answers 206, a real
//       <video> plays it, and its source passes the 9:16 720×1280 floor
//   M3  a nonexistent track resolves to {url:null} (honest miss)
//   M3b Kesariya (informational — Indian film coverage)
//   M4  E2E: toggle on -> search -> trusted tap -> #np-canvas plays, publishes
//       data-crop / data-loop, and the full-bleed layer covers the viewport
//   M5  the ambient canvas persists on Home (focus off, dim on, video alive)
//   M6  returning to Now Playing regains focus (no re-fetch needed)
//   M9  the visible front loops within ~12 s (crossfade swap or hard cut) and
//       the new window starts near 0.6 s
//   M7  a track with no Apple cut gets the generated 6 s cover canvas (wash +
//       card drift) and persists on Home
//   M8  the real canvas-OFF path (pref off -> stop -> repaint) stops
//       everything and restores the user's theme
//
// Cross-origin notes (why the checks are shaped this way):
//  - content-type / content-length are CORS-safelisted response headers, so the
//    page can read them; accept-ranges is NOT exposed, so ranges are proven by
//    the RESPONSE STATUS of a single-range request (`Range` with one bytes=a-b
//    is a safelisted request header) rather than by reading that header.
//  - Page.reload tears down the page-target websocket on the Android WebView:
//    the probe reconnects after the reload.
//
// Usage: node canvas-live-probe.mjs

import { setTimeout as sleep } from "node:timers/promises";
import { writeFileSync } from "node:fs";
import { cropBox, meetsCanvasFloor } from "../src/mobile/canvasmath.js";

const CDP_HTTP = "http://127.0.0.1:9223";

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.closed = false;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("cdp socket closed"));
      }
      this.pending.clear();
    });
    ws.addEventListener("error", () => {});
  }
  send(method, params = {}, watchdogMs = 30000) {
    if (this.closed) return Promise.reject(new Error(`send ${method}: socket closed`));
    const id = ++this.id;
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${watchdogMs}ms`));
      }, watchdogMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.ws.send(JSON.stringify({ id, method, params }));
    return p;
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function connect() {
  const list = await (await fetch(CDP_HTTP + "/json")).json();
  const pages = list.filter((t) => t.type === "page");
  const main = pages.find((t) => /tauri\.localhost/.test(t.url)) || pages[0];
  if (!main) throw new Error(`no page target — got: ${pages.map((p) => p.url).join(", ")}`);
  const ws = new WebSocket(main.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("ws connect failed")), { once: true });
    setTimeout(() => rej(new Error("ws connect timed out")), 8000);
  });
  const cdp = new CDP(ws);
  await cdp.send("Runtime.enable").catch(() => {});
  await cdp.send("Page.enable").catch(() => {});
  return cdp;
}

async function evalPage(cdp, expr, awaitPromise = false, pageTimeout = 120000) {
  const r = await cdp.send(
    "Runtime.evaluate",
    { expression: expr, returnByValue: true, awaitPromise, timeout: pageTimeout },
    pageTimeout + 15000,
  );
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(
      `in-page: ${d.text || ""} ${(d.exception && (d.exception.description || d.exception.value)) || ""}`,
    );
  }
  return r.result.value;
}

const results = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push([name, true, detail]);
    console.log(`PASS ${name} (${Date.now() - t0}ms)${detail ? " — " + detail : ""}`);
  } catch (e) {
    results.push([name, false, String(e.message || e)]);
    console.log(`FAIL ${name} (${Date.now() - t0}ms) — ${String(e.message || e)}`);
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

let cdp = await connect();
// The user's real theme, captured after M4's reload and before the first
// canvas — M8 compares the restored state against it.
let preCanvasDark = null;
// M7 pauses the transport so the player's ~4×/s timeupdate paint cannot
// repaint the real track over the fallback; M8 resumes it if it was playing.
let probeWasPlaying = false;

// ---------------------------------------------------------------- M0 boot
await step("M0 mobile shell boots", async () => {
  const info = await evalPage(
    cdp,
    `({ url: location.href, shell: !!document.getElementById("screen"), tauri: !!window.__TAURI__, canvasEl: !!document.getElementById("np-canvas") })`,
  );
  assert(info.shell, `shell missing — ${JSON.stringify(info)}`);
  assert(info.tauri, "window.__TAURI__ missing");
  return JSON.stringify(info);
});

// ------------------------------------------- M1 command returns relay URL
// The user's canvas pref at probe start: M4 forces it on, M8 restores it so
// the device is left exactly as it was found.
const origCanvasPref = await evalPage(cdp, `localStorage.getItem("tm-canvas")`, false, 15000).catch(() => null);
let canvasUrl = "";
await step("M1 fetch_canvas resolves a relay URL (After Hours)", async () => {
  const t0 = Date.now();
  const r = await evalPage(
    cdp,
    `(async () => await window.__TAURI__.core.invoke("fetch_canvas", { title: "After Hours", artist: "The Weeknd", album: "After Hours", isrc: null }))()`,
    true,
  );
  assert(
    r && typeof r.url === "string" && /^http:\/\/127\.0\.0\.1:\d+\/canvas\?id=[0-9a-f]{16}&token=[0-9a-f]{64}$/.test(r.url),
    `bad url: ${JSON.stringify(r)}`,
  );
  canvasUrl = r.url;
  return `cold resolve ${Date.now() - t0}ms — ${r.url.replace(/token=.*/, "token=…")}`;
});

// ------------------------------------------------- M2 relay serves video
await step("M2 relay serves video/mp4 + 206 range; a real <video> plays it", async () => {
  assert(canvasUrl, "M1 produced no url");
  const expr = `(async () => {
    const u = ${JSON.stringify(canvasUrl)};
    const full = await fetch(u);
    const st = full.status;
    const ct = full.headers.get("content-type");
    const cl = full.headers.get("content-length");
    try { full.body && full.body.cancel(); } catch {}
    const part = await fetch(u, { headers: { Range: "bytes=0-99" } });
    const rst = part.status;
    await part.arrayBuffer().catch(() => {});
    const v = document.createElement("video");
    v.muted = true; v.loop = true; v.playsInline = true;
    v.style.cssText = "position:fixed;left:-9999px;top:0;width:222px;height:222px";
    document.body.appendChild(v);
    v.src = u;
    let playErr = "";
    try { await v.play(); } catch (e) { playErr = String(e && e.name || e); }
    const t0 = v.currentTime;
    await new Promise((r) => setTimeout(r, 1600));
    const t1 = v.currentTime;
    const out = { st, ct, cl, rst, t0, t1, w: v.videoWidth, h: v.videoHeight, rs: v.readyState, err: v.error && v.error.code, dur: v.duration, playErr };
    v.remove();
    return out;
  })()`;
  const out = await evalPage(cdp, expr, true);
  const dump = JSON.stringify(out);
  assert(out.st === 200, `full GET status ${out.st} (${dump})`);
  assert(String(out.ct || "").includes("video/mp4"), `content-type ${out.ct} (${dump})`);
  assert(out.rst === 206, `range request status ${out.rst} (${dump})`);
  assert(out.t1 > out.t0 + 0.4, `playhead stuck ${out.t0} -> ${out.t1} (${dump})`);
  assert(out.w > 0 && out.h > 0, `no decoded frames (${dump})`);
  const crop = cropBox(out.w, out.h);
  assert(
    meetsCanvasFloor(out.w, out.h),
    `source ${out.w}x${out.h} fails the 9:16 720x1280 floor (crop ${crop.w}x${crop.h}) (${dump})`,
  );
  return `${out.w}x${out.h} crop=${crop.w}x${crop.h} ct=${out.ct} bytes=${out.cl} range=206 t ${out.t0.toFixed(2)}->${out.t1.toFixed(2)} dur=${(out.dur || 0).toFixed(1)}s`;
});

// ------------------------------------------------------ M3 honest miss
await step("M3 nonexistent track resolves to null (honest miss)", async () => {
  const r = await evalPage(
    cdp,
    `(async () => await window.__TAURI__.core.invoke("fetch_canvas", { title: "Zzzz Not A Real Song 12345", artist: "Nobody At All", album: "Nowhere", isrc: null }))()`,
    true,
  );
  assert(r && r.url === null, `expected null, got ${JSON.stringify(r)}`);
  return "null";
});

await step("M3b Kesariya (informational)", async () => {
  const r = await evalPage(
    cdp,
    `(async () => await window.__TAURI__.core.invoke("fetch_canvas", { title: "Kesariya", artist: "Arijit Singh", album: "Brahmastra", isrc: null }))()`,
    true,
  );
  return r && r.url ? `hit: ${r.url.replace(/token=.*/, "token=…")}` : "miss (expected — Indian film coverage is low)";
});

// ------------------------------------------------------ M4 full E2E
await step("M4 E2E: toggle on -> search -> trusted tap -> #np-canvas plays", async () => {
  await evalPage(cdp, `(() => { localStorage.setItem("tm-canvas", "1"); return true; })()`);
  await cdp.send("Page.reload", {}, 15000).catch(() => {});
  await sleep(1500);
  // the page-target socket dies with the reload — reconnect.
  cdp.close();
  for (let i = 0; i < 20; i++) {
    try {
      cdp = await connect();
      break;
    } catch {
      await sleep(1000);
    }
  }
  let shell = false;
  for (let i = 0; i < 25; i++) {
    try {
      shell = await evalPage(cdp, `!!document.getElementById("screen")`, false, 15000);
    } catch {}
    if (shell) break;
    await sleep(1000);
  }
  assert(shell, "shell did not come back after reload");
  preCanvasDark = await evalPage(
    cdp,
    `document.documentElement.classList.contains("dark")`,
    false,
    15000,
  );
  await evalPage(cdp, `location.hash = "#/search"`, false, 15000);
  await sleep(900);
  await evalPage(
    cdp,
    `(() => { const i = document.getElementById("search-input"); if (i) { i.value = "after hours the weeknd"; i.dispatchEvent(new Event("input", { bubbles: true })); } return true; })()`,
  );

  // tap loop: the source-first merge lands ~1-2 s after the first paint and
  // re-renders the list, so settle first; verify the tap landed (hash ->
  // nowplaying) and retry if a re-render swallowed it (2026-10-17b lesson).
  let tapped = false;
  let tapDetail = "";
  for (let attempt = 0; attempt < 4 && !tapped; attempt++) {
    const row = await evalPage(
      cdp,
      `(async () => {
        const pick = () => [...document.querySelectorAll('[data-list="topres"][data-idx], [data-list="sres"][data-idx]')];
        // settle: three consecutive identical list snapshots ~700ms apart
        let prev = ""; let stable = 0; let rows = [];
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 700));
          rows = pick();
          const sig = rows.map((r) => r.textContent.trim().replace(/\\s+/g, " ").slice(0, 48)).join("|");
          if (sig && sig === prev) { stable++; if (stable >= 3) break; } else { stable = 0; prev = sig; }
        }
        if (!rows.length) return { x: -1, y: -1, n: 0, pick: "no rows after settle" };
        const clean = (el) => el.textContent.trim().replace(/\\s+/g, " ");
        const beforeWeeknd = (el) => { const t = clean(el); const i = t.indexOf("The Weeknd"); return i > 0 ? t.slice(0, i) : t; };
        let hit = rows.find((r) => /after hours/i.test(clean(r)) && !/\\(/.test(beforeWeeknd(r)));
        if (!hit) hit = rows.find((r) => /after hours/i.test(clean(r)));
        if (!hit) hit = rows[0];
        hit.scrollIntoView({ block: "center" });
        await new Promise((r) => setTimeout(r, 500));
        const rect = hit.getBoundingClientRect();
        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + Math.min(rect.height / 2, 24)),
          n: rows.length,
          pick: clean(hit).slice(0, 72),
          w: Math.round(rect.width), h: Math.round(rect.height),
        };
      })()`,
      true,
      90000,
    );
    if (row.x < 0) {
      tapDetail = `${row.pick} (attempt ${attempt + 1})`;
      await evalPage(
        cdp,
        `(() => { const i = document.getElementById("search-input"); if (i) { i.value = "after hours the weeknd"; i.dispatchEvent(new Event("input", { bubbles: true })); } return !!i; })()`,
      ).catch(() => {});
      continue;
    }
    const pt = { x: row.x, y: row.y, radiusX: 5, radiusY: 5, force: 1 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [pt] }, 15000);
    await sleep(70);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, 15000);
    await sleep(2200);
    const state = await evalPage(
      cdp,
      `({ hash: location.hash, np: !!document.getElementById("np-title") })`,
      false,
      15000,
    );
    tapDetail = `picked "${row.pick}" of ${row.n} rows @(${row.x},${row.y}) ${row.w}x${row.h} -> hash "${state.hash}" np=${state.np} (attempt ${attempt + 1})`;
    if (String(state.hash).includes("nowplaying") || state.np) tapped = true;
  }
  assert(tapped, `tap never landed — ${tapDetail}`);

  const seen = await evalPage(
    cdp,
    `(async () => {
      const title = () => { const el = document.getElementById("np-title"); return el ? el.textContent.trim() : ""; };
      let last = null;
      for (let i = 0; i < 45; i++) {
        const v =
          document.querySelector('#np-canvas-layer video[data-front="1"]') ||
          document.getElementById("np-canvas");
        if (v && !v.classList.contains("hidden") && v.src) {
          const t0 = v.currentTime;
          await new Promise((r) => setTimeout(r, 1300));
          const layer = document.getElementById("np-canvas-layer");
          const lr = layer ? layer.getBoundingClientRect() : null;
          return {
            src: String(v.src), t0, t1: v.currentTime, rs: v.readyState, w: v.videoWidth, h: v.videoHeight,
            crop: layer ? layer.dataset.crop : null,
            loop: layer ? layer.dataset.loop : null,
            source: layer ? layer.dataset.source : null,
            base: layer ? layer.dataset.base : null,
            floor: layer ? layer.dataset.floor : null,
            hash: location.hash, title: title(),
            mode: document.documentElement.classList.contains("np-canvas-live"),
            artMode: document.documentElement.classList.contains("np-canvas-art"),
            layer: lr ? { pos: getComputedStyle(layer).position, w: Math.round(lr.width), h: Math.round(lr.height) } : null,
            mainBg: getComputedStyle(document.querySelector("#screen main")).backgroundColor,
            cardBg: getComputedStyle(document.getElementById("np-art-card")).backgroundColor,
            vw: innerWidth, vh: innerHeight,
          };
        }
        last = { has: !!v, hidden: v ? v.classList.contains("hidden") : null, src: v ? String(v.src).slice(0, 60) : "", hash: location.hash, title: title() };
        await new Promise((r) => setTimeout(r, 700));
      }
      return { src: "", t0: -1, t1: -1, rs: -1, w: 0, h: 0, last };
    })()`,
    true,
    60000,
  );
  assert(String(seen.hash || "").includes("nowplaying"), `not on nowplaying: ${JSON.stringify(seen)} (${tapDetail})`);
  assert(seen.src && /\/canvas\?id=[0-9a-f]{16}/.test(seen.src), `np-canvas not loaded: ${JSON.stringify(seen)} (${tapDetail})`);
  assert(seen.t1 > seen.t0 + 0.4, `np-canvas not playing: ${JSON.stringify(seen)} (${tapDetail})`);
  assert(seen.w > 0 && seen.h > 0, `np-canvas no frames: ${JSON.stringify(seen)} (${tapDetail})`);
  assert(
    meetsCanvasFloor(seen.w, seen.h),
    `source ${seen.w}x${seen.h} fails the 9:16 720x1280 floor: ${JSON.stringify(seen)} (${tapDetail})`,
  );
  assert(
    seen.crop && /^\d+x\d+$/.test(String(seen.crop)),
    `layer.data-crop missing: ${JSON.stringify(seen)} (${tapDetail})`,
  );
  const [cropW, cropH] = String(seen.crop).split("x").map(Number);
  assert(
    cropW >= 720 && cropH >= 1280,
    `data-crop ${seen.crop} is below 720x1280: ${JSON.stringify(seen)} (${tapDetail})`,
  );
  assert(seen.loop === "6", `data-loop is not 6: ${JSON.stringify(seen)} (${tapDetail})`);
  assert(seen.floor === "ok", `data-floor is not ok: ${JSON.stringify(seen)} (${tapDetail})`);
  assert(seen.mode === true && seen.artMode === true, `cinematic mode not on: ${JSON.stringify(seen)} (${tapDetail})`);
  assert(
    seen.layer && seen.layer.pos === "fixed" && Math.abs(seen.layer.w - seen.vw) <= 2 && Math.abs(seen.layer.h - seen.vh) <= 2,
    `canvas layer is not full-bleed: ${JSON.stringify(seen)} (${tapDetail})`,
  );
  assert(
    seen.mainBg === "rgba(0, 0, 0, 0)" && seen.cardBg === "rgba(0, 0, 0, 0)",
    `page/art card still opaque — the video cannot show through: ${JSON.stringify(seen)} (${tapDetail})`,
  );

  // screenshot for the eye (mobile Now Playing with the canvas playing)
  try {
    await sleep(1200);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, 30000);
    writeFileSync(`${process.env.TEMP}\\opencode\\canvas-e2e.png`, Buffer.from(shot.data, "base64"));
  } catch {}

  return `title="${seen.title}" ${seen.w}x${seen.h} crop=${seen.crop} loop=${seen.loop}s base=${seen.base}s t ${seen.t0.toFixed(2)}->${seen.t1.toFixed(2)} src=${seen.src.replace(/token=.*/, "token=…")} — ${tapDetail}`;
});

// ---------------------------------------------- M5 ambient on Home
await step("M5 ambient canvas persists on Home (focus off, dim on)", async () => {
  await evalPage(cdp, `location.hash = "#/home"`, false, 15000);
  await sleep(1800);
  const st = await evalPage(
    cdp,
    `(() => {
      const v = document.querySelector('#np-canvas-layer video[data-front="1"]');
      const layer = document.getElementById("np-canvas-layer");
      const img = document.getElementById("np-canvas-backdrop");
      return {
        hash: location.hash,
        live: document.documentElement.classList.contains("np-canvas-live"),
        focus: document.documentElement.classList.contains("np-canvas-focus"),
        art: document.documentElement.classList.contains("np-canvas-art"),
        paused: v ? v.paused : null,
        src: v ? v.getAttribute("src") : null,
        layerHidden: layer ? layer.classList.contains("hidden") : null,
        dim: layer ? layer.classList.contains("dim") : null,
        mode: layer ? layer.dataset.mode : null,
        backdrop: img ? String(img.currentSrc || img.src || "") : null,
        dark: document.documentElement.classList.contains("dark"),
        np: !!document.getElementById("np-title"),
      };
    })()`,
    false,
    15000,
  );
  assert(String(st.hash).includes("home"), `navigation did not land on home: ${JSON.stringify(st)}`);
  assert(st.np === false, `the Now Playing fragment is still mounted: ${JSON.stringify(st)}`);
  assert(st.live === true && st.focus === false, `ambient classes wrong: ${JSON.stringify(st)}`);
  assert(st.layerHidden === false && st.dim === true, `layer not visible/ambient: ${JSON.stringify(st)}`);
  assert(st.mode === "video", `video mode lost on navigation: ${JSON.stringify(st)}`);
  assert(st.src && /\/canvas\?id=/.test(st.src) && st.paused === false, `canvas video stopped on navigation: ${JSON.stringify(st)}`);
  assert(st.dark === true, `cinematic theme dropped on navigation: ${JSON.stringify(st)}`);
  assert(st.backdrop && !/logo\.png$/.test(st.backdrop), `artwork backdrop missing: ${JSON.stringify(st)}`);
  try {
    await sleep(800);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, 30000);
    writeFileSync(`${process.env.TEMP}\\opencode\\canvas-home-ambient.png`, Buffer.from(shot.data, "base64"));
  } catch {}
  return `home keeps the full-bleed canvas (dim=${st.dim}, focus=${st.focus}, dark=${st.dark}, video playing)`;
});

// ---------------------------------------------- M6 focus returns
await step("M6 returning to Now Playing regains focus", async () => {
  await evalPage(cdp, `location.hash = "#/nowplaying"`, false, 15000);
  await sleep(1400);
  const st = await evalPage(
    cdp,
    `(() => {
      const layer = document.getElementById("np-canvas-layer");
      const v = document.querySelector('#np-canvas-layer video[data-front="1"]');
      const t = document.getElementById("np-title");
      return {
        hash: location.hash,
        title: t ? t.textContent.trim() : "",
        live: document.documentElement.classList.contains("np-canvas-live"),
        focus: document.documentElement.classList.contains("np-canvas-focus"),
        dim: layer ? layer.classList.contains("dim") : null,
        mode: layer ? layer.dataset.mode : null,
        paused: v ? v.paused : null,
      };
    })()`,
    false,
    15000,
  );
  assert(String(st.hash).includes("nowplaying"), `navigation did not land on nowplaying: ${JSON.stringify(st)}`);
  assert(st.title, `np-title not painted: ${JSON.stringify(st)}`);
  assert(st.live === true && st.focus === true && st.dim === false, `focus not restored: ${JSON.stringify(st)}`);
  assert(st.mode === "video" && st.paused === false, `canvas video not alive: ${JSON.stringify(st)}`);
  return `focused Now Playing again ("${st.title}")`;
});

// ---------------------------------------------- M9 6 s loop
await step("M9 the official cut loops a 6 s window", async () => {
  const read = `(() => {
    const vids = [...document.querySelectorAll("#np-canvas-layer video")];
    const v = vids.find((el) => el.dataset.front === "1") || vids[0];
    const layer = document.getElementById("np-canvas-layer");
    return v
      ? {
          id: v.id,
          t: v.currentTime,
          paused: v.paused,
          loop: v.loop,
          mode: layer ? layer.dataset.mode : null,
          loopAttr: layer ? layer.dataset.loop : null,
          base: layer ? layer.dataset.base : null,
        }
      : null;
  })()`;
  const start = await evalPage(cdp, read, false, 15000);
  assert(
    start && start.mode === "video" && start.paused === false,
    `no playing canvas video for the loop probe: ${JSON.stringify(start)}`,
  );
  assert(start.loop === false, `video.loop must stay false (the rAF owns the window): ${JSON.stringify(start)}`);
  const base = Number(start.base || 0);
  const expected = base + 0.6;
  let maxT = start.t;
  let moved = null;
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    const cur = await evalPage(cdp, read, false, 15000);
    if (!cur) continue;
    if (cur.id !== start.id || cur.t + 0.5 < maxT) {
      moved = cur;
      break;
    }
    maxT = Math.max(maxT, cur.t);
  }
  assert(moved, `the visible front never looped within 12 s (start ${JSON.stringify(start)}, maxT=${maxT.toFixed(2)})`);
  assert(moved.paused === false, `the new front is not playing: ${JSON.stringify(moved)}`);
  assert(
    Math.abs(moved.t - expected) <= 1.2,
    `the new front did not start near the window start (base ${base.toFixed(2)}, expected ${expected.toFixed(2)}): ${JSON.stringify(moved)}`,
  );
  return `base=${base.toFixed(2)}s front ${start.id} t=${start.t.toFixed(2)} -> ${moved.id} t=${moved.t.toFixed(2)} (data-loop=${moved.loopAttr}s)`;
});

// ---------------------------------------------- M7 artwork fallback
await step("M7 a track without an Apple cut still shows a full-bleed artwork backdrop", async () => {
  // The transport paints on every timeupdate; pause it so the deliberately
  // painted fallback is not immediately replaced by the real track's canvas.
  probeWasPlaying = await evalPage(
    cdp,
    `(async () => { const { audio } = await import("./player.js"); return audio ? !audio.paused : false; })()`,
    true,
    15000,
  ).catch(() => false);
  await evalPage(
    cdp,
    `(async () => { const { audio } = await import("./player.js"); if (audio) audio.pause(); return true; })()`,
    true,
    15000,
  );
  await sleep(600);
  const info = await evalPage(
    cdp,
    `(async () => {
      const { playerState } = await import("./player.js");
      const { paintCanvasForTrack } = await import("./canvas.js");
      const cur = playerState().track;
      const image = cur && cur.image ? String(cur.image) : "";
      // A real cover (the current track's) with a title that cannot resolve:
      // the fetch_canvas miss is real, the renderer path is real.
      await paintCanvasForTrack({ id: "probe-fallback-1", title: "Zzzz No Canvas Probe 12345", artist: "Nobody At All", album: "Nowhere", image });
      return { image, cur: cur ? { id: cur.id, title: cur.title } : null };
    })()`,
    true,
    60000,
  );
  assert(info.image, `current track has no cover to fall back on: ${JSON.stringify(info)}`);
  const read = `(() => {
    const v = document.getElementById("np-canvas");
    const layer = document.getElementById("np-canvas-layer");
    const img = document.getElementById("np-canvas-backdrop");
    const art = document.getElementById("np-art");
    const wash = document.getElementById("np-canvas-wash");
    return {
      mode: layer ? layer.dataset.mode : null,
      layerHidden: layer ? layer.classList.contains("hidden") : null,
      dim: layer ? layer.classList.contains("dim") : null,
      focus: document.documentElement.classList.contains("np-canvas-focus"),
      live: document.documentElement.classList.contains("np-canvas-live"),
      artWindow: document.documentElement.classList.contains("np-canvas-art"),
      motion: document.documentElement.classList.contains("np-canvas-motion"),
      artAnim: art ? getComputedStyle(art).animationName : null,
      artDur: art ? getComputedStyle(art).animationDuration : null,
      artTransform: art ? getComputedStyle(art).transform : null,
      washName: wash ? getComputedStyle(wash).animationName : null,
      washDur: wash ? getComputedStyle(wash).animationDuration : null,
      washOpacity: wash ? getComputedStyle(wash).opacity : null,
      videoHidden: v ? v.classList.contains("hidden") : null,
      videoSrc: v ? v.getAttribute("src") : null,
      backdrop: img ? String(img.currentSrc || img.src || "") : "",
      complete: img ? img.complete : null,
      w: img ? img.naturalWidth : 0,
      hash: location.hash,
    };
  })()`;
  let st;
  for (let i = 0; i < 30; i++) {
    st = await evalPage(cdp, read, false, 15000);
    if (st.mode === "art" && st.complete && st.w > 0) break;
    await sleep(400);
  }
  assert(st.mode === "art", `artwork fallback mode missing: ${JSON.stringify(st)}`);
  assert(st.layerHidden === false && st.live === true && st.focus === true, `fallback presentation wrong: ${JSON.stringify(st)}`);
  assert(st.videoHidden === true && !st.videoSrc, `the fallback should have no video: ${JSON.stringify(st)}`);
  assert(st.artWindow === false, `the art card must stay sharp/opaque for the fallback: ${JSON.stringify(st)}`);
  assert(st.backdrop && !/logo\.png$/.test(st.backdrop), `backdrop src is not the cover: ${JSON.stringify(st)}`);
  assert(st.complete === true && st.w > 0, `backdrop image never decoded: ${JSON.stringify(st)}`);
  // 2026-10-20: a track without Apple motion artwork must still animate — the
  // art card cover pans/zooms (the all-songs "canvas"). Prove the CSS
  // animation is genuinely running, not merely declared.
  assert(st.motion === true, `fallback motion class missing: ${JSON.stringify(st)}`);
  assert(String(st.artAnim).includes("np-cover-drift"), `art card has no drift animation: ${JSON.stringify(st)}`);
  assert(st.artDur === "6s", `generated canvas is not on the 6 s clock: ${JSON.stringify(st)}`);
  assert(String(st.washName).includes("np-canvas-wash"), `generated canvas wash missing: ${JSON.stringify(st)}`);
  assert(st.washDur === "6s", `generated canvas wash is not 6 s: ${JSON.stringify(st)}`);
  assert(Number(st.washOpacity) > 0, `generated canvas wash is invisible: ${JSON.stringify(st)}`);
  const firstTransform = st.artTransform;
  assert(firstTransform && firstTransform !== "none", `art card transform never applied: ${JSON.stringify(st)}`);
  await sleep(1500);
  const moving = await evalPage(cdp, read, false, 15000);
  assert(moving.artTransform !== firstTransform, `art card did not move over 1.5s: ${firstTransform} -> ${moving.artTransform}`);

  // …and the fallback also persists on Home (every song × every screen).
  await evalPage(cdp, `location.hash = "#/home"`, false, 15000);
  await sleep(1600);
  const home = await evalPage(cdp, read, false, 15000);
  assert(String(home.hash).includes("home"), `fallback navigation did not land on home: ${JSON.stringify(home)}`);
  assert(home.mode === "art" && home.layerHidden === false && home.live === true, `fallback lost on Home: ${JSON.stringify(home)}`);
  assert(home.focus === false && home.dim === true, `fallback not ambient on Home: ${JSON.stringify(home)}`);
  assert(home.complete === true && home.w > 0, `fallback cover never decoded on Home: ${JSON.stringify(home)}`);
  try {
    await sleep(800);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, 30000);
    writeFileSync(`${process.env.TEMP}\\opencode\\canvas-home-fallback.png`, Buffer.from(shot.data, "base64"));
  } catch {}
  return `fallback cover ${st.w}px decoded; card drift ${firstTransform.slice(0, 30)} -> ${moving.artTransform.slice(0, 30)}; persists on Home (mode=${home.mode}, dim=${home.dim})`;
});

// ---------------------------------------------- M8 off → restore
await step("M8 canvas OFF stops the layer and restores the theme", async () => {
  // Drive the real Settings toggle-off path: the switch writes the pref OFF
  // first, then stops the renderer, then repaints the current track. Without
  // that first write the next player paint (~4x/s) legitimately resurrects
  // the canvas, which is exactly what the earlier probe mis-read as a leak.
  await evalPage(cdp, `localStorage.setItem("tm-canvas", "0")`, false, 15000);
  await evalPage(
    cdp,
    `(async () => {
      const { stopCanvas, paintCanvasForTrack } = await import("./canvas.js");
      const { playerState } = await import("./player.js");
      stopCanvas();
      await paintCanvasForTrack(playerState().track || null);
      return true;
    })()`,
    true,
    15000,
  );
  await sleep(600);
  const st = await evalPage(
    cdp,
    `(() => {
      const v = document.getElementById("np-canvas");
      const layer = document.getElementById("np-canvas-layer");
      const img = document.getElementById("np-canvas-backdrop");
      return {
        live: document.documentElement.classList.contains("np-canvas-live"),
        focus: document.documentElement.classList.contains("np-canvas-focus"),
        art: document.documentElement.classList.contains("np-canvas-art"),
        motion: document.documentElement.classList.contains("np-canvas-motion"),
        layerHidden: layer ? layer.classList.contains("hidden") : null,
        paused: v ? v.paused : null,
        src: v ? v.getAttribute("src") : null,
        backdrop: img ? img.getAttribute("src") : null,
        dark: document.documentElement.classList.contains("dark"),
      };
    })()`,
    false,
    15000,
  );
  assert(!st.live && !st.focus && !st.art && !st.motion, `cinematic classes survived stop: ${JSON.stringify(st)}`);
  assert(st.layerHidden === true, `layer still visible after stop: ${JSON.stringify(st)}`);
  assert(!st.src && !st.backdrop, `media src kept after stop: ${JSON.stringify(st)}`);
  assert(st.dark === preCanvasDark, `theme not restored (expected dark=${preCanvasDark}): ${JSON.stringify(st)}`);
  // Leave the device as found: restore the user's pref, then repaint the real
  // track if the canvas was on (stopCanvas clears the per-track guard).
  if (origCanvasPref === null) {
    await evalPage(cdp, `localStorage.removeItem("tm-canvas")`, false, 15000);
  } else {
    await evalPage(cdp, `localStorage.setItem("tm-canvas", ${JSON.stringify(origCanvasPref)})`, false, 15000);
  }
  if (origCanvasPref === "1") {
    await evalPage(
      cdp,
      `(async () => { const { playerState } = await import("./player.js"); const { stopCanvas, paintCanvasForTrack } = await import("./canvas.js"); stopCanvas(); await paintCanvasForTrack(playerState().track); return true; })()`,
      true,
      30000,
    ).catch(() => {});
  }
  if (probeWasPlaying) {
    await evalPage(
      cdp,
      `(async () => { const { audio } = await import("./player.js"); if (audio) { const p = audio.play(); if (p && p.catch) p.catch(() => {}); } return true; })()`,
      true,
      15000,
    ).catch(() => {});
  }
  return `stopped, layer hidden, theme restored (dark=${st.dark})`;
});

// ---------------------------------------------------------------- summary
const pass = results.filter(([, ok]) => ok).length;
const fail = results.length - pass;
console.log(`\n=== canvas-live: ${pass}/${results.length} pass, ${fail} fail ===`);
if (fail) {
  for (const [name, ok, detail] of results) if (!ok) console.log(`  FAILED ${name}: ${detail}`);
}
process.exit(fail ? 1 : 0);
