// LIVE scale + cycle probe — desktop host + N node WebSocket guests.
// Hand-run (not in `npm test`). Audio p95 is not claimed: node clients have
// no playhead. Server fan-out, cap, drop/rejoin, and host close→reopen are.
//
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
//   cargo build && target/debug/trance-music.exe
//   node tests/live-scale.mjs
//
// docs/jam-professional-grade.md N4 · docs/jam-upgrade.md §F.

import { cdp, connectGuest, waitFor, sleep, reporter, CODE_RE, CODE_FROM_BANNER } from "./live-harness.mjs";

const CDP = "http://127.0.0.1:9222";
const LADDER = [4, 8, 16];
const t = reporter("live-scale");

function waitFrame(g, pred, ms = 4000) {
  const t0 = Date.now();
  return new Promise((res) => {
    const iv = setInterval(() => {
      const hit = g.frames.find(pred);
      if (hit || Date.now() - t0 > ms) {
        clearInterval(iv);
        res(hit || null);
      }
    }, 20);
  });
}

async function joinN(url, code, n, prefix) {
  const guests = [];
  for (let i = 0; i < n; i++) {
    const g = await connectGuest(url);
    g.send({ t: "join", v: 1, code, name: `${prefix}${i}` });
    const joined = await waitFrame(g, (f) => f.t === "joined");
    if (!joined) throw new Error(`guest ${i} never joined`);
    guests.push(g);
  }
  return guests;
}

function closeAll(guests) {
  for (const g of guests) {
    try {
      g.close();
    } catch {
      /* already down */
    }
  }
}

async function main() {
  let targets;
  try {
    targets = await (await fetch(`${CDP}/json`)).json();
  } catch (e) {
    t.check("CDP :9222 is listening", false, String(e).slice(0, 120));
    process.exit(t.finish() ? 0 : 1);
  }
  const page = targets.find((x) => x.type === "page" && !/widget\.html$/.test(x.url));
  if (!t.check("app page found over CDP", !!page, page?.url)) {
    process.exit(t.finish() ? 0 : 1);
  }
  const app = await cdp(page.webSocketDebuggerUrl);
  if (!t.check("real Tauri IPC present", await waitFor(app, "!!window.__TAURI__?.core"))) {
    process.exit(t.finish() ? 0 : 1);
  }

  const at = async (id) => await app.evalJs(`(document.getElementById("${id}")||{}).textContent`);
  const click = async (id) => await app.evalJs(`document.getElementById("${id}")?.click()`);

  if (String(await at("jam-room-id")) !== "NO ROOM") {
    await click("btn-leave-room");
    await waitFor(app, 'document.getElementById("jam-room-id").textContent==="NO ROOM"', 8000);
  }
  if (!(await waitFor(app, 'document.body.classList.contains("soc-social")', 4000))) {
    await click("btn-mode-social");
    await waitFor(app, 'document.body.classList.contains("soc-social")');
  }

  await click("btn-open-room");
  const opened = await waitFor(app, 'document.getElementById("jam-room-id").textContent !== "NO ROOM"');
  const code = CODE_FROM_BANNER(await at("jam-room-id"));
  t.check("hosting started", opened && CODE_RE.test(code), code);

  const info = JSON.parse(
    await app.evalJs('window.__TAURI__.core.invoke("room_info").then(i=>JSON.stringify(i))'),
  );
  const advertised = (info.urls || [])[0];
  t.check("room advertises a dialable address", /^ws:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(String(advertised)), advertised);

  let guests = [];
  try {
    for (const n of LADDER) {
      closeAll(guests);
      await sleep(200);
      guests = await joinN(advertised, code, n, `S${n}G`);
      t.check(`N=${n} all joined`, guests.length === n, guests.length);

      const ping = `fan-out-${n}`;
      await app.evalJs(
        `window.__TAURI__.core.invoke("room_chat",{text:${JSON.stringify(ping)}})`,
      );
      await app.evalJs(
        'window.__TAURI__.core.invoke("room_playback",{playing:true,trackId:"scale-track",title:"T",artist:"A",positionMs:1000})',
      );
      await Promise.all(guests.map((g) => waitFrame(g, (f) => f.t === "chat" && f.text === ping)));
      await Promise.all(guests.map((g) => waitFrame(g, (f) => f.t === "playback" && f.trackId === "scale-track")));
      const chatHits = guests.filter((g) => g.frames.some((f) => f.t === "chat" && f.text === ping)).length;
      const playHits = guests.filter((g) => g.frames.some((f) => f.t === "playback" && f.trackId === "scale-track")).length;
      t.check(`N=${n} chat reaches every guest`, chatHits === n, `${chatHits}/${n}`);
      t.check(`N=${n} playback reaches every guest`, playHits === n, `${playHits}/${n}`);
    }

    const late = await connectGuest(advertised);
    late.send({ t: "join", v: 1, code, name: "Late17" });
    const full = await waitFrame(late, (f) => f.t === "error" && f.code === "room_full");
    t.check("17th guest is room_full", !!full, full?.message);
    late.close();

    guests[0].close();
    await sleep(250);
    const again = await connectGuest(advertised);
    again.send({ t: "join", v: 1, code, name: "Rejoin" });
    t.check("drop then rejoin same code", !!(await waitFrame(again, (f) => f.t === "joined")));
    again.close();

    closeAll(guests);
    await click("btn-leave-room");
    t.check("host close returns to NO ROOM", await waitFor(app, 'document.getElementById("jam-room-id").textContent==="NO ROOM"', 8000));

    await click("btn-open-room");
    t.check("reopen after close", await waitFor(app, 'document.getElementById("jam-room-id").textContent !== "NO ROOM"', 8000));
    const code2 = CODE_FROM_BANNER(await at("jam-room-id"));
    const info2 = JSON.parse(
      await app.evalJs('window.__TAURI__.core.invoke("room_info").then(i=>JSON.stringify(i))'),
    );
    const url2 = (info2.urls || [])[0];
    const g2 = await connectGuest(url2);
    g2.send({ t: "join", v: 1, code: code2, name: "AfterSwap" });
    t.check("new room accepts a guest after host close", !!(await waitFrame(g2, (f) => f.t === "joined")), code2);
    g2.close();

    await click("btn-leave-room");
    await waitFor(app, 'document.getElementById("jam-room-id").textContent==="NO ROOM"', 8000);
  } finally {
    closeAll(guests);
    try {
      app.close();
    } catch {
      /* probe done */
    }
  }

  process.exit(t.finish() ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
