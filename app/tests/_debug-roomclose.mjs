// temp: does room_close resolve? (deleted after run)
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
        res(m.result?.result?.value ?? JSON.stringify(m.result?.exceptionDetails?.exception?.description));
      }
    };
    ws.addEventListener("message", h);
    ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  });

console.log("room_close:", await evalJs(`Promise.race([
  window.__TAURI__.core.invoke('room_close').then(r=>JSON.stringify(r)).catch(e=>'ERR '+e),
  new Promise(r=>setTimeout(()=>r('TIMEOUT after 6s'),6000))
])`));
await new Promise((r) => setTimeout(r, 800));
console.log("after:", await evalJs(`JSON.stringify({room:document.getElementById('jam-room-id')?.textContent,soc:document.body.classList.contains('soc-social')})`));
ws.close();
