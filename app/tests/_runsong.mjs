// Temporary: play ONE real song end-to-end and measure that the playhead moves.
// Deleted after the run. Desktop CDP on :9222.
const CDP = "http://127.0.0.1:9222";
const query = process.argv[2] || "kesariya";

const targets = await (await fetch(`${CDP}/json`)).json();
const page = targets.find((x) => x.type === "page" && !/widget\.html$/.test(x.url));
if (!page) throw new Error("no app page over CDP");
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
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const js = async (expr) => {
  const m = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  return m.result?.exceptionDetails ? "EXC " + (m.result.exceptionDetails.exception?.description || "?") : m.result?.result?.value;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (expr, ms = 25000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await js(expr)) return true;
    } catch {}
    await wait(300);
  }
  return false;
};
const out = [];
const check = (n, ok, d) => out.push(`${ok ? "PASS" : "FAIL"} ${n}${d !== undefined ? " :: " + d : ""}`);

check("real IPC present", await waitFor("!!window.__TAURI__?.core"));
console.log("network badge:", await js('document.getElementById("net-badge")?.dataset.netMode'), "(informational — the app reports its own mirror health)");

// Search the way a user does: type into the Search view's field and hit Enter.
await js('(()=>{const i=document.getElementById("search-input");i.value=' + JSON.stringify(query) + ';i.dispatchEvent(new Event("input",{bubbles:true}));i.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));})()');
const gotRows = await waitFor('document.querySelectorAll("[data-track-id]").length > 0', 30000);
check(`search returned rows for "${query}"`, gotRows, await js('String(document.querySelectorAll("[data-track-id]").length)'));
if (!gotRows) {
  console.log(out.join("\n"));
  console.log("---- NOTE: no results; network/API may be unreachable");
  process.exit(1);
}

const first = JSON.parse(await js('(()=>{const r=document.querySelector("[data-track-id]");return JSON.stringify({id:r.dataset.trackId,txt:r.innerText.replace(/\\n/g," | ").slice(0,140)});})()'));
console.log("first result:", first.txt);

// Click it — the real user path. The app may already have a track playing
// (it restores the last session), so anchor the wait to the SOURCE changing:
// otherwise the old track satisfies the "is playing" condition instantly.
const beforeSrc = String(await js('String(document.getElementById("audio")?.src||"")'));
await js('document.querySelector("[data-track-id]").click()');
const swapped = await waitFor(
  `(()=>{const a=document.getElementById("audio");return !!a && String(a.src||"") !== ${JSON.stringify(beforeSrc)};})()`,
  30000,
);
check("clicking the row swapped the audio source", swapped, `${beforeSrc.slice(0, 46)} -> ${String(await js('String(document.getElementById("audio")?.src||"")')).slice(0, 46)}`);

// Now wait for the NEW stream to settle before measuring.
const settled = await waitFor(
  '(()=>{const a=document.getElementById("audio");return !!a && Number.isFinite(a.duration) && a.duration>30 && a.currentTime>1 && !a.paused;})()',
  45000,
);
check("the clicked track loaded and is playing", settled);

const snap = () => js('(()=>{const a=document.getElementById("audio");return JSON.stringify({t:a?a.currentTime:-1,d:Number.isFinite(a?.duration)?a.duration:-1,paused:a?a.paused:null,ready:a?a.readyState:-1,err:a&&a.error?a.error.code:null,srcHead:String(a?.src||"").slice(0,60)});})()');
const s1 = JSON.parse(await snap());
await wait(4000);
const s2 = JSON.parse(await snap());

console.log("bar title :", await js('document.getElementById("bar-title")?.textContent'));
console.log("bar artist:", await js('document.getElementById("bar-artist")?.textContent'));
console.log("bar badge :", await js('document.getElementById("bar-badge")?.textContent'));
console.log("bar clock :", await js('document.getElementById("bar-time-cur")?.textContent'), "/", await js('document.getElementById("bar-time-total")?.textContent'));
console.log(`audio: t=${s1.t.toFixed(2)} -> ${s2.t.toFixed(2)}  paused=${s2.paused}  dur=${s2.d.toFixed(1)}  readyState=${s2.ready}  err=${s2.err}`);
console.log("src:", s2.srcHead);

check("playhead is not paused", s2.paused === false, String(s2.paused));
check("playhead advanced over 4 s", s2.t > s1.t + 2.5, `${s1.t.toFixed(2)} -> ${s2.t.toFixed(2)}`);
check("track has a real duration", s2.d > 30, `${s2.d.toFixed(1)}s`);
check("media element reports no error", !s2.err, String(s2.err));
check("progress bar is painted", Number(await js('parseFloat(document.getElementById("bar-progress-fill")?.style.width||"0")')) > 0, await js('document.getElementById("bar-progress-fill")?.style.width'));

console.log(out.join("\n"));
const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(`---- run-song (desktop): ${out.length - failed} pass / ${failed} fail`);
ws.close();
process.exit(failed === 0 ? 0 : 1);
