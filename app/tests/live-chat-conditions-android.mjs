// LIVE Android chat-conditions sweep — real debug APK on the emulator, real
// device-side Rust server, real second socket over `adb forward`.
//
// Companion to live-android-emulator.mjs (D1 baseline, 28 checks): this probe
// drives D2–D8 plus the mobile sides of the ledger rows G2 (typed text lost on
// failure), G3 (maxlength), G5 (device-local echo surviving into a room), G6
// (mobile rebuilds its empty state — asserted by TEXT, not id), and the F
// system-line conditions seen from the host device (F1/F2/F7, desired
// behaviour → FAIL pre-fix, PASS after Stage 7).
//
//   node tests/live-chat-conditions-android.mjs
//
// Needs: emulator running, debug APK installed (`webview_devtools_remote`
// socket = debug build). Cold-starts the app itself if needed.
//
// Rate budget: the server allows 5 messages / 10 s per member, so the probe
// spends exactly 5 (D2's reactions), sleeps 11 s, then sends the rest.

import { execFileSync } from "node:child_process";
import { cdp, connectGuest, waitFor, sleep, reporter, CODE_RE } from "./live-harness.mjs";

const PKG = "com.openmusic.trancemusic";
const CDP_PORT = 9224; // distinct from live-android-emulator (9223)
const ADB = `${process.env.ANDROID_HOME}\\platform-tools\\adb.exe`;
const t = reporter("android chat conditions");

const adb = (...args) => execFileSync(ADB, args, { encoding: "utf8" });

async function ensureApp() {
  let sock = "";
  try {
    const unix = adb("shell", "cat /proc/net/unix");
    sock = [...unix.matchAll(/webview_devtools_remote_\d+/g)].map((m) => m[0]).pop() || "";
  } catch {
    /* app not up yet */
  }
  if (!sock) {
    adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1");
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      await sleep(1000);
      try {
        const unix = adb("shell", "cat /proc/net/unix");
        sock = [...unix.matchAll(/webview_devtools_remote_\d+/g)].map((m) => m[0]).pop() || "";
        if (sock) break;
      } catch {
        /* retry */
      }
    }
  }
  adb("forward", "--remove-all");
  adb("forward", `tcp:${CDP_PORT}`, `localabstract:${sock}`);
}

async function main() {
  await ensureApp();
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const page = targets.find((x) => x.type === "page");
  if (!t.check("CDP page target found", !!page, page?.url)) return;
  const app = await cdp(page.webSocketDebuggerUrl);
  if (!t.check("real Tauri IPC present", await waitFor(app, "!!window.__TAURI__?.core"))) return;

  const at = async (id) => await app.evalJs(`(document.getElementById("${id}")||{}).textContent`);
  const val = async (id) => await app.evalJs(`(document.getElementById("${id}")||{}).value || ""`);
  const click = async (expr) => await app.evalJs(expr);
  const count = async (needle) =>
    Number(
      await app.evalJs(
        `(()=>{const s=document.getElementById("jamChatList")?.textContent||"";return s.split(${JSON.stringify(needle)}).length-1})()`,
      ),
    );
  const toastText = async () => String(await app.evalJs('document.getElementById("tm-toast-stack")?.textContent||""'));

  await app.evalJs('location.hash = "#/nowplaying"');
  if (!(await waitFor(app, '!!document.getElementById("jamQueueList")'))) {
    t.check("NowPlaying screen mounted", false);
    return;
  }
  await sleep(600);

  // ---- Phase 0: known state — no room, Solo, no leftover toasts ----------
  const info0 = JSON.parse(
    await app.evalJs('window.__TAURI__.core.invoke("room_info").then(i=>JSON.stringify(i))'),
  );
  if (info0.role !== "idle") {
    await app.evalJs('window.__TAURI__.core.invoke("room_close").catch(()=>{})');
    await sleep(500);
  }
  await click('document.getElementById("modeSoloTab")?.click()');
  await sleep(600);
  const info1 = JSON.parse(
    await app.evalJs('window.__TAURI__.core.invoke("room_info").then(i=>JSON.stringify(i))'),
  );
  t.check("Phase 0: idle + Solo", info1.role === "idle", JSON.stringify(info1));

  // ---- D5: chat tab hidden in Solo (P25 regression) ----------------------
  t.check("D5: chat tab hidden in Solo",
    (await app.evalJs('getComputedStyle(document.getElementById("chatTabBtn")).display')) === "none",
    await app.evalJs('getComputedStyle(document.getElementById("chatTabBtn")).display'));

  // ---- G3: mobile input declares maxlength (desired; pre-fix FAILs) ------
  t.check("G3: jamChatInput declares maxlength=500",
    (await app.evalJs('document.getElementById("jamChatInput").maxLength')) === 500,
    await app.evalJs('document.getElementById("jamChatInput").maxLength'));

  // ---- Enter Social (no room), open the chat tab -------------------------
  await click('document.getElementById("modeSocialTab")?.click()');
  await sleep(500);
  t.check("social chrome shows the chat tab",
    (await app.evalJs('getComputedStyle(document.getElementById("chatTabBtn")).display')) !== "none",
    await app.evalJs('getComputedStyle(document.getElementById("chatTabBtn")).display'));
  await click('document.getElementById("chatTabBtn")?.click()');
  await sleep(400);
  t.check("chat view opened",
    !(await app.evalJs('document.getElementById("view-chat").classList.contains("hidden")')));

  // ---- D6: no-room → local echo + honest toast ---------------------------
  await app.evalJs(
    '(()=>{const i=document.getElementById("jamChatInput");i.value="device local line";i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()',
  );
  await click('document.getElementById("jamChatSend")?.click()');
  await sleep(600);
  t.check("D6: local echo painted once", (await count("device local line")) === 1, await count("device local line"));
  t.check("D6: honest no-room toast",
    (await toastText()).includes("Not in a room — the message stayed on this device"),
    (await toastText()).slice(0, 80));
  t.check("D6: input cleared after send", (await val("jamChatInput")) === "");

  // ---- Open a room from the UI (real sheet) ------------------------------
  await click('document.getElementById("modeToggleBtn")?.click()');
  await sleep(500);
  await click('[...document.querySelectorAll("button")].find(b=>b.textContent.trim().startsWith("Start a Jam"))?.click()');
  const opened = await waitFor(
    app,
    'document.getElementById("jamBannerCode")?.textContent?.startsWith("#")',
    10000,
  );
  t.check("room opened from the UI", opened, await at("jamBannerCode"));
  const code = String(await at("jamBannerCode")).replace(/[^A-Za-z0-9]/g, "");
  t.check("code shape", CODE_RE.test(code), code);

  // ---- G5: device-local echo must NOT survive into the room (desired) ----
  t.check("G5: device-local echo does NOT survive into the room",
    (await count("device local line")) === 0, await count("device local line"));

  // ---- D2: the five quick-reaction buttons send + echo (spends budget) ---
  const reacts = JSON.parse(
    await app.evalJs(
      'JSON.stringify([...document.querySelectorAll("#jamChatReactions .chat-react-btn")].map(b=>b.dataset.react||""))',
    ),
  );
  t.check("D2: five reaction buttons present", reacts.length === 5, reacts.join(""));
  for (const r of reacts) {
    await click(
      `[...document.querySelectorAll("#jamChatReactions .chat-react-btn")].find(b=>(b.dataset.react||"")===${JSON.stringify(r)})?.click()`,
    );
    await sleep(350);
  }
  await sleep(800);
  let painted = 0;
  for (const r of reacts) painted += await count(r);
  t.check("D2: all five reactions painted once each", painted === 5, `${painted}/5`);

  // Budget is now full (5/10 s) — wait it out before the next send.
  await sleep(11000);

  // ---- D3: Enter-key send ------------------------------------------------
  await app.evalJs(
    '(()=>{const i=document.getElementById("jamChatInput");i.value="via enter key";i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()',
  );
  await app.evalJs(
    'document.getElementById("jamChatInput").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))',
  );
  await sleep(700);
  t.check("D3: Enter key painted once", (await count("via enter key")) === 1, await count("via enter key"));
  t.check("D3: input cleared", (await val("jamChatInput")) === "");

  // ---- D7: XSS payload renders as text -----------------------------------
  const xss = '<img src=x onerror="window.__pwned=1">';
  await app.evalJs(
    `(()=>{const i=document.getElementById("jamChatInput");i.value=${JSON.stringify(xss)};i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`,
  );
  await click('document.getElementById("jamChatSend")?.click()');
  await sleep(700);
  t.check("D7: XSS painted once as text", (await count(xss)) === 1, await count(xss));
  t.check("D7: no element created",
    (await app.evalJs('document.getElementById("jamChatList").querySelectorAll("img").length')) === 0);
  t.check("D7: handler never ran", (await app.evalJs("typeof window.__pwned")) === "undefined");

  // ---- D4/G2: send failure → verbatim toast AND text retained (desired) --
  const long501 = "L".repeat(501);
  await app.evalJs(
    `(()=>{const i=document.getElementById("jamChatInput");i.value=${JSON.stringify(long501)};i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`,
  );
  await click('document.getElementById("jamChatSend")?.click()');
  await sleep(900);
  const toast4 = await toastText();
  t.check("D4: verbatim too_long toast",
    toast4.includes("Message too long (max 500 characters)."), toast4.slice(0, 90));
  t.check("D4/G2: typed text retained after failure",
    (await val("jamChatInput")) === long501, `len=${(await val("jamChatInput")).length}`);
  t.check("D4: no bubble for the rejected line", (await count("LLLL")) === 0);

  // ---- D8: late joiner history on the device -----------------------------
  const info = JSON.parse(
    await app.evalJs('window.__TAURI__.core.invoke("room_info").then(i=>JSON.stringify(i))'),
  );
  adb("forward", `tcp:${info.port}`, `tcp:${info.port}`);
  const guest = await connectGuest(info.port);
  guest.send({ t: "join", v: 1, code, name: "Node Guest" });
  const hist = await guest.await("history");
  t.check("D8: late joiner got history", !!hist, hist ? `${hist.msgs.length} msgs` : "none");
  if (hist) {
    const texts = hist.msgs.map((m) => String(m.text));
    const expect = [...reacts, "via enter key", xss];
    const missing = expect.filter((x) => !texts.some((tx) => tx.includes(x)));
    t.check("D8: history carries every accepted line", missing.length === 0,
      missing.length ? `missing: ${missing.join(" | ")}` : `${texts.length} msgs`);
    const leak = ["LLLL", "device local line"].filter((x) => texts.some((tx) => tx.includes(x)));
    t.check("D8: history never carries rejected or device-local lines", leak.length === 0, leak.join(", "));
    t.check("D8: history within cap", texts.length <= 50, texts.length);
  }

  // ---- F1 (joiner side): the joiner receives its own system line (desired)
  await sleep(800);
  const sysFrames = guest.frames.filter((f) => f.t === "chat" && f.system === true);
  t.check("F1: joiner received a system line", sysFrames.length >= 1,
    sysFrames.map((f) => f.text).join(" | ") || "none");

  // ---- F1 (host side): host paints exactly one join line (desired) -------
  await sleep(800);
  const joinLines = await count("joined");
  t.check("F1: host paints exactly one join line", joinLines === 1, `${joinLines}`);
  const sysStyle = await app.evalJs(
    '(()=>{const n=document.querySelector("#jamChatList [class*=system]");return n?n.textContent:"NO-SYSTEM-EL"})()',
  );
  t.check("F7: join line styled as a system element (not a bubble)",
    typeof sysStyle === "string" && /joined/.test(sysStyle), String(sysStyle).slice(0, 60));

  // ---- guest line paints once on the device ------------------------------
  guest.send({ t: "chat", text: "line back from node guest" });
  await sleep(900);
  t.check("guest line painted on host exactly once",
    (await count("line back from node guest")) === 1, await count("line back from node guest"));

  // ---- unread badge (§5): parked on queue, a line arrives → pill + toast
  // startRoom auto-lands on Jam Data (QR visible at create), so lines that
  // arrived before this section were correctly counted while hidden — clear
  // first so the pill below measures exactly the one probe line.
  await click('document.getElementById("chatTabBtn")?.click()');
  await sleep(400);
  await click('document.querySelector(\'[data-tab="queue"]\')?.click()');
  await sleep(300);
  guest.send({ t: "chat", text: "badge probe line" });
  await sleep(900);
  const pill = String(await app.evalJs('(document.getElementById("jamChatUnread")?.textContent || "")'));
  const pillHidden = await app.evalJs('!!document.getElementById("jamChatUnread")?.hidden');
  t.check("unread: pill counts the hidden line", pill === "1" && !pillHidden, `${pill}/${pillHidden}`);
  t.check("unread: toast teaches the way", (await toastText()).includes("badge probe line"), (await toastText()).slice(0, 80));
  await click('document.getElementById("chatTabBtn")?.click()');
  await sleep(400);
  t.check("unread: opening chat clears the pill",
    (await app.evalJs('(document.getElementById("jamChatUnread")?.textContent || "")')) === "");

  // ---- F2: guest leave → one system line (desired) -----------------------
  guest.send({ t: "leave" });
  await sleep(900);
  const leaveLines = await count("left");
  t.check("F2: host paints exactly one leave line", leaveLines === 1, `${leaveLines}`);

  // ---- Leave: chat wiped, empty state visible (by text — mobile rebuilds)
  await click('document.getElementById("chatTabBtn")?.click()'); // ensure chat tab current
  await sleep(300);
  await click('document.querySelector(\'[data-tab="jam-data"]\')?.click()');
  await sleep(300);
  await click('document.getElementById("jamLeaveBtn")?.click()');
  const back = await waitFor(
    app,
    'document.getElementById("jamBannerCode")?.textContent === "NO ROOM"',
    8000,
  );
  t.check("room closed from the UI", back, await at("jamBannerCode"));
  // Mobile rebuilds its empty state as a fresh <p> (jam.js:572-579), so the
  // honest assertion is: no message rows survive, and the empty copy shows.
  const listText = String(await at("jamChatList"));
  const leftover = ["device local line", "via enter key", "line back from node guest"]
    .filter((x) => listText.includes(x));
  t.check("chat messages wiped after leave", leftover.length === 0, leftover.join(", "));
  t.check("empty state visible after leave (text)",
    /No messages yet/.test(listText), listText.slice(0, 60));

  // ---- D5 post-condition: leaving returns to Solo → chat tab hidden ------
  t.check("D5: chat tab hidden again after leave",
    (await app.evalJs('getComputedStyle(document.getElementById("chatTabBtn")).display')) === "none",
    await app.evalJs('getComputedStyle(document.getElementById("chatTabBtn")).display'));

  guest.close();
  app.close();
}

try {
  await main();
} catch (err) {
  t.check("threw: " + (err?.message ?? String(err)), false);
}
process.exit(t.finish() ? 0 : 1);
