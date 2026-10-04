// Minimal CDP client: evaluate an expression in the attached WebView.
//   node scripts/cdp-eval.mjs "<js expression>"
// Talks to the `adb forward tcp:9222 localabstract:webview_devtools_remote_*`
// endpoint. Raw WebSocket on purpose — the repo has no `ws` dependency and
// adding one just to probe a running app is not worth it.
import net from "node:net";
import crypto from "node:crypto";
import http from "node:http";

// `@path` reads the expression from a file — Windows shells mangle regex
// literals and quotes otherwise.
import fs from "node:fs";
let expr = process.argv[2];
if (expr?.startsWith("@")) expr = fs.readFileSync(expr.slice(1), "utf8");
if (!expr) {
  console.error('usage: node scripts/cdp-eval.mjs "<expression>" | @file');
  process.exit(2);
}

function listTargets() {
  return new Promise((resolve, reject) => {
    http
      .get("http://127.0.0.1:9222/json", (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(b));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

const targets = await listTargets();
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("no page target — is `adb forward tcp:9222 ...` in place?");
  process.exit(1);
}

const url = new URL(page.webSocketDebuggerUrl);
const key = crypto.randomBytes(16).toString("base64");

const sock = net.connect(Number(url.port), url.hostname, () => {
  sock.write(
    [
      `GET ${url.pathname} HTTP/1.1`,
      `Host: ${url.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n")
  );
});

let handshaken = false;
let buf = Buffer.alloc(0);
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function sendFrame(payload, opcode = 0x1) {
  const data = Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(data);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  let header;
  if (masked.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | masked.length]);
  } else if (masked.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(masked.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(masked.length), 2);
  }
  sock.write(Buffer.concat([header, mask, masked]));
}

function readFrames() {
  for (;;) {
    if (buf.length < 2) return;
    const op = buf[0] & 0x0f;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      len = Number(buf.readBigUInt64BE(2));
      off = 10;
    }
    if (buf.length < off + len) return;
    const payload = buf.subarray(off, off + len);
    buf = buf.subarray(off + len);
    if (op === 0x1) onMessage(decoder.decode(payload));
    else if (op === 0x9) sendFrame(payload, 0x8 === 0x8 ? 0xa : 0xa); // pong
  }
}

let id = 0;
const pending = new Map();
function evaluate(expression) {
  const myId = ++id;
  return new Promise((resolve) => {
    pending.set(myId, resolve);
    sendFrame(
      JSON.stringify({
        id: myId,
        method: "Runtime.evaluate",
        params: {
          expression,
          returnByValue: true,
          awaitPromise: true,
        },
      })
    );
    setTimeout(() => {
      if (pending.delete(myId)) resolve({ error: "timeout" });
    }, 15000);
  });
}

function onMessage(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg.result ?? { error: msg.error });
  }
}

sock.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (!handshaken) {
    const idx = buf.indexOf("\r\n\r\n");
    if (idx === -1) return;
    const head = buf.subarray(0, idx).toString();
    if (!/101/.test(head.split("\r\n")[0])) {
      console.error("handshake failed:", head.split("\r\n")[0]);
      process.exit(1);
    }
    handshaken = true;
    buf = buf.subarray(idx + 4);
    evaluate(expr).then((r) => {
      console.log(JSON.stringify(r, null, 2));
      sock.end();
      process.exit(0);
    });
  }
  readFrames();
});

sock.on("error", (e) => {
  console.error("socket error:", e.message);
  process.exit(1);
});
