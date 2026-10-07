const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((x) => x.type === "page" && !/widget\.html$/.test(x.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
await new Promise((res, rej) => {
  ws.addEventListener("open", res);
  ws.addEventListener("error", rej);
});
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const js = (expr) =>
  new Promise((res) => {
    const id = ++seq;
    pending.set(id, (m) => res(m.result?.exceptionDetails ? "EXC " + (m.result.exceptionDetails.exception?.description || "?") : m.result?.result?.value));
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });

const dump = `(()=>{const o={};for(const id of ["audio","audio2"]){const a=document.getElementById(id);o[id]=a?{src:String(a.src).slice(0,120),t:a.currentTime,dur:Number.isFinite(a.duration)?a.duration:null,paused:a.paused,readyState:a.readyState,networkState:a.networkState,err:a.error?a.error.code+" "+a.error.message:null}:null;}return JSON.stringify(o,null,1);})()`;
console.log("AUDIO:", await js(dump));
console.log("bar badge :", await js('document.getElementById("bar-badge")?.textContent'));
console.log("bar clock :", await js('document.getElementById("bar-time-cur")?.textContent'), "/", await js('document.getElementById("bar-time-total")?.textContent'));
console.log("net mode  :", await js('document.getElementById("net-badge")?.dataset.netMode'));
console.log("toasts    :", await js('String(document.getElementById("tm-toast-stack")?.textContent||"").slice(0,200)'));
console.log("lastFrame :", await js('String((window.__lastPlaybackFrame||"")||"")'));
ws.close();
