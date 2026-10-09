// temp: leave while chat tab active (deleted after run)
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
    ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
ws.send(JSON.stringify({ id: 999, method: "Runtime.enable" }));
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown")
    console.log("CONSOLE EXC:", m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await evalJs(`document.getElementById('btn-mode-social')?.click()`);
await sleep(500);
await evalJs(`document.getElementById('tab-btn-chat')?.click()`);
await sleep(300);
await evalJs(`document.getElementById('btn-open-room')?.click()`);
await sleep(1500);
console.log("room open:", await evalJs(`document.getElementById('jam-room-id')?.textContent`));
console.log("active tab:", await evalJs(`document.querySelector('.np-deck-tab.active')?.dataset.npTab`));

await evalJs(`document.getElementById('btn-leave-room')?.click()`);
for (const ms of [400, 1500, 4000]) {
  await sleep(ms);
  console.log(`t+${ms}:`, await evalJs(`JSON.stringify({room:document.getElementById('jam-room-id')?.textContent,soc:document.body.classList.contains('soc-social'),kids:document.getElementById('chat-messages-container')?.children.length,tab:document.querySelector('.np-deck-tab.active')?.dataset.npTab})`));
}
ws.close();
