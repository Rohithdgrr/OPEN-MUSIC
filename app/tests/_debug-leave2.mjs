// temp: reproduce leave click sequence (deleted after run)
const t = await (await fetch("http://127.0.0.1:9222/json")).json();
const p = t.find((x) => x.type === "page" && !/widget\.html$/.test(x.url));
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const evalJs = (expression, awaitPromise = false) =>
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
    ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise } }));
  });

// capture console errors
ws.send(JSON.stringify({ id: 999, method: "Runtime.enable" }));
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") {
    console.log("CONSOLE EXC:", m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// enter social, open room
await evalJs(`document.getElementById('btn-mode-social')?.click()`);
await sleep(600);
console.log("soc:", await evalJs(`document.body.classList.contains('soc-social')`));
await evalJs(`document.getElementById('btn-open-room')?.click()`);
await sleep(1500);
console.log("room after open:", await evalJs(`document.getElementById('jam-room-id')?.textContent`));

// click leave
await evalJs(`document.getElementById('btn-leave-room')?.click()`);
for (const ms of [300, 1000, 3000, 6000]) {
  await sleep(ms);
  console.log(`t+${ms}:`, await evalJs(`JSON.stringify({room:document.getElementById('jam-room-id')?.textContent,soc:document.body.classList.contains('soc-social'),kids:document.getElementById('chat-messages-container')?.children.length,note:document.getElementById('room-note')?.textContent?.slice(0,40)})`));
}
ws.close();
