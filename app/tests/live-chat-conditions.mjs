// LIVE desktop chat-conditions sweep — real app, real sockets, CDP-driven.
//
// Companion to live-desktop.mjs (baseline relay): this probe drives every
// *condition* chat must survive — empty, boundary 500/501, XSS, unicode,
// rate limit, history replay to a late joiner, no-room echo, quote button,
// leave-wipes — plus pre-fix assertions for the defect ledger rows G1
// (stale LOCAL ONLY copy), G3 (maxlength) and G5 (device-local echo
// surviving into a new room) in docs/chat-test-plan.md. Every assertion
// states the DESIRED behaviour, so pre-fix failures document defects and
// the post-fix re-run must be all-green.
//
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
//   cargo build && target/debug/trance-music.exe
//   node tests/live-chat-conditions.mjs
//
// Rate budget care: the server allows 5 messages / 10 s per member, so the
// probe sleeps 11 s before the burst phase and keeps every other phase ≤ 5
// accepted sends.

import { cdp, connectGuest, waitFor, sleep, reporter, CODE_RE } from "./live-harness.mjs";

const CDP = "http://127.0.0.1:9222";
const t = reporter("desktop chat conditions");

async function main() {
  const targets = await (await fetch(`${CDP}/json`)).json();
  const page = targets.find((x) => x.type === "page" && !/widget\.html$/.test(x.url));
  if (!t.check("app page found over CDP", !!page, page?.url)) return;
  const app = await cdp(page.webSocketDebuggerUrl);
  if (!t.check("real Tauri IPC present", await waitFor(app, "!!window.__TAURI__?.core"))) return;

  const at = async (id) => await app.evalJs(`(document.getElementById("${id}")||{}).textContent`);
  const val = async (id) => await app.evalJs(`(document.getElementById("${id}")||{}).value || ""`);
  const click = async (id) => await app.evalJs(`document.getElementById("${id}")?.click()`);
  const count = async (needle) =>
    Number(
      await app.evalJs(
        `(()=>{const s=document.getElementById("chat-messages-container")?.textContent||"";return s.split(${JSON.stringify(needle)}).length-1})()`,
      ),
    );
  const toastText = async () => String(await app.evalJs('document.getElementById("toast-stack")?.textContent||""'));
  const chatCount = async () =>
    Number(await app.evalJs('document.querySelectorAll("#chat-messages-container .soc-chat-msg, #chat-messages-container .soc-chat-system").length'));
  const type = async (text) =>
    await app.evalJs(
      `(()=>{const i=document.getElementById("chat-input");i.value=${JSON.stringify(text)};i.dispatchEvent(new Event("input",{bubbles:true}));return i.value.length})()`,
    );

  // ---- Phase 0: known state (Social mode FIRST, then leave, then chat) --
  // Order matters twice: (1) Jam controls are display:none in Solo, so the
  // Leave button only works with Social engaged — leaving before engaging
  // clicks a hidden button and silently reuses the stale room (2026-10-09:
  // reused NZS96JY6, poisoning G5 + history order + device-local leak);
  // (2) Leave flips back to Solo, so Social must be re-engaged after.
  if (!(await waitFor(app, 'document.body.classList.contains("soc-social")', 4000))) {
    await click("btn-mode-social");
    t.check("Social mode engaged", await waitFor(app, 'document.body.classList.contains("soc-social")'));
  } else {
    t.check("Social mode already engaged", true);
  }
  const roomOpen = await app.evalJs('document.getElementById("jam-room-id").textContent');
  if (String(roomOpen) !== "NO ROOM") {
    await click("btn-leave-room");
    t.check("left any stale room", await waitFor(app, 'document.getElementById("jam-room-id").textContent==="NO ROOM"', 8000));
    await click("btn-mode-social");
    t.check("Social re-engaged after leave", await waitFor(app, 'document.body.classList.contains("soc-social")'));
  } else {
    t.check("starts with no room", true);
  }
  await click("tab-btn-chat");
  t.check("chat tab active", await waitFor(app, '!document.getElementById("np-panel-chat").classList.contains("hidden")'));
  // Drain toasts from Phase 0's room leave so C2's no-toast assertion tests
  // THIS action, not a leftover.
  t.check("toast stack drained before C2", await waitFor(app, '!document.getElementById("toast-stack")?.children.length', 8000),
    await app.evalJs('document.getElementById("toast-stack")?.children.length'));

  // ---- G3: input caps length client-side (desired; pre-fix FAILs) --------
  t.check("chat input declares maxlength=500", (await app.evalJs('document.getElementById("chat-input").maxLength')) === 500,
    await app.evalJs('document.getElementById("chat-input").maxLength'));

  // ---- C2: empty / whitespace never leaves the device --------------------
  const before2 = await chatCount();
  await type("   \n  ");
  await click("btn-chat-send");
  await sleep(500);
  t.check("whitespace send: no bubble", (await chatCount()) === before2, `${before2} -> ${await chatCount()}`);
  t.check("whitespace send: input untouched", (await val("chat-input")).trim() === "", JSON.stringify(await val("chat-input")).slice(0, 30));
  t.check("whitespace send: no toast", (await toastText()) === "", await toastText());

  // ---- C9: no-room local echo (idle) -------------------------------------
  await type("device local line");
  await click("btn-chat-send");
  await sleep(500);
  t.check("idle send: local echo painted once", (await count("device local line")) === 1, await count("device local line"));
  t.check("idle send: no 'Not in a room' toast (no IPC attempted)", !(await toastText()).includes("Not in a room"), await toastText());

  // ---- C11: quote-lyric button ------------------------------------------
  await click("btn-chat-quote");
  await sleep(400);
  const haveLyric = !!(await app.evalJs('!!document.querySelector(".lyric-line .lyric-text")'));
  const qText = await val("chat-input");
  const qToast = await toastText();
  t.check("quote button answers honestly",
    haveLyric ? qText.includes("\u201c") : qToast.includes("No lyric line to quote yet."),
    haveLyric ? qText.slice(0, 40) : qToast);
  await type("");

  // ---- Room open: G1 copy + G5 stale-echo (desired; pre-fix FAILs) ------
  await click("btn-open-room");
  const opened = await waitFor(app, 'document.getElementById("jam-room-id").textContent !== "NO ROOM"', 10000);
  t.check("room opened from the UI", opened, await at("jam-room-id"));
  const code = String(await at("jam-room-id")).replace(/[^A-Za-z0-9]/g, "");
  t.check("code shape", CODE_RE.test(code), code);

  t.check("G5: device-local echo does NOT survive into the room",
    (await count("device local line")) === 0, await count("device local line"));
  // #chat-empty lives INSIDE #chat-messages-container; renderChat's
  // replaceChildren() destroys it, so null here = defect G6.
  const emptyAlive = await app.evalJs('!!document.getElementById("chat-empty")');
  t.check("G6: empty-state node survives renderChat", !!emptyAlive, emptyAlive ? "present" : "DESTROYED");
  // F8: the host's own room-open emits no self-"joined" line (plan §F).
  const sysLines = async () =>
    Number(await app.evalJs('document.querySelectorAll("#chat-messages-container .soc-chat-system").length'));
  t.check("F8: no self-join line on room open", (await sysLines()) === 0, await sysLines());
  t.check("G5: empty state visible after open (chat truly empty)",
    emptyAlive ? !(await app.evalJs('document.getElementById("chat-empty").classList.contains("hidden")')) : false);
  const emptyCopy = String(await at("chat-empty"));
  t.check("G1: empty-state copy has no sidecar wording",
    !!emptyAlive && !/sidecar/i.test(emptyCopy), emptyAlive ? emptyCopy : "NODE MISSING");
  t.check("G1: in a live room the rate chip is not LOCAL ONLY",
    (await at("chat-rate-note")) !== "LOCAL ONLY", await at("chat-rate-note"));

  // ---- C4: 501 chars → verbatim toast + text restored --------------------
  const long501 = "L".repeat(501);
  await type(long501);
  await click("btn-chat-send");
  await sleep(700);
  const toast4 = await toastText();
  t.check("501 chars: verbatim too_long toast", toast4.includes("Message too long (max 500 characters)."), toast4.slice(0, 90));
  t.check("501 chars: text restored to input", (await val("chat-input")) === long501, (await val("chat-input")).length);
  t.check("501 chars: no bubble", (await count("LLLL")) === 0);

  // ---- C3: exactly 500 renders once --------------------------------------
  const exact500 = "B".repeat(494) + "END500";
  t.check("boundary message is 500 chars", exact500.length === 500, exact500.length);
  await type(exact500);
  await click("btn-chat-send");
  await sleep(700);
  t.check("500 chars: painted exactly once", (await count("END500")) === 1, await count("END500"));
  t.check("500 chars: input cleared", (await val("chat-input")) === "");

  // ---- C5: XSS payload renders literal -----------------------------------
  const xss = '<img src=x onerror="window.__pwned=1">';
  await type(xss);
  await click("btn-chat-send");
  await sleep(700);
  t.check("XSS: painted once as text", (await count(xss)) === 1, await count(xss));
  t.check("XSS: no element created", (await app.evalJs('document.getElementById("chat-messages-container").querySelectorAll("img").length')) === 0);
  t.check("XSS: handler never ran", (await app.evalJs("typeof window.__pwned")) === "undefined");

  // ---- C6: emoji + RTL + zero-width joiner -------------------------------
  const uni = "\u{1F3B5} \u0645\u0631\u062D\u0628\u0627 \u{1F30D} zw\u200Bsp";
  await type(uni);
  await click("btn-chat-send");
  await sleep(700);
  t.check("unicode: painted once verbatim", (await count(uni)) === 1, await count(uni));

  // ---- C11: Enter key sends ----------------------------------------------
  await type("via enter key");
  await app.evalJs(
    'document.getElementById("chat-input").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))',
  );
  await sleep(700);
  t.check("Enter key: painted once", (await count("via enter key")) === 1, await count("via enter key"));
  t.check("Enter key: input cleared", (await val("chat-input")) === "");

  // ---- C7: rate limit — 5 accepted, 6th refused verbatim -----------------
  await sleep(11000); // clear the sliding window (phases above used ≤4)
  let burstOk = 0;
  for (let i = 1; i <= 5; i++) {
    await type(`burst message ${i}`);
    await click("btn-chat-send");
    await sleep(450);
    if ((await val("chat-input")) === "") burstOk++;
  }
  t.check("burst: first five all accepted (input cleared each time)", burstOk === 5, `${burstOk}/5`);
  let painted5 = 0;
  for (let i = 1; i <= 5; i++) painted5 += await count(`burst message ${i}`);
  t.check("burst: five bubbles, each exactly once", painted5 === 5, `${painted5}/5`);

  await type("burst message 6");
  await click("btn-chat-send");
  await sleep(700);
  const toast7 = await toastText();
  t.check("6th: rate_limited verbatim", toast7.includes("Slow down \u2014 at most 5 messages every 10 seconds."), toast7.slice(0, 90));
  t.check("6th: text restored", (await val("chat-input")) === "burst message 6", await val("chat-input"));
  t.check("6th: no bubble", (await count("burst message 6")) === 0);

  // ---- C8: history replay to a late joiner -------------------------------
  const info = JSON.parse(await app.evalJs('window.__TAURI__.core.invoke("room_info").then(i=>JSON.stringify(i))'));
  const guest = await connectGuest(info.urls[0]);
  guest.send({ t: "join", v: 1, code, name: "Hist Guest" });
  const hist = await guest.await("history");
  t.check("late joiner got history", !!hist, hist ? `${hist.msgs.length} msgs` : "none");
  if (hist) {
    const texts = hist.msgs.map((m) => String(m.text));
    const expect = ["END500", xss, uni, "via enter key", "burst message 1", "burst message 5"];
    const missing = expect.filter((x) => !texts.some((tx) => tx.includes(x)));
    t.check("history carries every accepted line, in order", missing.length === 0, missing.length ? `missing: ${missing.join(" | ")}` : `${texts.length} msgs`);
    const idx = expect.map((x) => texts.findIndex((tx) => tx.includes(x)));
    const ordered = idx.every((v, i) => v >= 0 && (i === 0 || v > idx[i - 1]));
    t.check("history order matches send order", ordered, idx.join(","));
    const forbidden = ["LLLL", "burst message 6", "device local line"];
    const leak = forbidden.filter((x) => texts.some((tx) => tx.includes(x)));
    t.check("history never carries rejected or device-local lines", leak.length === 0, leak.join(", "));
    t.check("history within cap", texts.length <= 50, texts.length);
  }

  // ---- C12: guest → host paints once -------------------------------------
  // F1/F7: the guest's join also painted exactly one centred system line.
  const sysText = async () =>
    String(await app.evalJs(
      '[...document.querySelectorAll("#chat-messages-container .soc-chat-system")].map(n=>n.textContent).join("\\n")'));
  t.check("F1: guest join painted one system line once",
    (await sysLines()) === 1 && (await sysText()).includes("Hist Guest joined"), await sysText());
  guest.send({ t: "chat", text: "line back from hist guest" });
  await sleep(900);
  t.check("guest line painted on host exactly once", (await count("line back from hist guest")) === 1,
    await count("line back from hist guest"));
  // ---- unread badge (§5): parked on lyrics, a line arrives → pill + toast
  await click("tab-btn-lyrics");
  await sleep(300);
  guest.send({ t: "chat", text: "badge probe line" });
  await sleep(900);
  const pill = String(await app.evalJs('(document.getElementById("chat-unread-pill")?.textContent || "")'));
  const pillHidden = await app.evalJs('!!document.getElementById("chat-unread-pill")?.hidden');
  t.check("unread: pill counts the hidden line", pill === "1" && !pillHidden, `${pill}/${pillHidden}`);
  t.check("unread: toast teaches the way", (await toastText()).includes("badge probe line"), (await toastText()).slice(0, 80));
  await click("tab-btn-chat");
  await sleep(400);
  t.check("unread: opening chat clears the pill",
    (await app.evalJs('(document.getElementById("chat-unread-pill")?.textContent || "")')) === "");
  t.check("online count follows presence", (await at("chat-online-count")) === "2 online", await at("chat-online-count"));

  guest.send({ t: "leave" });
  await sleep(900);
  // F2: one "left" system line, exactly once — the join line stays (history).
  t.check("F2: guest leave painted one system line once",
    (await sysLines()) === 2 && (await sysText()).includes("Hist Guest left"), await sysText());

  // ---- C10: leave wipes chat ---------------------------------------------
  await click("btn-leave-room");
  const back = await waitFor(app, 'document.getElementById("jam-room-id").textContent === "NO ROOM"', 8000);
  t.check("room closed", back);
  t.check("C10: chat list empty after leave", (await chatCount()) === 0, await chatCount());
  t.check("C10: empty state visible after leave",
    !(await app.evalJs('document.getElementById("chat-empty")?.classList.contains("hidden") ?? true')));

  guest.close();
  app.close();
}

try {
  await main();
} catch (err) {
  t.check("threw: " + (err?.message ?? String(err)), false);
}
process.exit(t.finish() ? 0 : 1);
