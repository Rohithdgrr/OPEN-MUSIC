// Throwaway check: mobile net-banner delay + placement (rule 9 → temporary data/).
// Stubs DOM/time, drives startNet/probe, asserts visibility behavior.
let now = 1_000_000;
Date.now = () => now;
const timers = [];
globalThis.setTimeout = (fn) => (timers.push(fn), timers.length);
globalThis.clearTimeout = () => {};
globalThis.localStorage = { getItem: () => null };
globalThis.window = { addEventListener() {} };
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });
function makeEl() {
  let hidden = true;
  return {
    id: "", className: "", innerHTML: "",
    setAttribute() {},
    classList: {
      add: (c) => { if (c === "hidden") hidden = true; },
      remove: (c) => { if (c === "hidden") hidden = false; },
    },
    get hiddenFlag() { return hidden; },
  };
}
let els = [];
globalThis.document = {
  createElement: () => { const e = makeEl(); els.push(e); return e; },
  body: { appendChild() {} },
};
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
async function runProbe() { await tick(); const fn = timers.shift(); await fn(); await tick(); }
let pass = 0;
const ok = (cond, name) => { if (!cond) { console.error("FAIL:", name); process.exitCode = 1; } else { pass++; console.log("ok:", name); } };

// Case A — transient single failure stays hidden
{
  const m = await import("../app/src/mobile/net.js?case=a");
  let fail = true;
  m.startNet({ invoke: async () => { if (fail) throw new Error("down"); return 50; } });
  await runProbe();
  const b = els[els.length - 1];
  ok(b.hiddenFlag === true, "A: transient 1-fail banner stays hidden");
}

// Case B — sustained failure unhides + placement/size classes
{
  els = []; timers.length = 0;
  const m = await import("../app/src/mobile/net.js?case=b");
  m.startNet({ invoke: async () => { throw new Error("down"); } });
  await runProbe();
  const b = els[els.length - 1];
  ok(b.hiddenFlag === true, "B: first failure still hidden (delay)");
  now += 11_000;
  await runProbe(); // fails=2 → lost, delay elapsed
  ok(b.hiddenFlag === false, "B: sustained failure unhides banner");
  ok(b.className.includes("3.5rem+8px"), "B: banner sits below header (3.5rem+8px)");
  ok(b.className.includes("text-[11px]") && b.className.includes("px-3 py-1"), "B: compact pill (11px, px-3 py-1)");
}

// Case C — recovery hides + resets timer, next lone blip stays hidden
{
  els = []; timers.length = 0; now = 2_000_000;
  const m = await import("../app/src/mobile/net.js?case=c");
  let down = true;
  m.startNet({ invoke: async () => { if (down) throw new Error("down"); return 50; } });
  await runProbe(); now += 11_000; await runProbe(); // sustained → visible
  const b = els[els.length - 1];
  ok(b.hiddenFlag === false, "C: sustained failure visible before recovery");
  down = false;
  now += 11_000; await runProbe(); // reconnecting (oks 1)
  now += 11_000; await runProbe(); // reconnecting (oks 2)
  now += 11_000; await runProbe(); // online → hide + reset
  ok(b.hiddenFlag === true, "C: recovery hides banner");
  down = true;
  now += 11_000; await runProbe(); // lone blip after reset
  ok(b.hiddenFlag === true, "C: post-recovery blip stays hidden (timer reset)");
}
// Case D — bad → recovery: exactly one "Back online" toast, banner hides
{
  els = []; timers.length = 0; now = 3_000_000;
  const m = await import("../app/src/mobile/net.js?case=d");
  const toastCalls = [];
  let down = true;
  m.startNet({
    invoke: async () => { if (down) throw new Error("down"); return 50; },
    toast: (msg, ms, kind) => toastCalls.push([msg, ms, kind]),
  });
  await runProbe(); now += 11_000; await runProbe(); // sustained → visible
  const b = els[els.length - 1];
  ok(b.hiddenFlag === false, "D: sustained failure visible before recovery");
  ok(toastCalls.length === 0, "D: no toast while banner owns the bad state");
  down = false;
  now += 11_000; await runProbe(); // reconnecting (oks 1)
  now += 11_000; await runProbe(); // reconnecting (oks 2)
  now += 11_000; await runProbe(); // online → hide + single toast
  ok(b.hiddenFlag === true, "D: recovery hides banner");
  ok(toastCalls.length === 1 && toastCalls[0][0].includes("Back online"), "D: exactly one Back-online toast on recovery");
}

// Case E — sustained slow with no state change: banner matures, zero toasts
{
  els = []; timers.length = 0; now = 4_000_000;
  const m = await import("../app/src/mobile/net.js?case=e");
  const toastCalls = [];
  m.startNet({
    invoke: async () => 1500,
    toast: (msg, ms, kind) => toastCalls.push([msg, ms, kind]),
  });
  await runProbe();
  const b = els[els.length - 1];
  ok(b.hiddenFlag === true, "E: slow start stays hidden (delay)");
  now += 11_000; await runProbe(); // same state → maturation unhides
  ok(b.hiddenFlag === false, "E: sustained slow unhides without a transition");
  ok(toastCalls.length === 0, "E: degraded stretch produces zero toasts");
}
console.log(pass === 15 ? "ALL 15 PASS" : `${pass}/15 pass`);