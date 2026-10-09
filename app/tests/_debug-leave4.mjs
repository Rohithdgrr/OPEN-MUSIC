// temp: leave with a raw guest present (deleted after run)
import { connectGuest, sleep } from "./live-harness.mjs";

const t = await (await fetch("http://127.0.0.1:9222/json")).json();
const p = t.find((x) => x.type === "page" && !/widget\.html$/.test(x.url));
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const evalJs = (expression) =>
  new Promise((res) => {
    const i = ++id;
    const h = (e) => {
      const m = JSON.parse(e.data);
      if (m.id === i) {
        ws.removeEventListener("message", h);
        res(m.result?.result?.value ?? "EXC " + (m.result?.exceptionDetails?.exception?.description || ""));
      }
    };
    ws.addEventListener("message", h);
    ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  });
ws.send(JSON.stringify({ id: 999, method: "Runtime.enable" }));
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown")
    console.log("CONSOLE EXC:", m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
});

await evalJs(`document.getElementById('btn-mode-social')?.click()`);
await sleep(500);
await evalJs(`document.getElementById('btn-open-room')?.click()`);
await sleep(1500);
const code = (await evalJs(`document.getElementById('jam-room-id')?.textContent`)).replace(/[^A-Za-z0-9]/g, "");
console.log("room:", code);

const info = JSON.parse(await evalJs(`window.__TAURI__.core.invoke('room_info').then(i=>JSON.stringify(i))`));
const guest = await connectGuest(info.urls[0]);
guest.send({ t: "join", v: 1, code, name: "Probe Guest" });
const hist = await guest.await("history");
console.log("history:", hist ? hist.msgs.length : "none");

guest.send({ t: "leave" });
await sleep(900);

console.log("clicking leave with guest socket still open...");
await evalJs(`document.getElementById('btn-leave-room')?.click()`);
for (const ms of [500, 2000, 5000, 9000]) {
  await sleep(ms);
  console.log(`t+${ms}:`, await evalJs(`JSON.stringify({room:document.getElementById('jam-room-id')?.textContent,soc:document.body.classList.contains('soc-social'),kids:document.getElementById('chat-messages-container')?.children.length})`));
}
guest.close();
ws.close();
