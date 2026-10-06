// Shared plumbing for the two LIVE tests (`live-desktop.mjs`,
// `live-android-emulator.mjs`). Both drive a real running app — never a stub —
// so they need the same three things: a CDP client for the app's own webview,
// a plain second client, and a report that is impossible to misread.

/// Minimal Chrome DevTools Protocol client over the webview's debugger socket.
/// Tauri exposes one on desktop (`--remote-debugging-port`) and on Android
/// (the `webview_devtools_remote_<pid>` unix socket, reachable via adb forward).
export function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    ws.addEventListener("open", () =>
      resolve({
        evalJs: (expression) =>
          new Promise((res, rej) => {
            const id = ++seq;
            pending.set(id, (msg) => {
              if (msg.result?.exceptionDetails) {
                rej(new Error(JSON.stringify(msg.result.exceptionDetails.exception)));
              } else {
                res(msg.result?.result?.value);
              }
            });
            ws.send(
              JSON.stringify({
                id,
                method: "Runtime.evaluate",
                params: { expression, awaitPromise: true, returnByValue: true },
              }),
            );
          }),
        close: () => ws.close(),
      }),
    );
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    });
    ws.addEventListener("error", reject);
  });
}

/// Poll an expression until it is truthy. The devtools socket is available
/// *before* the webview has run the app, so every step waits for the thing it
/// needs instead of sleeping a guess.
export async function waitFor(app, expr, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await app.evalJs(expr)) return true;
    } catch {
      /* document not ready yet */
    }
    await sleep(250);
  }
  return false;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// A plain second client — exactly what another device opens. Real sockets.
/// `url` is the address the room advertises (`room_info().urls[0]`), so the
/// test dials what a guest is told to dial, not a guessed loopback port.
export function connectGuest(url) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const ws = new WebSocket(/^ws:\/\//.test(url) ? `${url}/ws` : `ws://127.0.0.1:${url}/ws`);
    ws.addEventListener("open", () =>
      resolve({
        frames,
        send: (o) => ws.send(JSON.stringify(o)),
        close: () => ws.close(),
        await: (t, ms = 3000) =>
          new Promise((res) => {
            const t0 = Date.now();
            const iv = setInterval(() => {
              const hit = frames.find((f) => f.t === t);
              if (hit || Date.now() - t0 > ms) {
                clearInterval(iv);
                res(hit || null);
              }
            }, 20);
          }),
      }),
    );
    ws.addEventListener("message", (e) => {
      try {
        frames.push(JSON.parse(e.data));
      } catch {
        /* the protocol has no non-JSON frame; ignore anything else */
      }
    });
    ws.addEventListener("error", reject);
    setTimeout(() => reject(new Error("guest socket never opened")), 8000);
  });
}

/// Collects PASS/FAIL lines and prints the tally. Exit code follows the tally,
/// so no caller can mistake a red run for a green one.
export function reporter(label) {
  const lines = [];
  return {
    check(name, ok, detail) {
      lines.push(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " :: " + detail : ""}`);
      return !!ok;
    },
    finish() {
      console.log(lines.join("\n"));
      const passed = lines.filter((l) => l.startsWith("PASS")).length;
      const failed = lines.filter((l) => l.startsWith("FAIL")).length;
      console.log(`---- ${label}: ${passed} pass / ${failed} fail`);
      return failed === 0;
    },
  };
}

/// The room code alphabet (32 symbols, `0/O/1/I` removed) — a code that does
/// not match this never came from the server.
export const CODE_RE = /^[2-9A-HJ-NP-Z]{8}$/;

/// Strip the punctuation a UI adds around a code (`#Q9CMK8W6`).
export const CODE_FROM_BANNER = (text) => String(text ?? "").replace(/[^A-Za-z0-9]/g, "");
