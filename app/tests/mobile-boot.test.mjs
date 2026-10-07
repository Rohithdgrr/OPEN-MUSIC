// mobile-boot.test.mjs — execute the real mobile module graph in Node.
//
// Guards the bug class recorded in AGENTS.md (2026-10-07): a *static* import
// of `qrview.js` pulled `core.js → dom.js` into the mobile shell, and
// `dom.js` dereferences `#audio2` (the desktop crossfade bed) at module top
// level. Mobile's markup never ships that id, so `audio2.volume = 0` threw
// during graph evaluation and the ENTIRE `app.js` graph died — no bindings,
// no injected Settings prefs. Lint, `node --check`, `imports.test` and
// `npm test` all stayed green because none of them *executes* the graph.
//
// How: install a DOM whose element lookup is backed by the ids mobile
// actually ships (`index.html` + `screens/*.html`), then import `app.js`.
// An id mobile never ships resolves to `null`, so a desktop-only top-level
// dereference reproduces the device failure here.
//
// Scope: graph evaluation + top-level init only. Layout, rendering and
// frame-driven behaviour still need the headless-Chrome harness
// (`tests/jam-ui.test.mjs`, `tests/live-*.mjs` — run by hand, not in CI).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..", "src");
const mobile = path.join(src, "mobile");

// ---------------------------------------------------------------- markup ---
// id -> tag name, from every fragment mobile can ever inject.
const ids = new Map();
function scanMarkup(file) {
  const s = fs.readFileSync(file, "utf8");
  for (const m of s.matchAll(/<([a-zA-Z][\w-]*)[^>]*\sid="([^"]+)"/g)) {
    if (!ids.has(m[2])) ids.set(m[2], m[1].toLowerCase());
  }
}
scanMarkup(path.join(mobile, "index.html"));
const screensDir = path.join(mobile, "screens");
const screens = fs.readdirSync(screensDir).filter((f) => f.endsWith(".html"));
for (const f of screens) scanMarkup(path.join(screensDir, f));

// ------------------------------------------------------------- elements ---
function el(tag = "div") {
  return {
    tagName: tag.toUpperCase(),
    style: new Proxy({}, { get: () => "", set: () => true }),
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [],
    childNodes: [],
    value: "",
    checked: false,
    disabled: false,
    hidden: false,
    textContent: "",
    innerText: "",
    innerHTML: "",
    outerHTML: "",
    className: "",
    href: "",
    src: "",
    volume: 1,
    paused: true,
    currentTime: 0,
    scrollLeft: 0,
    scrollTop: 0,
    offsetWidth: 412,
    offsetHeight: 915,
    clientWidth: 412,
    clientHeight: 915,
    parentNode: null,
    parentElement: null,
    firstChild: null,
    lastChild: null,
    nextSibling: null,
    previousSibling: null,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    prepend(c) {
      this.children.unshift(c);
      return c;
    },
    append(c) {
      this.children.push(c);
    },
    replaceChildren(...c) {
      this.children = c;
    },
    replaceWith() {},
    before() {},
    after() {},
    insertAdjacentHTML() {},
    insertAdjacentElement() {},
    hasChildNodes: () => false,
    getElementsByTagName: () => [],
    getElementsByClassName: () => [],
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    hasAttribute: () => false,
    toggleAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    matches: () => false,
    contains: () => false,
    cloneNode: () => el(tag),
    focus() {},
    blur() {},
    click() {},
    scrollTo() {},
    scrollIntoView() {},
    animate: () => ({ cancel() {}, finish() {} }),
    play: () => Promise.resolve(),
    pause() {},
    canPlayType: () => "",
  };
}

const byId = (id) => {
  const tag = ids.get(id);
  if (!tag) return null; // never shipped by mobile -> the bug signal
  const node = el(tag);
  if (tag === "template") {
    node.content = {
      firstElementChild: el("div"),
      children: [],
      querySelector: () => null,
      querySelectorAll: () => [],
      appendChild(c) {
        this.children.push(c);
        return c;
      },
    };
  }
  return node;
};

const storage = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
};

// ------------------------------------------------------------- globals ----
const captured = [];
const cap = (level) => (...a) => captured.push(`${level}: ${a.map(String).join(" ")}`);
const logs = { log: console.log, error: console.error, warn: console.warn, info: console.info };

globalThis.window = globalThis;
globalThis.document = {
  getElementById: byId,
  querySelector(sel) {
    const m = /^\s*#([\w-]+)/.exec(sel);
    return m ? byId(m[1]) : null; // non-id selectors: mobile screens are injected later
  },
  querySelectorAll: () => [],
  createElement: (n) => el(n),
  createTextNode: (t) => ({ textContent: t }),
  createDocumentFragment: () => el("fragment"),
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => true,
  body: el("body"),
  head: el("head"),
  documentElement: el("html"),
  hidden: false,
  visibilityState: "visible",
  fonts: { ready: Promise.resolve(), add() {} },
  elementFromPoint: () => null,
};
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "node", language: "en", onLine: true, vibrate() {}, clipboard: null },
  configurable: true,
  writable: true,
});
globalThis.location = {
  href: "http://127.0.0.1/mobile/index.html",
  protocol: "http:",
  host: "127.0.0.1",
  origin: "http://127.0.0.1",
  pathname: "/mobile/index.html",
  search: "",
  hash: "",
};
globalThis.history = { pushState() {}, replaceState() {}, back() {}, go() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.getComputedStyle = () => new Proxy({}, { get: () => "" });
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return []; } };
globalThis.Audio = function Audio() {
  return el("audio");
};
globalThis.Image = function Image() {
  return el("img");
};
globalThis.WebSocket = class {
  constructor() {
    setTimeout(() => this.onclose?.(), 0);
  }
  addEventListener() {}
  send() {}
  close() {}
};
// Resolves so a rejected promise can never surface as an unhandled rejection
// and take the test process down; `ok:false` is the honest "no network" answer.
globalThis.fetch = () =>
  Promise.resolve({ ok: false, status: 0, headers: new Map(), json: async () => ({}), text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) });
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.dispatchEvent = () => true;
globalThis.requestIdleCallback = (cb) => setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0);
globalThis.cancelIdleCallback = (id) => clearTimeout(id);
globalThis.innerWidth = 412;
globalThis.innerHeight = 915;
globalThis.devicePixelRatio = 2;
globalThis.pageXOffset = 0;
globalThis.pageYOffset = 0;
globalThis.screen = { width: 412, height: 915, orientation: { type: "portrait" } };
globalThis.scrollTo = () => {};

// Init arms ticks (host 1 s tick, rAF repaint). Track + unref so the file's
// process always exits, and release them once the graph has evaluated.
const pending = new Set();
const _st = globalThis.setTimeout;
const _si = globalThis.setInterval;
const _ct = globalThis.clearTimeout;
const _ci = globalThis.clearInterval;
const track = (id) => {
  pending.add(id);
  if (id && typeof id.unref === "function") id.unref();
  return id;
};
globalThis.setTimeout = (fn, ms, ...a) => track(_st(fn, ms, ...a));
globalThis.setInterval = (fn, ms, ...a) => track(_si(fn, ms, ...a));
globalThis.clearTimeout = (id) => {
  pending.delete(id);
  return _ct(id);
};
globalThis.clearInterval = (id) => {
  pending.delete(id);
  return _ci(id);
};
function releaseTimers() {
  for (const id of pending) {
    _ct(id);
    _ci(id);
  }
  pending.clear();
}

// Non-vacuity: the graph must actually be a graph, not one file.
function reachableFrom(entry) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    for (const m of text.matchAll(/(?:import|export)[^'"]*from\s*["'](\.[^"']+)["']|import\s*["'](\.[^"']+)["']/g)) {
      const rel = m[1] || m[2];
      let target = path.normalize(path.join(path.dirname(file), rel));
      if (!target.endsWith(".js")) target += ".js";
      if (fs.existsSync(target)) walk(target);
    }
  };
  walk(entry);
  return seen;
}

const entry = path.join(mobile, "app.js");

test("the mobile graph boots: app.js + its whole import tree evaluate on mobile's markup", async () => {
  assert.ok(fs.existsSync(entry), `missing entry ${entry}`);
  for (const level of ["log", "error", "warn", "info"]) console[level] = cap(level);
  let failure = null;
  try {
    await import(pathToFileURL(entry).href);
  } catch (e) {
    failure = e;
  } finally {
    Object.assign(console, logs);
    releaseTimers();
  }
  assert.equal(failure, null, `module graph died during evaluation${captured.length ? `\nconsole:\n${captured.join("\n")}` : ""}\n${failure ? failure.stack : ""}`);
});

test("the boot is non-vacuous: a real module graph and real markup were loaded", () => {
  const reachable = reachableFrom(entry);
  assert.ok(reachable.size >= 30, `only ${reachable.size} modules reachable from app.js — the scan is broken`);
  assert.ok(screens.length >= 10, `only ${screens.length} screen fragments — the markup scan is broken`); // observed 13
  assert.ok(ids.size >= 100, `only ${ids.size} ids found in mobile markup — the scan is broken`);
});

test("the detector bites: a desktop-only module cannot evaluate in the mobile environment", async () => {
  // dom.js reads `#audio2` (desktop crossfade bed) at top level; mobile ships
  // `#screen` + `#audio` and no `#audio2`, so it must throw here. If this
  // assertion ever flips, the detector no longer reproduces the failure —
  // re-verify with a fresh desktop-only dereference before trusting a green boot.
  assert.notEqual(byId("audio"), null, "mobile ships #audio — the id scan is broken");
  assert.equal(byId("audio2"), null, "mobile must NOT ship #audio2 — otherwise this proof is dead");
  await assert.rejects(() => import(pathToFileURL(path.join(src, "dom.js")).href), /Cannot read propert|null/i);
});
