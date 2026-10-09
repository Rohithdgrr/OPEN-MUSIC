// temp DOM probe (deleted after run)
const t = await (await fetch("http://127.0.0.1:9222/json")).json();
const p = t.find((x) => x.type === "page" && !/widget\.html$/.test(x.url));
const ws = new WebSocket(p.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
const expr = `JSON.stringify({empty:!!document.getElementById('chat-empty'),typing:!!document.getElementById('chat-typing'),kids:document.getElementById('chat-messages-container').children.length,first:document.getElementById('chat-messages-container').firstElementChild?.className})`;
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } }));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id === 1) {
    console.log(m.result.result.value);
    ws.close();
  }
};
