// LIVE desktop test — the real `npm run tauri dev` app, real sockets.
//
// The desktop app hosts a room through its own Rust server; this script drives
// the app's Jam pane over CDP (WebView2 remote debugging) and joins that room
// as a genuine second WebSocket client. Everything asserted here is a number or
// a string the app itself produced: the code the server generated, the port it
// bound, the members it sees, the drift it measured, the chat it rendered.
//
//   npm run tauri dev            # with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
//                                # =--remote-debugging-port=9222
//   node tests/live-desktop.mjs
//
// See docs/listen-together.md §13.4.

import { cdp, connectGuest, waitFor, sleep, reporter, CODE_RE, CODE_FROM_BANNER } from "./live-harness.mjs";

const CDP = "http://127.0.0.1:9222";
const t = reporter("desktop live");

async function main() {
  const targets = await (await fetch(`${CDP}/json`)).json();
  const page = targets.find((x) => x.type === "page" && !/widget\.html$/.test(x.url));
  if (!t.check("dev app page found over CDP", !!page, page?.url)) return;
  const app = await cdp(page.webSocketDebuggerUrl);

  if (!t.check("real Tauri IPC present (not a stub)", await waitFor(app, "!!window.__TAURI__?.core"))) return;

  const at = async (id) => await app.evalJs(`(document.getElementById("${id}")||{}).textContent`);
  const click = async (id) => await app.evalJs(`document.getElementById("${id}")?.click()`);

  // Precondition: the dev app starts Solo.
  t.check("starts Solo (no room adopted)", (await at("jam-mode-label")) === "Solo", await at("jam-mode-label"));
  t.check("code slots read NO ROOM", (await at("jam-room-id")) === "NO ROOM", await at("jam-room-id"));
  t.check("sync tile starts unmeasured", (await at("jam-sync-value")) === "—", await at("jam-sync-value"));
  t.check("member rows show the one provable member", (await app.evalJs('String(document.getElementById("jam-members").children.length)')) === "1");

  // ---- host a room from the real UI ----
  // The Jam pane is social-only (`docs/social-nowplaying.md` §3): its controls
  // are `display:none` in Solo, so the real user path is the header switch
  // first. Clicking a hidden button would prove nothing about that path.
  await click("btn-mode-social");
  t.check(
    "Social mode engaged (Jam controls are reachable)",
    await waitFor(app, 'document.body.classList.contains("soc-social")'),
  );
  await click("btn-open-room");
  const opened = await waitFor(app, 'document.getElementById("jam-room-id").textContent !== "NO ROOM"');
  const code = CODE_FROM_BANNER(await at("jam-room-id"));
  t.check("hosting started from the UI", opened && CODE_RE.test(code), code);
  t.check("mode label flips to Host", (await at("jam-mode-label")) === "Host", await at("jam-mode-label"));
  const session = String(await at("jam-session-mode"));
  const port = Number((session.match(/port (\d+)/) || [])[1]);
  t.check("session line names the bound port", /^Hosting on port \d+$/.test(session), session);
  t.check("online count reads 1 online", (await at("chat-online-count")) === "1 online", await at("chat-online-count"));
  t.check("room note hands out the invite", String(await at("room-join-note")).includes(code), await at("room-join-note"));

  // ---- second client, over the wire ----
  // Dial the address the room itself advertises (a real guest has no other way
  // to find it). On this machine an `adb forward` may hold 127.0.0.1:8787, so
  // loopback is exactly the address NOT to guess.
  const info = JSON.parse(
    await app.evalJs('window.__TAURI__.core.invoke("room_info").then(i=>JSON.stringify(i))'),
  );
  const advertised = (info.urls || [])[0];
  t.check("room advertises a dialable address", /^ws:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(String(advertised)), advertised);
  t.check("advertised port matches the session line", Number(String(advertised).split(":").pop()) === port, `${advertised} vs ${port}`);
  const guest = await connectGuest(advertised);
  guest.send({ t: "join", v: 1, code, name: "Node Guest" });
  await sleep(1200);
  const kinds = guest.frames.map((f) => f.t).join(",");
  t.check("handshake: joined + history + presence", ["joined", "history", "presence"].every((k) => kinds.includes(k)), kinds);
  t.check("guest is told it is not the host", guest.frames.some((f) => f.t === "joined" && f.youAreHost === false));

  const t0 = Date.now();
  guest.send({ t: "chat", text: "hello from the node guest" });
  // F-era: the first `chat` frame on a fresh join is the server-origin system
  // line ("Node Guest joined"), so match OUR text, not the first frame.
  let echo = null;
  while (Date.now() - t0 < 3000) {
    echo = guest.frames.find((f) => f.t === "chat" && /node guest/i.test(String(f.text || "")) && !f.system);
    if (echo) break;
    await sleep(50);
  }
  const rtt = Date.now() - t0;
  t.check("chat round-trips through the desktop server", !!echo, `echo in ${rtt}ms`);
  t.check("chat round-trip is local-LAN-grade", rtt < 250, `${rtt}ms`);

  guest.send({ t: "report", driftMs: -250 });
  await sleep(900);
  guest.send({ t: "playback", playing: true, trackId: "x", positionMs: 0 });
  await sleep(900);
  t.check("guest playback is refused verbatim", guest.frames.some((f) => f.t === "error" && f.code === "not_host"));

  const members = await app.evalJs('String(document.getElementById("jam-members").children.length)');
  t.check("member rows follow presence", members === "2", members);
  t.check("online count follows presence", (await at("chat-online-count")) === "2 online", await at("chat-online-count"));
  t.check("members note counts the room", String(await at("jam-members-note")).startsWith("2 in the room"), await at("jam-members-note"));
  t.check("drift tile shows the guest's measurement", (await at("jam-sync-value")) === "±0.25s", await at("jam-sync-value"));
  const bubbles = String(await app.evalJs('document.getElementById("chat-messages-container").textContent'));
  t.check("chat pane painted the guest line exactly once", (bubbles.match(/hello from the node guest/g) || []).length === 1, bubbles.slice(0, 60));

  // ---- desktop → guest direction ----
  // Wrapped in an IIFE: `Runtime.evaluate` runs at global scope, so a bare
  // top-level `const` would survive in the page and make this file fail with
  // "Identifier 'i' has already been declared" the second time it is run
  // against the same window.
  await app.evalJs(
    '(()=>{const i=document.getElementById("chat-input"); i.value="line from the desktop"; i.dispatchEvent(new Event("input",{bubbles:true}));})()',
  );
  await click("btn-chat-send");
  await sleep(1200);
  t.check("guest received the desktop's line", guest.frames.some((f) => f.t === "chat" && /line from the desktop/.test(f.text)));
  t.check("desktop rendered its own line once", (String(await app.evalJs('document.getElementById("chat-messages-container").textContent')).match(/line from the desktop/g) || []).length === 1);
  t.check("chat input was cleared after send", (await app.evalJs('document.getElementById("chat-input").value')) === "");

  guest.send({ t: "leave" });
  await sleep(1200);
  t.check("host drops to 1 after the guest leaves", (await at("chat-online-count")) === "1 online", await at("chat-online-count"));
  t.check("drift returns to unmeasured", (await at("jam-sync-value")) === "—");

  // ---- leave from the UI ----
  await click("btn-leave-room");
  const back = await waitFor(app, 'document.getElementById("jam-room-id").textContent === "NO ROOM"', 8000);
  t.check("leaving the room clears the code slots", back, await at("jam-room-id"));
  t.check("mode label returns to Solo", (await at("jam-mode-label")) === "Solo", await at("jam-mode-label"));
  t.check("session line says local room", (await at("jam-session-mode")) === "Local room", await at("jam-session-mode"));

  guest.close();
  app.close();
}

try {
  await main();
} catch (err) {
  t.check("threw: " + (err?.message ?? String(err)), false);
}

process.exit(t.finish() ? 0 : 1);
