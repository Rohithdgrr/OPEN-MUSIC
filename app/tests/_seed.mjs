// Temporary: seed localStorage play history on the emulator app so
// recommend.js shelfPlan has a profile to render from (fresh install wiped
// the data). DELETED after the run. Scaffolding from tests/live-android-emulator.mjs.

import { execFileSync } from "node:child_process";

const SDK = process.env.ANDROID_HOME || "C:/Users/rohit/AppData/Local/Android/Sdk";
const ADB = `${SDK}/platform-tools/adb`;
const PKG = "com.openmusic.trancemusic";
const CDP_PORT = 9223;

const adb = (...args) => execFileSync(ADB, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const adbTry = (...args) => {
  try {
    return adb(...args);
  } catch {
    return "";
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const day = 86400000;
const now = Date.now();
const t = (id, title, artist, language, count, daysAgo, extra = {}) => ({
  id, title, artist, album: extra.album || `${artist} — ${title}`,
  image: "", duration: "4:00", duration_secs: 240, year: "2023", language,
  ts: now - daysAgo * day - Math.floor(Math.random() * 3600000), count, ...extra,
});

const plays = [
  t("p1", "Kesariya", "Arijit Singh", "Hindi", 9, 0),
  t("p2", "Tum Hi Ho", "Arijit Singh", "Hindi", 7, 0),
  t("p3", "Channa Mereya", "Arijit Singh", "Hindi", 5, 1),
  t("p4", "Blinding Lights", "The Weeknd", "English", 8, 0),
  t("p5", "Levitating", "Dua Lipa", "English", 6, 1),
  t("p6", "Shape of You", "Ed Sheeran", "English", 4, 2),
  t("p7", "Lover", "Diljit Dosanjh", "Punjabi", 5, 1),
  t("p8", "Brown Munde", "AP Dhillon", "Punjabi", 3, 3),
  t("p9", "Kesariya (Brahmastra)", "Arijit Singh", "Hindi", 2, 4),
  t("p10", "Raataan Lambiyan", "Jubin Nautiyal", "Hindi", 4, 2),
  t("p11", "Stay", "The Kid LAROI", "English", 3, 5),
  t("p12", "As It Was", "Harry Styles", "English", 2, 6),
  t("p13", "Pasoori", "Ali Sethi", "Punjabi", 3, 3),
  t("p14", "Agar Tum Saath Ho", "Arijit Singh", "Hindi", 6, 5),
];

async function main() {
  // App must be running with a devtools socket.
  adbTry("shell", "am", "force-stop", PKG);
  await wait(800);
  adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1");
  let sock = "";
  for (let i = 0; i < 30 && !sock; i++) {
    await wait(1000);
    const unix = adbTry("shell", "cat /proc/net/unix");
    sock = [...unix.matchAll(/webview_devtools_remote_\d+/g)].map((m) => m[0]).pop() || "";
  }
  if (!sock) throw new Error("no devtools socket");
  adb("forward", `tcp:${CDP_PORT}`, `localabstract:${sock}`);
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const page = targets.find((x) => x.type === "page");
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
      pending.set(id, (m) => res(m.result?.exceptionDetails ? "EXC " + JSON.stringify(m.result.exceptionDetails).slice(0, 200) : m.result?.result?.value));
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    });

  // Wait for the real app origin (never evaluate against about:blank).
  for (let i = 0; i < 25; i++) {
    if (await js("!!window.__TAURI__?.core && location.href.startsWith('http')")) break;
    await wait(1000);
  }
  const seeded = await js(`(()=>{
    localStorage.setItem("tm-plays", ${JSON.stringify(JSON.stringify(plays))});
    localStorage.setItem("tm-favorites", ${JSON.stringify(JSON.stringify(plays.slice(0, 6)))});
    return (JSON.parse(localStorage.getItem("tm-plays")||"[]")).length;
  })()`);
  console.log("SEEDED plays =", seeded, "origin =", await js("location.origin"));
  ws.close();
  process.exit(seeded === plays.length ? 0 : 1);
}

main().catch((e) => {
  console.error("SEED ERROR:", e.message);
  process.exit(2);
});
