// _probe-notepad-govinda.mjs — task 13 chord probe (UNTRACKED, govinda.md §26).
// Connects to the running app over CDP, installs a keydown logger, dispatches
// every candidate chord via Input.dispatchKeyEvent and reports which reach
// the page. Node 24 global WebSocket — no deps.
//
// Usage: node _probe-notepad-govinda.mjs

const VERSION = "http://127.0.0.1:9222/json/version";
const LIST = "http://127.0.0.1:9222/json/list";

async function pageTarget() {
  const list = await (await fetch(LIST)).json();
  const page = list.find((t) => t.type === "page" && !/widget|devtools/.test(t.url));
  if (!page) throw new Error("no page target: " + JSON.stringify(list.map((t) => t.type + " " + t.url)));
  return page;
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  return {
    ready,
    send(method, params = {}) {
      const mid = ++id;
      ws.send(JSON.stringify({ id: mid, method, params }));
      return new Promise((resolve, reject) => pending.set(mid, { resolve, reject }));
    },
    close() {
      ws.close();
    },
  };
}

// CDP rawKeyDown: modifiers bitmask 1=Alt 2=Ctrl 4=Meta 8=Shift.
function keyParams(chord) {
  const base = { windowsVirtualKeyCode: chord.vk, code: chord.code, key: chord.key };
  if (chord.shift) base.modifiers = 8;
  return base;
}

// Candidate chords from govinda.md task 13. vk = Windows virtual key code.
const CANDIDATES = [
  { name: "Ctrl+T", ctrl: true, vk: 0x54, code: "KeyT", key: "t" },
  { name: "Ctrl+W", ctrl: true, vk: 0x57, code: "KeyW", key: "w" },
  { name: "Ctrl+Tab", ctrl: true, vk: 0x09, code: "Tab", key: "Tab" },
  { name: "Ctrl+Shift+Tab", ctrl: true, shift: true, vk: 0x09, code: "Tab", key: "Tab" },
  { name: "Ctrl+F", ctrl: true, vk: 0x46, code: "KeyF", key: "f" },
  { name: "Ctrl+P", ctrl: true, vk: 0x50, code: "KeyP", key: "p" },
  { name: "Ctrl+S", ctrl: true, vk: 0x53, code: "KeyS", key: "s" },
  { name: "F2", vk: 0x71, code: "F2", key: "F2" },
  { name: "Alt+T", alt: true, vk: 0x54, code: "KeyT", key: "t" },
  { name: "Alt+W", alt: true, vk: 0x57, code: "KeyW", key: "w" },
  { name: "Alt+ArrowRight", alt: true, vk: 0x27, code: "ArrowRight", key: "ArrowRight" },
  { name: "Alt+ArrowLeft", alt: true, vk: 0x25, code: "ArrowLeft", key: "ArrowLeft" },
  { name: "Ctrl+1", ctrl: true, vk: 0x31, code: "Digit1", key: "1" },
  { name: "Ctrl+Shift+T", ctrl: true, shift: true, vk: 0x54, code: "KeyT", key: "T" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const target = await pageTarget();
console.log("target:", target.url);
const cdp = connect(target.webSocketDebuggerUrl);
await cdp.ready;

await cdp.send("Runtime.enable");
await cdp.send("Page.enable");

// Focus the document so the app's keydown pipeline receives events.
await cdp.send("Runtime.evaluate", {
  expression: `window.__npdProbe = []; window.__npdProbeInstalled = true;
    window.addEventListener("keydown", (e) => {
      window.__npdProbe.push({
        key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey,
        defaultPrevented: e.defaultPrevented,
        target: (e.target && (e.target.id || e.target.tagName)) || "?",
      });
    }, true);
    document.title`,
});

// The panel must be OPEN for in-panel chords (Ctrl+T/W/F/S/Tab, F2) to be
// meaningful; the global hotkey opens it — but during probing we drive the
// event directly through the documented event bus (that is the same code
// path the Rust shortcut takes). First check the bus exists.
const busCheck = await cdp.send("Runtime.evaluate", {
  expression: `typeof window.emitShortcutNotepad === "function" ? "fn" : (window.__TAURI__ ? "tauri" : "none")`,
  returnByValue: true,
});
console.log("bus:", busCheck.result.value);

// Open the panel via the real event the Rust side emits. shortcuts.js
// registers through window.__TAURI__.event.listen, so emit on that bus —
// same round-trip the Rust shortcut takes, minus the OS keypress.
await cdp.send("Runtime.evaluate", {
  expression: `window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.emit
    ? window.__TAURI__.event.emit("shortcut:notepad").then(() => "emitted", (e) => "emit-failed: " + e)
    : "no-tauri-bus"`,
});

await sleep(600);

const panelState = await cdp.send("Runtime.evaluate", {
  expression: `(() => { const p = document.getElementById("npd-panel");
    return p ? (p.hidden ? "hidden" : "visible") : "absent"; })()`,
  returnByValue: true,
});
console.log("panel after shortcut:notepad:", panelState.result.value);

// Focus the pad so plain-text chords have a real target.
await cdp.send("Runtime.evaluate", {
  expression: `(() => { const pad = document.getElementById("npd-pad");
    if (pad) { pad.focus(); return "focused"; } return "no-pad"; })()`,
  returnByValue: true,
});

// Clear the log, then dispatch every candidate.
await cdp.send("Runtime.evaluate", { expression: `window.__npdProbe = []; "cleared"` });

const results = [];
for (const c of CANDIDATES) {
  const mods = (c.ctrl ? 2 : 0) | (c.alt ? 1 : 0) | (c.shift ? 8 : 0);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    modifiers: mods,
    windowsVirtualKeyCode: c.vk,
    code: c.code,
    key: c.key,
    unmodifiedText: "",
    text: "",
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: mods,
    windowsVirtualKeyCode: c.vk,
    code: c.code,
    key: c.key,
    unmodifiedText: "",
    text: "",
  });
  await sleep(120);
  const logged = await cdp.send("Runtime.evaluate", {
    expression: `JSON.stringify(window.__npdProbe)`,
    returnByValue: true,
  });
  const entries = JSON.parse(logged.result.value || "[]");
  await cdp.send("Runtime.evaluate", { expression: `window.__npdProbe = []; "c"` });
  results.push({ chord: c.name, reached: entries.length > 0, entries });
  console.log(
    `${entries.length > 0 ? "REACHES " : "RESERVED"}  ${c.name.padEnd(16)} ${entries.length ? JSON.stringify(entries[0]) : ""}`,
  );
}

// Panel state after the chord storm (some chords may have closed it).
const finalState = await cdp.send("Runtime.evaluate", {
  expression: `(() => { const p = document.getElementById("npd-panel");
    const tabs = document.querySelectorAll("#npd-tabs .npd-tab").length;
    return JSON.stringify({ panel: p ? (p.hidden ? "hidden" : "visible") : "absent", tabs }); })()`,
  returnByValue: true,
});
console.log("final state:", finalState.result.value);

cdp.close();
console.log("\n--- summary ---");
for (const r of results) console.log(`${r.reached ? "REACHES" : "RESERVED"}  ${r.chord}`);
