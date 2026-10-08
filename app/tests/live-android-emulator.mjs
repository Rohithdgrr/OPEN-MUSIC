// LIVE end-to-end test — real app, real sockets, no stubs.
//
// The Tauri Android app running on an emulator hosts a LAN room through its
// own Rust server; this script drives that app's UI over CDP (the WebView
// devtools socket, forwarded with `adb forward`) and joins the room as a
// genuine second WebSocket client. Every number it prints came from the
// device: chat latency, member counts, drift, the host/guest rules.
//
//   node tests/live-android-emulator.mjs
//
// Requires: an emulator with the debug APK installed and running, plus
// ANDROID_HOME (default C:/Users/<you>/AppData/Local/Android/Sdk).
// See docs/listen-together.md §13.4.

import { execFileSync } from "node:child_process";

const SDK = process.env.ANDROID_HOME || "C:/Users/rohit/AppData/Local/Android/Sdk";
const ADB = `${SDK}/platform-tools/adb`;
const PKG = "com.openmusic.trancemusic";
const CDP_PORT = 9223;

// stderr is captured too: `monkey` narrates on stderr and would otherwise
// interleave with the report.
const adb = (...args) => execFileSync(ADB, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/// Same, but a non-zero exit is data rather than an exception (probing).
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
  out.push(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " :: " + detail : ""}`);

/// Minimal CDP client: enough for `Runtime.evaluate`.
function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.addEventListener("open", () =>
      resolve({
        evalJs: (expression) =>
          new Promise((res, rej) => {
            const id = ++seq;
            pending.set(id, (msg) => {
              if (msg.result?.exceptionDetails) rej(new Error(JSON.stringify(msg.result.exceptionDetails.exception)));
              else res(msg.result?.result?.value);
            });
            ws.send(
              JSON.stringify({
                id,
                method: "Runtime.evaluate",
                params: { expression, awaitPromise: true, returnByValue: true },
              }),
            );
          }),
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

/// A plain second client, exactly what another device would open.
function connectGuest(port) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.addEventListener("open", () =>
      resolve({
        frames,
        send: (o) => ws.send(JSON.stringify(o)),
        close: () => ws.close(),
        await: (t, ms = 3000) =>
          new Promise((res) => {
            const t0 = Date.now();
            const iv = setInterval(() => {
              const hit = frames.find((f) => f.t === t);
              if (hit || Date.now() - t0 > ms) {
                clearInterval(iv);
                res(hit || null);
              }
            }, 20);
          }),
      }),
    );
    ws.addEventListener("message", (e) => {
      try {
        frames.push(JSON.parse(e.data));
      } catch {
        /* non-JSON frame: ignore, nothing in the protocol sends one */
      }
    });
    ws.addEventListener("error", reject);
    setTimeout(() => reject(new Error("guest socket never opened")), 8000);
  });
}

/// The assertions below describe a **cold** app: a room opened by an earlier
/// run would survive inside the still-running Rust process, so the precondition
/// is established here rather than assumed.
async function coldStart() {
  adb("shell", "am", "force-stop", PKG);
  adb("forward", "--remove-all");
  await wait(1500);
  adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1");
  for (let i = 0; i < 30; i++) {
    await wait(1000);
    const up = adbTry("shell", "grep -c webview_devtools_remote /proc/net/unix");
    if (Number(up) > 0) return;
  }
  throw new Error("the app never came up with a devtools socket");
}

async function main() {
  await coldStart();
  const pid = adb("shell", "pidof", PKG).split(/\s+/)[0];
  check("app is running on the emulator", !!pid, `pid=${pid}`);
  const unix = adb("shell", "cat /proc/net/unix");
  const sock = [...unix.matchAll(/webview_devtools_remote_\d+/g)].map((m) => m[0]).pop();
  check("WebView devtools socket exists (debug build)", !!sock, sock);
  adb("forward", `tcp:${CDP_PORT}`, `localabstract:${sock}`);
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const page = targets.find((t) => t.type === "page");
  check("CDP page target found", !!page, page?.url);
  const app = await cdp(page.webSocketDebuggerUrl);

  /// The devtools socket appears before the webview has run the app, so every
  /// step waits for the element/IPC it needs instead of sleeping a guess.
  const waitFor = async (expr, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        if (await app.evalJs(expr)) return true;
      } catch {
        /* document not ready yet */
      }
      await wait(250);
    }
    return false;
  };

  check("real Tauri IPC present (not a stub)", await waitFor("!!window.__TAURI__?.core"));

  await app.evalJs('location.hash = "#/nowplaying"');
  check("NowPlaying screen mounted", await waitFor('!!document.getElementById("jamQueueList")'));
  await wait(600);

  // Diagnostics: any failing check below must be explainable from this dump.
  const state = await app.evalJs(
    'window.__TAURI__.core.invoke("room_info").then(i=>JSON.stringify(i)).catch(e=>"ERR "+e)',
  );
  const at = async (id) => await app.evalJs(`(document.getElementById("${id}")||{}).textContent`);
  console.log(
    [
      `diag room_info=${state}`,
      `diag bannerCode=${await at("jamBannerCode")}`,
      `diag role=${await at("jamRoleBadge")}`,
      `diag count=${await at("jamBannerCount")}`,
      `diag header=${await at("headerSubtitle")}`,
      `diag bannerDisplay=${await app.evalJs('getComputedStyle(document.getElementById("jamSessionBanner")).display')}`,
    ].join("\n"),
  );

  check(
    "Solo hides all social chrome",
    (await app.evalJs('getComputedStyle(document.getElementById("jamSessionBanner")).display')) === "none",
  );

  await app.evalJs('document.getElementById("modeToggleBtn").click()');
  await wait(400);
  const labels = await app.evalJs('[...document.querySelectorAll("button")].map(b=>b.textContent.trim()).join("|")');
  check("jam sheet offers host + join", /Start a Jam/.test(labels) && /Join a Jam/.test(labels), labels.slice(0, 90));

  await app.evalJs(
    '[...document.querySelectorAll("button")].find(b=>b.textContent.trim().startsWith("Start a Jam")).click()',
  );
  await wait(2500);

  const banner = await app.evalJs('document.getElementById("jamBannerCode").textContent');
  const code = String(banner).replace(/[^A-Za-z0-9]/g, "");
  check("the device's Rust server opened a room", /^[2-9A-HJ-NP-Z]{8}$/.test(code), banner);
  check("member count starts at 1", (await app.evalJs('document.getElementById("jamBannerCount").textContent')) === "1");
  check("drift is unmeasured with no peers", (await app.evalJs('document.getElementById("jamBannerDrift").textContent')) === "—");
  check("Jam Data titles the real room", (await app.evalJs('document.getElementById("jamRoomTitle").textContent')) === `Jam Room #${code}`);
  check("role badge reads HOST", (await app.evalJs('document.getElementById("jamRoleBadge").textContent')) === "HOST");
  const invite = await app.evalJs('document.getElementById("jamInviteUri").textContent');
  // c994fae unified invites: the backend mints `trancemusic://join?host=…&port=…&code=…`
  // (canonical, parsed by room_join_uri); the legacy `ws://ip:port · CODE`
  // composite is the fallback. Both are dialable — accept either, extract port.
  const inviteStr = String(invite);
  const canonical = inviteStr.match(/^trancemusic:\/\/join\?.*?\bport=(\d{2,5})\b/);
  const legacy = inviteStr.match(/^ws:\/\/\d+\.\d+\.\d+\.\d+:(\d{2,5}) · /);
  const port = (canonical || legacy || [])[1];
  check("invite carries a dialable address", !!(canonical || legacy), inviteStr);

  // ---- second client, over the wire ----
  adb("forward", `tcp:${port}`, `tcp:${port}`);
  const guest = await connectGuest(Number(port));
  guest.send({ t: "join", v: 1, code, name: "Node Guest" });
  await wait(1200);
  const kinds = guest.frames.map((f) => f.t).join(",");
  check("handshake: joined + history + presence", ["joined", "history", "presence"].every((t) => kinds.includes(t)), kinds);
  check("guest is told it is not the host", guest.frames.some((f) => f.t === "joined" && f.youAreHost === false));

  const t0 = Date.now();
  guest.send({ t: "chat", text: "hello from the node guest" });
  const echo = await guest.await("chat");
  const rtt = Date.now() - t0;
  check("chat round-trips through the device", !!echo && /node guest/.test(echo.text), `echo in ${rtt}ms`);
  check("chat round-trip is LAN-grade", rtt < 250, `${rtt}ms including the adb bridge`);

  guest.send({ t: "report", driftMs: -250 });
  await wait(800);
  guest.send({ t: "playback", playing: true, trackId: "x", positionMs: 0 });
  await wait(800);
  check("guest playback is refused verbatim", guest.frames.some((f) => f.t === "error" && f.code === "not_host"));

  const members = await app.evalJs('String(document.getElementById("jamMembersList").children.length)');
  check("host UI shows 2 members", (await app.evalJs('document.getElementById("jamBannerCount").textContent')) === "2");
  check("member rows follow presence", members === "2", members);
  check(
    "host shows the guest's measured drift",
    (await app.evalJs('document.getElementById("jamBannerDrift").textContent')) === "±0.25s",
    await app.evalJs('document.getElementById("jamBannerDrift").textContent'),
  );
  const chatText = String(await app.evalJs('document.getElementById("jamChatList").textContent'));
  check("host painted the guest line exactly once", (chatText.match(/hello from the node guest/g) || []).length === 1);
  check("chat state line counts the room", (await app.evalJs('document.getElementById("jamChatState").textContent')) === "2 in room");

  guest.send({ t: "chat", text: "second line from guest" });
  await wait(900);
  check("host renders a second guest line", String(await app.evalJs('document.getElementById("jamChatList").textContent')).includes("second line from guest"));

  guest.send({ t: "leave" });
  await wait(1200);
  check("host drops to 1 member after the guest leaves", (await app.evalJs('document.getElementById("jamBannerCount").textContent')) === "1");
  check("drift returns to unmeasured", (await app.evalJs('document.getElementById("jamBannerDrift").textContent')) === "—");

  await app.evalJs('document.getElementById("jamEndBtn").click()');
  await wait(900);
  const after = await app.evalJs('[...document.querySelectorAll("button")].map(b=>b.textContent.trim()).join("|")');
  if (/(End|Confirm|Yes)/.test(after)) {
    await app.evalJs(
      '([...document.querySelectorAll("button")].find(b=>/^(End|Confirm|Yes)/.test(b.textContent.trim()))||{click(){}}).click()',
    );
    await wait(1200);
  }
  check(
    "leaving the room returns the deck to Solo",
    (await app.evalJs('document.getElementById("jamBannerCode").textContent')) === "NO ROOM",
    await app.evalJs('document.getElementById("jamBannerCode").textContent'),
  );
  check(
    "Solo hides social chrome again",
    (await app.evalJs('getComputedStyle(document.getElementById("jamSessionBanner")).display')) === "none",
  );

  guest.close();
  app.close();
}

try {
  await main();
} catch (err) {
  out.push("FAIL threw: " + (err?.message ?? String(err)));
}

console.log(out.join("\n"));
const passed = out.filter((l) => l.startsWith("PASS")).length;
const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(`---- ${passed} pass / ${failed} fail`);
process.exit(failed === 0 ? 0 : 1);
