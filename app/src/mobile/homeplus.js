// homeplus.js — personal Home layer: streak card + "New from artists you
// follow" shelf. Runs as a post-mount enhancer (smount listener) so the
// generated home fragment + binders mounts stay untouched. Shelves reuse the
// shared card renderers, so taps navigate and rows play exactly like native
// shelves. New-release lookups are cached 24h (tm-newrel) to avoid hammering
// artist endpoints on every Home visit.
import { invoke, load, save, hqArt, paintArt, loadFollows } from "./shared.js";
import { esc } from "../html.js";
import { streakStats, streakLabel } from "./streaks.js";

const NEWREL_KEY = "tm-newrel";

function routeKey() {
  try {
    const raw = location.hash.replace(/^#\/?/, "");
    const qi = raw.indexOf("?");
    return (qi >= 0 ? raw.slice(0, qi) : raw).toLowerCase() || "home";
  } catch {
    return "home";
  }
}

function loadCache() {
  try {
    const c = load(NEWREL_KEY, null);
    if (c && Date.now() - (c.ts || 0) < 86400000 && Array.isArray(c.items)) return c.items;
  } catch {}
  return null;
}

function albumCard(a, i, listName) {
  const nav = a.albumId ? `album?id=${encodeURIComponent(a.albumId)}` : a.id && a.kind === "album" ? `album?id=${encodeURIComponent(a.id)}` : "";
  return `<div ${nav ? `data-nav="${esc(nav)}"` : ""} class="w-40 flex-shrink-0 bg-surface-container-lowest border border-surface-container-high/70 rounded-2xl p-2.5 shadow-sm hover:shadow-md flex flex-col space-y-2 cursor-pointer active:scale-[0.98] transition-all group">
    <div class="relative w-full aspect-square rounded-xl overflow-hidden bg-surface-container-highest shadow-sm ring-1 ring-black/5"><img alt="" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" src="${esc(hqArt(a.image || ""))}" loading="lazy" data-art-orig="${esc(a.image || "")}"></div>
    <div class="flex flex-col pt-0.5 min-w-0">
      <span class="font-label-md text-label-md text-on-surface font-semibold truncate tracking-tight text-[13px]">${esc(a.title || "Untitled")}</span>
      <span class="font-body-sm text-[11.5px] text-secondary truncate mt-0.5">${esc(a.artist || "")}</span>
      <div class="flex items-center gap-1.5 mt-1"><span class="px-1.5 py-0.5 rounded bg-surface-container-low font-label-mono text-[9.5px] font-medium text-secondary uppercase tracking-wider">${esc(a.year || "New")}</span></div>
    </div>
  </div>`;
}

async function fetchNewReleases() {
  const cached = loadCache();
  if (cached) return cached;
  const follows = loadFollows().slice(0, 4);
  if (!follows.length || !invoke) return [];
  const out = [];
  try {
    const settled = await Promise.allSettled(
      follows.map((f) => invoke("artist_overview", { token: String(f.id) }).catch(() => null)),
    );
    for (let i = 0; i < settled.length; i += 1) {
      const r = settled[i];
      if (r.status !== "fulfilled" || !r.value) continue;
      const ov = r.value;
      const items = []
        .concat(ov.latest || [], ov.top_albums || [], ov.albums || [], ov.singles || [])
        .filter(Boolean)
        .slice(0, 3);
      for (const it of items) {
        out.push({
          title: it.title || it.name || "",
          artist: follows[i].title || "",
          image: it.image || "",
          year: it.year || it.release_year || "",
          albumId: it.id || it.album_id || "",
          kind: "album",
        });
        if (out.length >= 10) break;
      }
      if (out.length >= 10) break;
    }
  } catch {}
  try {
    save(NEWREL_KEY, { ts: Date.now(), items: out });
  } catch {}
  return out;
}

function injectStreak(main) {
  if (!main || main.querySelector("[data-hp-streak]")) return;
  const st = streakStats();
  if (st.streak < 2 && st.today < 1) return; // brand-new listener: no card yet
  const h1 = main.querySelector("h1");
  const host = h1 ? h1.parentElement : main.querySelector("section");
  if (!host) return;
  const pill = document.createElement("div");
  pill.setAttribute("data-hp-streak", "1");
  pill.className = "flex items-center gap-2 mt-1.5";
  const label = streakLabel(st);
  pill.innerHTML = `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/10 text-primary font-label-mono text-[10.5px] font-semibold tracking-wide"><span class="material-symbols-outlined text-[14px]" style="font-variation-settings:'FILL' 1;">local_fire_department</span>${esc(label || "Start your streak")}</span>${st.today ? `<span class="font-label-mono text-[10.5px] text-secondary">${st.today} play${st.today === 1 ? "" : "s"} today</span>` : ""}`;
  host.appendChild(pill);
}

function shelfHTML(id, title, tag, cards) {
  return `<section class="flex flex-col space-y-space-sm" data-shelf="${id}" data-hp="1"><div class="flex items-center justify-between"><h2 class="font-headline-md text-[17px] tracking-tight text-on-surface font-bold">${esc(title)}</h2><span class="font-label-mono text-[11px] text-secondary font-medium">${esc(tag)}</span></div><div class="flex gap-space-md overflow-x-auto no-scrollbar -mx-gutter px-gutter py-1">${cards}</div></section>`;
}

async function injectNewReleases(main) {
  if (!main || main.querySelector('[data-shelf="hp-newrel"]')) return;
  const items = await fetchNewReleases().catch(() => []);
  if (!items.length) return;
  if (!document.body.contains(main)) return; // user navigated away mid-fetch
  const wrap = main.querySelector("main div.space-y-7, main div[class*='space-y']") || main.querySelector("main");
  if (!wrap) return;
  const host = document.createElement("div");
  host.innerHTML = shelfHTML("hp-newrel", "New from artists you follow", "FRESH", items.map((a) => albumCard(a)).join(""));
  const sec = host.firstElementChild;
  if (sec) {
    // Artwork through the same ladder as native shelves.
    try {
      sec.querySelectorAll("img[data-art-orig]").forEach((img) => paintArt(img, img.getAttribute("data-art-orig") || ""));
    } catch {}
    wrap.appendChild(sec);
  }
}

let inflight = 0;

async function enhanceHome() {
  const my = ++inflight;
  // The home mount fetches home_feed asynchronously — wait for shelves.
  let tries = 0;
  let main = null;
  while (tries < 50) {
    if (routeKey() !== "home") return;
    main = document.getElementById("screen");
    if (main && main.querySelector("section[data-shelf]")) break;
    await new Promise((r) => setTimeout(r, 100));
    tries += 1;
  }
  if (my !== inflight || routeKey() !== "home" || !main) return;
  injectStreak(main);
  injectNewReleases(main).catch(() => {});
}

document.addEventListener("smount", (e) => {
  try {
    if (e && e.detail && (e.detail.key === "home" || e.detail.dir === "home")) enhanceHome();
  } catch {}
});

// First paint can beat the deferred module graph the same way it beats
// app.js — flush a queued home mount if we are already on it.
try {
  if (routeKey() === "home" && document.getElementById("screen")) enhanceHome();
} catch {}
