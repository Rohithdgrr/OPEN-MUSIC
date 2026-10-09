// temp: debug leave-room click (deleted after run)
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
        res(m.result?.result?.value);
      }
    };
    ws.addEventListener("message", h);
    ws.send(JSON.stringify({ id: i, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });

const before = await evalJs(`JSON.stringify({
  room: document.getElementById('jam-room-id')?.textContent,
  btnExists: !!document.getElementById('btn-leave-room'),
  btnVisible: (()=>{const b=document.getElementById('btn-leave-room');if(!b)return null;const r=b.getBoundingClientRect();return {w:r.width,h:r.height,disp:getComputedStyle(b).display,disabled:b.disabled}})(),
  role: document.body.className,
})`);
console.log("before:", before);

const clickRes = await evalJs(`(()=>{const b=document.getElementById('btn-leave-room');if(!b)return 'no btn';b.click();return 'clicked'})()`);
console.log("click:", clickRes);
await new Promise((r) => setTimeout(r, 1500));

const after = await evalJs(`JSON.stringify({
  room: document.getElementById('jam-room-id')?.textContent,
  toast: document.getElementById('toast-stack')?.textContent,
  kids: document.getElementById('chat-messages-container')?.children.length,
})`);
console.log("after:", after);
ws.close();
