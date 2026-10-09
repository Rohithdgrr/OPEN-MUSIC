// TEMP — position emulator app for screencaps. Rule 9: temporary data/.
import { execFileSync } from "node:child_process";
const SDK = "C:/Users/rohit/AppData/Local/Android/Sdk";
const ADB = `${SDK}/platform-tools/adb`;
const adb = (...a) => execFileSync(ADB, ["-s", "emulator-5554", ...a], { encoding: "utf8" }).trim();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const [hash, focus] = process.argv.slice(2);
const unix = adb("shell", "cat /proc/net/unix");
const sock = [...unix.matchAll(/webview_devtools_remote_\d+/g)].map((m) => m[0]).pop();
adb("forward", "tcp:9223", `localabstract:${sock}`);
const targets = await (await fetch("http://127.0.0.1:9223/json")).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const ev = (expression) => new Promise((rs, rj) => {
  const id = ++seq;
  pending.set(id, (m) => (m.result?.exceptionDetails ? rj(new Error("x")) : rs(m.result?.result?.value)));
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
});
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
await ev(`location.hash = "#/${hash}"`);
await wait(2500);
if (focus === "focus") { await ev(`document.getElementById("search-input").focus()`); await wait(600); }
ws.close();
console.log("positioned " + hash);
process.exit(0);
