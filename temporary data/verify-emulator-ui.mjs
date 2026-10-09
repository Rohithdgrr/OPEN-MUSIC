// TEMP verify — checks new header/greeting/search chrome inside the emulator app. Rule 9: lives in temporary data/.
import { execFileSync } from "node:child_process";
const SDK = "C:/Users/rohit/AppData/Local/Android/Sdk";
const ADB = `${SDK}/platform-tools/adb`;
const adb = (...a) => execFileSync(ADB, ["-s", "emulator-5554", ...a], { encoding: "utf8" }).trim();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.addEventListener("open", () => resolve({
      evalJs: (e) => new Promise((rs, rj) => {
        const id = ++seq;
        pending.set(id, (m) => {
          if (m.result?.exceptionDetails) rj(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 400)));
          else rs(m.result?.result?.value);
        });
        ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: e, awaitPromise: true, returnByValue: true } }));
      }),
      close: () => ws.close(),
    }));
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    ws.addEventListener("error", reject);
  });
}

const unix = adb("shell", "cat /proc/net/unix");
const sock = [...unix.matchAll(/webview_devtools_remote_\d+/g)].map((m) => m[0]).pop();
console.log("sock=" + sock);
adb("forward", "tcp:9223", `localabstract:${sock}`);
const targets = await (await fetch("http://127.0.0.1:9223/json")).json();
const page = targets.find((t) => t.type === "page");
const app = await cdp(page.webSocketDebuggerUrl);
const j = (e) => app.evalJs(e);
const out = [];
const check = (n, ok, d) => out.push(`${ok ? "PASS" : "FAIL"} ${n}${d !== undefined ? " :: " + d : ""}`);

// HOME
await j(`location.hash = "#/home"`);
await wait(2500);
const h1 = await j(`document.querySelector("main h1").textContent`);
check("greeting h1 paints", /Good (morning|afternoon|evening)/.test(h1), h1);
const dateEl = await j(`document.querySelector("main section span.uppercase").textContent`);
check("date eyebrow paints", /[A-Z][a-z]+,/.test(dateEl), dateEl);
const tile = await j(`(() => { const el = document.querySelector("header div.w-9"); return el ? el.className.slice(0, 120) : "MISSING"; })()`);
check("new w-9 logo tile present", !tile.startsWith("MISSING"), tile.slice(0, 80));
const pill = await j(`(() => { const el = [...document.querySelectorAll("header span")].find(s => s.textContent === "CORE"); return el ? el.className.slice(0, 120) : "MISSING"; })()`);
check("tinted CORE pill present", pill.includes("bg-primary/15"), pill.slice(0, 80));
const dot = await j(`document.querySelector('header button[aria-label="Notifications"] span.absolute') ? "yes" : "no"`);
check("notification dot present", dot === "yes", dot);
const tagline = await j(`[...document.querySelectorAll("main section p")].some(p => /ready when you are/.test(p.textContent))`);
check("greeting tagline present", tagline === true);
console.log("HOME-DONE");

// SEARCH
await j(`location.hash = "#/search"`);
await wait(2500);
await j(`document.getElementById("search-input").focus()`);
await wait(500);
const bw = await j(`(() => { const cs = getComputedStyle(document.getElementById("search-input")); return [cs.borderTopWidth, cs.borderLeftWidth, cs.outlineWidth, cs.outlineStyle].join(","); })()`);
check("search input chromeless when focused", bw === "0px,0px,0px,none" || /^0px,0px,/.test(bw), bw);
const pillBorder = await j(`(() => { const el = document.getElementById("search-input").closest("div.relative"); return el ? getComputedStyle(el).borderTopWidth : "MISSING"; })()`);
check("pill container keeps its own border", parseFloat(pillBorder) > 0, pillBorder);
console.log("SEARCH-DONE");

app.close();
console.log(out.join("\n"));
const failed = out.filter((l) => l.startsWith("FAIL")).length;
process.exit(failed ? 1 : 0);
