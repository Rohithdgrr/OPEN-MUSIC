// binders.js — paints real backend data into each static design screen.
import { esc } from "../html.js";
import { querySim } from "../fuzzy.js";
import { didYouMean } from "../query.js";
import {
  invoke,
  load,
  save,
  go,
  toast,
  setList,
  store,
  hooks,
  fmtTime,
  fmtDur,
  badgeLabel,
  art,
  paintArt,
  hqArt,
  rowHTML,
  plCardHTML,
  artistCardHTML,
  paintFavs,
  pushHistory,
  downloadTrack,
  downloadAll,
  toggleFav,
  FAVS_KEY,
  PLAYS_KEY,
  HISTORY_KEY,
  LIBRARY_KEY,
  LANG_KEY,
  COUNTRY_KEY,
  dlQuality,
  setDlQuality,
  checkForUpdates,
  AUTOUPDATE_KEY,
  EVENTS_KEY,
  pushEvent,
  shareThing,
  getActiveDownloads,
  cancelDownload,
  setBatchPaused,
  batchPausedNow,
  wifiOnly,
  setWifiOnly,
  pushDiag,
  readDiag,
  clearDiag,
  loadFollows,
  isFollowing,
  toggleFollow,
  dataSaver,
  setDataSaver,
  effStreamWifi,
  setEffStreamWifi,
  effStreamCell,
  setEffStreamCell,
  explicitHidden,
  setExplicitHidden,
  eqPreset,
  setEqPreset,
  normalizeOn,
  setNormalize,
  smartDlOn,
  setSmartDl,
  vaultQuotaGb,
  setVaultQuotaGb,
  enforceVaultQuota,
  prefetchOn,
  setPrefetchOn,
  playlistOffline,
  setPlaylistOffline,
  movePlaylistTrack,
  removePlaylistTrack,
  updatePlaylistMeta,
  shareCard,
  haptic,
} from "./shared.js";
import { buildBackup, parseBackupFile, applyBackup, readSettings, writeSettings, backupFilename } from "../sync.js";
import { playList, playerState, onPaint, toggle, next, prev, seek, toggleShuffle, cycleRepeat, repaint, insertNext, audio as mAudio } from "./player.js";
import { ensureReco, isRadioOn, setRadioOn } from "./radio.js";
import { renderLyrics, resetLyrics, syncLyrics, setLyricOffset, setLyricTrack, lyricOffsetMs } from "./lyrics.js";
import { getGeminiKey, setGeminiKey, hasGeminiKey, fetchAiLyrics, aiCopyright } from "./ai-lyrics.js";
import { importCsvToPlaylist, readCsvFile } from "../importer.js";
import { netMode } from "./net.js";
import { licensesHTML, aboutHTML, termsHTML } from "./legal.js";
import { trackMenu, openSheet, detailsSheet } from "./menus.js";
// The taste engine (pure + unit-tested in tests/recommend.test.mjs). Home's
// Made-for-you shelves are a windowed projection of one profile built here.
import { buildProfile, explain, shelfPlan, trackLangs } from "./recommend.js";
import { groupLangAlbums, variantsFor } from "../albumgroup.js";

const main = () => document.querySelector("#screen main");

// ------------------------------------------------- search rank + recovery -
// Ordering lives in rank.js (pure + unit-tested); this shell owns the chip
// that cycles it and the typo toast. Both reuse the desktop's helpers.
import { nextSort, SORT_LABEL } from "./rank.js";
// Query understanding, ranking, highlighting and the cache the search screen
// runs on — pure logic, unit-tested in tests/mobile-searchkit.test.mjs.
import {
  createLru,
  highlight,
  parseSearch,
  pickTop,
  queryTokens,
  rankForQuery,
  tasteContext,
  understoodLabels,
  uniqueById,
} from "./searchkit.js";
let searchSort = "relevance";

/// Nothing matched: ask the catalog for nearby titles and offer the closest as
/// a toast action (desktop shows the same list under "Did you mean").
function offerTypoFix(q) {
  if (!invoke || !q) return;
  invoke("search_suggestions", { query: q })
    .then((s) => {
      const remote = [s?.top, ...(s?.songs || [])].filter(Boolean);
      const seen = load(HISTORY_KEY, []).map((t) => ({ title: typeof t === "string" ? t : t?.title }));
      const cands = didYouMean(q, [...remote, ...seen], (a, b) => querySim(a, b));
      if (!cands.length) return;
      const fix = cands[0].title;
      toast(`Nothing for “${q}” — did you mean “${fix}”?`, 7000, "info", {
        label: "Search",
        fn: () => go(`search?q=${encodeURIComponent(fix)}`),
      });
    })
    .catch(() => {});
}

// Last successful Home feed — rendered verbatim when the network is gone.
const HOME_SNAP_KEY = "tm-home-snap";

/// Byte counts as a human string: "0.00 GB" for a 3 MB download reads as
/// broken, so scale the unit to the value.
const fmtBytes = (b) => {
  const n = Number(b) || 0;
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  return n > 0 ? `${Math.max(1, Math.round(n / 1024))} KB` : "0 MB";
};

function headIn(root, text) {
  return [...root.querySelectorAll("h1,h2,h3")].find((h) => h.textContent.includes(text));
}

function sectionFor(text) {
  const h = main() && headIn(main(), text);
  return h ? h.closest("section") : null;
}

function afterHead(s, text) {
  const h = headIn(s, text);
  if (!h || !s.contains(h)) return null;
  let n = h;
  while (n && n.parentElement !== s) n = n.parentElement;
  return n ? n.nextElementSibling : null;
}

function firstButtonWith(root, icon) {
  return [...root.querySelectorAll("button")].find((b) =>
    [...b.querySelectorAll(".material-symbols-outlined")].some((s) => s.textContent.trim() === icon),
  );
}

/// Every screen keeps its back affordance in the fragment <header>, which
/// lives OUTSIDE `#screen main` — scoping the search to `main` left every one
/// of those buttons dead (the report's "back button not working"). Scope to
/// the screen root and wire them all; fragments that already go back through
/// an inline handler (NowPlaying's Collapse) are skipped or they'd double-step.
function wireBack(m) {
  const scope = (m && m.closest && m.closest("#screen")) || document.getElementById("screen");
  if (!scope) return;
  scope.querySelectorAll("button").forEach((b) => {
    if (b.dataset.backWired || b.hasAttribute("onclick")) return;
    const collapse = b.getAttribute("aria-label") === "Collapse";
    const arrow = [...b.querySelectorAll(".material-symbols-outlined")].some((s) => /arrow_back|chevron_left|arrow_back_ios/.test(s.textContent));
    if (!collapse && !arrow) return;
    b.dataset.backWired = "1";
    b.addEventListener("click", () => history.back());
  });
}

// ---------------------------------------------------------------- detail --
// The generated screens carry the design's placeholder copy ("Monolith
// Sessions", "Solaris & Kaelen", "12 TRACKS"). Everything below replaces it
// with the row data the backend returns, addressing elements by their text
// rather than by fraction selectors that shift between screens.

/// Deepest element whose trimmed text matches `re`.
function findByText(root, re) {
  if (!root) return null;
  let best = null;
  for (const el of root.querySelectorAll("*")) {
    if (!re.test(el.textContent.trim())) continue;
    if (!best || el.querySelectorAll("*").length < best.querySelectorAll("*").length) best = el;
  }
  return best;
}

/// Replace placeholder copy, or drop the element when there is no real value
/// to put there (better an absent row than a lie).
function paintOrHide(root, re, value) {
  const el = findByText(root, re);
  if (!el) return null;
  if (value) el.textContent = String(value);
  else el.remove();
  return el;
}

/// URL for an entity screen, carrying the card's own metadata so the header
/// paints real values immediately instead of the design's placeholders.
export function entityNav(kind, it) {
  const item = it || {};
  const q = new URLSearchParams();
  if (item.token) q.set("token", item.token);
  if (item.id) q.set("id", item.id);
  if (item.local) q.set("local", "1"); // local playlist: read from LIBRARY_KEY
  // Merged language-variant card: every sibling token rides along so the
  // detail can load all languages, not just the first.
  const v = kind === "album" && (item.variantTokens || variantsFor(item.token));
  if (v && v.length > 1) {
    q.set("tokens", v.map((x) => x.token || x).filter(Boolean).join(","));
    const langs = v.map((x) => x.language).filter(Boolean).join(",");
    if (langs) q.set("langs", langs);
  }
  for (const [k, v] of [
    ["title", item.title],
    ["subtitle", item.subtitle],
    ["image", item.image],
    ["count", item.count],
    ["year", item.year],
  ]) {
    if (v) q.set(k, String(v));
  }
  return `${kind}?${q.toString()}`;
}

/// Replace a shelf's rows with real ones, keeping the shelf heading.
///
/// The old version removed children heuristically (img / w-10 / w-11), which
/// left the design's placeholder rows behind whenever they carried no image —
/// so playlists showed mock tracks above the real list.
function fillRows(sec, tracks, name) {
  if (!sec) return;
  setList(name, tracks);
  const keep = new Set();
  for (const h of sec.querySelectorAll("h1,h2,h3,h4")) {
    let el = h;
    while (el && el.parentElement !== sec) el = el.parentElement;
    if (el) keep.add(el);
  }
  [...sec.children].forEach((c) => {
    if (!keep.has(c)) c.remove();
  });
  sec.insertAdjacentHTML("beforeend", tracks.map((t, i) => rowHTML(name, i, t)).join(""));
}

/// In-screen filters (album/playlist detail, liked songs): toggle rendered
/// rows by text match and show a "No matches" line when nothing survives.
/// The row indices never change, so playback and menus keep their targets.
function wireRowFilter(input, container, rowSel) {
  if (!input || !container || input.dataset.filterWired) return;
  input.dataset.filterWired = "1";
  input.addEventListener("input", () => {
    const term = input.value.trim().toLowerCase();
    let visible = 0;
    container.querySelectorAll(rowSel).forEach((r) => {
      const ok = !term || r.textContent.toLowerCase().includes(term);
      r.classList.toggle("hidden", !ok);
      if (ok) visible += 1;
    });
    let none = container.querySelector("[data-filter-empty]");
    if (!term || visible > 0) {
      none?.remove();
      return;
    }
    if (!none) {
      none = document.createElement("div");
      none.setAttribute("data-filter-empty", "");
      none.className = "py-6 text-center font-body-sm text-secondary italic";
      none.textContent = "No matches";
      container.appendChild(none);
    }
  });
}

// --------------------------------------------------------------- made for you
// Home's personal shelves: the hybrid recommender (recommend.js) reads the
// local logs — plays, likes, vault, saved playlists, country + language picks
// — and hands back an ordered shelf plan. Runs *before* the feed guard in
// mountHome: it needs no network, so an offline cold boot still gets them.
async function renderMadeForYou(m) {
  const root = m.querySelector("section")?.parentElement;
  if (!root) return;

  // Vault rows are the "intent to own" signal, and they are what the
  // Downloaded shelf shows. Best effort: a preview with no IPC just loses it.
  let downloads = [];
  if (invoke) {
    try {
      downloads = (await invoke("list_downloads")).entries || [];
    } catch (e) {
      console.warn("made-for-you: no vault", e);
    }
  }

  // Saved library entries are albums/playlists; only the locally materialised
  // ones carry their tracks (Spotify CSV imports land here), and those tracks
  // are the library signal buildProfile asks for.
  const saved = load(LIBRARY_KEY, []).flatMap((e) => (e && e.local && Array.isArray(e.tracks) ? e.tracks : []));

  // The SQLite ledger is the analytics layer: play counters that survive
  // restarts, a longer history than the 100-row localStorage log, and likes
  // mirrored for offline. Best effort — without IPC the localStorage signals
  // still carry the shelves.
  let ledger = [];
  try {
    const db = await import("../store_db.js");
    const [most, recent, liked] = await Promise.all([db.getMostPlayed(120), db.getRecent(60), db.getStoredFavs(200)]);
    ledger = [...most, ...recent, ...liked];
  } catch (e) {
    console.warn("made-for-you: no store ledger", e);
  }

  const profile = buildProfile({
    plays: load(PLAYS_KEY, []),
    favs: [...load(FAVS_KEY, []), ...ledger.filter((r) => r && r.is_fav)],
    downloads,
    library: saved,
    extra: ledger,
    country: load(COUNTRY_KEY, ""),
  });
  // An explicit language pick outranks what the log merely leans towards.
  const picked = prefLangs()[0] || "";
  const plan = shelfPlan(profile, { limit: 10, language: picked });

  // Reconcile against the DOM: a remount must not stack sections, and a
  // profile that shrank must not leave a shelf with nothing behind it.
  for (const stale of [...root.querySelectorAll("[data-shelf]")]) {
    if (stale.dataset.shelf.startsWith("tm-shelf-mfy-") && !plan.some((s) => `tm-shelf-mfy-${s.id}` === stale.dataset.shelf)) {
      stale.remove();
    }
  }

  for (const shelf of plan) {
    const key = `tm-shelf-mfy-${shelf.id}`;
    const listName = key;
    let sec = root.querySelector(`[data-shelf="${key}"]`);
    if (!sec) {
      sec = document.createElement("section");
      sec.dataset.shelf = key;
      sec.className = "flex flex-col space-y-space-sm";
      const why = explain(profile, shelf);
      sec.innerHTML = `<div class="flex flex-col space-y-0.5"><div class="flex items-center justify-between"><h2 class="font-headline-md text-headline-md tracking-tight text-on-surface font-semibold">${esc(shelf.title)}</h2><span class="font-label-mono text-[9.5px] uppercase tracking-widest text-secondary">${esc(shelf.tag)}</span></div>${why ? `<p class="font-body-sm text-[11.5px] text-secondary truncate">${esc(why)}</p>` : ""}</div><div class="flex flex-col gap-1" data-cards></div>`;
      root.appendChild(sec);
    }
    setList(listName, shelf.tracks);
    const box = sec.querySelector("[data-cards]");
    if (box) box.innerHTML = shelf.tracks.map((t, i) => rowHTML(listName, i, t)).join("");
  }

  paintFavs();
}

async function mountHome() {
  const m = main();
  if (!m) return;
  const h1 = m.querySelector("h1");
  if (h1) {
    const hr = new Date().getHours();
    const base = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
    const name = String(load(NAME_KEY, "")).trim();
    h1.textContent = name ? `${base}, ${name}` : base;
  }
  const dateEl = m.querySelector("section span.uppercase");
  if (dateEl) dateEl.textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  // Personal shelves first: local logs only, so they still render when the
  // launch feed fails below and this mount would otherwise bail out.
  await renderMadeForYou(m);

  if (!invoke) return;
  let feed = null;
  try {
    // Offline: skip the upstream call entirely (it would sit on timeouts)
    // and repaint the last feed the app actually saw.
    if (netMode() !== "offline") feed = await invoke("home_feed");
  } catch (e) {
    console.error(e);
    toast(`Couldn't load Home: ${String(e).split("\n")[0].slice(0, 70)}`, 5000, "error");
  }
  if (!feed) {
    feed = load(HOME_SNAP_KEY, null);
    if (feed) toast("Offline — showing your saved Home", 3500, "info");
  }
  if (!feed) return;
  save(HOME_SNAP_KEY, feed); // the offline fallback for the next cold boot
  const sections = [...m.querySelectorAll("section")];

  const spot = feed.spotlight;
  const hero = sections[1];
  if (hero && spot) {
    if (spot.image) paintArt(hero.querySelector("img"), spot.image);
    const ht = hero.querySelector("h3");
    if (ht) ht.textContent = spot.title || ht.textContent;
    const sub = hero.querySelector("p");
    if (sub && spot.subtitle) sub.textContent = spot.subtitle;
    const meta = [...hero.querySelectorAll("span")].find((sp) => /Tracks/i.test(sp.textContent));
    if (meta && spot.count) meta.textContent = `${spot.count} Tracks`;
    const pb = [...hero.querySelectorAll("button")].find((b) => b.textContent.includes("Play"));
    // The hero is a playlist: Play must load its tracks (playlist_tracks),
    // not hand its id to resolve_song as if it were a song.
    if (pb && spot.id) pb.dataset.plPlay = spot.id;
  }

  const jump = sectionFor("Jump Back In");
  const plays = load(PLAYS_KEY, []).slice(0, 4);
  if (jump) {
    const c = afterHead(jump, "Jump Back In");
    if (plays.length && c) {
      setList("jump", plays);
      c.innerHTML = plays
        .map(
          (t, i) => `<div data-list="jump" data-idx="${i}" class="p-space-sm bg-surface-container-lowest border border-surface-container rounded-lg shadow-sm flex flex-col space-y-2 cursor-pointer active:bg-surface-container-low transition-colors">
          <div class="flex items-center gap-space-sm">
            <div class="w-12 h-12 rounded bg-surface-container-highest flex-shrink-0 overflow-hidden relative"><img alt="" class="w-full h-full object-cover" ${art(t.image)}></div>
            <div class="flex flex-col min-w-0 flex-1">
              <span class="font-label-md text-label-md text-on-surface font-medium truncate">${esc(t.title || "")}</span>
              <span class="font-body-sm text-[11px] text-secondary truncate">${esc(t.artist || "")}</span>
            </div>
          </div>
        </div>`,
        )
        .join("");
    } else {
      jump.classList.add("hidden");
    }
  }

  // 1. Dedicated Top Charts shelf
  const charts = feed.charts || [];
  const chartsSec = m.querySelector('[data-shelf="charts"]');
  if (chartsSec) {
    const c = chartsSec.querySelector("[data-charts-carousel]");
    if (c && charts.length) {
      setList("charts", charts);
      c.innerHTML = charts
        .slice(0, 10)
        .map((p, i) => plCardHTML(p, i, entityNav("playlist", p)))
        .join("");
    } else if (!charts.length) {
      chartsSec.classList.add("hidden");
    }
  }

  // 2. Curated Playlists shelf
  const curated = (feed.playlists && feed.playlists.length ? feed.playlists : (feed.charts || [])).filter(
    (p, i, all) => p && p.id && all.findIndex((x) => x && x.id === p.id) === i,
  );
  const curS = sectionFor("Curated Playlists");
  if (curS) {
    const c = afterHead(curS, "Curated Playlists");
    if (c) {
      setList("curated", curated);
      c.innerHTML = curated
        .slice(0, 12)
        .map((p, i) => plCardHTML(p, i, entityNav("playlist", p)))
        .join("");
    }
  }

  const tracks = feed.top_tracks || [];
  const qp = sectionFor("Quick Picks");
  if (qp) {
    const c = afterHead(qp, "Quick Picks");
    if (c) {
      setList("qp", tracks);
      c.innerHTML = tracks.map((t, i) => rowHTML("qp", i, t)).join("");
    }
    const all = [...qp.querySelectorAll("button")].find((b) => b.textContent.includes("PLAY ALL"));
    if (all) {
      all.dataset.list = "qp";
      all.dataset.idx = "0";
    }
    // Rows are painted from the first five of the day's chart; the chart has
    // ~100. Swap in the full list so Play All and every row tap agree.
    if (feed.chart_id) {
      invoke("playlist_tracks", { id: feed.chart_id })
        .then((full) => {
          if (!Array.isArray(full) || !full.length) return;
          setList("qp", full);
          const box = afterHead(qp, "Quick Picks");
          if (box) {
            box.innerHTML = full.slice(0, 8).map((t, i) => rowHTML("qp", i, t)).join("");
            paintFavs();
          }
        })
        .catch(() => {});
    }
  }

  const artists = feed.artists || [];
  const artS = sectionFor("Artists You May Like");
  if (artS) {
    const c = afterHead(artS, "Artists You May Like");
    if (c) {
      setList("artists", artists);
      c.innerHTML = artists
        .slice(0, 10)
        .map((a, i) => artistCardHTML(a, i, entityNav("artist", a)))
        .join("");
    }
    // No "all artists" screen exists on mobile — hide the button rather than
    // leave a dead one in the corner.
    [...artS.querySelectorAll("button")].find((b) => /SEE ALL/i.test(b.textContent))?.remove();
  }

  // Wire Genre Cards to search
  m.querySelectorAll("#home-genres-grid .genre-card").forEach((gc) => {
    gc.addEventListener("click", () => {
      const gq = gc.dataset.genreQ;
      if (gq) go(`search?q=${encodeURIComponent(gq)}`);
    });
  });

  // Wire Category Filter Chips
  const chipContainer = m.querySelector("#home-category-chips");
  if (chipContainer) {
    const chips = chipContainer.querySelectorAll(".home-cat-chip");
    chips.forEach((chip) => {
      chip.addEventListener("click", () => {
        const cat = chip.dataset.homeCat || "all";
        // Update active chip pill appearance
        chips.forEach((c) => {
          c.className = "home-cat-chip px-4 py-1.5 rounded-full font-label-sm text-label-sm whitespace-nowrap transition-all font-medium active:scale-95 border border-surface-container-high/60 bg-surface-container-low text-on-surface-variant hover:bg-surface-container hover:text-on-surface";
        });
        chip.className = "home-cat-chip px-4 py-1.5 rounded-full font-label-sm text-label-sm whitespace-nowrap shadow-sm font-semibold active:scale-95 transition-all bg-primary text-on-primary";

        // Map category to shelf visibility
        const allShelves = m.querySelectorAll("section[data-shelf]");
        allShelves.forEach((s) => {
          const key = s.dataset.shelf;
          if (cat === "all") {
            s.classList.remove("hidden");
          } else if (cat === "charts") {
            s.classList.toggle("hidden", key !== "charts");
          } else if (cat === "playlists") {
            s.classList.toggle("hidden", key !== "curated" && key !== "tm-shelf-daily");
          } else if (cat === "albums") {
            s.classList.toggle("hidden", key !== "spotlight" && key !== "tm-shelf-albums");
          } else if (cat === "artists") {
            s.classList.toggle("hidden", key !== "artists");
          } else if (cat === "genres") {
            s.classList.toggle("hidden", key !== "genres");
          } else if (cat === "jump") {
            s.classList.toggle("hidden", key !== "jump" && key !== "qp");
          }
        });
      });
    });
  }

  // Two shelves the feed already returns: new releases and daily playlists
  const root = m.querySelector("section")?.parentElement;
  const shelves = [
    ["tm-shelf-albums", "New Releases", groupLangAlbums(feed.albums || []).map((a, i) => plCardHTML(a, i, entityNav("album", a)))],
    ["tm-shelf-daily", "Fresh Playlists", (feed.daily || []).map((p, i) => plCardHTML(p, i, entityNav("playlist", p)))],
  ];
  for (const [key, title, cards] of shelves) {
    if (!root) break;
    let sec = root.querySelector(`[data-shelf="${key}"]`);
    if (!cards.length) {
      sec?.remove();
      continue;
    }
    if (!sec) {
      sec = document.createElement("section");
      sec.dataset.shelf = key;
      sec.className = "flex flex-col space-y-space-sm";
      sec.innerHTML = `<div class="flex items-center justify-between"><h2 class="font-headline-md text-headline-md tracking-tight text-on-surface font-semibold">${title}</h2></div><div class="flex gap-space-md overflow-x-auto no-scrollbar -mx-gutter px-gutter py-1" data-cards></div>`;
      root.appendChild(sec);
    }
    const box = sec.querySelector("[data-cards]");
    if (box) box.innerHTML = cards.slice(0, 12).join("");
  }

  // Made For You is no longer built here: renderMadeForYou() runs before the
  // feed guard above (see docs/recommendations.md §4) so personal shelves
  // survive an offline cold boot, and it renders all ten mixes from
  // recommend.js instead of the three play-counter shelves.

  // Genre/mood grid fallback: the fragment may not ship one — inject eight
  // chips wired exactly like the design's own genre cards (search the term).
  if (root && !m.querySelector("#home-genres-grid")) {
    const terms = ["Pop", "Hip-Hop", "Lo-Fi", "Workout", "Chill", "Party", "Devotional", "Retro"];
    const gsec = document.createElement("section");
    gsec.dataset.shelf = "genres";
    gsec.className = "flex flex-col space-y-space-sm";
    gsec.innerHTML = `<div class="flex items-center justify-between"><h2 class="font-headline-md text-headline-md tracking-tight text-on-surface font-semibold">Genres &amp; Moods</h2></div><div id="home-genres-grid" class="grid grid-cols-4 gap-2">${terms.map((t) => `<button type="button" class="genre-card px-3 py-2.5 rounded-xl bg-surface-container-low border border-surface-container-high/60 font-label-md text-label-md text-on-surface font-medium active:scale-95 transition-all" data-genre-q="${esc(t)}">${esc(t)}</button>`).join("")}</div>`;
    root.appendChild(gsec);
    gsec.querySelectorAll(".genre-card").forEach((gc) => {
      gc.addEventListener("click", () => {
        const gq = gc.dataset.genreQ;
        if (gq) go(`search?q=${encodeURIComponent(gq)}`);
      });
    });
  }

  // SEE ALL: Jump Back In → the history it is drawn from; Curated → lift the
  // 12-card cap for this session.
  const jumpSeeAll = jump && [...jump.querySelectorAll("button")].find((b) => /SEE ALL/i.test(b.textContent));
  if (jumpSeeAll) jumpSeeAll.addEventListener("click", () => go("history"));
  const curSeeAll = curS && [...curS.querySelectorAll("button")].find((b) => /SEE ALL/i.test(b.textContent));
  if (curSeeAll) {
    curSeeAll.addEventListener("click", () => {
      const c = afterHead(curS, "Curated Playlists");
      if (c) c.innerHTML = curated.map((p, i) => plCardHTML(p, i, entityNav("playlist", p))).join("");
      curSeeAll.remove();
    });
  }

  paintFavs();
}

// The search screen's auto-load observer survives between mounts only as a
// handle to disconnect — each mount replaces it with its own button.
let smMoreIO = null;

// ------------------------------------------------------------- search caches
// Three tiers, cheapest first, all keyed by query + category + sort:
//   1. SEARCH_MEM — in-process LRU. Back-navigation, chip switches and
//      retyping a query repaint with no IPC at all.
//   2. store.db `search_cache` (store_db.js) — 6 h TTL, capped at 200 keys.
//      Survives restarts and is what makes offline search answer.
//   3. localStorage — a one-query snapshot, the last resort when even the
//      store is unavailable (browser preview, disk error).
const SEARCH_MEM = createLru({ max: 80, ttlMs: 30 * 60 * 1000 });
const SUG_MEM = createLru({ max: 160, ttlMs: 15 * 60 * 1000 });
const RESULT_FRESH_MS = 2 * 60 * 1000; // keep a page this long before revalidating
const LIVE_DEBOUNCE_MS = 320; // search-as-you-type delay
const SUG_DEBOUNCE_MS = 220;
const UPGRADE_MS = 700; // idle time before the mixed shelves are fetched
const MIXED_SONGS = 6; // song rows shown under "Top result" in the All view
const SNAP_KEY = "tm-search-snap";

// "Click away closes the suggestions" as ONE listener for the whole shell.
// A per-mount listener would be re-added on every search navigation and then
// never removed, leaking one closure per visit; this points at whichever mount
// is on screen instead.
let smSuggestCtx = null;
document.addEventListener("click", (e) => {
  const ctx = smSuggestCtx;
  if (!ctx || ctx.box.classList.contains("hidden")) return;
  if (e.target.closest("#m-suggest") || e.target.closest("#search-input")) return;
  ctx.hide();
});

async function mountSearch(query) {
  const m = main();
  if (!m) return;
  const q0 = (query && query.get("q")) || "";
  const cat0 = (query && query.get("cat")) || "all";
  // The sort chip rides in the URL: `go()` with an unchanged hash never
  // remounts, so a chip that only advanced module state looked dead.
  const sortParam = query && query.get("s");
  if (sortParam && SORT_LABEL[sortParam]) searchSort = sortParam;
  // Plural chip -> singular backend kind. Every other chip (all / tracks /
  // hires) is a song search.
  const entityKinds = { albums: "album", artists: "artist", playlists: "playlist" };
  const isEntityCat = (cat) => !!entityKinds[cat];
  const navOf = (it, k) => entityNav(k, it);

  const input = document.getElementById("search-input");
  if (input) input.value = q0;
  // The field is white on a near-white surface; a hairline makes it read as an
  // input instead of empty space.
  const fieldWrap = input && input.closest(".relative");
  if (fieldWrap) fieldWrap.classList.add("border", "border-surface-container-high");

  // ---- live view state (a live search repaints in place, no remount) ------
  let curQ = q0;
  let curCat = cat0;
  let curSort = searchSort;
  let parsed = parseSearch(q0);
  let tokens = queryTokens(parsed);
  let results = []; // songs, or entity cards for an entity chip
  let page = 1;
  let pageFull = false;
  let shelves = { album: [], artist: [], playlist: [] };
  let statusNote = ""; // "offline copy" and friends, shown in the status line
  let topPick = null; // memoized Spotify-style "Top result"
  let topKey = "";
  let seq = 0; // supersedes in-flight searches
  let sugSeq = 0; // supersedes in-flight autocomplete
  let sugIndex = -1;
  let liveTimer = 0;
  let sugTimer = 0;
  let upgradeTimer = 0;

  // ------------------------------------------------------------- cache tiers
  const cacheKey = (q, cat, sort) => `${cat}|${sort}|${String(q).toLowerCase()}`;
  const cacheKeyNow = () => cacheKey(curQ, curCat, curSort);
  let dbPromise = null;
  const db = () => (dbPromise || (dbPromise = import("../store_db.js").catch(() => null)));
  const diskGet = async (key) => {
    const mod = await db();
    if (!mod || !mod.searchCacheGet) return null;
    try {
      return await mod.searchCacheGet(`sm:${key}`);
    } catch {
      return null;
    }
  };
  const diskPut = (key, value) => {
    db()
      .then((mod) => mod && mod.searchCachePut(`sm:${key}`, value).catch(() => {}))
      .catch(() => {});
  };
  const cacheSongs = (list) => {
    if (isEntityCat(curCat) || !list.length) return;
    db()
      .then((mod) => mod && mod.cacheSongs(list.slice(0, 50)).catch(() => {}))
      .catch(() => {});
  };
  const saveSnap = (key, payload) => save(SNAP_KEY, { key, ...payload, at: Date.now() });
  const readSnap = (key) => {
    const snap = load(SNAP_KEY, null);
    return snap && snap.key === key ? snap : null;
  };

  // ------------------------------------------------------------ DOM anchors
  const topSec = [...m.querySelectorAll("section")].find((s) => s.textContent.includes("Top result"));
  let box = document.getElementById("sm-results");
  if (!box) {
    box = document.createElement("div");
    box.id = "sm-results";
    (topSec || m.firstElementChild).insertAdjacentElement("afterend", box);
  }
  box.setAttribute("aria-live", "polite");

  const ROW_SKELETON = Array.from(
    { length: 6 },
    () =>
      '<div class="flex items-center gap-3 p-2.5"><div class="w-11 h-11 rounded-lg tm-skeleton shrink-0"></div><div class="flex flex-col gap-1.5 flex-1 min-w-0"><div class="h-3.5 w-2/5 rounded tm-skeleton"></div><div class="h-3 w-1/4 rounded tm-skeleton"></div></div></div>',
  ).join("");
  const GRID_SKELETON = `<div class="grid grid-cols-2 gap-3">${Array.from(
    { length: 6 },
    () =>
      '<div class="rounded-2xl border border-surface-container-high/70 p-2.5 space-y-2"><div class="aspect-square rounded-xl tm-skeleton"></div><div class="h-3.5 w-3/4 rounded tm-skeleton"></div><div class="h-3 w-1/2 rounded tm-skeleton"></div></div>',
  ).join("")}</div>`;
  const skeletonHTML = (cat) => (isEntityCat(cat) ? GRID_SKELETON : ROW_SKELETON);

  /// What the search understood, said out loud — a stripped filter must be
  /// visible rather than silently applied.
  const statusText = () => {
    if (!curQ) return "";
    const labels = understoodLabels(parsed);
    const tail = labels.length ? ` · ${esc(labels.join(" · "))}` : "";
    const unit = isEntityCat(curCat) ? "result" : "song";
    const want = esc(parsed.text || curQ);
    if (!results.length) {
      // The All chip can have shelves without a single song match.
      const cards = shelves.album.length + shelves.artist.length + shelves.playlist.length;
      if (curCat === "all" && cards) return `Top matches for “${want}”${tail}`;
      return `No ${unit}s for “${want}”${tail}`;
    }
    const n = results.length;
    return `${n} ${unit}${n === 1 ? "" : "s"} for “${want}”${tail}${statusNote ? ` · ${esc(statusNote)}` : ""}`;
  };
  const statusHTML = () => {
    const text = statusText();
    return text
      ? `<div data-sm-status class="px-1 pt-2 pb-0.5 font-body-sm text-body-sm text-secondary">${text}</div>`
      : "";
  };
  const emptyHTML = () => `<div class="flex flex-col items-center gap-2 py-8 px-4 text-center">
    <span class="material-symbols-outlined text-[28px] text-secondary">search_off</span>
    <span class="font-body-md text-body-md text-on-surface">No results for “${esc(curQ)}”</span>
    <span class="font-body-sm text-body-sm text-secondary">Check the spelling, or try a different keyword.</span>
  </div>`;

  /// The design's spotlight card, wired to whatever the best match is. Kept
  /// here (not in the fragment's script) so a chip switch or a live search can
  /// repoint it without a remount.
  const paintTopResult = (first, kind) => {
    if (!topSec) return;
    if (!first) {
      topSec.classList.add("hidden");
      return;
    }
    topSec.classList.remove("hidden");
    if (first.image) paintArt(topSec.querySelector("img"), first.image);
    const typeEl = [...topSec.querySelectorAll("span")].find((sp) => /^(song|album|artist|playlist)$/i.test(sp.textContent.trim()));
    if (typeEl) typeEl.textContent = kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : "Song";
    const h3 = topSec.querySelector("h3");
    if (h3) h3.textContent = first.title || "";
    const p = topSec.querySelector("p");
    if (p) p.textContent = [first.artist || first.subtitle, first.year].filter(Boolean).join(" • ") || p.textContent;
    // Anchor on the action buttons, not a class substring: the fragment's
    // inner thumbnail is also "rounded-xl" and matched first, so data-list
    // landed on a sibling of the Play button and the delegation never
    // resolved a row (dead top-result Play/Favorite). `card` must be the
    // container that actually wraps the buttons.
    const card = (() => {
      const btn = topSec.querySelector('button[aria-label="Play Song"], button[aria-label]');
      return (btn && btn.closest("div.rounded-2xl, div[class*='rounded-']")) || topSec.querySelector('div[class*="rounded-xl"]');
    })();
    // A reused fragment can carry the previous query's wiring on the old
    // thumbnail — strip it so only `card` resolves.
    topSec.querySelectorAll("[data-list],[data-idx],[data-nav]").forEach((el) => {
      if (el === card) return;
      delete el.dataset.list;
      delete el.dataset.idx;
      delete el.dataset.nav;
    });
    if (card && kind) {
      delete card.dataset.list;
      delete card.dataset.idx;
      card.dataset.nav = navOf(first, kind);
    } else if (card) {
      delete card.dataset.nav;
      setList("topres", [first]);
      card.dataset.list = "topres";
      card.dataset.idx = "0";
    }
    // The card's Favorite button was static chrome: for songs it becomes a
    // real favorite (the delegation resolves the card's track); entity
    // results have no favorite concept, so it is hidden there.
    const favBtn = topSec.querySelector('[aria-label="Favorite"]');
    if (favBtn) {
      const ic = favBtn.querySelector(".material-symbols-outlined");
      if (kind || !card) {
        favBtn.classList.add("hidden");
        favBtn.removeAttribute("data-fav");
        if (ic) delete ic.dataset.favIcon;
      } else {
        favBtn.classList.remove("hidden");
        favBtn.dataset.fav = "";
        if (ic) ic.dataset.favIcon = first.id || "";
      }
    }
  };

  /// One horizontal shelf of cards, with a "See all" that jumps to its chip.
  const shelf = (title, cat, items) => {
    if (!items || !items.length) return "";
    const cards = items
      .map((e, i) =>
        cat === "artists" ? artistCardHTML(e, i, navOf(e, "artist")) : plCardHTML(e, i, navOf(e, entityKinds[cat])),
      )
      .join("");
    return `<section class="flex flex-col gap-2">
      <div class="flex items-center justify-between px-1">
        <h2 class="font-headline-md text-[15px] font-bold text-on-surface tracking-tight">${esc(title)}</h2>
        <button type="button" data-cat-jump="${cat}" class="font-label-sm text-label-sm text-secondary hover:text-on-surface font-semibold active:scale-95 transition-colors">See all</button>
      </div>
      <div class="flex gap-3 overflow-x-auto no-scrollbar -mx-gutter px-gutter pb-1">${cards}</div>
    </section>`;
  };

  const paintLoading = () => {
    box.className = isEntityCat(curCat) ? "flex flex-col gap-3" : "flex flex-col gap-1";
    box.innerHTML = skeletonHTML(curCat);
  };

  /// Artists / albums / playlists chip: one grid of cards.
  const paintEntityGrid = () => {
    const kind = entityKinds[curCat];
    paintTopResult(results[0], kind);
    box.className = "flex flex-col gap-3";
    if (!results.length) {
      box.innerHTML = statusHTML() + emptyHTML();
      paintFavs();
      return;
    }
    box.innerHTML =
      statusHTML() +
      `<div class="grid grid-cols-2 gap-3">${(kind === "album" ? groupLangAlbums(results) : results)
        .map((e, i) => (kind === "artist" ? artistCardHTML(e, i, navOf(e, "artist")) : plCardHTML(e, i, navOf(e, kind))))
        .join("")}</div>`;
    // The cards are shelf-sized (w-48/w-56), which overflows a half-width cell
    // and overlaps the neighbour — in a grid they must fill the cell instead.
    box.querySelectorAll("[data-pl-idx]").forEach((el) => {
      el.classList.remove("w-48", "w-56");
      el.classList.add("w-full");
    });
    paintFavs();
  };

  /// Songs chip (and Hi-Res): the top match plus a paged table.
  const paintSongs = () => {
    paintTopResult(results[0], "");
    box.className = "flex flex-col gap-1";
    if (!results.length) {
      box.innerHTML = statusHTML() + emptyHTML();
      paintFavs();
      return;
    }
    setList("sres", results);
    box.innerHTML =
      statusHTML() +
      results
        .slice(1)
        .map((t, i) => rowHTML("sres", i + 1, t, highlight(t.title, tokens)))
        .join("");
    paintFavs();
  };

  /// The "All" chip: Spotify's mixed answer — top result, a Songs preview and
  /// one shelf per entity kind. `See all` jumps to the matching chip, which is
  /// where pagination lives.
  const paintMixed = () => {
    const songs = results;
    const cards = { album: shelves.album || [], artist: shelves.artist || [], playlist: shelves.playlist || [] };
    if (topKey !== curQ) {
      topPick = pickTop(parsed.text, { tracks: songs, albums: cards.album, artists: cards.artist, playlists: cards.playlist });
      topKey = curQ;
    }
    const topKind = topPick && topPick.kind !== "song" ? topPick.kind : "";
    paintTopResult(topPick && topPick.item, topKind);
    const topSongId = topPick && topPick.kind === "song" ? String(topPick.item.id || "") : "";
    const rows = songs.filter((t) => String(t.id || "") !== topSongId).slice(0, MIXED_SONGS);
    setList("sres", rows);
    box.className = "flex flex-col gap-4";
    const songsSection = rows.length
      ? `<section class="flex flex-col gap-1">
          <div class="flex items-center justify-between px-1">
            <h2 class="font-headline-md text-[15px] font-bold text-on-surface tracking-tight">Songs</h2>
            <button type="button" data-cat-jump="tracks" class="font-label-sm text-label-sm text-secondary hover:text-on-surface font-semibold active:scale-95 transition-colors">See all</button>
          </div>
          ${rows.map((t, i) => rowHTML("sres", i, t, highlight(t.title, tokens))).join("")}
        </section>`
      : "";
    const shelfHTML = shelf("Albums", "albums", groupLangAlbums(cards.album)) + shelf("Artists", "artists", cards.artist) + shelf("Playlists", "playlists", cards.playlist);
    const body = songsSection + shelfHTML;
    box.innerHTML = statusHTML() + (body || emptyHTML());
    paintFavs();
  };

  const render = () => {
    if (!curQ) {
      paintTopResult(null, "");
      box.className = "flex flex-col gap-1";
      box.innerHTML = "";
      updateMore();
      return;
    }
    if (isEntityCat(curCat)) paintEntityGrid();
    else if (curCat === "all") paintMixed();
    else paintSongs();
    updateMore();
  };

  /// Append a freshly fetched page without rebuilding the rows already on
  /// screen — the whole point of paging is that the existing scroll and
  /// decode work is not thrown away.
  const appendSongRows = (fresh) => {
    if (!fresh.length) return;
    const base = results.length - fresh.length;
    setList("sres", results);
    const status = box.querySelector("[data-sm-status]");
    if (status) status.innerHTML = statusText();
    box.insertAdjacentHTML(
      "beforeend",
      fresh.map((t, i) => rowHTML("sres", base + i, t, highlight(t.title, tokens))).join(""),
    );
    paintFavs();
  };

  const updateMore = () => {
    document.getElementById("sm-more")?.remove();
    smMoreIO?.disconnect();
    smMoreIO = null;
    // The All view is a preview: its "See all" chips own pagination, so the
    // button would be a second, redundant way to grow the same page.
    if (!curQ || !invoke || !pageFull || curCat === "all") return;
    const more = document.createElement("button");
    more.id = "sm-more";
    more.type = "button";
    more.className =
      "self-center mt-3 px-4 py-2 rounded-lg bg-surface-container text-on-surface font-label-md text-label-md hover:bg-surface-container-high transition-colors flex items-center gap-1.5 shadow-sm";
    more.textContent = "Load more results";
    box.insertAdjacentElement("afterend", more);
    // Scrolling near the bottom pulls the next page automatically; the
    // button remains as the manual fallback and as the observer's target.
    smMoreIO = new IntersectionObserver(
      (entries) => {
        for (const en of entries) if (en.isIntersecting && !more.disabled) more.click();
      },
      { rootMargin: "300px 0px" },
    );
    smMoreIO.observe(more);
    more.addEventListener("click", loadMore);
  };

  // ------------------------------------------------------------- suggestions
  const sugBox = document.createElement("div");
  sugBox.id = "m-suggest";
  sugBox.setAttribute("role", "listbox");
  sugBox.className =
    "hidden flex-col rounded-xl bg-surface-container-lowest border border-surface-container shadow-md overflow-y-auto max-h-[55vh]";
  const sugHost = input && (input.closest(".relative") || input.closest("section"));
  if (sugHost && sugHost.parentElement) sugHost.parentElement.insertBefore(sugBox, sugHost.nextElementSibling);

  const hideSug = () => {
    sugBox.classList.add("hidden");
    sugBox.classList.remove("flex");
    sugIndex = -1;
  };
  smSuggestCtx = { box: sugBox, hide: hideSug };
  const showSug = (html) => {
    sugBox.innerHTML = html;
    sugBox.classList.remove("hidden");
    sugBox.classList.add("flex");
    sugIndex = -1;
  };

  const SUG_GROUPS = [
    ["songs", "Songs"],
    ["albums", "Albums"],
    ["artists", "Artists"],
    ["playlists", "Playlists"],
  ];
  const SUG_ICON = { song: "music_note", album: "album", artist: "person", playlist: "queue_music" };
  const sugLabel = (label) =>
    `<div class="px-3 pt-2 pb-1 font-label-mono text-[10px] uppercase tracking-wider text-secondary">${esc(label)}</div>`;
  const sugRow = (it, kind, toks) =>
    `<button type="button" role="option" data-sug-kind="${esc(kind)}" data-sug-id="${esc(it.id || "")}" data-sug-token="${esc(it.token || "")}" data-sug-title="${esc(it.title || "")}" data-sug-sub="${esc(it.subtitle || "")}" data-sug-img="${esc(it.image || "")}" class="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-container focus:bg-surface-container outline-none transition-colors border-b border-surface-container/60 last:border-b-0">
      <div class="w-9 h-9 rounded bg-surface-container-highest overflow-hidden shrink-0 flex items-center justify-center">${
        it.image
          ? `<img alt="" loading="lazy" class="w-full h-full object-cover" ${art(it.image)}>`
          : `<span class="material-symbols-outlined text-[18px] text-on-surface-variant">${SUG_ICON[kind] || "music_note"}</span>`
      }</div>
      <div class="flex flex-col min-w-0 flex-1">
        <span class="font-body-md text-body-md text-on-surface truncate">${highlight(it.title || "", toks)}</span>
        <span class="font-body-sm text-[11px] text-secondary truncate">${esc(it.subtitle || kind)}</span>
      </div>
      <span class="font-label-mono text-[10px] uppercase tracking-wider text-secondary shrink-0">${esc(kind)}</span>
    </button>`;
  const sugQueryRow = (text, toks, icon) =>
    `<button type="button" role="option" data-sug-q="${esc(text)}" class="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-container focus:bg-surface-container outline-none transition-colors border-b border-surface-container/60 last:border-b-0">
      <span class="material-symbols-outlined text-[18px] text-secondary shrink-0">${icon}</span>
      <span class="font-body-md text-body-md text-on-surface truncate flex-1">${highlight(text, toks)}</span>
    </button>`;

  /// The dropdown for one server answer: the listener's own matching recent
  /// searches first (free, and the likeliest intent), then the catalog's
  /// grouped entities. Duplicates across the two are dropped.
  const buildSuggest = (s, text) => {
    const toks = queryTokens(parseSearch(text));
    const needle = String(text || "").toLowerCase();
    const seen = new Set();
    const parts = [];
    const recent = load(HISTORY_KEY, [])
      .filter((x) => {
        const low = String(x).toLowerCase();
        return low !== needle && low.startsWith(needle);
      })
      .slice(0, 3);
    if (recent.length) {
      parts.push(sugLabel("Recent searches"));
      for (const r of recent) {
        seen.add(String(r).toLowerCase());
        parts.push(sugQueryRow(r, toks, "history"));
      }
    }
    const groups = {
      songs: [...((s && s.songs) || [])],
      albums: [...((s && s.albums) || [])],
      artists: [...((s && s.artists) || [])],
      playlists: [...((s && s.playlists) || [])],
    };
    const top = s && s.top;
    if (top) {
      const bucket = groups[`${(s.top_kind || "song")}s`] || groups.songs;
      if (bucket && !bucket.some((it) => it.id === top.id)) bucket.unshift(top);
    }
    for (const [key, label] of SUG_GROUPS) {
      const items = groups[key].filter((it) => {
        const k = String((it && it.title) || "").toLowerCase();
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (!items.length) continue;
      const kind = key.slice(0, -1);
      parts.push(sugLabel(label), items.slice(0, 6).map((it) => sugRow(it, kind, toks)).join(""));
    }
    // Nothing matched anywhere: offer the typed text itself, so tapping and
    // pressing Enter behave the same.
    if (!parts.length) parts.push(sugLabel("Search"), sugQueryRow(text, toks, "search"));
    return parts.join("");
  };

  const recentSuggest = () => {
    const hist = load(HISTORY_KEY, []).slice(0, 6);
    if (!hist.length) {
      hideSug();
      return;
    }
    showSug(sugLabel("Recent searches") + hist.map((s) => sugQueryRow(s, [], "history")).join(""));
  };

  /// One autocomplete call per keystroke burst, memoized per prefix; the
  /// sequence token stops a slow response from painting over a newer query.
  const fetchSuggest = async (text) => {
    const needle = String(text || "").trim().toLowerCase();
    if (needle.length < 2 || !invoke) return;
    const mine = ++sugSeq;
    const cached = SUG_MEM.get(needle);
    if (cached) {
      showSug(buildSuggest(cached, needle));
      return;
    }
    try {
      const s = await invoke("search_suggestions", { query: needle });
      if (mine !== sugSeq) return;
      SUG_MEM.set(needle, s);
      showSug(buildSuggest(s, needle));
    } catch {
      if (mine !== sugSeq) return;
      const stale = SUG_MEM.get(needle);
      if (stale) showSug(buildSuggest(stale, needle));
      else hideSug();
    }
  };

  const sugRows = () => [...sugBox.querySelectorAll("[data-sug-kind],[data-sug-q]")];
  const moveSug = (delta) => {
    const rows = sugRows();
    if (!rows.length) return;
    rows.forEach((r) => r.classList.remove("bg-surface-container"));
    sugIndex = Math.max(0, Math.min(rows.length - 1, sugIndex + delta));
    const row = rows[sugIndex];
    row.classList.add("bg-surface-container");
    row.scrollIntoView({ block: "nearest" });
  };
  const pickSug = () => {
    const rows = sugRows();
    if (sugIndex >= 0 && rows[sugIndex]) {
      rows[sugIndex].click();
      return true;
    }
    return false;
  };

  // --------------------------------------------------------- hash + commit
  const hashFor = (q, cat, sort) =>
    `#/search?q=${encodeURIComponent(q)}${cat !== "all" ? `&cat=${cat}` : ""}${sort !== "relevance" ? `&s=${sort}` : ""}`;
  /// Keep the address bar honest while repainting in place. `replaceState`
  /// (not `go()`) so typing is one history entry, not one per keystroke, and
  /// the router — which listens for `hashchange` — does not remount.
  const syncHash = () => {
    try {
      history.replaceState(history.state, "", hashFor(curQ, curCat, curSort));
    } catch {}
  };
  const commit = (text) => {
    const next = String(text == null ? (input ? input.value : curQ) : text).trim();
    if (!next) return;
    clearTimeout(liveTimer);
    clearTimeout(upgradeTimer);
    hideSug();
    go(hashFor(next, curCat, curSort).slice(2));
  };

  // ------------------------------------------------------------ data loading
  const tasteOpts = () => tasteContext(load(PLAYS_KEY, []), load(FAVS_KEY, []), load(COUNTRY_KEY, "") || "");

  /// One page for the active chip: entity cards for the album/artist/playlist
  /// chips, songs otherwise. Returns null when a newer search superseded it.
  const fetchPage = async (mine, next) => {
    const limit = curCat === "hires" ? 50 : 30;
    const r = isEntityCat(curCat)
      ? await invoke("search_entities", { query: parsed.text, kind: entityKinds[curCat], limit, page: next })
      : await invoke("search_songs", { query: parsed.text, limit, page: next });
    if (mine !== seq) return null;
    let got = isEntityCat(curCat) ? (r && r.items) || [] : (r && r.tracks) || [];
    if (curCat === "hires") got = got.filter((t) => t.hq);
    return { got, pageFull: !!(r && r.page_full) };
  };

  const shapePage = (raw) =>
    isEntityCat(curCat) ? uniqueById(raw) : rankForQuery(uniqueById(raw), parsed, curSort, tasteOpts());

  /// The mixed shelves behind the All chip: one small page per entity kind,
  /// fetched together and cached under the query (not the chip) so switching
  /// to Albums and back never refetches.
  const loadShelves = async (mine) => {
    if (curCat !== "all" || !curQ || !invoke || netMode() === "offline") return;
    const ekey = `ent|${cacheKey(curQ, "all", curSort)}`;
    const mem = SEARCH_MEM.get(ekey);
    if (mem) {
      shelves = mem;
      render();
      return;
    }
    const disk = await diskGet(ekey);
    if (mine !== seq) return;
    if (disk) {
      shelves = disk;
      SEARCH_MEM.set(ekey, disk);
      render();
      return;
    }
    const kinds = ["album", "artist", "playlist"];
    const settled = await Promise.allSettled(
      kinds.map((kind) => invoke("search_entities", { query: parsed.text, kind, limit: 8, page: 1 })),
    );
    if (mine !== seq) return;
    const found = { album: [], artist: [], playlist: [] };
    settled.forEach((res, i) => {
      if (res.status === "fulfilled" && res.value) found[kinds[i]] = uniqueById(res.value.items || []);
    });
    shelves = found;
    SEARCH_MEM.set(ekey, found);
    diskPut(ekey, found);
    render();
  };

  /// Live typing pays for song rows only; the shelf fan-out waits until the
  /// query has been still for a moment.
  const scheduleUpgrade = () => {
    clearTimeout(upgradeTimer);
    const at = curQ;
    upgradeTimer = setTimeout(() => {
      if (curQ === at && curCat === "all") loadShelves(seq);
    }, UPGRADE_MS);
  };

  const applyPayload = (p) => {
    results = Array.isArray(p && p.results) ? p.results : [];
    page = Number(p && p.page) || 1;
    pageFull = !!(p && p.pageFull);
  };

  /// One full search for the current query/chip/sort, cache-first.
  ///
  /// Order: in-process LRU (instant) → localStorage snapshot (instant) →
  /// store.db (one fast IPC) → network. A cached page paints immediately and
  /// is revalidated in the background once it is older than RESULT_FRESH_MS,
  /// so repeat and back-navigation searches feel instant without going stale.
  const runSearch = async ({ full = true, live = false } = {}) => {
    if (!invoke || !curQ.trim()) return;
    parsed = parseSearch(curQ);
    tokens = queryTokens(parsed);
    topKey = "";
    statusNote = "";
    shelves = { album: [], artist: [], playlist: [] };
    const mine = ++seq;
    const key = cacheKeyNow();
    let painted = false;
    const mem = SEARCH_MEM.peek(key);
    if (mem) {
      applyPayload(mem.value);
      render();
      painted = true;
    } else {
      const snap = readSnap(key);
      if (snap) {
        applyPayload(snap);
        render();
        painted = true;
      }
    }
    const fresh = mem && Date.now() - mem.at < RESULT_FRESH_MS;
    if (painted && fresh) {
      if (full && curCat === "all") loadShelves(mine);
      return;
    }
    if (!painted) {
      const disk = await diskGet(key);
      if (mine !== seq) return;
      if (disk) {
        SEARCH_MEM.set(key, disk);
        applyPayload(disk);
        render();
        painted = true;
      }
    }
    // Typing keeps the previous rows on screen until the new page lands — a
    // skeleton flash on every keystroke reads as flicker, not as speed.
    const keepOld = !painted && live && results.length > 0;
    if (!painted && !keepOld) paintLoading();
    try {
      if (netMode() === "offline") throw new Error("offline");
      const got = await fetchPage(mine, 1);
      if (!got || mine !== seq) return;
      page = 1;
      pageFull = got.pageFull;
      results = shapePage(got.got);
      if (!results.length) pageFull = false;
      const payload = { results, page, pageFull };
      SEARCH_MEM.set(key, payload);
      diskPut(key, payload);
      saveSnap(key, payload);
      cacheSongs(results);
      pushHistory(curQ);
      pushDiag("search_page", true, `${results.length} ${isEntityCat(curCat) ? "cards" : "songs"} · ${curCat} · ${curSort}`);
      render();
      if (full && curCat === "all") loadShelves(mine);
      else if (!full && curCat === "all") scheduleUpgrade();
      if (!results.length && !isEntityCat(curCat) && curCat !== "hires") offerTypoFix(curQ);
    } catch (e) {
      if (mine !== seq) return;
      pushDiag("search", false, String(e).split("\n")[0].slice(0, 90));
      if (String(e) === "Error: offline") {
        statusNote = painted ? "offline copy" : "offline";
        if (!painted && !keepOld) results = [];
        render(); // repaint so the status line names the offline copy
        toast("You're offline — showing what's saved when possible", 3500, "info");
        return;
      }
      if (!painted) {
        // A live search that failed mid-typing leaves the last good page up.
        if (!keepOld) results = [];
        render();
        toast(`Search failed: ${String(e).split("\n")[0].slice(0, 70)}`, 5000, "error");
      } else {
        toast(`Couldn't refresh: ${String(e).split("\n")[0].slice(0, 60)}`, 4000, "error");
      }
    }
  };

  /// Pull the next page and append it — no full repaint, so scroll and the
  /// images already decoded survive.
  const loadMore = async () => {
    const more = document.getElementById("sm-more");
    if (!more || more.disabled) return;
    more.disabled = true;
    more.textContent = "Loading…";
    const mine = seq;
    const at = curQ;
    try {
      const next = page + 1;
      const r = await fetchPage(mine, next);
      if (!r || mine !== seq || at !== curQ) return;
      pageFull = r.pageFull;
      const known = new Set(results.map((x) => x && x.id));
      const fresh = uniqueById(r.got.filter((x) => x && (!x.id || !known.has(x.id))));
      if (!fresh.length) pageFull = false;
      page = next;
      results = results.concat(fresh);
      const payload = { results, page, pageFull };
      SEARCH_MEM.set(cacheKeyNow(), payload);
      diskPut(cacheKeyNow(), payload);
      saveSnap(cacheKeyNow(), payload);
      if (isEntityCat(curCat)) paintEntityGrid();
      else appendSongRows(fresh);
      updateMore();
      pushDiag("search_page", true, `+${fresh.length} (page ${page})`);
    } catch (e) {
      more.disabled = false;
      more.textContent = "Load more results";
      if (mine === seq) toast(String(e).split("\n")[0].slice(0, 70), 5000, "error");
    }
  };

  // ------------------------------------------------------------------ input
  /// Search as you type: the hash is kept in sync but nothing remounts, so
  /// results update in place under the keyboard the way Spotify's do.
  const liveSearch = () => {
    const text = (input ? input.value : "").trim();
    if (text === curQ) return;
    curQ = text;
    syncHash();
    clearTimeout(upgradeTimer);
    if (!text) {
      parsed = parseSearch("");
      tokens = [];
      results = [];
      shelves = { album: [], artist: [], playlist: [] };
      topKey = "";
      statusNote = "";
      render();
      return;
    }
    runSearch({ full: false, live: true });
  };

  if (input) {
    input.addEventListener("input", () => {
      clearTimeout(liveTimer);
      clearTimeout(sugTimer);
      const text = input.value.trim();
      liveTimer = setTimeout(liveSearch, LIVE_DEBOUNCE_MS);
      if (!invoke) return;
      if (text.length >= 2) sugTimer = setTimeout(() => fetchSuggest(text), SUG_DEBOUNCE_MS);
      else if (!text) recentSuggest();
      else hideSug();
    });
    input.addEventListener("focus", () => {
      const text = input.value.trim();
      if (!text) recentSuggest();
      else if (text.length >= 2) fetchSuggest(text);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        if (sugBox.classList.contains("hidden")) return;
        e.preventDefault();
        moveSug(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveSug(-1);
        return;
      }
      if (e.key === "Escape") {
        hideSug();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (pickSug()) return;
        commit();
      }
    });
  }

  sugBox.addEventListener("click", (e) => {
    const qb = e.target.closest("[data-sug-q]");
    if (qb) {
      if (input) input.value = qb.dataset.sugQ;
      commit(qb.dataset.sugQ);
      return;
    }
    const b = e.target.closest("[data-sug-kind]");
    if (!b) return;
    const kind = b.dataset.sugKind;
    hideSug();
    if (kind === "song") {
      playList([{ id: b.dataset.sugId, title: b.dataset.sugTitle, artist: b.dataset.sugSub, image: b.dataset.sugImg }], 0);
      go("nowplaying");
    } else {
      go(
        entityNav(kind, {
          id: b.dataset.sugId,
          token: b.dataset.sugToken,
          title: b.dataset.sugTitle,
          subtitle: b.dataset.sugSub,
          image: b.dataset.sugImg,
        }),
      );
    }
  });

  // ------------------------------------------------------------ category chips
  const chips = [...m.querySelectorAll(".filter-chip")];
  const applyChipStates = () => {
    for (const chip of chips) {
      const active = (chip.dataset.category || "all") === curCat;
      chip.classList.toggle("bg-primary", active);
      chip.classList.toggle("text-on-primary", active);
      chip.classList.toggle("shadow-sm", active);
      chip.classList.toggle("bg-surface-container-high", !active);
      chip.classList.toggle("text-on-surface-variant", !active);
    }
  };
  /// Switch chip in place (no remount): cached pages for the new chip paint
  /// instantly, and the query already in the box rides along.
  const switchCat = (cat) => {
    if (cat === curCat) return;
    curCat = cat;
    hideSug();
    clearTimeout(liveTimer);
    clearTimeout(upgradeTimer);
    curQ = (input ? input.value : curQ).trim();
    syncHash();
    applyChipStates();
    refreshSortChip();
    if (!curQ) {
      results = [];
      render();
      return;
    }
    runSearch({ full: true });
  };
  chips.forEach((chip) => {
    if (chip.dataset.sort !== undefined) return;
    const key = chip.dataset.category || "all";
    chip.addEventListener("click", () => switchCat(key));
  });

  // Sort chip: cycles relevance → quality → popular → length → A–Z in place
  // and re-runs the query so the page comes back in the new order.
  const chipsRow = m.querySelector("#filter-chips-container");
  let sortBtn = chipsRow && chipsRow.querySelector("[data-sort]");
  if (chipsRow && !sortBtn) {
    sortBtn = document.createElement("button");
    sortBtn.type = "button";
    sortBtn.dataset.sort = "";
    sortBtn.className = "filter-chip shrink-0 bg-surface-container-low border border-surface-container-high/60 text-on-surface-variant font-label-md font-medium";
    chipsRow.appendChild(sortBtn);
  }
  const refreshSortChip = () => {
    if (!sortBtn) return;
    const on = !isEntityCat(curCat) && curCat !== "hires";
    // Rewrite the classes rather than toggling: the screen's own companion
    // script repaints every .filter-chip on click, and this chip is one of
    // them — without a full reset it would keep that active look.
    const base = "filter-chip shrink-0 bg-surface-container-low border border-surface-container-high/60 text-on-surface-variant font-label-md font-medium";
    sortBtn.className = on ? base : `${base} hidden`;
    sortBtn.textContent = `↕ ${SORT_LABEL[curSort]}`;
    sortBtn.setAttribute("aria-label", `Sort: ${SORT_LABEL[curSort]}`);
  };
  sortBtn?.addEventListener("click", () => {
    searchSort = nextSort(searchSort);
    curSort = searchSort;
    refreshSortChip();
    syncHash();
    if (curQ) runSearch({ full: true });
  });

  // ------------------------------------------------------- recent-query bay
  const bay = document.getElementById("recent-queries-bay");
  const paintBay = () => {
    if (!bay) return;
    const hist = load(HISTORY_KEY, []);
    bay.innerHTML = hist.length
      ? hist
          .map(
            (s, i) => `<div class="recent-pill group flex items-center gap-1.5 bg-surface-container rounded-full pl-3 pr-2 py-1.5 cursor-pointer" data-q="${esc(s)}">
            <span class="font-body-sm text-body-sm text-on-surface truncate max-w-[9.5rem]">${esc(s)}</span>
            <button type="button" data-qdel="${i}" class="text-secondary group-hover:text-on-surface flex items-center" aria-label="Remove"><span class="material-symbols-outlined text-[14px]">close</span></button>
          </div>`,
          )
          .join("")
      : '<span class="font-body-sm text-body-sm text-secondary italic py-1">No recent searches recorded</span>';
  };
  paintBay();
  hooks.repaintBay = paintBay;

  // "Clear all" must clear what the bay repaints from — storage — not just
  // the DOM the generated screen script empties.
  document.getElementById("clear-all-queries")?.addEventListener("click", () => {
    save(HISTORY_KEY, []);
    paintBay();
    hideSug();
  });
  document.getElementById("clear-search-btn")?.addEventListener("click", () => {
    if (input) input.value = "";
    hideSug();
    clearTimeout(liveTimer);
    clearTimeout(upgradeTimer);
    curQ = "";
    syncHash();
    parsed = parseSearch("");
    tokens = [];
    results = [];
    shelves = { album: [], artist: [], playlist: [] };
    topKey = "";
    statusNote = "";
    render();
  });
  // "See all" inside the All view jumps to the chip that owns that shelf.
  box.addEventListener("click", (e) => {
    const jump = e.target.closest("[data-cat-jump]");
    if (!jump) return;
    e.stopPropagation();
    switchCat(jump.dataset.catJump);
  });

  applyChipStates();
  refreshSortChip();
  if (curQ && invoke) runSearch({ full: true });
  else render();
}

// Library screen state, kept across re-mounts (create-playlist re-runs the
// mount, and the shelf must not forget its filter).
// The design's chips are plural ("albums") while the item kinds are singular.
const LIB_CAT = { albums: "album", artists: "artist", podcasts: "podcast" };
const normCat = (c) => LIB_CAT[c] || c || "all";
let libFilter = "all";
let libAlpha = false;
let libGrid = false;
let libMenu = null;

// Downloads screen state, kept across re-mounts (progress ticks repaint via
// hooks.repaintDownload, which re-runs the mount — the filter must survive).
let dlFilter = "all";
let dlSort = "recent";
let dlQuery = "";

/// Items shown in the Library list: the two pins' contents, saved entities and
/// recently played songs, so the shelf is real instead of design mock rows.
function libraryItems(favs, entries) {
  const items = [];
  const firstFav = favs.find((t) => t.image);
  const firstEntry = entries.find((e) => e.image);
  if (favs.length) items.push({ cat: "playlist", title: "Liked Songs", sub: `${favs.length} tracks`, image: firstFav?.image || "", nav: "liked", ts: Date.now() });
  if (entries.length) items.push({ cat: "downloaded", title: "Downloaded", sub: `${entries.length} tracks`, image: firstEntry?.image || "", nav: "download", downloaded: true, ts: Date.now() });
  for (const e of load(LIBRARY_KEY, [])) {
    const kind = e.kind || (e.token ? "album" : "playlist");
    items.push({
      id: e.id,
      cat: kind,
      title: e.title || "",
      sub: e.local ? `${(e.tracks || []).length} songs` : e.subtitle || "Saved",
      image: e.image || "",
      nav: e.local ? null : entityNav(kind, e),
      local: e.local,
      tracks: e.tracks,
      downloaded: !!e.downloaded,
      ts: Number(e.ts) || 0,
    });
  }
  const plays = load(PLAYS_KEY, []).slice(0, 20);
  for (const t of plays) items.push({ cat: "track", title: t.title || "", sub: t.artist || "", image: t.image || "", track: t, ts: Number(t.ts) || 0 });
  return { items, plays };
}

async function mountLibrary() {
  const m = main();
  if (!m) return;
  wireBack(m);
  const cont = document.getElementById("libraryContainer");
  const empty = document.getElementById("libraryEmptyState");
  const favs = load(FAVS_KEY, []);
  let entries = [];
  if (invoke) {
    try {
      entries = (await invoke("list_downloads")).entries || [];
    } catch (e) {
      console.error(e);
    }
  }

  const pins = m.querySelector(".grid.grid-cols-2");
  if (pins) {
    const cards = [...pins.children];
    const info = [
      { count: `${favs.length} tracks`, nav: "liked" },
      { count: `${entries.length} tracks`, nav: "download" },
    ];
    cards.slice(0, 2).forEach((card, i) => {
      const meta = info[i];
      if (!meta) return;
      card.dataset.nav = meta.nav;
      card.classList.add("cursor-pointer");
      const h3 = card.querySelector("h3");
      const countEl = h3 && h3.nextElementSibling;
      if (countEl && countEl.tagName === "SPAN") countEl.textContent = meta.count;
      if (i === 1) {
        const gb = card.querySelector("span.font-label-mono");
        const bytes = entries.reduce((s, e) => s + (Number(e.bytes) || 0), 0);
        if (gb) gb.textContent = fmtBytes(bytes);
      }
    });
  }
  if (!cont) return;

  const { items, plays } = libraryItems(favs, entries);
  setList("recent", plays);
  cont.innerHTML = items
    .map((it, i) => {
      let target = "";
      if (it.track) target = `data-list="recent" data-idx="${plays.indexOf(it.track)}"`;
      else if (it.local) {
        setList(`libpl-${i}`, it.tracks || []);
        target = `data-list="libpl-${i}" data-idx="0"`;
      } else if (it.nav) target = `data-nav="${esc(it.nav)}"`;
      return `<div ${target} class="library-item flex items-center justify-between p-space-xs rounded-xl border border-transparent hover:bg-surface-container-low cursor-pointer transition-colors" data-title="${esc(it.title)}" data-category="${esc(it.cat)}" data-downloaded="${it.downloaded ? "true" : "false"}" data-ts="${it.ts}">
        <div class="flex items-center gap-space-md min-w-0 flex-1">
          <div class="relative w-12 h-12 rounded-lg overflow-hidden bg-surface-container-highest shrink-0"><img alt="" class="w-full h-full object-cover" ${art(it.image)}></div>
          <div class="flex flex-col min-w-0">
            <span class="font-body-md font-medium text-on-surface truncate">${esc(it.title || "")}</span>
            <span class="flex items-center gap-1.5 text-secondary font-label-sm text-label-sm"><span class="material-symbols-outlined text-[14px]">${it.cat === "downloaded" ? "download_done" : it.track ? "music_note" : it.cat === "artist" ? "person" : it.cat === "album" ? "album" : "queue_music"}</span>${esc(it.sub || "")}</span>
          </div>
        </div>
        <div class="flex items-center gap-space-xs flex-shrink-0 ml-space-sm text-secondary">
          <button type="button" data-libmenu="${i}" aria-label="More options" class="w-9 h-9 rounded-full flex items-center justify-center hover:bg-surface-container"><span class="material-symbols-outlined text-[18px]">more_vert</span></button>
          <span class="material-symbols-outlined text-[18px]">chevron_right</span>
        </div>
      </div>`;
    })
    .join("");

  // Followed artists (Spotify parity): artist rows that resolve to the
  // artist screen, mirroring the feed cards' entityNav navigation. They are
  // plain .library-item rows so the filter/sort below treat them like the
  // rest of the shelf.
  {
    const follows = loadFollows();
    if (follows.length && !cont.querySelector("[data-follows-group]")) {
      cont.insertAdjacentHTML(
        "beforeend",
        `<div data-follows-group class="px-space-xs pt-2"><span class="font-label-mono text-[11px] text-secondary uppercase tracking-wider">Followed artists</span></div>` +
          follows
            .map(
              (f, i) => `<div data-follow-idx="${i}" class="library-item flex items-center justify-between p-space-xs rounded-xl border border-transparent hover:bg-surface-container-low cursor-pointer transition-colors" data-title="${esc(f.title || "")}" data-category="artist" data-downloaded="false" data-ts="${Date.now()}">
        <div class="flex items-center gap-space-md min-w-0 flex-1">
          <div class="relative w-12 h-12 rounded-full overflow-hidden bg-surface-container-highest shrink-0"><img alt="" class="w-full h-full object-cover" ${art(f.image)}></div>
          <div class="flex flex-col min-w-0">
            <span class="font-body-md font-medium text-on-surface truncate">${esc(f.title || "")}</span>
            <span class="flex items-center gap-1.5 text-secondary font-label-sm text-label-sm"><span class="material-symbols-outlined text-[14px]">person</span>Followed</span>
          </div>
        </div>
        <div class="flex items-center gap-space-xs flex-shrink-0 ml-space-sm text-secondary">
          <span class="material-symbols-outlined text-[18px]">chevron_right</span>
        </div>
      </div>`,
            )
            .join(""),
      );
    }
  }
  // One listener for the follows rows (guarded: create-playlist re-runs this
  // mount on the same DOM, and the handler must not stack).
  if (!cont.dataset.followsWired) {
    cont.dataset.followsWired = "1";
    cont.addEventListener("click", (e) => {
      const row = e.target.closest("[data-follow-idx]");
      if (!row || e.target.closest("[data-libmenu]")) return;
      e.stopPropagation();
      openFollowArtist(loadFollows()[Number(row.dataset.followIdx)] || null);
    });
  }

  const applyFilter = () => {
    const term = (document.getElementById("filterInput")?.value || "").toLowerCase().trim();
    let visible = 0;
    cont.querySelectorAll(".library-item").forEach((el) => {
      const okCat = libFilter === "all" || el.dataset.category === libFilter || (libFilter === "downloaded" && el.dataset.downloaded === "true");
      const okTerm = !term || (el.dataset.title || "").toLowerCase().includes(term);
      const show = okCat && okTerm;
      el.classList.toggle("hidden", !show);
      if (show) visible += 1;
    });
    empty?.classList.toggle("hidden", visible > 0);
    empty?.classList.toggle("flex", visible === 0);
  };

  const sortLib = () => {
    const rows = [...cont.querySelectorAll(".library-item")];
    rows.sort((a, b) => (libAlpha ? (a.dataset.title || "").localeCompare(b.dataset.title || "") : Number(b.dataset.ts) - Number(a.dataset.ts)));
    rows.forEach((r) => cont.appendChild(r));
  };

  // The generated screen script keeps its handlers inside an IIFE, so the
  // markup's inline onclick attributes can never resolve them. Publish working
  // ones on window, backed by the real item list.
  window.showToast = (msg) => {
    const box = document.getElementById("toastNotification");
    const text = document.getElementById("toastMessage");
    if (text) text.textContent = String(msg);
    if (!box) return toast(msg);
    box.classList.remove("opacity-0", "-translate-y-4");
    box.classList.add("opacity-100", "translate-y-0");
    clearTimeout(box._t);
    box._t = setTimeout(() => {
      box.classList.remove("opacity-100", "translate-y-0");
      box.classList.add("opacity-0", "-translate-y-4");
    }, 2200);
  };
  window.setActiveFilter = (btn, cat) => {
    libFilter = normCat(cat);
    m.querySelectorAll(".filter-chip").forEach((c) => {
      c.classList.remove("bg-primary", "text-on-primary");
      c.classList.add("bg-surface-container", "text-on-surface-variant");
    });
    btn.classList.add("bg-primary", "text-on-primary");
    btn.classList.remove("bg-surface-container", "text-on-surface-variant");
    applyFilter();
  };
  window.toggleLibrarySearch = () => {
    const bar = document.getElementById("librarySearchBar");
    if (!bar) return;
    const nowHidden = bar.classList.toggle("hidden");
    const inp = document.getElementById("filterInput");
    if (!nowHidden) inp?.focus();
    else {
      if (inp) inp.value = "";
      applyFilter();
    }
  };
  window.clearLibrarySearch = () => {
    const inp = document.getElementById("filterInput");
    if (inp) inp.value = "";
    applyFilter();
    document.getElementById("librarySearchBar")?.classList.add("hidden");
  };
  window.toggleSortMode = window.cycleSort = () => {
    libAlpha = !libAlpha;
    const label = document.getElementById("currentSortLabel");
    if (label) label.textContent = libAlpha ? "Alphabetical" : "Recently played";
    sortLib();
    window.showToast(`Sorted by ${libAlpha ? "Alphabetical" : "Recently played"}`);
  };
  window.setViewMode = (mode) => {
    libGrid = mode === "grid";
    cont.className = libGrid ? "grid grid-cols-2 gap-space-sm transition-all duration-200" : "flex flex-col gap-space-xs transition-all duration-200";
    const g = document.getElementById("viewGridBtn");
    const l = document.getElementById("viewListBtn");
    g?.classList.toggle("text-primary", libGrid);
    g?.classList.toggle("bg-surface-container", libGrid);
    l?.classList.toggle("text-primary", !libGrid);
    l?.classList.toggle("bg-surface-container", !libGrid);
  };
  // The Library kebab shares the one options sheet in menus.js. These window
  // names stay because the fragment's static rows call them from inline
  // onclick attributes; they resolve the item first, then hand off.
  window.openItemMenu = (e, title) => {
    e?.stopPropagation?.();
    if (title) libMenu = items.find((x) => x.title === title) || libMenu;
    window.__tmLibraryMenu?.(libMenu);
  };
  window.closeItemMenu = () => {};
  window.handleMenuAction = () => window.__tmLibraryMenu?.(libMenu);
  window.promptCreatePlaylist = () => {
    // Native prompt() never opens in the Android WebView — use the shared
    // bottom-sheet input (menus.js). Fall back to prompt only on desktop web.
    if (window.__tmCreatePlaylist) return window.__tmCreatePlaylist([], "");
    const name = prompt("Playlist name:", "");
    if (name == null) return;
    const clean = name.trim();
    if (!clean) return toast("Give the playlist a name", 4000, "error");
    const saved = load(LIBRARY_KEY, []);
    if (saved.some((x) => x.local && String(x.title).toLowerCase() === clean.toLowerCase())) {
      return toast("You already have a playlist with that name", 4000, "error");
    }
    saved.unshift({ id: `local-${Date.now()}`, local: true, kind: "playlist", title: clean, subtitle: "0 songs", tracks: [], image: "", ts: Date.now() });
    save(LIBRARY_KEY, saved);
    window.showToast(`Created "${clean}"`);
    mountLibrary();
  };

  cont.addEventListener("click", (e) => {
    const b = e.target.closest("[data-libmenu]");
    if (!b) return;
    e.stopPropagation();
    libMenu = items[Number(b.dataset.libmenu)] || null;
    window.openItemMenu(e, libMenu?.title || "");
  });
  document.getElementById("filterInput")?.addEventListener("input", applyFilter);
  // The fragment's inline oninput calls filterLibraryList on window, but the
  // generated screen script keeps its own copy inside an IIFE — publish a
  // window shim so the handler resolves instead of throwing per keystroke.
  window.filterLibraryList = () => applyFilter();

  // Restore the active chip and view for this mount. Podcasts have no source
  // in this catalog, so that chip would only ever show an empty shelf.
  const chips = [...m.querySelectorAll(".filter-chip")];
  chips.forEach((chip) => {
    const cat = normCat((chip.getAttribute("onclick") || "").match(/setActiveFilter\(this,\s*'([^']*)'\)/)?.[1]);
    if (cat === "podcast") return chip.remove();
    // The design labels the catch-all chip "Playlists", which is not what it
    // filters. Every row kind the shelf can hold gets a chip of its own.
    if (cat === "all") chip.querySelector("span")?.replaceChildren("All");
    chip.dataset.libCat = cat;
    const on = cat === libFilter;
    chip.classList.toggle("bg-primary", on);
    chip.classList.toggle("text-on-primary", on);
    chip.classList.toggle("bg-surface-container", !on);
    chip.classList.toggle("text-on-surface-variant", !on);
  });
  const seed = chips.find((c) => c.dataset.libCat === "downloaded");
  if (seed && !m.querySelector('[data-lib-cat="track"]')) {
    const songs = seed.cloneNode(true);
    songs.dataset.libCat = "track";
    songs.setAttribute("data-lib-cat", "track");
    songs.removeAttribute("onclick");
    songs.querySelector("span.material-symbols-outlined")?.replaceChildren("music_note");
    [...songs.querySelectorAll("span")].pop()?.replaceChildren("Songs");
    songs.classList.remove("bg-primary", "text-on-primary");
    songs.classList.add("bg-surface-container", "text-on-surface-variant");
    songs.addEventListener("click", () => window.setActiveFilter(songs, "track"));
    seed.insertAdjacentElement("afterend", songs);
  }
  window.setViewMode(libGrid ? "grid" : "list");
  applyFilter();
  paintFavs();
}

/// A followed artist back to its screen: direct entityNav when the record
/// carries a token, otherwise resolve by name exactly like app.js
/// resolveEntity does, falling back to the artist search.
async function openFollowArtist(f) {
  if (!f) return;
  if (f.token) return go(entityNav("artist", { token: f.token, title: f.title, image: f.image }));
  const name = String(f.title || "").split(",")[0].trim();
  if (invoke && name) {
    try {
      const r = await invoke("search_entities", { query: name, kind: "artist", limit: 8, page: 1 });
      const hit = (r && r.items && r.items[0]) || null;
      if (hit && (hit.token || hit.id)) return go(entityNav("artist", hit));
    } catch (e) {
      console.error(e);
    }
  }
  if (f.id) return go(entityNav("artist", { id: f.id, title: f.title, image: f.image }));
  if (name) go(`search?q=${encodeURIComponent(name)}&cat=artists`);
}

async function openLib(item) {
  if (!item || !invoke) return;
  if (item.local) return go(entityNav("playlist", item));
  if (item.token) return go(entityNav("album", item));
  try {
    const r = await invoke("playlist_tracks", { id: item.id });
    if (r) return go(entityNav("playlist", item));
  } catch {}
  try {
    await invoke("resolve_song", { id: item.id });
    playList([{ id: item.id, title: item.title || "", artist: item.subtitle || "", image: item.image || "" }], 0);
  } catch (e) {
    console.error(e);
    toast(`Can't open ${item.title || "item"}`, 5000, "error");
  }
}

function mountLiked() {
  const m = main();
  if (!m) return;
  wireBack(m);
  const favs = load(FAVS_KEY, []);
  setList("favs", favs);
  const h2 = m.querySelector("h2");
  const meta = h2 && h2.nextElementSibling;
  if (meta) {
    const total = favs.reduce((s, t) => s + (Number(t.duration_secs) || 0), 0);
    meta.innerHTML = `<span class="font-body-sm text-[13px] text-secondary">${favs.length} songs</span><span class="text-secondary">•</span><span class="font-label-mono text-label-sm text-secondary">${fmtDur(total) || "0m"}</span>`;
  }
  const firstRow = m.querySelector('div[class*="py-2 px-space-sm"]');
  const listBox = firstRow && firstRow.parentElement;
  const empty = m.querySelector("div.opacity-70");
  if (listBox) {
    if (favs.length) {
      listBox.innerHTML = favs.map((t, i) => rowHTML("favs", i, t)).join("");
      listBox.classList.remove("hidden");
      empty?.classList.add("hidden");
    } else {
      listBox.innerHTML = "";
      listBox.classList.add("hidden");
      empty?.classList.remove("hidden");
    }
  }
  const pb = firstButtonWith(m, "play_arrow");
  if (pb) {
    pb.dataset.list = "favs";
    pb.dataset.idx = "0";
    pb.classList.toggle("opacity-40", !favs.length);
  }
  const dl = document.getElementById("dl-toggle");
  if (dl && !dl.dataset.dlWired) {
    dl.dataset.dlWired = "1";
    const fresh = dl.cloneNode(true);
    dl.replaceWith(fresh);
    fresh.addEventListener("click", () => downloadAll(favs, "liked tracks", fresh));
  }
  wireRowFilter(document.getElementById("liked-filter"), listBox, '[data-list="favs"]');
  paintFavs();
}

async function mountDownload() {
  const m = main();
  if (!m) return;
  wireBack(m);
  const pauseBtn = document.getElementById("pauseAllBtn");
  const activeBlock = pauseBtn && pauseBtn.closest("div.w-full");
  let entries = [];
  if (invoke) {
    try {
      entries = (await invoke("list_downloads")).entries || [];
    } catch (e) {
      console.error(e);
      toast(`Couldn't load downloads: ${String(e).split("\n")[0].slice(0, 60)}`, 5000, "error");
    }
  }
  const active = getActiveDownloads();

  // ---- In-Transit: live progress rows with cancel (was always hidden) ----
  if (activeBlock) {
    if (!active.length) {
      activeBlock.classList.add("hidden");
      // Drop the rows, not just the block: a cancel leaves its row node
      // behind otherwise, and row counters (plus the next paint) see ghosts.
      const stale = activeBlock.querySelector("[data-dl-active-list]");
      if (stale) stale.innerHTML = "";
    } else {
      activeBlock.classList.remove("hidden");
      const countPill = activeBlock.querySelector("span.bg-primary");
      if (countPill) countPill.textContent = String(active.length);
      let list = activeBlock.querySelector("[data-dl-active-list]");
      if (!list) {
        list = document.createElement("div");
        list.dataset.dlActiveList = "";
        list.className = "flex flex-col gap-2";
        activeBlock.appendChild(list);
      }
      list.innerHTML = active
        .map((p) => {
          const pct = p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : 0;
          const mb = `${(Number(p.received) / 1048576).toFixed(1)} / ${p.total ? `${(Number(p.total) / 1048576).toFixed(1)} MB` : "? MB"}`;
          return `<div class="p-3 rounded-xl bg-surface-container-lowest border border-surface-container-high/60 shadow-sm flex flex-col gap-2">
            <div class="flex items-center gap-3 min-w-0">
              <div class="w-11 h-11 rounded-lg bg-surface-container-highest overflow-hidden shrink-0"><img alt="" class="w-full h-full object-cover" ${art(p.image)}></div>
              <div class="flex flex-col min-w-0 flex-1">
                <span class="font-body-md text-[13px] font-semibold text-on-surface truncate">${esc(p.title || "")}</span>
                <span class="font-label-mono text-[10px] text-secondary truncate">${esc([p.artist, p.quality].filter(Boolean).join(" · "))} · ${esc(mb)}</span>
              </div>
              <span class="font-label-mono text-[11px] text-on-surface font-semibold shrink-0">${pct}%</span>
              <button type="button" data-dl-cancel="${esc(p.id)}" aria-label="Cancel download" class="w-9 h-9 rounded-full flex items-center justify-center text-secondary hover:text-error active:scale-90 transition-all shrink-0"><span class="material-symbols-outlined text-[19px]">close</span></button>
            </div>
            <div class="w-full h-1.5 bg-surface-container-high rounded-full overflow-hidden"><div class="h-full bg-primary rounded-full transition-all duration-200" style="width:${pct}%"></div></div>
          </div>`;
        })
        .join("");
      // Pause wiring + label live below the block (they must also run with
      // zero active rows — see below).
      if (!activeBlock.dataset.cancelWired) {
        activeBlock.dataset.cancelWired = "1";
        activeBlock.addEventListener("click", (e) => {
          const btn = e.target.closest("[data-dl-cancel]");
          if (!btn) return;
          e.stopPropagation();
          cancelDownload(btn.dataset.dlCancel);
        });
      }
    }
  }
  // The pause control must mirror batchPausedNow() even with zero active
  // rows: pausing as the last file drains left a stale "Pause All" label and
  // hid the paused state from the next mount.
  if (pauseBtn) {
    if (!pauseBtn.dataset.dlWired) {
      pauseBtn.dataset.dlWired = "1";
      pauseBtn.addEventListener("click", () => {
        const pausing = !batchPausedNow();
        setBatchPaused(pausing);
        toast(pausing ? "Batch paused — current file finishes, rest stop" : "Batch resumed", 3000, "info");
        mountDownload();
      });
    }
    const label = pauseBtn.querySelector("span:last-child");
    if (label) label.textContent = batchPausedNow() ? "Resume All" : "Pause All";
    const icon = pauseBtn.querySelector(".material-symbols-outlined");
    if (icon) icon.textContent = batchPausedNow() ? "play_circle" : "pause_circle";
  }

  // ---- Toolbar: storage summary + wifi-only + search (injected once) ----
  const topStrip = m.querySelector("div.flex.items-center.justify-between.pt-1");
  if (topStrip && !topStrip.dataset.dlToolsWired) {
    topStrip.dataset.dlToolsWired = "1";
  }
  let tools = m.querySelector("[data-dl-tools]");
  if (!tools && topStrip) {
    tools = document.createElement("div");
    tools.dataset.dlTools = "";
    tools.className = "w-full flex flex-col gap-2 pt-1";
    topStrip.insertAdjacentElement("afterend", tools);
  }
  const paintDlListRef = { fn: null };
  if (tools) {
    const bytes = entries.reduce((s, e) => s + (Number(e.bytes) || 0), 0);
    const mb = bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(2)} GB` : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(0, Math.round(bytes / 1024))} KB`;
    const on = wifiOnly();
    // Progress ticks re-run this mount many times per second — rebuilding the
    // search input would steal focus mid-typing, so build once and patch.
    if (!tools.querySelector("[data-dl-search]")) {
      tools.innerHTML = `
      <div class="flex items-center justify-between gap-2 px-1">
        <span data-dl-count class="font-label-mono text-[11px] text-secondary">${entries.length} track${entries.length === 1 ? "" : "s"} · ${mb} vaulted</span>
        <button type="button" data-dl-wifi role="switch" aria-checked="${on}" class="flex items-center gap-1.5 font-label-mono text-[11px] ${on ? "text-primary" : "text-secondary"} hover:text-on-surface transition-colors">
          <span class="material-symbols-outlined text-[15px]">${on ? "wifi" : "wifi_off"}</span><span>${on ? "Wi-Fi only ON" : "Wi-Fi only OFF"}</span>
        </button>
        <button type="button" data-dl-verify class="flex items-center gap-1.5 font-label-mono text-[11px] text-secondary hover:text-on-surface transition-colors" title="Re-hash every saved file against the vault ledger">
          <span class="material-symbols-outlined text-[15px]">verified_user</span><span>Verify</span>
        </button>
      </div>
      <div class="relative w-full flex items-center bg-surface-container-lowest border border-surface-container-high/80 rounded-2xl px-3.5 py-1 shadow-sm">
        <span class="material-symbols-outlined text-secondary text-[19px] mr-2">search</span>
        <input data-dl-search class="w-full h-9 bg-transparent text-on-surface font-body-md text-body-md placeholder-secondary focus:outline-none" placeholder="Search downloads…" value="${esc(dlQuery)}" type="text" />
      </div>`;
      tools.querySelector("[data-dl-wifi]")?.addEventListener("click", () => {
        const next = !wifiOnly();
        setWifiOnly(next);
        toast(next ? "Wi-Fi only on — downloads pause on cellular" : "Wi-Fi only off", 3000, "info");
        mountDownload();
      });
      tools.querySelector("[data-dl-search]")?.addEventListener("input", (e) => {
        dlQuery = String(e.target.value || "").toLowerCase().trim();
        try {
          paintDlListRef.fn?.();
        } catch {}
      });
      // Verify: re-hash every saved file on a worker thread (the command is
      // report-only — nothing is deleted), then say what did not match.
      tools.querySelector("[data-dl-verify]")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const label = btn.querySelector("span:last-child");
        const was = label?.textContent;
        if (label) label.textContent = "Checking…";
        try {
          const r = await invoke("verify_vault");
          const bad = Number(r?.mismatch || 0) + Number(r?.missing || 0);
          pushDiag("verify_vault", !bad, `${r.ok} ok · ${r.mismatch} mismatch · ${r.missing} missing`);
          if (!bad) toast(`Vault verified — ${r.ok} file${r.ok === 1 ? "" : "s"} intact`, 3500, "success");
          else toast(`Vault problems: ${r.mismatch} changed, ${r.missing} missing`, 5000, "error");
        } catch (err) {
          pushDiag("verify_vault", false, String(err));
          toast(`Verify failed: ${String(err).split("\n")[0].slice(0, 70)}`, 5000, "error");
        } finally {
          btn.disabled = false;
          if (label) label.textContent = was || "Verify";
        }
      });
    } else {
      const count = tools.querySelector("[data-dl-count]");
      if (count) count.textContent = `${entries.length} track${entries.length === 1 ? "" : "s"} · ${mb} vaulted`;
      const wifiBtn = tools.querySelector("[data-dl-wifi]");
      if (wifiBtn) {
        wifiBtn.setAttribute("aria-checked", String(on));
        wifiBtn.className = `flex items-center gap-1.5 font-label-mono text-[11px] ${on ? "text-primary" : "text-secondary"} hover:text-on-surface transition-colors`;
        const ic = wifiBtn.querySelector(".material-symbols-outlined");
        if (ic) ic.textContent = on ? "wifi" : "wifi_off";
        const lbl = wifiBtn.querySelector("span:last-child");
        if (lbl) lbl.textContent = on ? "Wi-Fi only ON" : "Wi-Fi only OFF";
      }
      const input = tools.querySelector("[data-dl-search]");
      if (input && document.activeElement !== input && input.value !== dlQuery) input.value = dlQuery;
    }
  }

  const box = [...m.querySelectorAll("div")].find((d) => d.className.includes("rounded-xl") && d.className.includes("p-space-xs"));
  const paintDlList = () => {
    if (!box) return;
    const q = dlQuery;
    const kbps = (s) => Number(String(s || "").replace(/\D/g, "")) || 0;
    let shown = entries.filter((e) => {
      if (dlFilter === "hq" && kbps(e.quality) < 320) return false;
      if (dlFilter === "std" && kbps(e.quality) >= 320) return false;
      if (q && ![e.title, e.artist, e.album].join(" ").toLowerCase().includes(q)) return false;
      return true;
    });
    if (dlSort === "name") shown = [...shown].sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));
    else if (dlSort === "size") shown = [...shown].sort((a, b) => Number(b.bytes || 0) - Number(a.bytes || 0));
    else shown = [...shown].sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
    setList("dls", shown);
    box.innerHTML = shown.length
      ? shown
          .map(
            (e, i) => `<div data-list="dls" data-idx="${i}" class="flex items-center justify-between p-space-sm rounded-lg hover:bg-surface-container-low cursor-pointer transition-colors">
          <div class="flex items-center gap-space-sm min-w-0 flex-1">
            <div class="relative w-12 h-12 rounded bg-surface-container flex-shrink-0 overflow-hidden"><img alt="" class="w-full h-full object-cover" ${art(e.image)}></div>
            <div class="flex flex-col min-w-0">
              <span class="font-body-md font-medium text-on-surface truncate">${esc(e.title || "")}</span>
              <span class="flex items-center gap-space-xs mt-0.5 font-label-mono text-label-sm text-secondary truncate">${esc(e.artist || "")} · ${esc(e.quality || "")} · ${((Number(e.bytes) || 0) / 1048576).toFixed(1)} MB</span>
            </div>
          </div>
          <div class="flex items-center gap-1 flex-shrink-0">
            <button type="button" data-rm="${esc(e.path)}" class="w-10 h-10 flex items-center justify-center text-secondary hover:text-on-surface transition-colors" aria-label="Remove"><span class="material-symbols-outlined text-[18px]">delete</span></button>
            <button type="button" aria-label="More options" class="w-10 h-10 flex items-center justify-center text-secondary hover:text-on-surface transition-colors"><span class="material-symbols-outlined text-[18px]">more_vert</span></button>
            <button type="button" class="w-10 h-10 flex items-center justify-center rounded-full text-on-surface" aria-hidden="true"><span class="material-symbols-outlined text-[20px]">play_arrow</span></button>
          </div>
        </div>`,
          )
          .join("")
      : `<div class="py-space-md text-center font-body-sm text-secondary">${entries.length ? "No downloads match this filter." : "No downloads yet"}</div>`;
  };
  // Exposed for the search input above (same tick, no remount).
  paintDlListRef.fn = paintDlList;
  m._paintDlList = paintDlList;
  paintDlList();

  // ---- Filter pills: All / HQ / Standard (design said Albums/Playlists, but
  // vault rows carry no source — quality is the honest split) ----
  const pills = [...m.querySelectorAll(".filter-pill")];
  if (pills.length && !m.dataset.dlPillsWired) {
    m.dataset.dlPillsWired = "1";
    const defs = [
      ["all", "All"],
      ["hq", "HQ 320"],
      ["std", "Standard"],
    ];
    pills.forEach((pill, idx) => {
      const [key, label] = defs[idx] || ["all", "All"];
      pill.dataset.dlFilter = key;
      pill.textContent = label.trim();
      pill.addEventListener("click", () => {
        dlFilter = key;
        pills.forEach((p) => {
          const activePill = p === pill;
          p.classList.toggle("bg-primary", activePill);
          p.classList.toggle("text-on-primary", activePill);
          p.classList.toggle("bg-surface-container-low", !activePill);
          p.classList.toggle("text-secondary", !activePill);
        });
        paintDlList();
      });
    });
    // Restore active pill across remounts (progress ticks remount).
    pills.forEach((p) => {
      const activePill = p.dataset.dlFilter === dlFilter;
      p.classList.toggle("bg-primary", activePill);
      p.classList.toggle("text-on-primary", activePill);
      p.classList.toggle("bg-surface-container-low", !activePill);
      p.classList.toggle("text-secondary", !activePill);
    });
  } else if (pills.length) {
    pills.forEach((p) => {
      const activePill = p.dataset.dlFilter === dlFilter;
      p.classList.toggle("bg-primary", activePill);
      p.classList.toggle("text-on-primary", activePill);
    });
  }

  // ---- Sort toggle: Recent → Name → Size ----
  const sortBtn = [...m.querySelectorAll("button")].find((b) => b.textContent.includes("RECENT") || b.textContent.includes("SORT"));
  if (sortBtn && !sortBtn.dataset.dlWired) {
    sortBtn.dataset.dlWired = "1";
    sortBtn.addEventListener("click", () => {
      dlSort = dlSort === "recent" ? "name" : dlSort === "name" ? "size" : "recent";
      const label = sortBtn.querySelector("span");
      if (label) label.textContent = dlSort === "recent" ? "RECENT" : dlSort === "name" ? "NAME" : "SIZE";
      paintDlList();
      toast(`Sorted by ${dlSort}`, 2500);
    });
  }
  if (sortBtn) {
    const label = sortBtn.querySelector("span");
    if (label) label.textContent = dlSort === "recent" ? "RECENT" : dlSort === "name" ? "NAME" : "SIZE";
  }

  // The header's refresh icon only spun itself; re-run the mount so the vault
  // list is actually re-read. Storage opens the real settings screen.
  const sync = document.getElementById("refreshSyncBtn");
  if (sync && !sync.dataset.vaultWired) {
    sync.dataset.vaultWired = "1";
    sync.addEventListener("click", () => mountDownload());
  }
  const storage = m.querySelector('button[aria-label="Storage Settings"]');
  if (storage && !storage.dataset.vaultWired) {
    storage.dataset.vaultWired = "1";
    storage.addEventListener("click", () => go("settings"));
  }
}

function mountHistory() {
  const m = main();
  if (!m) return;
  wireBack(m);
  const root = m.querySelector(":scope > div");
  if (!root) return;
  const header = root.firstElementChild;
  [...root.children].forEach((c, i) => {
    if (i > 0) c.remove();
  });
  const plays = load(PLAYS_KEY, []);
  const clearBtn =
    document.getElementById("clear-history-trigger") ||
    [...(header ? header.querySelectorAll("button") : [])].find((b) => /clear/i.test(b.getAttribute("aria-label") || "") || /clear/i.test(b.textContent));
  if (clearBtn && !clearBtn.dataset.histWired) {
    clearBtn.dataset.histWired = "1";
    clearBtn.addEventListener("click", () => {
      save(PLAYS_KEY, []);
      mountHistory();
    });
  }
  if (!plays.length) {
    root.insertAdjacentHTML(
      "beforeend",
      '<div class="py-space-xl flex flex-col items-center justify-center gap-2 opacity-70"><span class="material-symbols-outlined text-[32px]">history</span><span class="font-body-sm text-secondary">Nothing played yet</span></div>',
    );
    return;
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yest = new Date(today.getTime() - 86400000);
  const groups = {};
  const order = [];
  for (const t of plays) {
    const d = t.ts ? new Date(t.ts) : new Date();
    const label = d >= today ? "TODAY" : d >= yest ? "YESTERDAY" : "EARLIER";
    if (!groups[label]) {
      groups[label] = [];
      order.push(label);
    }
    groups[label].push(t);
  }
  for (const label of order) {
    const list = groups[label];
    const name = `hist-${label}`;
    setList(name, list);
    root.insertAdjacentHTML(
      "beforeend",
      `<div class="flex flex-col gap-space-xs">
        <div class="flex items-center justify-between px-space-xs py-1">
          <span class="font-label-mono text-[11px] text-secondary uppercase tracking-wider">${label}</span>
          <span class="font-label-mono text-[10px] text-secondary">${list.length}</span>
        </div>
        <div class="flex flex-col bg-surface-container-lowest rounded-xl overflow-hidden shadow-sm divide-y divide-surface-container">${list.map((t, i) => rowHTML(name, i, t)).join("")}</div>
      </div>`,
    );
  }
  paintFavs();
}

/// The section whose rows are the track list: the one owning the per-track
/// option buttons. The old "last section" guess landed on the liner-notes
/// block, which is why playlists kept showing design placeholder rows.
function trackSection(m) {
  const btn = m.querySelector('[aria-label^="Track "]');
  if (btn) return btn.closest("section");
  return sectionFor("Tracklist") || [...m.querySelectorAll("section")].pop() || null;
}

/// Wire the primary play control. The design labels it "Pause"/"Play Top
/// Track" while showing a play glyph, so match by icon or label.
function wirePlayAll(m, tracks) {
  const pb =
    firstButtonWith(m, "play_arrow") ||
    m.querySelector('button[aria-label="Pause"], button[aria-label="Play"], button[aria-label="Play Top Track"]');
  if (pb) {
    pb.dataset.list = "detail";
    pb.dataset.idx = "0";
    pb.classList.toggle("opacity-40", !tracks.length);
  }
  return pb;
}

function trackMeta(tracks) {
  const n = tracks.length;
  const lead = tracks[0] || {};
  const total = tracks.reduce((s, t) => s + (Number(t.duration_secs) || 0), 0);
  return {
    n,
    lead,
    total,
    mins: total ? Math.max(1, Math.round(total / 60)) : 0,
    allHq: n > 0 && tracks.every((t) => t.hq),
    artist: lead.artist || "",
    label: lead.label || lead.album || "",
    year: lead.year || "",
    image: lead.image || "",
  };
}

/// Paint a playlist / album detail screen from its loaded tracks plus the card
/// metadata carried in the URL.
function paintDetail(m, kind, tracks, meta, opts) {
  const info = meta || {};
  const t = trackMeta(tracks);
  const title = info.title || t.lead.album || (kind === "playlist" ? "Playlist" : "Album");
  const artist = info.subtitle || t.artist;
  const image = info.image || t.image;
  const year = info.year || t.year;

  const cover = m.querySelector("section img") || m.querySelector("main img");
  if (cover && image) paintArt(cover, image);

  if (kind === "playlist") {
    const h1 = m.querySelector("h1.font-headline-xl, h1");
    if (h1) h1.textContent = title;
    // Artist credit sits in the anchor under the title — swap avatar + name.
    const link = h1 && h1.parentElement && h1.parentElement.querySelector("a");
    if (link) {
      if (image) paintArt(link.querySelector("img"), image);
      const nameEl = [...link.querySelectorAll("span")].find((s) => s.textContent.trim() && !s.classList.contains("material-symbols-outlined"));
      if (nameEl && artist) nameEl.textContent = artist;
    }
    paintOrHide(m, /^[A-Z]{3}\s\d{4}$/, year);
    paintOrHide(m, /^\d+\sTRACKS$/i, t.n ? `${t.n} TRACKS` : "");
    paintOrHide(m, /^\d+\sMIN$/i, t.mins ? `${t.mins} MIN` : "");
    paintOrHide(m, /^HYPERION SOUND$/, t.label);
    // Liner notes are editorial mock copy with no upstream equivalent.
    const liner = findByText(m, /^Studio Liner Notes$/);
    if (liner) liner.closest("section")?.classList.add("hidden");
  } else {
    const h2 = m.querySelector("h2");
    if (h2) h2.textContent = title;
    paintOrHide(m, /^By .+•\s*\d+ tracks/i, `By ${artist || "You"} • ${t.n} tracks${t.mins ? ` • ${fmtDur(t.total)}` : ""}`);
    paintOrHide(m, /^\d+\sTRACKS$/i, t.n ? `${t.n} TRACKS` : "");
    const pill = findByText(m, /^Private$/i);
    if (pill) {
      const tag = [year, t.lead.year, t.lead.language, t.lead.label].find(Boolean);
      if (tag) pill.textContent = tag;
      else {
        const sep = pill.parentElement && [...pill.parentElement.querySelectorAll("span")].find((s) => /^[•·|]$/.test(s.textContent.trim()));
        if (sep) sep.remove();
        pill.remove();
      }
    }
    // The blurb has no upstream equivalent — drop it rather than lie.
    findByText(m, /^Deep atmospheric synths/)?.remove();
  }

  fillRows(trackSection(m), tracks, "detail");
  if (!((opts || {}).skipMore)) void paintMoreBy(m, tracks, t.lead.album_id, title);
  // "Tracklist  12" badge
  const tl = findByText(m, /^Tracklist$/i);
  if (tl && tl.parentElement) {
    const badge = [...tl.parentElement.querySelectorAll("span")].find((s) => /^\d+$/.test(s.textContent.trim()));
    if (badge) badge.textContent = String(t.n);
  }
  wirePlayAll(m, tracks);
  wireShuffleHeader(m);
  wireShareHeader(m, () => shareThing({ title, text: artist }));
  paintFavs();
}

/// Language chips above a multi-language track list (album detail merges
/// every variant album; playlists natively span languages). Reuses the
/// row-paint path so counts, play-all and downloads follow the pick;
/// "More by" loads once (skipMore) instead of refetching per tap.
let detailFullTracks = [];
let detailLangSel = "";
const langDisplay = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
function paintDetailLang(m, kind, tracks, meta, first = true) {
  if (first) {
    detailFullTracks = tracks || [];
    detailLangSel = "";
  }
  const counts = {};
  for (const t of detailFullTracks) for (const l of trackLangs(t)) counts[l] = (counts[l] || 0) + 1;
  const buckets = Object.keys(counts).sort();
  const sec = trackSection(m);
  let chips = m.querySelector("#detail-langchips");
  const list = !detailLangSel
    ? detailFullTracks
    : detailFullTracks.filter((t) => trackLangs(t).includes(detailLangSel));
  if (buckets.length < 2) {
    chips?.remove();
  } else {
    if (!chips) {
      chips = document.createElement("div");
      chips.id = "detail-langchips";
      sec?.parentElement?.insertBefore(chips, sec);
    }
    chips.className = "flex items-center gap-2 flex-wrap px-1 pb-2";
    const btn = (v, label) =>
      `<button type="button" data-dlang="${esc(v)}" class="px-3 py-1 rounded-full font-label-sm text-label-sm transition-colors ${v === detailLangSel ? "bg-primary text-on-primary font-semibold" : "bg-surface-container-low text-secondary border border-surface-container-high/60"}">${esc(label)}</button>`;
    chips.innerHTML =
      btn("", `All (${detailFullTracks.length})`) + buckets.map((l) => btn(l, `${langDisplay(l)} (${counts[l]})`)).join("");
    chips.onclick = (e) => {
      const b = e.target.closest("[data-dlang]");
      if (!b) return;
      detailLangSel = b.dataset.dlang || "";
      paintDetailLang(m, kind, null, meta, false);
    };
  }
  paintDetail(m, kind, list, meta, { skipMore: !first });
}

/// Artist screen: real header, listener count, bio and discography shelves.
async function mountArtist(m, token, meta) {
  const [page, ov] = await Promise.allSettled([invoke("artist_tracks", { token, page: 0 }), invoke("artist_overview", { token })]);
  if (page.status === "rejected") throw page.reason;
  const tracks = (page.value && (page.value.tracks || page.value.list)) || [];
  const overview = (ov.status === "fulfilled" && ov.value) || {};
  const name = overview.name || meta.title || "Artist";
  const image = overview.image || meta.image || "";

  const h1 = m.querySelector("h1");
  if (h1) h1.textContent = name;
  const sub = findByText(m, /monthly listeners/i);
  if (sub) {
    if (overview.listeners) sub.textContent = `${Number(overview.listeners).toLocaleString()} monthly listeners`;
    else sub.remove();
  }
  const banner = m.querySelector("div.h-72");
  if (banner && image) banner.style.backgroundImage = `url("${hqArt(image)}")`;
  const avatar = m.querySelector("section img, main img");
  if (avatar && image) paintArt(avatar, image);

  fillRows(sectionFor("Popular") || m.querySelector("section"), tracks, "detail");

  // Discography: real releases, split across the shelf tabs.
  const disc = sectionFor("Discography");
  if (disc) paintReleases(disc, overview.releases || [], meta);

  // "Featuring <artist>" is a playlist shelf: fill it from a real playlist
  // search on the artist's name, or drop it.
  const feat = sectionFor("Featuring");
  if (feat) {
    const h = headIn(feat, "Featuring");
    if (h) h.textContent = `Playlists Featuring ${name}`;
    let pls = [];
    try {
      pls = (await invoke("search_entities", { query: name, kind: "playlist", limit: 10 })).items || [];
    } catch (e) {
      console.error(e);
    }
    const row = afterHead(feat, "Featuring");
    if (!pls.length) feat.classList.add("hidden");
    else if (row) row.innerHTML = pls.map((p) => shelfCardHTML(p, "playlist")).join("");
  }

  const about = sectionFor("About");
  const bio = overview.bio || "";
  if (about) {
    if (bio) {
      const p = findByText(about, /.{40,}/);
      if (p) p.textContent = bio;
    } else {
      about.classList.add("hidden");
    }
    // The "Primary Label / Global Rank / Master Fidelity" block is mock copy:
    // keep the rows, but only where a real value backs them.
    const facts = [
      ["Primary Label", tracks.find((t) => t.label)?.label || ""],
      ["Releases", (overview.releases || []).length ? String(overview.releases.length) : ""],
    ];
    [...about.querySelectorAll("div.flex.items-center.justify-between")].forEach((row, i) => {
      const [k, v] = facts[i] || [];
      if (!k || !v) return row.classList.add("hidden");
      const spans = row.querySelectorAll("span");
      if (spans[0]) spans[0].textContent = k;
      if (spans[1]) spans[1].textContent = v;
    });
  }
  // Follow toggle (Spotify parity): artist.html ships #followBtn with a dead
  // inline onclick — rebind it to the real toggle and paint the state.
  {
    const fq = new URLSearchParams(location.hash.split("?")[1] || "");
    const fid = token || fq.get("token") || fq.get("id") || name;
    const paintFollow = (btn) => {
      const on = isFollowing(fid);
      const tx = btn.querySelector("#followText");
      const ic = btn.querySelector("#followIcon");
      if (tx) tx.textContent = on ? "Following" : "Follow";
      if (ic) ic.textContent = on ? "check" : "add";
    };
    const fb = m.querySelector("#followBtn");
    if (fb) {
      fb.removeAttribute("onclick");
      paintFollow(fb);
      if (!fb.dataset.followWired) {
        fb.dataset.followWired = "1";
        const fresh = fb.cloneNode(true);
        fresh.removeAttribute("onclick");
        fb.replaceWith(fresh);
        fresh.addEventListener("click", () => {
          const on = toggleFollow({ id: fid, title: name, image: image || "" });
          haptic(12);
          paintFollow(fresh);
          toast(on ? `Following ${name}` : `Unfollowed ${name}`, 3000, "success");
        });
      }
    }
  }

  // Similar Artists shelf from the overview payload, when the backend sends one.
  {
    const raw = overview.similar || overview.similar_artists || overview.related || overview.list || [];
    const sim = (Array.isArray(raw) ? raw : []).map((r) => r && (r.item || r)).filter((a) => a && (a.token || a.id) && a.title);
    let ssec = m.querySelector('[data-shelf="similar"]');
    if (!sim.length) ssec?.remove();
    else {
      if (!ssec) {
        ssec = document.createElement("section");
        ssec.dataset.shelf = "similar";
        ssec.className = "flex flex-col mb-space-xl";
        ssec.innerHTML = `<div class="flex items-center justify-between mb-space-xs px-1"><h2 class="font-headline-md text-headline-md tracking-tight text-on-surface font-semibold">Similar Artists</h2></div><div class="flex gap-space-sm overflow-x-auto pb-2 no-scrollbar -mx-gutter px-gutter" data-cards></div>`;
        const featSec = sectionFor("Featuring");
        if (featSec) featSec.insertAdjacentElement("afterend", ssec);
        else m.appendChild(ssec);
      }
      const sbox = ssec.querySelector("[data-cards]");
      if (sbox) sbox.innerHTML = sim.slice(0, 10).map((a, i) => artistCardHTML(a, i, entityNav("artist", a))).join("");
    }
  }

  wirePlayAll(m, tracks);
  wireShuffleHeader(m);
  wireShareHeader(m, () => shareThing({ title: name, text: "Artist" }));
  wireStationRadio(m, tracks);
  paintFavs();
}

const trackCount = (n) => (n ? `${n} ${n === 1 ? "track" : "tracks"}` : "");

/// One card for a horizontal shelf: fixed width, so the row scrolls instead
/// of wrapping.
function shelfCardHTML(it, kind) {
  const meta =
    kind === "playlist"
      ? [trackCount(it.count), it.subtitle].filter(Boolean).join(" • ")
      : [it.year, trackCount(it.count)].filter(Boolean).join(" • ");
  return `<div data-nav="${esc(entityNav(kind, it))}" class="w-40 flex-shrink-0 flex flex-col bg-surface-container-lowest p-space-sm rounded-xl shadow-sm cursor-pointer active:opacity-80 transition-opacity">
    <div class="relative w-full aspect-square rounded-lg overflow-hidden mb-space-sm bg-surface-container-highest"><img alt="" loading="lazy" class="w-full h-full object-cover" ${art(it.image)}>${it.langCount > 1 ? `<span class="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/70 text-white font-label-mono text-[9px] uppercase tracking-wider">${it.langCount} languages</span>` : ""}</div>
    <span class="font-body-md text-body-md font-medium text-on-surface truncate">${esc(it.title || "")}</span>
    <span class="font-body-sm text-body-sm text-secondary truncate">${esc(meta)}</span>
  </div>`;
}

/// "More by <artist>" is design placeholder copy on the playlist screen. Fill it
/// with the lead artist's real releases — or drop the shelf when there is
/// nothing else by them rather than leave the mock cards standing.
async function paintMoreBy(m, tracks, excludeId, excludeTitle) {
  const sec = sectionFor("More by");
  if (!sec) return;
  const lead = tracks.find((t) => (t.artist_ids || []).length) || tracks[0];
  if (!lead) return sec.classList.add("hidden");
  const token = (lead.artist_ids || [])[0];
  const leadName = (lead.artist || "").split(",")[0].trim() || lead.artist || "";
  let name = leadName;
  let releases = [];
  try {
    if (token) {
      const ov = await invoke("artist_overview", { token });
      name = ov.name || name;
      releases = (ov.releases || []).map((r) => r.item || r);
    } else if (leadName) {
      // Mirror-sourced tracks carry no artist ids, so fall back to an album
      // search on the credited name.
      releases = (await invoke("search_entities", { query: leadName, kind: "album", limit: 12 })).items || [];
    }
  } catch (e) {
    console.error(e);
  }
  releases = releases.filter((r) => r.id && r.id !== excludeId && r.title && r.title !== excludeTitle).slice(0, 12);
  if (!releases.length || !name) return sec.classList.add("hidden");
  const h = headIn(sec, "More by");
  if (h) h.textContent = `More by ${name}`;
  const row = afterHead(sec, "More by");
  if (row) row.innerHTML = groupLangAlbums(releases).map((r) => shelfCardHTML(r, "album")).join("");
}

/// The container in `sec` with the most direct children that hold an image —
/// the release grid, found without relying on generated class names.
function gridIn(sec) {
  let best = null;
  let bestN = 0;
  for (const el of sec.querySelectorAll("div")) {
    const n = [...el.children].filter((c) => c.querySelector("img")).length;
    if (n > bestN) {
      bestN = n;
      best = el;
    }
  }
  return best;
}

function releaseCardHTML(r) {
  const it = r.item || r;
  const meta = [it.year, r.kind === "single" ? "Single" : "Album", trackCount(it.count)].filter(Boolean).join(" • ");
  return `<div data-nav="${esc(entityNav("album", it))}" class="flex flex-col gap-2 cursor-pointer active:opacity-80 transition-opacity">
    <div class="relative w-full aspect-square rounded-lg overflow-hidden bg-surface-container-highest"><img alt="" loading="lazy" class="w-full h-full object-cover" ${art(it.image)}></div>
    <div class="flex flex-col min-w-0">
      <span class="font-label-md text-label-md text-on-surface font-semibold truncate">${esc(it.title || "")}</span>
      <span class="font-body-sm text-[11px] text-secondary truncate">${esc(meta)}</span>
    </div>
  </div>`;
}

/// Discography shelf: the tabs filter the artist's real releases by kind.
function paintReleases(sec, releases, meta) {
  const tabs = [...sec.querySelectorAll("button")].filter((b) => /^(Popular Releases|Albums|Singles)/i.test(b.textContent.trim()));
  const host = gridIn(sec);
  const countEl = findByText(sec, /^\d+\sRELEASES$/i);
  if (countEl) countEl.textContent = `${releases.length} RELEASES`;
  if (!host) return;
  const modes = ["all", "album", "single"];
  const render = (mode) => {
    const list = releases.filter((r) => mode === "all" || (mode === "single" ? r.kind === "single" : r.kind !== "single"));
    host.innerHTML = list.length ? list.map(releaseCardHTML).join("") : '<div class="font-body-sm text-secondary py-4">Nothing here yet</div>';
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t, j) => {
        t.classList.toggle("bg-primary", i === j);
        t.classList.toggle("text-on-primary", i === j);
        t.classList.toggle("bg-surface-container", i !== j);
        t.classList.toggle("text-on-surface-variant", i !== j);
      });
      render(modes[i] || "all");
    });
  });
  render("all");
  void meta;
}

async function mountDetail(kind, query) {
  const m = main();
  if (!m) return;
  wireBack(m);
  const q = query || new URLSearchParams();
  const token = q.get("token") || "";
  const id = q.get("id") || "";
  const meta = { title: q.get("title") || "", subtitle: q.get("subtitle") || "", image: q.get("image") || "", count: q.get("count") || "", year: q.get("year") || "" };
  if (!token && !id) {
    toast("Open this from Home or Search");
    return;
  }
  if (!invoke) return;
  // album_tracks / playlist_tracks return a bare Track[]; artist_tracks
  // returns a page object. Accept either shape.
  const asTracks = (r) => (Array.isArray(r) ? r : (r && (r.list || r.tracks)) || []);
  // Fetch with a one-entry disk snapshot: a previously opened album or
  // playlist repaints offline instead of dying on the network. (Local
  // playlists below never hit this — they are already offline.)
  const DETAIL_SNAP_KEY = "tm-detail-snap";
  const withSnap = async (key, fn) => {
    if (netMode() === "offline") {
      const snap = load(DETAIL_SNAP_KEY, null);
      if (snap && snap.key === key) return snap.value;
      throw new Error("offline");
    }
    try {
      const value = await fn();
      save(DETAIL_SNAP_KEY, { key, value });
      return value;
    } catch (e) {
      const snap = load(DETAIL_SNAP_KEY, null);
      if (snap && snap.key === key) {
        toast("Offline — showing saved copy", 3500, "info");
        return snap.value;
      }
      throw e;
    }
  };
  try {
    if (kind === "album") {
      // Merged language-variant card: every sibling token in parallel
      // (bounded), merged — the chip row below then offers each language.
      const primary = token || id;
      const sibs = (q.get("tokens") || "").split(",").map((s) => s.trim()).filter(Boolean);
      const tokens = [...new Set([primary, ...sibs])].filter(Boolean).slice(0, 7);
      const key = `album:${tokens.join(",")}`;
      const merged = await withSnap(key, async () => {
        const lists = await Promise.allSettled(tokens.map((t) => invoke("album_tracks", { token: t })));
        const out = lists.flatMap((r) => (r.status === "fulfilled" ? asTracks(r.value) : []));
        return out.length ? out : asTracks(await invoke("album_tracks", { token: primary }));
      });
      detailLangSel = "";
      paintDetailLang(m, kind, merged, meta);
      wireHeaderDownload(m, "album tracks");
    } else if (kind === "playlist" && q.get("local")) {
      // Locally created playlists never reach the network — they live in
      // LIBRARY_KEY and previously opened nowhere at all.
      const rec = load(LIBRARY_KEY, []).find((x) => x.id === id);
      if (!rec) return toast("Playlist not found");
      paintDetailLang(
        m,
        kind,
        rec.tracks || [],
        meta.title ? meta : { title: rec.title, subtitle: rec.subtitle, image: rec.image, count: String((rec.tracks || []).length) },
      );
      wireHeaderDownload(m, "playlist tracks");
      wireLocalPlaylistTools(m, kind, query, rec.id);
    } else if (kind === "playlist") {
      paintDetailLang(m, kind, asTracks(await withSnap(`playlist:${id}`, () => invoke("playlist_tracks", { id }))), meta);
      wireHeaderDownload(m, "playlist tracks");
    } else await mountArtist(m, token, meta);
  } catch (e) {
    console.error(e);
    if (String(e) === "Error: offline") toast("You're offline — open this again after connecting", 4000, "info");
    else toast(String(e).slice(0, 100), 5000, "error");
  }
  // Album fragments carry the filter in their toolbar, playlist fragments in
  // the tracklist header; both address the rows fillRows just rendered.
  wireRowFilter(m.querySelector("#detail-filter"), trackSection(m), '[data-list="detail"]');
}

/// Local-playlist editing (Spotify parity): header Edit + Offline toggle plus
/// per-track Remove / Up / Down. Local records only — server playlists stay
/// read-only. Idempotent per mount: the header bar is injected once and the
/// row buttons are skipped when already present.
function wireLocalPlaylistTools(m, kind, query, plId) {
  if (!m || !plId) return;
  if (!m.querySelector("[data-pl-edit]")) {
    const h1 = m.querySelector("h1");
    const anchor = h1 && h1.parentElement;
    if (anchor) {
      const off = playlistOffline(plId);
      const bar = document.createElement("div");
      bar.className = "flex items-center gap-2 pt-2";
      bar.innerHTML =
        `<button type="button" data-pl-edit class="px-3.5 py-1.5 rounded-full bg-surface-container-low border border-surface-container-high/60 font-label-sm text-label-sm text-on-surface font-medium active:scale-95 transition-all">Edit</button>` +
        `<button type="button" data-pl-offline role="switch" aria-checked="${off}" class="px-3.5 py-1.5 rounded-full border font-label-sm text-label-sm font-medium active:scale-95 transition-all ${off ? "bg-primary text-on-primary border-transparent" : "bg-surface-container-low border-surface-container-high/60 text-secondary"}">${off ? "Available offline" : "Save offline"}</button>`;
      anchor.appendChild(bar);
    }
  }
  const editBtn = m.querySelector("[data-pl-edit]");
  if (editBtn && !editBtn.dataset.wired) {
    editBtn.dataset.wired = "1";
    editBtn.addEventListener("click", () => {
      const rec = load(LIBRARY_KEY, []).find((x) => x && x.id === plId);
      if (!rec) return toast("Playlist not found", 4000, "error");
      const title = prompt("Playlist name", rec.title || "");
      if (title == null) return;
      const desc = prompt("Description", rec.subtitle || rec.desc || "");
      if (desc == null) return;
      const clean = String(title).trim();
      if (!clean) return toast("Give the playlist a name", 4000, "error");
      if (!updatePlaylistMeta(plId, { title: clean, desc: String(desc) })) return toast("Nothing changed", 3000);
      toast("Playlist updated", 3000, "success");
      mountDetail(kind, query);
    });
  }
  const offBtn = m.querySelector("[data-pl-offline]");
  if (offBtn && !offBtn.dataset.wired) {
    offBtn.dataset.wired = "1";
    offBtn.addEventListener("click", () => {
      const on = !playlistOffline(plId);
      setPlaylistOffline(plId, on);
      offBtn.setAttribute("aria-checked", String(on));
      offBtn.textContent = on ? "Available offline" : "Save offline";
      offBtn.className = `px-3.5 py-1.5 rounded-full border font-label-sm text-label-sm font-medium active:scale-95 transition-all ${on ? "bg-primary text-on-primary border-transparent" : "bg-surface-container-low border-surface-container-high/60 text-secondary"}`;
      toast(on ? "Playlist saved for offline" : "Offline copy off", 3000, "success");
    });
  }
  const sec = trackSection(m);
  const rows = [...(sec || m).querySelectorAll('[data-list="detail"]')];
  const tracks = store.detail || [];
  rows.forEach((row, i) => {
    if (row.querySelector("[data-pl-rm]")) return;
    const cluster = row.querySelector("[data-menu-list]")?.parentElement || row.lastElementChild || row;
    const t = tracks[i] || {};
    const tid = t.id != null ? String(t.id) : "";
    const btn = (attr, icon, label) =>
      `<button type="button" ${attr} aria-label="${label}" title="${label}" class="w-8 h-8 rounded-full flex items-center justify-center text-secondary hover:text-on-surface hover:bg-surface-container active:scale-90 transition-all"><span class="material-symbols-outlined text-[18px]">${icon}</span></button>`;
    cluster.insertAdjacentHTML(
      "afterbegin",
      btn(`data-pl-down="${i}"`, "arrow_downward", "Move down") + btn(`data-pl-up="${i}"`, "arrow_upward", "Move up") + btn(`data-pl-rm="${esc(tid)}"`, "close", "Remove from playlist"),
    );
  });
  if (sec && !sec.dataset.plToolsWired) {
    sec.dataset.plToolsWired = "1";
    sec.addEventListener("click", (e) => {
      const rm = e.target.closest("[data-pl-rm]");
      const up = e.target.closest("[data-pl-up]");
      const dn = e.target.closest("[data-pl-down]");
      if (!rm && !up && !dn) return;
      e.stopPropagation();
      e.preventDefault();
      const list = store.detail || [];
      if (rm) {
        if (!removePlaylistTrack(plId, rm.dataset.plRm)) return toast("Couldn't remove that track", 4000, "error");
        toast("Removed from playlist", 3000, "success");
      } else if (up) {
        const from = Number(up.dataset.plUp);
        if (!Number.isInteger(from) || from <= 0) return;
        if (!movePlaylistTrack(plId, from, from - 1)) return toast("Couldn't move that track", 4000, "error");
      } else if (dn) {
        const from = Number(dn.dataset.plDown);
        if (!Number.isInteger(from) || from < 0 || from >= list.length - 1) return;
        if (!movePlaylistTrack(plId, from, from + 1)) return toast("Couldn't move that track", 4000, "error");
      }
      mountDetail(kind, query);
    });
  }
}

/// The design's header download toggles only restyled themselves. Rebind them
/// (cloneNode drops the generated script's cosmetic listener) to a real batch
/// download of the loaded tracklist.
function wireHeaderDownload(m, what) {
  const btn = m.querySelector("#download-toggle, #album-download-btn");
  if (!btn || btn.dataset.dlWired) return;
  btn.dataset.dlWired = "1";
  const fresh = btn.cloneNode(true);
  btn.replaceWith(fresh);
  fresh.addEventListener("click", () => downloadAll(store.detail || [], what, fresh));
}

/// Header Shuffle / Share shipped as static chrome. Shuffle plays the loaded
/// detail list (turning shuffle mode on first); Share opens the system sheet.
/// The labels differ per screen, so one selector covers album/playlist/artist.
function wireShuffleHeader(m) {
  const btn = m.querySelector('button[aria-label="Shuffle"], button[aria-label="Shuffle playback"], button[aria-label="Shuffle Discography"]');
  if (!btn || btn.dataset.shWired) return;
  const fresh = btn.cloneNode(true);
  fresh.dataset.shWired = "1";
  btn.replaceWith(fresh);
  fresh.addEventListener("click", () => {
    const list = store.detail || [];
    if (!list.length) return toast("Tracklist hasn't loaded yet", 3000, "error");
    if (!playerState().shuffle) toggleShuffle();
    playList(list, Math.floor(Math.random() * list.length));
    go("nowplaying");
  });
}

function wireShareHeader(m, mk) {
  const btn = m.querySelector('button[aria-label="Share Playlist"], button[aria-label="Share Album"], button[aria-label="Share Artist"]');
  if (!btn || btn.dataset.shrWired) return;
  const fresh = btn.cloneNode(true);
  fresh.dataset.shrWired = "1";
  btn.replaceWith(fresh);
  fresh.addEventListener("click", mk);
}

/// "Artist Station Radio": play the artist's tracks and keep the queue fed
/// from recommendations — the same path the NowPlaying radio toggle uses.
function wireStationRadio(m, tracks) {
  const btn = m.querySelector('button[aria-label="Artist Station Radio"]');
  if (!btn || btn.dataset.stWired) return;
  const fresh = btn.cloneNode(true);
  fresh.dataset.stWired = "1";
  btn.replaceWith(fresh);
  fresh.addEventListener("click", () => {
    if (!tracks.length) return toast("Nothing to play yet", 3000, "error");
    playList(tracks, 0);
    setRadioOn(true);
    const st = playerState();
    go("nowplaying");
    toast("Station on — recommendations keep the queue fed", 3000, "success");
    ensureReco(st.queue, st.qi);
  });
}

let lyricsFor = "";
let lyricsBox = null;
let lyricToken = 0;
/// Tracks whose lookup already failed: paintNowplaying runs ~4×/s, so a
/// cleared `lyricsFor` on error retried the fetch on every single frame
/// (permanent skeleton + a request storm). One failure = one message.
const lyricsFailed = new Set();

const LYRICS_UNAVAILABLE = '<span class="font-body-sm text-secondary italic">Lyrics unavailable</span>';

async function ensureLyrics() {
  const box = document.querySelector("[data-lyrics]");
  const t = playerState().track;
  if (!box || !document.getElementById("elapsed-time") || !invoke) return;
  if (!t) {
    // Queue drained while the card is still open: drop the last track's words.
    if (lyricsFor !== "") {
      lyricsFor = "";
      setLyricTrack(null);
      box.innerHTML = '<span class="font-body-sm text-secondary italic">Nothing playing</span>';
    }
    return;
  }
  // Keyed per box as well as per track: remounting NowPlaying rebuilds the
  // card, and its placeholder lines must be replaced again for the same track.
  if (lyricsFor === t.id && lyricsBox === box) return;
  lyricsFor = t.id;
  lyricsBox = box;
  // The offset buttons (P1-1) must target this track from here on — even if
  // the fetch below fails and renderLyrics never runs.
  setLyricTrack(t.id);
  if (lyricsFailed.has(t.id)) {
    box.innerHTML = LYRICS_UNAVAILABLE;
    return;
  }
  const token = ++lyricToken;
  box.innerHTML =
    '<div class="h-3.5 w-3/4 rounded-md animate-pulse bg-surface-container-high"></div><div class="h-3.5 w-1/2 rounded-md animate-pulse bg-surface-container-high"></div>';
  try {
    const r = await invoke("get_lyrics", { id: t.id, title: t.title || "", artist: t.artist || "", album: t.album || "", duration: t.duration_secs || 0 });
    if (token !== lyricToken) return; // a newer track already fetched its own
    renderLyrics(box, { ...(r || {}), trackId: t.id });
    maybeAiLyrics(box, t, r);
  } catch (e) {
    console.error(e);
    if (token !== lyricToken) return;
    lyricsFailed.add(t.id);
    box.innerHTML = LYRICS_UNAVAILABLE;
    maybeAiLyrics(box, t, null);
  }
}

/// Gemini fallback: when the cascade returns nothing for a track, offer a
/// one-tap AI generation (key set) or a nudge to Settings (no key). Rendered
/// as plain unsynced lines with an AI label — never presented as verified.
function maybeAiLyrics(box, t, r) {
  try {
    if (!box || !t || box.querySelector("[data-ai-lyrics]")) return;
    const synced = r && Array.isArray(r.synced) ? r.synced : [];
    const plain = r && typeof r.plain === "string" ? r.plain.trim() : "";
    if (synced.length || plain) return; // real lyrics won — nothing to do
    const wrap = document.createElement("div");
    wrap.setAttribute("data-ai-lyrics", "1");
    wrap.className = "pt-1";
    if (hasGeminiKey()) {
      wrap.innerHTML = `<button type="button" data-ai-go class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-container hover:bg-surface-container-high font-label-mono text-[11px] text-on-surface font-semibold transition-colors active:scale-95"><span class="material-symbols-outlined text-[15px]">auto_awesome</span>No lyrics found — get AI lyrics</button>`;
      const btn = wrap.querySelector("[data-ai-go]");
      if (btn) {
        btn.addEventListener("click", async () => {
          const id = t.id;
          btn.disabled = true;
          btn.innerHTML = `<span class="font-label-mono text-[11px]">Asking Gemini…</span>`;
          try {
            const { text } = await fetchAiLyrics(t);
            if (lyricsFor !== id || lyricsBox !== box || !box.isConnected) return; // moved on
            renderLyrics(box, { plain: text, copyright: aiCopyright(), trackId: id });
            try {
              haptic(12);
            } catch {}
          } catch (e) {
            btn.disabled = false;
            btn.innerHTML = `<span class="material-symbols-outlined text-[15px]">auto_awesome</span>No lyrics found — get AI lyrics`;
            toast(String((e && e.message) || e).slice(0, 120), 5000, "error");
          }
        });
      }
    } else {
      wrap.innerHTML = `<button type="button" data-nav="settings" class="font-body-sm text-[12px] text-secondary underline underline-offset-2">No lyrics found — add a Gemini key in Settings for AI lyrics</button>`;
    }
    box.appendChild(wrap);
  } catch {}
}

let upNextKey = "";

function paintNowplaying(st) {
  const m = main();
  if (!m || !m.querySelector("#scrubber-bar")) {
    // Another screen owns <main>: drop the karaoke clock so the rAF loop
    // never scrolls a detached card.
    resetLyrics();
    return;
  }
  const pct = st.dur ? Math.min(100, (st.pos / st.dur) * 100) : 0;
  const bar = document.getElementById("scrubber-bar");
  if (bar) bar.style.width = pct + "%";
  const needle = document.getElementById("scrubber-needle");
  if (needle) needle.style.left = `calc(${pct}% - 7px)`;
  // Paint guards: this runs ~4×/s and a textContent write invalidates layout
  // even when the string is unchanged.
  const setTxt = (el, v) => {
    if (el && el.textContent !== v) el.textContent = v;
  };
  const el = document.getElementById("elapsed-time");
  setTxt(el, fmtTime(st.pos));
  const rm = document.getElementById("remaining-time");
  setTxt(rm, `-${fmtTime(Math.max(0, st.dur - st.pos))}`);
  const icon = document.getElementById("play-pause-icon");
  setTxt(icon, st.paused ? "play_arrow" : "pause");

  const t = st.track;
  if (t) {
    // Ids first (#np-title/#np-artist, the Social Now Playing screen), then the
    // original class probes for every older screen.
    const title = document.getElementById("np-title") || m.querySelector('[class*="font-headline-lg"]');
    if (title && t.title) setTxt(title, t.title);
    // The artist line lives beside the title (p.font-body-md); the only
    // font-headline-md in <main> is the middle lyrics line — painting it
    // would overwrite the lyrics with the artist name.
    const titleEl = m.querySelector("h1.font-headline-lg");
    const headerArtist =
      document.getElementById("np-artist") ||
      (titleEl && titleEl.parentElement && titleEl.parentElement.querySelector("p.font-body-md"));
    const artist = headerArtist || m.querySelector("p.font-body-md");
    const album = document.getElementById("np-album");
    if (album && t.album) setTxt(album, t.album);
    if (artist && t.artist) setTxt(artist, t.artist);
    // Only the header credit is stamped: the fallback match can land on a
    // lyric line, and a lyric tap must mean "seek", not "open artist".
    if (headerArtist && t.artist) {
      headerArtist.dataset.entityName = "";
      headerArtist.dataset.entityKind = "artist";
    }
    const artImg = m.querySelector("img");
    // Always paint — see the widget: an artless track must fall back to the
    // brand mark instead of keeping the last cover (06-features batch).
    if (artImg) paintArt(artImg, t.image || "");
    const fi = document.getElementById("favorite-icon");
    if (fi) fi.dataset.favIcon = t.id || "";
    paintFavs();
  }
  // Eyebrow + telemetry strip (desktop `.np-art-overlay` parity). TRACK nn
  // and the length are real player state; STEREO DIRECT is desktop's exact
  // wording (app/src/playback.js np-trackline), and the quality chip is fed
  // only by the resolve's own `chosen_quality` (st.badge "320KBPS") — a
  // transient state (RESOLVING/ERROR) hides the chip rather than inventing
  // a number (docs/mobile/06-features.md, Android UI parity batch).
  setTxt(
    document.getElementById("np-trackline"),
    t && st.queue.length
      ? `TRACK ${String(st.qi + 1).padStart(2, "0")} / ${st.queue.length} • STEREO DIRECT`
      : "—",
  );
  setTxt(document.getElementById("np-length"), st.dur ? fmtTime(st.dur) : "—");
  const qm = /^(\d{2,3})K?BPS$/.exec(String(st.badge || ""));
  const qval = qm ? `${qm[1]}kbps` : String(st.badge || "") === "VAULT" ? "vault" : "";
  const chip = document.getElementById("np-qchip");
  if (chip) {
    chip.textContent = qval;
    chip.classList.toggle("hidden", !qval);
  }
  setTxt(document.getElementById("np-quality"), qval || "—");

  const bd = document.querySelector("[data-badge]");
  if (bd) {
    if (bd.dataset.badgeIdle === undefined) bd.dataset.badgeIdle = bd.textContent;
    const want = badgeLabel(st.badge, bd.dataset.badgeIdle);
    if (bd.textContent !== want) bd.textContent = want;
  }

  // Both shuffle affordances: the header mirror must track the real state too.
  for (const sh of [document.getElementById("shuffle-btn"), document.getElementById("header-shuffle-btn")]) {
    if (!sh) continue;
    sh.classList.toggle("text-primary", st.shuffle);
    sh.classList.toggle("text-on-surface-variant", !st.shuffle);
    sh.setAttribute("aria-pressed", String(!!st.shuffle));
  }
  const rp = document.getElementById("repeat-btn");
  if (rp) {
    rp.classList.toggle("text-primary", st.repeat > 0);
    rp.classList.toggle("text-on-surface-variant", st.repeat === 0);
    // 0=off, 1=queue, 2=one track — the glyph is the only cue the mode has.
    const ic = rp.querySelector(".material-symbols-outlined");
    if (ic) ic.textContent = st.repeat === 2 ? "repeat_one" : "repeat";
    rp.setAttribute("aria-label", st.repeat === 0 ? "Repeat off" : st.repeat === 1 ? "Repeat all" : "Repeat one");
    rp.setAttribute("aria-pressed", String(st.repeat > 0));
  }
  const rb = document.getElementById("radio-btn");
  if (rb) paintRadioBtn(rb, isRadioOn());

  const qc = m.querySelector("[data-queue-count]");
  if (qc) {
    const n = Math.max(0, st.queue.length - st.qi - 1);
    if (qc.textContent !== String(n)) qc.textContent = String(n);
  }
  const key = `${st.qi}:${st.queue.length}:${t ? t.id : ""}`;
  if (key !== upNextKey) {
    upNextKey = key;
    // The host is explicit (`data-upnext-list` in nowplaying.html). The
    // old row-class probe silently missed when the design markup changed
    // its padding/radius, leaving the mock rows on screen forever.
    const host = m.querySelector("[data-upnext-list]");
    if (host) {
      const rest = st.queue.slice(st.qi + 1);
      host.innerHTML = rest.length
        ? rest
            .map((x, i) => `<div data-list="npq" data-idx="${st.qi + 1 + i}" class="p-2 rounded-xl bg-surface-container-lowest border border-surface-container/60 cursor-pointer active:bg-surface-container-low transition-colors flex items-center gap-2">
            <div class="flex items-center gap-3 min-w-0 flex-1">
              <div class="w-10 h-10 rounded-lg bg-surface-container-highest overflow-hidden shrink-0"><img alt="" class="w-full h-full object-cover" ${art(x.image)}></div>
              <div class="flex flex-col min-w-0 flex-1">
                <span class="font-body-md font-medium text-on-surface truncate">${esc(x.title || "")}</span>
                <span class="font-body-sm text-[11px] text-secondary truncate">${esc(x.artist || "")}</span>
              </div>
            </div>
            <span class="font-label-mono text-[11px] text-secondary font-medium shrink-0">${x.duration_secs ? fmtTime(x.duration_secs) : esc(x.duration || "")}</span>
            <button type="button" aria-label="More options" class="w-8 h-8 flex items-center justify-center flex-shrink-0 text-secondary hover:text-on-surface active:bg-surface-container rounded-lg transition-colors"><span class="material-symbols-outlined text-[18px]">more_vert</span></button>
          </div>`,
          )
          .join("")
        : '<div class="font-body-sm text-secondary py-1">Nothing queued</div>';
      setList("npq", st.queue);
      paintFavs();
    }
  }
  ensureLyrics();
}

/// The Radio toggle is pure preference state — paint it from the source of
/// truth so a remount never shows a stale switch.
function paintRadioBtn(btn, on) {
  if (!btn) return;
  btn.classList.toggle("text-primary", !!on);
  btn.classList.toggle("text-on-surface-variant", !on);
  btn.setAttribute("aria-pressed", String(!!on));
}

/// Queue overlay (menus.js owns it and is edited concurrently): reached ONLY
/// through this guarded dynamic import so this file stays link-safe when the
/// overlay is absent — scrollQueue is the fallback in every failure path.
function openQueueOverlay(m) {
  import("./menus.js")
    .then((mod) => {
      if (mod && typeof mod.openQueue === "function") mod.openQueue();
      else scrollQueue(m);
    })
    .catch(() => scrollQueue(m));
}

/// Smooth-scroll the Up Next list into view (transport Queue button and the
/// header's "View Queue" link both land here).
function scrollQueue(m) {
  const host = m.querySelector("[data-upnext-list]");
  if (host && host.querySelector("[data-list]")) host.scrollIntoView({ behavior: "smooth", block: "end" });
  else toast("Nothing queued", 2500);
}

/// NowPlaying extras injected per mount (fresh DOM every navigation): the
/// speed select and the header more-options menu. There is no volume slider —
/// system volume keys own it, and `tm-mobile-vol` still seeds the level in
/// player.js (slider removed 2026-10-06, docs/mobile/06-features.md). Sleep
/// lives in the utility bar ([data-sleep] → app.js + shared sleep.js), so it
/// is not duplicated here. Idempotent per mount.
function ensureNpExtras(m) {
  // Speed row after the utility bar (AirPlay row). Sleep is the utility-bar
  // bedtime button (app.js), not duplicated here.
  const routeBtn = document.getElementById("device-route-btn");
  const utilBar = routeBtn?.closest("div.px-margin");
  if (utilBar && !m.querySelector("#m-np-speed")) {
    const row = document.createElement("div");
    row.className = "px-margin mt-3 flex items-center gap-2";
    row.innerHTML = `
      <div class="flex-1 bg-surface-container-low/90 border border-surface-container-high/80 rounded-2xl px-3.5 py-2.5 flex items-center justify-between">
        <span class="font-body-sm text-[12px] font-medium text-on-surface flex items-center gap-2"><span class="material-symbols-outlined text-[18px]">speed</span>Speed</span>
        <select id="m-np-speed" class="bg-transparent font-label-mono text-[12px] text-on-surface focus:outline-none">
          <option value="0.75">0.75x</option><option value="0.9">0.9x</option><option value="1">1x</option><option value="1.1">1.1x</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option>
        </select></div>`;
    utilBar.insertAdjacentElement("afterend", row);
  }
  const speedSel = m.querySelector("#m-np-speed");
  if (speedSel && !speedSel.dataset.wired) {
    speedSel.dataset.wired = "1";
    try {
      speedSel.value = localStorage.getItem("tm-play-speed") || "1";
    } catch {}
    speedSel.addEventListener("change", () => {
      try {
        localStorage.setItem("tm-play-speed", speedSel.value);
        if (mAudio) mAudio.playbackRate = Number(speedSel.value) || 1;
      } catch {}
      toast(`Speed ${Number(speedSel.value)}x`, 2500, "success");
    });
  }
  // Header more-options was dead chrome — open the full track menu.
  const more = document.getElementById("more-options-btn");
  if (more && !more.dataset.npWired) {
    more.dataset.npWired = "1";
    more.addEventListener("click", () => {
      const t = playerState().track;
      if (!t) return toast("Nothing is playing", 3000, "error");
      trackMenu(t);
    });
  }
  // Bookmark-add button was dead chrome — same add-to-playlist sheet.
  const add = document.getElementById("playlist-add-btn");
  if (add && !add.dataset.npWired) {
    add.dataset.npWired = "1";
    add.addEventListener("click", () => {
      const t = playerState().track;
      if (!t) return toast("Nothing is playing", 3000, "error");
      trackMenu(t);
    });
  }
}

function mountNowplaying() {
  const m = main();
  if (!m) return;
  wireBack(m);
  // Every mount gets a fresh DOM, so the Up Next key guard must re-run:
  // an unchanged queue would otherwise leave the new container empty.
  upNextKey = "";
  const sc = document.getElementById("scrubber-container");
  if (sc) {
    const fresh = sc.cloneNode(true);
    sc.replaceWith(fresh);
    let dragging = false;
    const seekFrom = (clientX) => {
      const st = playerState();
      const rect = fresh.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      if (st.dur) seek(pct * st.dur);
    };
    fresh.addEventListener("pointerdown", (e) => {
      dragging = true;
      fresh.setPointerCapture?.(e.pointerId);
      seekFrom(e.clientX);
    });
    fresh.addEventListener("pointermove", (e) => {
      if (dragging) seekFrom(e.clientX);
    });
    const stop = () => {
      dragging = false;
    };
    fresh.addEventListener("pointerup", stop);
    fresh.addEventListener("pointercancel", stop);
  }
  const dlBtn = document.getElementById("download-btn");
  if (dlBtn) {
    const fresh = dlBtn.cloneNode(true);
    dlBtn.replaceWith(fresh);
    fresh.addEventListener("click", () => {
      const t = playerState().track;
      if (t) downloadTrack(t, fresh);
    });
  }
  // Lyrics "Full View": promote the preview card to the fixed stage (CSS in
  // index.html) and re-pin the active line to the new geometry right away.
  const fullBtn = m.querySelector("[data-lyrics-full]");
  if (fullBtn && !fullBtn.dataset.fullWired) {
    fullBtn.dataset.fullWired = "1";
    fullBtn.addEventListener("click", () => {
      const card = fullBtn.closest("div.rounded-2xl, div.rounded-xl");
      if (!card) return;
      const on = card.classList.toggle("tm-lyrics-full");
      fullBtn.textContent = on ? "Close" : "Full View";
      requestAnimationFrame(() => syncLyrics());
    });
  }
  // Manual lyrics offset (P1-1): ±100ms per press, clamp/persist/label live
  // in setLyricOffset — same three controls as desktop index.html:1470-1474.
  for (const [sel, fn] of [
    ["#lyric-offset-minus", () => setLyricOffset(lyricOffsetMs() - 100)],
    ["#lyric-offset-plus", () => setLyricOffset(lyricOffsetMs() + 100)],
    ["#lyric-offset-reset", () => setLyricOffset(0)],
  ]) {
    const b = m.querySelector(sel);
    if (b && !b.dataset.offWired) {
      b.dataset.offWired = "1";
      b.addEventListener("click", fn);
    }
  }
  const shareBtn = document.getElementById("share-utility-btn");
  if (shareBtn && !shareBtn.dataset.shrWired) {
    const fresh = shareBtn.cloneNode(true);
    fresh.dataset.shrWired = "1";
    shareBtn.replaceWith(fresh);
    fresh.addEventListener("click", () => {
      const t = playerState().track;
      if (!t) return toast("Nothing is playing", 3000, "error");
      shareThing({ title: t.title, text: t.artist, url: t.page_url });
    });
  }
  const queueBtn = m.querySelector('button[aria-label="Queue"]');
  if (queueBtn && !queueBtn.dataset.qWired) {
    const fresh = queueBtn.cloneNode(true);
    fresh.dataset.qWired = "1";
    queueBtn.replaceWith(fresh);
    fresh.addEventListener("click", () => openQueueOverlay(m));
  }
  // Swipe the header down to collapse NowPlaying (drag-to-dismiss). Header
  // only: a gesture on <main> would fight the page's own scroll.
  const hdr = document.querySelector("#screen header");
  if (hdr && !hdr.dataset.swipeWired) {
    hdr.dataset.swipeWired = "1";
    let y0 = null;
    hdr.addEventListener("touchstart", (e) => {
      y0 = e.touches[0].clientY;
    }, { passive: true });
    hdr.addEventListener("touchend", (e) => {
      if (y0 == null) return;
      const dy = e.changedTouches[0].clientY - y0;
      y0 = null;
      if (dy > 60) history.back();
    });
  }
  // Drag-down-to-dismiss for the whole screen: a downward swipe on the body
  // of NowPlaying (art, title, cards, Up Next) slides header + content down
  // and collapses it — the header chevron's gesture, extended. Armed only
  // from the very top of the page so it never fights scrolling, and never
  // from the scrubber or the lyrics card, which own their own gestures.
  // The header keeps its own swipe: it is a sibling of <main>, so its
  // touches never reach these listeners anyway.
  const parts = [hdr, m].filter(Boolean);
  let gY0 = 0;
  let gX0 = 0;
  let gT0 = 0;
  let gOn = false;
  let gTaken = false;
  const springBack = () => {
    for (const p of parts) {
      p.style.transition = "transform 0.26s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.26s";
      p.style.transform = "";
      p.style.opacity = "";
    }
    setTimeout(() => {
      for (const p of parts) p.style.transition = "";
    }, 300);
  };
  m.addEventListener(
    "touchstart",
    (e) => {
      const t = e.target;
      if (t.closest && t.closest("#scrubber-container, [data-lyrics], .tm-lyrics-full, button, a, input")) return;
      if (window.scrollY > 1) return; // scrolled content owns its own swipes
      gOn = true;
      gTaken = false;
      gY0 = e.touches[0].clientY;
      gX0 = e.touches[0].clientX;
      gT0 = Date.now();
      for (const p of parts) p.style.transition = "none";
    },
    { passive: true },
  );
  m.addEventListener(
    "touchmove",
    (e) => {
      if (!gOn) return;
      const dy = e.touches[0].clientY - gY0;
      const dx = e.touches[0].clientX - gX0;
      if (!gTaken) {
        if (dy < 12 || dy < Math.abs(dx)) return; // wait for a clear downward swipe
        gTaken = true;
      }
      e.preventDefault(); // non-passive listener: hold the page still mid-drag
      const h = window.innerHeight || 700;
      for (const p of parts) {
        p.style.transform = `translateY(${dy}px)`;
        p.style.opacity = String(Math.max(0.35, 1 - dy / h));
      }
    },
    { passive: false },
  );
  const gEnd = (e) => {
    if (!gOn) return;
    const dy = (e.changedTouches ? e.changedTouches[0].clientY : 0) - gY0;
    const v = dy / Math.max(1, Date.now() - gT0);
    const wasTaken = gTaken;
    gOn = false;
    gTaken = false;
    if (!wasTaken) {
      for (const p of parts) p.style.transition = "";
      return;
    }
    const h = window.innerHeight || 700;
    if (dy > Math.min(160, h * 0.25) || v > 0.6) {
      // Commit: finish the slide off-screen, then collapse the route.
      for (const p of parts) {
        p.style.transition = "transform 0.24s cubic-bezier(0.4, 0, 1, 1), opacity 0.24s";
        p.style.transform = `translateY(${h}px)`;
        p.style.opacity = "0.4";
      }
      const before = location.hash;
      setTimeout(() => {
        history.back();
        // No history entry to pop (deep-linked boot): restore the screen.
        setTimeout(() => {
          if (location.hash === before) springBack();
        }, 150);
      }, 240);
    } else {
      springBack();
    }
  };
  m.addEventListener("touchend", gEnd);
  m.addEventListener("touchcancel", gEnd);
  // The output row's device button was static chrome — say where audio goes
  // instead of pretending to open a route picker.
  const routeBtn = document.getElementById("device-route-btn");
  if (routeBtn && !routeBtn.dataset.rtWired) {
    routeBtn.dataset.rtWired = "1";
    routeBtn.addEventListener("click", () => toast("Audio plays on this device — switch speakers or Bluetooth from the system media controls", 4000));
  }
  // The header's "View Queue" link — full overlay, same as the transport button.
  const viewQueue = m.querySelector("[data-queue-scroll]");
  if (viewQueue && !viewQueue.dataset.qWired) {
    viewQueue.dataset.qWired = "1";
    viewQueue.addEventListener("click", () => openQueueOverlay(m));
  }
  // "Play Next" — pick the next Up Next row and insert it straight after the
  // playing track. Re-clicking moves it further back in the same order, which
  // is what the gesture means on other players.
  const playNextBtn = m.querySelector("[data-queue-playnext]");
  if (playNextBtn && !playNextBtn.dataset.pnWired) {
    playNextBtn.dataset.pnWired = "1";
    playNextBtn.addEventListener("click", () => {
      const st = playerState();
      const upNext = st.queue.slice(st.qi + 1);
      if (!upNext.length) {
        toast("Nothing queued to move up", 2500, "info");
        return;
      }
      try {
        haptic(12);
      } catch {}
      insertNext(upNext[0]);
      // The Up Next list repaints from playerState on the next paint tick, so
      // the count only needs nudging here to feel immediate.
      const host = m.querySelector("[data-queue-count]");
      if (host) host.textContent = String(Math.max(0, st.queue.length - st.qi - 1));
      toast(`“${upNext[0].title || "Track"}” plays next`, 2500, "success");
    });
  }
  // Long-press a lyric line to share it as a card (550ms hold, <10px drift).
  const lyrBox = m.querySelector("[data-lyrics]");
  if (lyrBox && !lyrBox.dataset.lyrShareWired) {
    lyrBox.dataset.lyrShareWired = "1";
    let lpTimer = 0;
    let lpX = 0;
    let lpY = 0;
    let lpTarget = null;
    lyrBox.addEventListener(
      "touchstart",
      (e) => {
        const t = e.touches[0];
        lpX = t.clientX;
        lpY = t.clientY;
        lpTarget = e.target && e.target.closest ? e.target.closest(".lyric-line") : null;
        clearTimeout(lpTimer);
        lpTimer = setTimeout(() => {
          const line = lpTarget && lpTarget.isConnected ? lpTarget.textContent.trim() : "";
          const tr = playerState().track;
          if (!line || !tr) return;
          haptic(12);
          shareCard({ title: tr.title, subtitle: line, image: tr.image, badge: "LYRICS" });
        }, 550);
      },
      { passive: true },
    );
    lyrBox.addEventListener(
      "touchmove",
      (e) => {
        const t = e.touches[0];
        if (Math.hypot(t.clientX - lpX, t.clientY - lpY) > 10) clearTimeout(lpTimer);
      },
      { passive: true },
    );
    const lpClear = () => clearTimeout(lpTimer);
    lyrBox.addEventListener("touchend", lpClear);
    lyrBox.addEventListener("touchcancel", lpClear);
  }
  document.getElementById("master-play-pause")?.addEventListener("click", () => toggle());
  m.querySelector('[aria-label="Next"]')?.addEventListener("click", () => next());
  m.querySelector('[aria-label="Previous"]')?.addEventListener("click", () => prev());
  document.getElementById("shuffle-btn")?.addEventListener("click", () => {
    haptic(10);
    toggleShuffle();
  });
  document.getElementById("repeat-btn")?.addEventListener("click", () => {
    haptic(10);
    cycleRepeat();
  });
  const radioBtn = document.getElementById("radio-btn");
  if (radioBtn) {
    const fresh = radioBtn.cloneNode(true); // drop the design's cosmetic node
    radioBtn.replaceWith(fresh);
    paintRadioBtn(fresh, isRadioOn());
    fresh.addEventListener("click", () => {
      const on = setRadioOn(!isRadioOn());
      paintRadioBtn(fresh, on);
      if (!on) return toast("Radio off — the queue ends where it ends", 3000);
      toast("Radio on — recommendations keep the queue fed", 3000, "success");
      const st = playerState();
      ensureReco(st.queue, st.qi)
        .then((n) => {
          if (n) {
            toast(`Added ${n} recommended tracks`, 3500, "success");
            repaint();
          }
        })
        .catch(() => {});
    });
  }
  document.getElementById("favorite-btn")?.addEventListener("click", () => {
    const t = playerState().track;
    if (t) {
      haptic(10);
      toggleFav(t);
    }
  });
  const badgeEl = m.querySelector("[data-badge]");
  if (badgeEl && !badgeEl.dataset.wiredCredits) {
    badgeEl.dataset.wiredCredits = "1";
    badgeEl.style.cursor = "pointer";
    badgeEl.addEventListener("click", () => {
      const t = playerState().track;
      if (t) detailsSheet(t);
      else toast("Nothing playing", 2500, "info");
    });
  }
  ensureNpExtras(m);
  upNextKey = "";
  paintNowplaying(playerState());
}

// -------------------------------------------------------------- analytics -
// The Telemetry Bay ships as a design mock ("48h 12m", "Solaris & Kaelen",
// hardcoded bars). Everything here repaints it from the real play log, and
// hides the sections that no data can back (format split, mood spectrum)
// rather than restating invented numbers.

function hideNear(root, re, selector) {
  const el = findByText(root, re);
  const target = el && el.closest(selector);
  if (target) target.remove();
}

function mountAnalytics() {
  const m = main();
  if (!m) return;
  wireBack(m);

  const plays = load(PLAYS_KEY, []);
  const totalSec = plays.reduce((s, t) => s + (Number(t.duration_secs) || 0) * (Number(t.count) || 1), 0);
  const totalPlays = plays.reduce((s, t) => s + (Number(t.count) || 1), 0);
  const hqPlays = plays.filter((t) => t.hq).reduce((s, t) => s + (Number(t.count) || 1), 0);
  const hqPct = totalPlays ? Math.round((hqPlays / totalPlays) * 100) : 0;

  // Hero: real listening time + play count.
  const hero = m.querySelector(".font-headline-xl");
  if (hero) hero.innerHTML = `${Math.floor(totalSec / 3600)}<span class="text-secondary text-headline-md font-normal">h</span> ${Math.floor((totalSec % 3600) / 60)}<span class="text-secondary text-headline-md font-normal">m</span>`;
  const trend = [...m.querySelectorAll("span")].find((s) => /\+\d+%/.test(s.textContent) && s.querySelector(".material-symbols-outlined"));
  if (trend) {
    const icon = trend.querySelector(".material-symbols-outlined");
    trend.replaceChildren(icon, document.createTextNode(` ${totalPlays} plays`));
  }
  // The quality-breakdown block was removed from the markup: there is no
  // real fidelity data behind it, so nothing is painted here.
  // Nothing computed here: drop the fabricated blocks outright.
  hideNear(m, /Avg Session/, ".grid");
  hideNear(m, /Resolution Analysis/, "section");
  hideNear(m, /Acoustic Mood Spectrum/, "section");
  hideNear(m, /Peak session coincided/, ".flex");

  // Daily Rhythm: last 7 days of real listening, oldest → newest.
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - i);
    const from = start.getTime();
    const to = from + 24 * 3600e3;
    const sec = plays.reduce((s, t) => {
      const ts = Number(t.ts) || 0;
      return ts >= from && ts < to ? s + (Number(t.duration_secs) || 0) * (Number(t.count) || 1) : s;
    }, 0);
    days.push({ label: ["S", "M", "T", "W", "T", "F", "S"][start.getDay()], name: start.toLocaleDateString(undefined, { weekday: "short" }), sec });
  }
  const peak = days.reduce((a, b) => (b.sec > a.sec ? b : a), days[0]);
  const chart = m.querySelector(".h-28");
  if (chart) {
    const max = Math.max(60, ...days.map((d) => d.sec));
    const cols = [...chart.children];
    cols.forEach((col, i) => {
      const d = days[i];
      if (!d) return;
      const hrs = d.sec / 3600;
      const label = col.querySelector("span");
      if (label) {
        label.textContent = hrs >= 1 ? `${hrs.toFixed(1)}h` : hrs ? `${Math.round(hrs * 60)}m` : "0h";
        label.style.opacity = "1"; // touch devices have no hover to reveal it
      }
      const bar = col.querySelector("div");
      if (bar) {
        const pct = d.sec ? Math.max(4, Math.round((d.sec / max) * 100)) : 4;
        bar.style.height = `${pct}%`;
        const on = d === peak && peak.sec > 0;
        bar.classList.toggle("bg-primary", on);
        bar.classList.toggle("bg-surface-container-highest", !on);
      }
    });
  }
  const peakLabel = findByText(m, /^Sat/) || [...m.querySelectorAll("span")].find((s) => /•/.test(s.textContent) && /hrs?$/.test(s.textContent.trim()));
  if (peakLabel && peak.sec) peakLabel.textContent = `${peak.name} • ${(peak.sec / 3600).toFixed(1)} hrs`;

  // Top artists: aggregate the play log and rebuild the section's rows.
  const byArtist = new Map();
  for (const t of plays) {
    const name = String(t.artist || "").split(",")[0].trim() || "Unknown artist";
    const c = Number(t.count) || 1;
    const cur = byArtist.get(name) || { name, plays: 0, sec: 0, image: t.image || "" };
    cur.plays += c;
    cur.sec += (Number(t.duration_secs) || 0) * c;
    if (!cur.image && t.image) cur.image = t.image;
    byArtist.set(name, cur);
  }
  const top = [...byArtist.values()].sort((a, b) => b.plays - a.plays).slice(0, 5);
  const listHost = sectionFor("Top Artists")?.querySelector(".space-y-space-xs");
  if (listHost) {
    listHost.innerHTML = top.length
      ? top
          .map(
            (a, i) => `<div class="flex items-center justify-between p-2 rounded-lg hover:bg-surface-container-low transition-colors">
            <div class="flex items-center gap-space-sm min-w-0">
              <span class="font-label-mono text-label-mono font-semibold text-secondary w-3">${String(i + 1).padStart(2, "0")}</span>
              <div class="w-10 h-10 rounded-lg overflow-hidden bg-surface-container-high flex-shrink-0"><img alt="" class="w-full h-full object-cover" ${art(a.image)}></div>
              <div class="min-w-0">
                <h3 class="font-body-md text-body-md text-on-surface font-semibold truncate">${esc(a.name)}</h3>
                <span class="font-label-mono text-[10px] text-secondary truncate">${a.plays} plays • ${fmtDur(a.sec)}</span>
              </div>
            </div>
            <button aria-label="Play artist" data-artist-play="${esc(a.name)}" class="w-8 h-8 flex items-center justify-center text-secondary hover:text-primary transition-colors flex-shrink-0"><span class="material-symbols-outlined text-[18px]">play_arrow</span></button>
          </div>`,
          )
          .join("")
      : '<div class="font-body-sm text-secondary py-6 text-center">Play something and your real stats show up here.</div>';
    listHost.querySelectorAll("[data-artist-play]").forEach((b) => {
      b.addEventListener("click", () => {
        const mine = plays.filter((t) => (String(t.artist || "").split(",")[0].trim() || "Unknown artist") === b.dataset.artistPlay);
        if (!mine.length) return;
        playList(mine, 0);
        go("nowplaying");
      });
    });
  }

  // Export: share a plain-text summary (Share sheet → clipboard fallback).
  const exportBtn = [...m.querySelectorAll("button")].find((b) => /Export Telemetry/i.test(b.textContent));
  if (exportBtn && !exportBtn.dataset.expWired) {
    exportBtn.dataset.expWired = "1";
    exportBtn.addEventListener("click", async () => {
      const lines = [
        `Listening summary — ${new Date().toLocaleDateString()}`,
        `Total: ${Math.floor(totalSec / 3600)}h ${Math.floor((totalSec % 3600) / 60)}m across ${totalPlays} plays`,
        `High-quality tagged: ${hqPct}%`,
        "",
        "Top artists:",
        ...top.map((a, i) => `${i + 1}. ${a.name} — ${a.plays} plays (${fmtDur(a.sec)})`),
      ].join("\n");
      if (navigator.share) {
        try {
          await navigator.share({ title: "Listening summary", text: lines });
          return;
        } catch (e) {
          if (e && e.name === "AbortError") return;
        }
      }
      try {
        await navigator.clipboard.writeText(lines);
        toast("Summary copied");
      } catch {
        toast("Sharing is unavailable here");
      }
    });
  }
  // Share Wrapped card (Spotify parity): the same summary as an image card.
  if (exportBtn && !m.querySelector("[data-share-wrapped]")) {
    const wb = document.createElement("button");
    wb.type = "button";
    wb.dataset.shareWrapped = "";
    wb.className = exportBtn.className;
    wb.innerHTML = `<span class="material-symbols-outlined text-[18px]">ios_share</span><span>Share Wrapped</span>`;
    exportBtn.insertAdjacentElement("afterend", wb);
    wb.addEventListener("click", async () => {
      try {
        const lines = [
          `Listening summary — ${new Date().toLocaleDateString()}`,
          `Total: ${Math.floor(totalSec / 3600)}h ${Math.floor((totalSec % 3600) / 60)}m across ${totalPlays} plays`,
          "",
          "Top artists:",
          ...top.map((a, i) => `${i + 1}. ${a.name} — ${a.plays} plays (${fmtDur(a.sec)})`),
        ];
        await shareCard({ title: "My Listening", subtitle: lines[1], image: (top[0] && top[0].image) || "", badge: "WRAPPED" });
      } catch {
        toast("Sharing is unavailable here", 4000, "error");
      }
    });
  }
  // Share Insights is the same summary through the same sheet.
  const insights = [...m.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Share Insights");
  if (insights && !insights.dataset.insWired) {
    insights.dataset.insWired = "1";
    insights.addEventListener("click", () => exportBtn.click());
  }
}

// ----------------------------------------------------------- notifications -
// A real feed over the EVENTS_KEY log (downloads, updates, restores). The
// design ships six fictional cards with no way to clear them.

const EV_META = {
  update: { type: "releases", icon: "system_update", tag: "UPDATE" },
  downloads: { type: "drops", icon: "download_done", tag: "VAULT" },
  restore: { type: "system", icon: "settings_backup_restore", tag: "BACKUP" },
  system: { type: "system", icon: "info", tag: "SYSTEM" },
};

function relTime(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function mountNotification() {
  const m = main();
  if (!m) return;
  wireBack(m);
  const events = load(EVENTS_KEY, []);
  const unread = events.filter((e) => !e.read).length;

  const strip = findByText(m, /EVENT FEED/);
  if (strip) strip.textContent = `EVENT FEED: ${events.length} LOGGED`;
  const stripCount = findByText(m, /^\d+ EVENTS$/);
  if (stripCount) stripCount.textContent = `${unread} UNREAD`;

  // Filter pills: relabel to the kinds this app actually emits + counts.
  const pills = [...m.querySelectorAll(".filter-pill")];
  const cats = ["all", "update", "downloads", "system"];
  const names = { all: "All", update: "Updates", downloads: "Downloads", system: "System" };
  pills.forEach((p, i) => {
    const cat = cats[i];
    if (!cat) return;
    p.dataset.category = cat;
    const spans = p.querySelectorAll("span");
    if (spans[0]) spans[0].textContent = names[cat];
    if (spans[1]) spans[1].textContent = String(cat === "all" ? events.length : events.filter((e) => (EV_META[e.kind] || EV_META.system).type === cat).length);
  });

  const stream = m.querySelector("#notificationStream");
  if (stream) {
    if (!events.length) {
      stream.innerHTML = `<div class="flex flex-col items-center justify-center gap-3 py-20 text-center">
        <span class="material-symbols-outlined text-[40px] text-on-surface-variant">notifications_off</span>
        <div class="font-body-md text-body-md text-on-surface font-medium">You're all caught up</div>
        <div class="font-body-sm text-body-sm text-secondary max-w-[16rem]">Download results, update notices and backup events land here.</div>
      </div>`;
    } else {
      const groups = [
        { key: "today", label: "Today", items: events.filter((e) => Date.now() - e.ts < 24 * 3600e3) },
        { key: "earlier", label: "Earlier", items: events.filter((e) => Date.now() - e.ts >= 24 * 3600e3) },
      ].filter((g) => g.items.length);
      stream.innerHTML = groups
        .map(
          (g) => `<section class="notification-group flex flex-col gap-space-xs" data-group="${g.key}">
          <div class="flex items-center justify-between pb-space-xs">
            <span class="font-label-mono text-label-mono text-secondary uppercase tracking-widest">${g.label}</span>
            <span class="font-label-mono text-label-mono text-secondary">${g.items.filter((e) => !e.read).length} UNREAD</span>
          </div>
          ${g.items
            .map((e) => {
              const meta = EV_META[e.kind] || EV_META.system;
              return `<article class="notification-card group bg-surface-container-lowest p-space-md rounded-xl transition-all duration-200 relative shadow-sm" data-type="${meta.type}">
              <div class="flex items-start gap-space-md">
                <div class="w-12 h-12 rounded-lg bg-surface-container-low flex flex-col items-center justify-center flex-shrink-0 text-on-surface">
                  <span class="material-symbols-outlined text-[20px]">${meta.icon}</span>
                  <span class="font-label-mono text-[8px] text-secondary">${meta.tag}</span>
                </div>
                <div class="flex-1 min-w-0 flex flex-col gap-1">
                  <div class="flex items-baseline justify-between gap-space-xs">
                    <h2 class="font-headline-md text-body-lg font-medium text-on-surface truncate">${esc(e.title)}</h2>
                    <div class="flex items-center gap-1.5 flex-shrink-0">
                      <span class="font-label-mono text-label-mono text-secondary">${relTime(e.ts)}</span>
                      ${e.read ? "" : '<span class="status-dot w-1.5 h-1.5 rounded-full bg-primary"></span>'}
                    </div>
                  </div>
                  ${e.body ? `<p class="font-body-md text-body-md text-on-surface-variant leading-snug">${esc(e.body)}</p>` : ""}
                </div>
              </div>
            </article>`;
            })
            .join("")}
        </section>`,
        )
        .join("");
    }
  }

  const wire = (el, fn) => {
    if (!el || el.dataset.wired) return;
    el.dataset.wired = "1";
    el.addEventListener("click", fn);
  };
  // Screen scope, not main: Clear all / Notification settings live in the
  // fragment header, outside <main>.
  const findBtn = (re) => {
    const scope = (m && m.closest && m.closest("#screen")) || document;
    return [...scope.querySelectorAll("button")].find((b) => re.test(b.getAttribute("aria-label") || ""));
  };
  wire(findBtn(/clear all/i), () => {
    save(EVENTS_KEY, []);
    toast("Notifications cleared");
    mountNotification();
  });
  wire(findBtn(/notification settings/i), () => go("settings"));
  wire(findBtn(/configure alerts/i), () => go("settings"));
  wire(m.querySelector("#markAllReadBtn"), () => {
    if (!events.length) return;
    save(EVENTS_KEY, events.map((e) => ({ ...e, read: true })));
    toast("All marked read");
    mountNotification();
  });
}

// ---------------------------------------------------------------- settings -
// Preference lists are the desktop's (settings.js) verbatim: same slugs and
// same localStorage keys, so a backup restored across machines still means
// the same thing.
const NAME_KEY = "tm-name";
const LANGS = [
  ["all", "All languages"],
  ["telugu", "Telugu"],
  ["hindi", "Hindi"],
  ["tamil", "Tamil"],
  ["bengali", "Bengali"],
  ["kannada", "Kannada"],
  ["malayalam", "Malayalam"],
  ["english", "English"],
  ["chinese", "Chinese"],
  ["german", "German"],
  ["marathi", "Marathi"],
  ["punjabi", "Punjabi"],
  ["gujarati", "Gujarati"],
  ["odia", "Odia"],
  ["urdu", "Urdu"],
  ["spanish", "Spanish"],
  ["french", "French"],
  ["japanese", "Japanese"],
  ["korean", "Korean"],
];
const COUNTRIES = [
  ["", "Automatic"],
  ["IN", "India"],
  ["BD", "Bangladesh"],
  ["NP", "Nepal"],
  ["LK", "Sri Lanka"],
  ["PK", "Pakistan"],
  ["AE", "United Arab Emirates"],
  ["SA", "Saudi Arabia"],
  ["QA", "Qatar"],
  ["US", "United States"],
  ["CA", "Canada"],
  ["GB", "United Kingdom"],
  ["AU", "Australia"],
  ["SG", "Singapore"],
  ["MY", "Malaysia"],
  ["DE", "Germany"],
  ["FR", "France"],
  ["JP", "Japan"],
  ["ZA", "South Africa"],
  ["BR", "Brazil"],
];
const DL_QUALITIES = [
  ["128kbps", "128 kbps — Recommended"],
  ["320kbps", "320 kbps — max"],
  ["160kbps", "160 kbps"],
  ["96kbps", "96 kbps"],
  ["64kbps", "64 kbps — small"],
  ["48kbps", "48 kbps — tiny"],
];

const prefLangs = () => {
  const v = load(LANG_KEY, []);
  return (Array.isArray(v) ? v : [v]).filter((s) => typeof s === "string" && s && s !== "all");
};
const saveLangs = (list) => save(LANG_KEY, [...new Set(list.filter((s) => s && s !== "all"))]);

/// The whole language set goes over so the backend cache key changes when
/// any pick changes, not just the leading one (mirror of applySysPrefs).
function pushPrefs() {
  if (!invoke) return;
  invoke("content_prefs_set", { lang: prefLangs().join(","), country: load(COUNTRY_KEY, "") || "" }).catch(() => {});
}

function paintSwitch(btn, on) {
  btn.setAttribute("aria-checked", String(on));
  btn.classList.toggle("bg-primary", on);
  btn.classList.toggle("bg-surface-container-high", !on);
  const knob = btn.firstElementChild;
  if (knob) {
    knob.classList.toggle("translate-x-5", on);
    knob.classList.toggle("translate-x-0.5", !on);
  }
}

/// Values only — safe to run repeatedly (after a restore repaints the panel),
/// unlike the wiring below, which would stack listeners.
function paintSettings(m) {
  const name = m.querySelector("#set-name");
  if (name) name.value = load(NAME_KEY, "") || "";

  // Never clobber the key field while it is being typed — paintSettings
  // re-runs on unrelated pref changes (chips, restores).
  const gk = m.querySelector("#set-gemini-key");
  if (gk && document.activeElement !== gk) gk.value = getGeminiKey();

  const chips = m.querySelector("#set-langs");
  if (chips) {
    const on = prefLangs();
    chips.innerHTML = LANGS.map(([v, l]) => {
      const active = v === "all" ? !on.length : on.includes(v);
      return `<button type="button" data-lang="${esc(v)}" aria-pressed="${active}" class="px-2.5 py-1 rounded-full font-label-sm text-label-sm transition-colors ${
        active ? "bg-primary text-on-primary" : "bg-surface-container text-on-surface-variant"
      }">${esc(l)}</button>`;
    }).join("");
  }

  const country = m.querySelector("#set-country");
  if (country) {
    const cur = load(COUNTRY_KEY, "") || "";
    country.innerHTML = COUNTRIES.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`).join("");
  }

  const quality = m.querySelector("#set-dl-quality");
  if (quality) {
    const cur = dlQuality();
    quality.innerHTML = DL_QUALITIES.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`).join("");
  }

  const au = m.querySelector("#set-autoupdate");
  if (au) paintSwitch(au, String(load(AUTOUPDATE_KEY, "1")) === "1");
}

/// tauri.conf.json "version" — the design export shipped a mock v2.4.0.
const APP_VERSION = "0.4.0";

function paintVersion(m) {
  const head = m.querySelector("header span");
  if (head && /^v\d/i.test(head.textContent.trim())) head.textContent = `v${APP_VERSION}`;
  const foot = [...m.querySelectorAll("p")].find((p) => /VERSION\s+\d/i.test(p.textContent));
  if (foot) foot.textContent = `VERSION ${APP_VERSION}`;
}

/// The three legal rows were href="#" anchors the router swallows, so they
/// opened nothing. Expand them inline with the desktop's real copy instead
/// of inventing a second navigation model for three paragraphs.
function wireLegal(m) {
  const rows = [
    [/Open Source Licenses/i, licensesHTML],
    [/About Project/i, aboutHTML],
    [/Terms &\s*Conditions/i, termsHTML],
  ];
  for (const [re, html] of rows) {
    const row = [...m.querySelectorAll("a")].find((a) => re.test(a.textContent));
    if (!row || row.dataset.legalWired) continue;
    row.dataset.legalWired = "1";
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.removeAttribute("href"); // no hash navigation, no router swallow
    const holder = document.createElement("div");
    holder.className = "hidden px-space-md py-3 bg-surface-container-low/60";
    row.insertAdjacentElement("afterend", holder);
    const chev = row.querySelector(".material-symbols-outlined");
    const toggle = () => {
      const closed = holder.classList.toggle("hidden");
      if (!closed && !holder.dataset.filled) {
        holder.dataset.filled = "1";
        holder.innerHTML = html();
      }
      if (chev) chev.textContent = closed ? "chevron_right" : "expand_more";
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
  }
}

/// Mobile copy of the desktop's new Playback / Appearance / Lyrics prefs.
/// Same localStorage keys (raw strings, not JSON) so backups restore across
/// desktop ↔ mobile. Injected once — the static fragment has no such rows.
const mGet = (k, dflt) => {
  try {
    const v = localStorage.getItem(k);
    return v == null ? dflt : v;
  } catch {
    return dflt;
  }
};
const mSet = (k, v) => {
  try {
    localStorage.setItem(k, String(v));
  } catch {}
};
function applyMobileTheme() {
  const t = mGet("tm-theme", "system");
  const dark = t === "dark" ? true : t === "light" ? false : window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", !!dark);
  try {
    document.body.dataset.density = mGet("tm-density", "comfortable");
  } catch {}
}
// Settings → Storage: last `cache_stats` answer so the budget select can
// show the real value before the user touches it (fmtBytes is defined at
// the top of this file).
let lastCacheStats = null;

function ensureMobilePrefs(m) {
  if (!m || m.querySelector("#tm-m-playback")) return;
  const row = (icon, title, sub, control) =>
    `<div class="p-3.5 flex items-center gap-3 hover:bg-surface-container-low transition-colors"><span class="w-8 h-8 shrink-0 rounded-lg bg-surface-container border border-surface-container-high/60 flex items-center justify-center text-on-surface-variant"><span class="material-symbols-outlined text-[18px]">${icon}</span></span><span class="flex flex-col min-w-0 flex-1"><span class="font-body-md text-[14px] text-on-surface font-semibold tracking-tight">${title}</span><span class="font-body-sm text-[12px] text-on-surface-variant truncate mt-0.5">${sub}</span></span>${control}</div>`;
  const sel = (id, opts) => `<select id="${id}" class="max-w-[10rem] shrink-0 rounded-xl border border-surface-container-high bg-surface-container-low px-3 py-1.5 font-body-sm text-body-sm text-on-surface focus:outline-none">${opts}</select>`;
  const sw = (id) =>
    `<button type="button" id="${id}" role="switch" aria-checked="true" class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors bg-primary"><span class="inline-block h-5 w-5 rounded-full bg-white shadow transition-transform translate-x-5"></span></button>`;
  const sec = (id, head, tag, inner) =>
    `<div class="flex flex-col space-y-2" id="${id}"><div class="flex items-center justify-between px-1"><h2 class="font-label-mono text-[10.5px] uppercase tracking-[0.16em] text-secondary font-semibold">${head}</h2><span class="font-label-mono text-[9.5px] text-secondary font-medium px-2 py-0.5 rounded-full bg-surface-container">${tag}</span></div><div class="bg-surface-container-lowest rounded-2xl border border-surface-container-high/70 shadow-sm overflow-hidden flex flex-col divide-y divide-surface-container-high/60">${inner}</div></div>`;
  const html =
    sec(
      "tm-m-playback",
      "Playback & Audio",
      "AUDIO",
      row("stream", "Streaming quality", "Requested for each track", sel("m-stream-q", "")) +
        row("wifi", "Streaming Wi-Fi", "Quality on Wi-Fi", sel("m-stream-wifi", "")) +
        row("signal_cellular_alt", "Streaming Cellular", "Quality on mobile data", sel("m-stream-cell", "")) +
        row("data_saver_on", "Data Saver", "Force low quality everywhere", sw("m-datasaver")) +
        row("explicit", "Hide explicit", "Skip explicit-tagged tracks", sw("m-explicit")) +
        row("equalizer", "EQ preset", "Tone shaping", sel("m-eq", "")) +
        row("volume_up", "Normalize volume", "Even out loudness", sw("m-normalize")) +
        row("download_for_offline", "Smart downloads", "Auto-save mixes offline", sw("m-smart")) +
        row("all_inclusive", "Gapless playback", "No pause between tracks", sw("m-gapless")) +
        row("history", "Remember position", "Resume where you stopped", sw("m-remember")) +
        row("speed", "Playback speed", "Applies immediately", sel("m-speed", "")),
    ) +
    sec(
      "tm-m-appearance",
      "Appearance & Theme",
      "THEME",
      row("palette", "Theme", "System follows your OS", sel("m-theme", "")) +
        row("density_medium", "Density", "Compact fits more rows", sel("m-density", "")),
    ) +
    sec(
      "tm-m-lyrics",
      "Lyrics & Karaoke",
      "KARAOKE",
      row("unfold_more", "Auto-scroll", "Follow the playhead", sw("m-lyr-auto")) +
        row("mic", "Karaoke highlight", "Words light up as sung", sw("m-lyr-kara")) +
        row("format_size", "Lyric text size", "Base size for lines", sel("m-lyr-size", "")),
    ) +
    sec(
      "tm-m-storage",
      "Storage & Data",
      "STORAGE",
      row("database", "Vault quota", "Over quota evicts least-recently played", sel("m-quota", "")) +
        row("downloading", "Prefetch next track", "Save it while you listen (Wi-Fi)", sw("m-prefetch")) +
        row("cleaning_services", "Cache usage", "Art & lyrics files — vault excluded", `<span id="m-cache-stats" class="shrink-0 w-28 text-right font-label-mono text-[10px] text-on-surface-variant leading-tight">—</span>`) +
        row("save", "Cache limit", "Art & lyrics budget (LRU)", sel("m-cache-budget", "")) +
        row("delete_sweep", "Clear cache", "Never touches your downloads", `<button type="button" id="m-cache-clear" class="shrink-0 rounded-xl border border-surface-container-high bg-surface-container px-3 py-1.5 font-body-sm text-body-sm text-on-surface active:scale-95 transition-all">Clear</button>`) +
        row(
          "upload_file",
          "Import playlist CSV",
          "Spotify Exportify export",
          `<button type="button" id="m-csv-import" class="shrink-0 rounded-xl border border-surface-container-high bg-surface-container px-3 py-1.5 font-body-sm text-body-sm text-on-surface active:scale-95 transition-all">Import</button><input type="file" id="m-csv-file" accept=".csv,text/csv" class="hidden">`,
        ),
    );
  const wrap = m.querySelector("div.space-y-6") || m.firstElementChild || m;
  // Before the Legal block when it exists so prefs stay together.
  const legalH = [...wrap.querySelectorAll("h2")].find((h) => /Legal/i.test(h.textContent));
  const anchor = legalH ? legalH.closest("div.flex.flex-col.space-y-2") : null;
  if (anchor) anchor.insertAdjacentHTML("beforebegin", html);
  else wrap.insertAdjacentHTML("beforeend", html);
  // Wire once (guarded by settingsWired on the parent, but these nodes are new).
  const q = (id) => m.querySelector(`#${id}`);
  q("m-stream-q")?.addEventListener("change", (e) => {
    mSet("tm-stream-quality", e.target.value);
    toast(`Streaming: ${e.target.selectedOptions[0]?.textContent}`, 3000, "success");
  });
  q("m-speed")?.addEventListener("change", (e) => {
    mSet("tm-play-speed", e.target.value);
    try {
      const a = document.getElementById("audio");
      if (a) a.playbackRate = Number(e.target.value) || 1;
    } catch {}
    toast(`Speed ${Number(e.target.value)}x`, 3000, "success");
  });
  q("m-theme")?.addEventListener("change", (e) => {
    mSet("tm-theme", e.target.value);
    applyMobileTheme();
    toast(`Theme: ${e.target.selectedOptions[0]?.textContent}`, 3000, "success");
  });
  q("m-density")?.addEventListener("change", (e) => {
    mSet("tm-density", e.target.value);
    applyMobileTheme();
    toast(`Density: ${e.target.selectedOptions[0]?.textContent}`, 3000, "success");
  });
  q("m-lyr-size")?.addEventListener("change", (e) => {
    mSet("tm-lyrics-size", e.target.value);
    toast(`Lyric size: ${e.target.selectedOptions[0]?.textContent}`, 3000, "success");
  });
  q("m-stream-wifi")?.addEventListener("change", (e) => {
    setEffStreamWifi(e.target.value);
    toast(`Wi-Fi streaming: ${e.target.selectedOptions[0]?.textContent || e.target.value || "Auto"}`, 3000, "success");
  });
  q("m-stream-cell")?.addEventListener("change", (e) => {
    setEffStreamCell(e.target.value);
    toast(`Cellular streaming: ${e.target.selectedOptions[0]?.textContent || e.target.value || "Auto"}`, 3000, "success");
  });
  q("m-eq")?.addEventListener("change", (e) => {
    setEqPreset(e.target.value);
    toast(`EQ: ${e.target.value}`, 3000, "success");
  });
  const flipShared = (id, get, set, msg) => {
    q(id)?.addEventListener("click", () => {
      const on = !get();
      set(on);
      paintMobilePrefs(m);
      toast(msg(on), 3000, "success");
    });
  };
  flipShared("m-datasaver", dataSaver, setDataSaver, (on) => (on ? "Data Saver on — low quality everywhere" : "Data Saver off"));
  flipShared("m-explicit", explicitHidden, setExplicitHidden, (on) => (on ? "Explicit tracks hidden" : "Explicit tracks shown"));
  flipShared("m-normalize", normalizeOn, setNormalize, (on) => (on ? "Volume normalization on" : "Normalization off"));
  flipShared("m-smart", smartDlOn, setSmartDl, (on) => (on ? "Smart downloads on" : "Smart downloads off"));
  const flip = (id, key, msg) => {
    q(id)?.addEventListener("click", () => {
      const on = mGet(key, "1") !== "1";
      mSet(key, on ? "1" : "0");
      paintMobilePrefs(m);
      toast(msg(on), 3000, "success");
    });
  };
  flip("m-gapless", "tm-gapless", (on) => (on ? "Gapless on" : "Gapless off"));
  flip("m-remember", "tm-remember-pos", (on) => (on ? "Resume on" : "Resume off"));
  flip("m-lyr-auto", "tm-lyrics-autoscroll", (on) => (on ? "Lyrics follow you" : "Lyrics stay put"));
  flip("m-lyr-kara", "tm-lyrics-gloss", (on) => (on ? "Karaoke on" : "Karaoke off"));

  // ------------------------------------------- Storage & Data (new 2026-10-07)
  // P0-1 quota + LRU, P0-2 byte-prefetch, cache stats/budget/clear (previously
  // desktop-only UI over already-registered commands), P1-4 Exportify CSV.
  const paintCache = (s) => {
    if (s) lastCacheStats = s;
    const st = m.querySelector("#m-cache-stats");
    if (st && s) {
      st.textContent = `${fmtBytes((s.art_bytes || 0) + (s.lyrics_bytes || 0))} cached · ${fmtBytes(s.budget_bytes || 0)} budget`;
    }
    const bg = m.querySelector("#m-cache-budget");
    if (bg && s && s.budget_bytes) bg.value = String(Math.round(s.budget_bytes / (1024 * 1024)));
  };
  q("m-quota")?.addEventListener("change", (e) => {
    setVaultQuotaGb(e.target.value);
    const gb = e.target.value;
    toast(gb ? `Vault capped at ${gb} GB — least-recently played evicts first` : "Vault quota: unlimited", 3500, "success");
    if (gb) enforceVaultQuota().catch(() => {});
  });
  flipShared("m-prefetch", prefetchOn, setPrefetchOn, (on) =>
    on ? "Prefetch on — the next track saves while you listen" : "Prefetch off",
  );
  q("m-cache-budget")?.addEventListener("change", async (e) => {
    const mb = Number(e.target.value);
    if (!invoke || !(mb > 0)) return;
    try {
      const s = await invoke("cache_set_budget", { mb });
      paintCache(s);
      toast(`Cache limit ${mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`}`, 3000, "success");
    } catch (err) {
      toast(String(err).slice(0, 120), 5000, "error");
    }
  });
  q("m-cache-clear")?.addEventListener("click", async () => {
    if (!invoke) return toast("Backend unavailable", 4000, "error");
    try {
      const s = await invoke("cache_clear");
      paintCache(s);
      toast("Cache cleared — your downloads are untouched", 3500, "success");
    } catch (err) {
      toast(String(err).slice(0, 120), 5000, "error");
    }
  });
  q("m-csv-import")?.addEventListener("click", () => q("m-csv-file")?.click());
  q("m-csv-file")?.addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    toast("Importing CSV — matching tracks…", 4000, "info");
    try {
      const text = await readCsvFile(f);
      const { playlist, matched, missed, errors } = await importCsvToPlaylist(
        text,
        `Imported ${f.name.replace(/\.csv$/i, "")}`,
        invoke,
      );
      if (!playlist || !playlist.tracks.length) {
        toast(`No tracks imported${errors && errors.length ? ` — ${errors[0]}` : ""}`, 5000, "error");
        return;
      }
      const saved = load(LIBRARY_KEY, []);
      // Same record shape as createPlaylist so Library lists it as local.
      saved.unshift({
        ...playlist,
        local: true,
        kind: "playlist",
        subtitle: `${matched} songs`,
        image: "",
        ts: Date.now(),
      });
      save(LIBRARY_KEY, saved);
      toast(
        `Imported ${matched} tracks${missed ? ` — ${missed} not found` : ""}${errors && errors.length ? ` (${errors.length} bad rows skipped)` : ""}`,
        5500,
        "success",
      );
      pushEvent("library", `Imported playlist ${playlist.title}`, `${matched} tracks matched from ${f.name}.`);
    } catch (err) {
      toast(`Import failed: ${String(err).slice(0, 120)}`, 5000, "error");
    }
  });
  if (invoke) invoke("cache_stats").then((s) => paintCache(s)).catch(() => {});
  applyMobileTheme();
}
function paintMobilePrefs(m) {
  if (!m || !m.querySelector("#tm-m-playback")) return;
  const fill = (id, opts, cur) => {
    const el = m.querySelector(`#${id}`);
    if (!el) return;
    el.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`).join("");
  };
  fill("m-stream-q", [["320kbps", "320 kbps — max"], ["160kbps", "160 kbps"], ["96kbps", "96 kbps"], ["64kbps", "64 kbps — saver"]], mGet("tm-stream-quality", "320kbps"));
  fill(
    "m-stream-wifi",
    [["", "Auto"], ["320kbps", "320 kbps — max"], ["160kbps", "160 kbps"], ["96kbps", "96 kbps"], ["64kbps", "64 kbps — saver"]],
    effStreamWifi(),
  );
  fill(
    "m-stream-cell",
    [["", "Auto"], ["320kbps", "320 kbps — max"], ["160kbps", "160 kbps"], ["96kbps", "96 kbps"], ["64kbps", "64 kbps — saver"]],
    effStreamCell(),
  );
  fill(
    "m-eq",
    [["flat", "Flat"], ["bass", "Bass"], ["bassboost", "Bass Boost"], ["pop", "Pop"], ["bright", "Bright"], ["vocal", "Vocal"]],
    eqPreset(),
  );
  fill("m-speed", [["0.75", "0.75x"], ["0.9", "0.9x"], ["1", "1x"], ["1.1", "1.1x"], ["1.25", "1.25x"], ["1.5", "1.5x"]], mGet("tm-play-speed", "1"));
  fill("m-theme", [["system", "System"], ["light", "Light"], ["dark", "Dark"]], mGet("tm-theme", "system"));
  fill("m-density", [["comfortable", "Comfortable"], ["compact", "Compact"]], mGet("tm-density", "comfortable"));
  fill("m-lyr-size", [["s", "Small"], ["m", "Medium"], ["l", "Large"]], mGet("tm-lyrics-size", "m"));
  fill(
    "m-quota",
    [["", "Unlimited"], ["1", "1 GB"], ["2", "2 GB"], ["5", "5 GB"], ["10", "10 GB"], ["20", "20 GB"], ["50", "50 GB"]],
    vaultQuotaGb(),
  );
  fill(
    "m-cache-budget",
    [
      ["100", "100 MB"], ["256", "256 MB"], ["512", "512 MB"], ["1024", "1 GB"],
      ["2048", "2 GB"], ["3072", "3 GB"], ["4096", "4 GB"], ["5120", "5 GB"],
    ],
    lastCacheStats && lastCacheStats.budget_bytes ? String(Math.round(lastCacheStats.budget_bytes / (1024 * 1024))) : "100",
  );
  for (const [id, key, dflt] of [["m-gapless", "tm-gapless", "0"], ["m-remember", "tm-remember-pos", "1"], ["m-lyr-auto", "tm-lyrics-autoscroll", "1"], ["m-lyr-kara", "tm-lyrics-gloss", "1"]]) {
    const btn = m.querySelector(`#${id}`);
    if (btn) paintSwitch(btn, mGet(key, dflt) === "1");
  }
  for (const [id, on] of [["m-datasaver", dataSaver()], ["m-explicit", explicitHidden()], ["m-normalize", normalizeOn()], ["m-smart", smartDlOn()], ["m-prefetch", prefetchOn()]]) {
    const btn = m.querySelector(`#${id}`);
    if (btn) paintSwitch(btn, !!on);
  }
}

function mountSettings() {
  const m = main();
  if (!m) return;
  wireBack(m);
  paintSettings(m);
  paintVersion(m);
  wireLegal(m);
  ensureMobilePrefs(m);
  paintMobilePrefs(m);
  pushPrefs();
  if (m.dataset.settingsWired) return;
  m.dataset.settingsWired = "1";

  // Diagnostics row: the desktop shows the last backend calls on the Search
  // screen; mobile injects it here instead of editing the generated markup.
  const diagRow = (() => {
    const host = [...m.querySelectorAll("div.bg-surface-container-lowest")].pop();
    if (!host) return null;
    const row = document.createElement("button");
    row.type = "button";
    row.dataset.diag = "";
    row.className = "p-3.5 w-full flex items-center gap-3 hover:bg-surface-container-low transition-colors text-left";
    row.innerHTML = `<span class="w-8 h-8 shrink-0 rounded-lg bg-surface-container border border-surface-container-high/60 flex items-center justify-center text-on-surface-variant"><span class="material-symbols-outlined text-[18px]">bug_report</span></span><span class="flex flex-col min-w-0 flex-1"><span class="font-body-md text-[14px] text-on-surface font-semibold tracking-tight">Diagnostics</span><span data-diag-count class="font-body-sm text-[12px] text-on-surface-variant truncate mt-0.5">No backend calls logged yet</span></span><span class="material-symbols-outlined text-secondary shrink-0">chevron_right</span>`;
    host.appendChild(row);
    return row;
  })();
  if (diagRow)
    diagRow.addEventListener("click", () => {
      const entries = readDiag();
      openSheet({
        title: "Diagnostics",
        sub: entries.length ? `Last ${entries.length} backend calls` : "Nothing logged yet",
        rows: entries.map((d) => [
          `${d.ok === true ? "ok" : d.ok === false ? "fail" : "note"} · ${d.name}`,
          d.msg || "—",
        ]),
        items: entries.length
          ? [
              {
                label: "Clear log",
                icon: "delete_sweep",
                action: () => {
                  clearDiag();
                  toast("Diagnostics cleared", 2500, "success");
                  paintDiagCount();
                },
              },
            ]
          : [],
      });
    });
  const paintDiagCount = () => {
    const el = m.querySelector("[data-diag-count]");
    if (!el) return;
    const n = readDiag().length;
    el.textContent = n ? `${n} backend call${n === 1 ? "" : "s"} logged` : "No backend calls logged yet";
  };
  paintDiagCount();

  const name = m.querySelector("#set-name");
  if (name)
    name.addEventListener("change", () => {
      const value = name.value.trim();
      save(NAME_KEY, value);
      name.value = value;
      toast(value ? `Display name: ${value}` : "Display name cleared", 3000, "success");
    });

  // Gemini key for AI lyrics: stored on-device only, shown as dots, applied
  // on change (no save button — typing it in is the whole gesture).
  const gk = m.querySelector("#set-gemini-key");
  if (gk)
    gk.addEventListener("change", () => {
      const value = gk.value.trim();
      setGeminiKey(value);
      gk.value = value;
      toast(value ? "Gemini key saved — AI lyrics unlocked" : "Gemini key cleared", 3000, "success");
    });

  const chips = m.querySelector("#set-langs");
  if (chips)
    chips.addEventListener("click", (e) => {
      const b = e.target.closest("[data-lang]");
      if (!b) return;
      const v = b.dataset.lang;
      let on = prefLangs();
      if (v === "all") on = [];
      else on = on.includes(v) ? on.filter((x) => x !== v) : [...on, v];
      saveLangs(on);
      paintSettings(m);
      pushPrefs();
      toast(on.length ? `Music language: ${on.join(", ")}` : "Music language: all languages", 3000, "success");
    });

  const country = m.querySelector("#set-country");
  if (country)
    country.addEventListener("change", () => {
      save(COUNTRY_KEY, country.value);
      pushPrefs();
      const label = (COUNTRIES.find(([v]) => v === country.value) || [])[1] || "Automatic";
      toast(`Country: ${label}`, 3000, "success");
    });

  const quality = m.querySelector("#set-dl-quality");
  if (quality)
    quality.addEventListener("change", () => {
      setDlQuality(quality.value);
      toast(`New downloads: ${quality.selectedOptions[0] ? quality.selectedOptions[0].textContent : quality.value}`, 3000, "success");
    });

  const au = m.querySelector("#set-autoupdate");
  if (au)
    au.addEventListener("click", () => {
      const on = String(load(AUTOUPDATE_KEY, "1")) !== "1";
      save(AUTOUPDATE_KEY, on ? "1" : "0");
      paintSwitch(au, on);
      toast(on ? "Automatic updates on — checked once a day" : "Automatic updates off", 3000, "success");
    });

  const now = m.querySelector("#set-update-now");
  const status = m.querySelector("#set-update-status");
  const check = m.querySelector("#set-update-check");
  if (check)
    check.addEventListener("click", async () => {
      check.disabled = true;
      if (now) now.textContent = "Checking…";
      const r = await checkForUpdates(false);
      if (now) {
        now.textContent = !r
          ? "Check failed — try again"
          : r.latest
            ? `v${r.current} → v${r.latest.version}`
            : `v${r.current} — up to date`;
      }
      if (status && r && r.latest) status.textContent = r.latest.installable ? "Installing the update" : "A newer version exists";
      check.disabled = false;
    });

  const file = m.querySelector("#set-backup-file");
  m.querySelector("#set-backup-export")?.addEventListener("click", async () => {
    const doc = buildBackup(
      { favorites: load(FAVS_KEY, []), playlists: load(LIBRARY_KEY, []).filter((p) => p && p.local), settings: readSettings() },
      Date.now(),
    );
    const text = JSON.stringify(doc, null, 2);
    const blob = new File([text], backupFilename(doc.exportedAt), { type: "application/json" });
    // The desktop writes through a save dialog; Android has none, so hand the
    // file to the share sheet and fall back to the clipboard.
    try {
      if (navigator.canShare && navigator.canShare({ files: [blob] })) {
        await navigator.share({ files: [blob], title: "TRANCE MUSIC backup" });
        return toast(`Backup shared (${doc.favorites.records.length} favourites)`, 4000, "success");
      }
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast("Backup copied to clipboard", 5000, "success");
    } catch {
      toast("Couldn't share a backup on this device", 5000, "error");
    }
  });

  m.querySelector("#set-backup-restore")?.addEventListener("click", () => file && file.click());
  if (file)
    file.addEventListener("change", async () => {
      const picked = file.files && file.files[0];
      file.value = "";
      if (!picked) return;
      try {
        const applied = applyBackup(parseBackupFile(await picked.text()));
        save(FAVS_KEY, applied.favorites);
        const rest = load(LIBRARY_KEY, []).filter((p) => p && !p.local);
        save(LIBRARY_KEY, [...rest, ...(applied.playlists || [])]);
        writeSettings(applied.settings || {});
        paintFavs();
        mountSettings(); // repaint the controls from the restored settings
        toast(`Restored ${applied.counts.favorites} favourites, ${applied.counts.playlists} playlists`, 5000, "success");
        pushEvent("restore", "Backup restored", `${applied.counts.favorites} favourites and ${applied.counts.playlists} playlists were imported from a backup file.`);
      } catch (e) {
        console.error(e);
        toast(`Restore failed: ${e && e.message ? e.message : e}`, 5000, "error");
      }
    });
}

onPaint(paintNowplaying);

export const MOUNT = {
  home: mountHome,
  search: mountSearch,
  "main-library": mountLibrary,
  "liked-songs": mountLiked,
  download: mountDownload,
  history: mountHistory,
  settings: mountSettings,
  analytics: mountAnalytics,
  notification: mountNotification,
  album: (q) => mountDetail("album", q),
  artist: (q) => mountDetail("artist", q),
  playlist: (q) => mountDetail("playlist", q),
  nowplaying: mountNowplaying,
};

// Called by app.js after a delete and by shared.js after a batch. Only the
// screen that owns the list repaints — every other mount runs on navigation.
hooks.repaintDownload = () => {
  const h = location.hash;
  if (/^#\/(download|downloads)/.test(h)) mountDownload();
};

export { openLib };
