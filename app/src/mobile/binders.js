// binders.js — paints real backend data into each static design screen.
import { esc } from "../html.js";
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
} from "./shared.js";
import { buildBackup, parseBackupFile, applyBackup, readSettings, writeSettings, backupFilename } from "../sync.js";
import { playList, playerState, onPaint, toggle, next, prev, seek, toggleShuffle, cycleRepeat, repaint } from "./player.js";
import { ensureReco, isRadioOn, setRadioOn } from "./radio.js";
import { renderLyrics, resetLyrics, syncLyrics } from "./lyrics.js";
import { netMode } from "./net.js";
import { licensesHTML, aboutHTML, termsHTML } from "./legal.js";

const main = () => document.querySelector("#screen main");

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

function wireBack(m) {
  const b = [...m.querySelectorAll("button")].find(
    (btn) =>
      !btn.dataset.backWired &&
      (btn.getAttribute("aria-label") === "Collapse" ||
        [...btn.querySelectorAll(".material-symbols-outlined")].some((s) => /arrow_back|chevron_left|arrow_back_ios/.test(s.textContent))),
  );
  if (b) {
    b.dataset.backWired = "1";
    b.addEventListener("click", () => history.back());
  }
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

  // Charts are playlists too, and the design has no shelf of their own — fold
  // them into the curated carousel so every chart is reachable and playable.
  const curated = [...(feed.charts || []), ...(feed.playlists || [])].filter(
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

  // Two shelves the feed already returns but the shell never painted: new
  // releases and the daily-updating playlists. Built in JS so the design
  // fragment stays untouched.
  const root = m.querySelector("section")?.parentElement;
  const shelves = [
    ["tm-shelf-albums", "New Releases", (feed.albums || []).map((a, i) => plCardHTML(a, i, entityNav("album", a)))],
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

async function mountSearch(query) {
  const m = main();
  if (!m) return;
  const q = (query && query.get("q")) || "";
  const cat = (query && query.get("cat")) || "all";
  const input = document.getElementById("search-input");
  if (input) input.value = q;
  // The field is white on a near-white surface; a hairline makes it read as an
  // input instead of empty space.
  const fieldWrap = input && input.closest(".relative");
  if (fieldWrap) fieldWrap.classList.add("border", "border-surface-container-high");

  // Commit the typed query (Enter, or a recommendation tap) as one hash. The
  // active category rides along so the next screen filters the same way.
  const commit = (text) => {
    const next = String(text == null ? (input ? input.value : q) : text).trim();
    if (!next) return;
    hideSug();
    go(`search?q=${encodeURIComponent(next)}${cat !== "all" ? `&cat=${cat}` : ""}`);
  };

  // --- inline suggestions ------------------------------------------------
  // One debounced autocomplete call per keystroke burst; the sequence token
  // stops a slow response from painting over a newer query.
  const sugBox = document.createElement("div");
  sugBox.id = "m-suggest";
  sugBox.className = "hidden flex-col rounded-xl bg-surface-container-lowest border border-surface-container shadow-md overflow-y-auto max-h-[55vh]";
  const sugHost = input && (input.closest(".relative") || input.closest("section"));
  if (sugHost && sugHost.parentElement) sugHost.parentElement.insertBefore(sugBox, sugHost.nextElementSibling);

  const hideSug = () => {
    sugBox.classList.add("hidden");
    sugBox.classList.remove("flex");
  };
  const showSug = (html) => {
    sugBox.innerHTML = html;
    sugBox.classList.remove("hidden");
    sugBox.classList.add("flex");
  };

  const sugIcon = { song: "music_note", album: "album", artist: "person", playlist: "queue_music" };
  const sugRow = (it, kind) =>
    `<button type="button" data-sug-kind="${kind}" data-sug-id="${esc(it.id || "")}" data-sug-token="${esc(it.token || "")}" data-sug-title="${esc(it.title || "")}" data-sug-sub="${esc(it.subtitle || "")}" data-sug-img="${esc(it.image || "")}" class="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-container transition-colors border-b border-surface-container/60 last:border-b-0">
      <div class="w-9 h-9 rounded bg-surface-container-highest overflow-hidden shrink-0 flex items-center justify-center">${
        it.image
          ? `<img alt="" loading="lazy" class="w-full h-full object-cover" ${art(it.image)}>`
          : `<span class="material-symbols-outlined text-[18px] text-on-surface-variant">${sugIcon[kind] || "music_note"}</span>`
      }</div>
      <div class="flex flex-col min-w-0 flex-1">
        <span class="font-body-md text-body-md text-on-surface truncate">${esc(it.title || "")}</span>
        <span class="font-body-sm text-[11px] text-secondary truncate">${esc(it.subtitle || kind)}</span>
      </div>
      <span class="font-label-mono text-[10px] uppercase tracking-wider text-secondary shrink-0">${esc(kind)}</span>
    </button>`;
  const sugLabel = (label) => `<div class="px-3 pt-2 pb-1 font-label-mono text-[10px] uppercase tracking-wider text-secondary">${esc(label)}</div>`;

  const suggestHtml = (s) => {
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
    const parts = [];
    for (const [key, label] of [["songs", "Songs"], ["albums", "Albums"], ["artists", "Artists"], ["playlists", "Playlists"]]) {
      if (!groups[key].length) continue;
      parts.push(sugLabel(label), groups[key].map((it) => sugRow(it, key.slice(0, -1))).join(""));
    }
    return parts.length ? parts.join("") : '<div class="px-3 py-3 font-body-sm text-secondary">No suggestions.</div>';
  };

  const recentSuggest = () => {
    const hist = load(HISTORY_KEY, []);
    if (!hist.length) {
      hideSug();
      return;
    }
    showSug(
      sugLabel("Recent searches") +
        hist
          .slice(0, 6)
          .map(
            (s) =>
              `<button type="button" data-sug-q="${esc(s)}" class="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-container transition-colors border-b border-surface-container/60 last:border-b-0"><span class="material-symbols-outlined text-[18px] text-secondary">history</span><span class="font-body-md text-body-md text-on-surface truncate">${esc(s)}</span></button>`,
          )
          .join(""),
    );
  };

  let sugTimer = 0;
  let sugSeq = 0;
  const fetchSuggest = async () => {
    const text = input ? input.value.trim() : "";
    const mine = ++sugSeq;
    try {
      const s = await invoke("search_suggestions", { query: text });
      if (mine !== sugSeq) return; // a newer keystroke already superseded this
      showSug(suggestHtml(s));
    } catch (e) {
      if (mine === sugSeq) hideSug();
      console.error(e);
    }
  };

  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
      }
    });
    input.addEventListener("input", () => {
      clearTimeout(sugTimer);
      const text = input.value.trim();
      if (!invoke) return;
      if (text.length >= 2) sugTimer = setTimeout(fetchSuggest, 250);
      else if (!text) recentSuggest();
      else hideSug();
    });
    input.addEventListener("focus", () => {
      const text = input.value.trim();
      if (!text) recentSuggest();
      else if (text.length >= 2) fetchSuggest();
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
      go(entityNav(kind, { id: b.dataset.sugId, token: b.dataset.sugToken, title: b.dataset.sugTitle, subtitle: b.dataset.sugSub, image: b.dataset.sugImg }));
    }
  });

  // --- category chips ----------------------------------------------------
  // Active state is derived from `data-category`, not from the static markup,
  // so a deep link or back-navigation restores the right chip.
  m.querySelectorAll(".filter-chip").forEach((chip) => {
    const key = chip.dataset.category || "all";
    const active = key === cat;
    chip.classList.toggle("bg-primary", active);
    chip.classList.toggle("text-on-primary", active);
    chip.classList.toggle("shadow-sm", active);
    chip.classList.toggle("bg-surface-container-high", !active);
    chip.classList.toggle("text-on-surface-variant", !active);
    chip.addEventListener("click", () => {
      const text = (input ? input.value : q).trim();
      hideSug();
      go(`search?q=${encodeURIComponent(text)}${key !== "all" ? `&cat=${key}` : ""}`);
    });
  });

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
  });

  const topSec = [...m.querySelectorAll("section")].find((s) => s.textContent.includes("Top result"));
  const entityKinds = { albums: "album", artists: "artist", playlists: "playlist" };
  const navOf = (it, k) => entityNav(k, it);

  let results = [];
  // One-query snapshot: the offline fallback repaints the last successful
  // search verbatim (mirrors the desktop's tm-search behaviour).
  const SEARCH_SNAP_KEY = "tm-search-snap";
  const snapKey = `${q}::${cat}`;
  if (q && invoke) {
    try {
      if (netMode() === "offline") throw new Error("offline");
      if (entityKinds[cat]) {
        const r = await invoke("search_entities", { query: q, kind: entityKinds[cat], limit: 30, page: 1 });
        results = r.items || [];
      } else {
        const r = await invoke("search_songs", { query: q, limit: cat === "hires" ? 50 : 30, page: 1 });
        results = r.tracks || [];
        // Hi-Res chip: the catalog already tags each track, so the chip
        // filters this page instead of asking a different endpoint.
        if (cat === "hires") results = results.filter((t) => t.hq);
      }
      pushHistory(q);
      save(SEARCH_SNAP_KEY, { key: snapKey, results });
    } catch (e) {
      const snap = load(SEARCH_SNAP_KEY, null);
      if (snap && snap.key === snapKey && Array.isArray(snap.results) && snap.results.length) {
        results = snap.results;
        toast("Offline — showing saved results", 3500, "info");
      } else {
        console.error(e);
        if (String(e) !== "Error: offline") toast(`Search failed: ${String(e).split("\n")[0].slice(0, 70)}`, 5000, "error");
        else toast("You're offline — search needs a network", 3500, "info");
      }
    }
  }

  if (topSec) {
    const first = results[0];
    if (!first) {
      topSec.classList.add("hidden");
    } else {
      topSec.classList.remove("hidden");
      if (first.image) paintArt(topSec.querySelector("img"), first.image);
      const kind = entityKinds[cat];
      const typeEl = [...topSec.querySelectorAll("span")].find((sp) => /^(song|album|artist|playlist)$/i.test(sp.textContent.trim()));
      if (typeEl) typeEl.textContent = kind || "Song";
      const h3 = topSec.querySelector("h3");
      if (h3) h3.textContent = first.title || "";
      const p = topSec.querySelector("p");
      if (p) p.textContent = [first.artist || first.subtitle, first.year].filter(Boolean).join(" • ") || p.textContent;
      const card = topSec.querySelector('div[class*="rounded-xl"]');
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
    }
  }

  let box = document.getElementById("sm-results");
  if (!box) {
    box = document.createElement("div");
    box.id = "sm-results";
    (topSec || m.firstElementChild).insertAdjacentElement("afterend", box);
  }
  const head = '<div class="font-label-mono text-label-sm text-secondary uppercase tracking-wider px-1 pt-3 pb-1">Results</div>';
  if (!q || !results.length) {
    box.className = "flex flex-col gap-1";
    box.innerHTML = q ? '<div class="font-body-sm text-secondary py-4 text-center">No matches</div>' : "";
  } else if (entityKinds[cat]) {
    box.className = "grid grid-cols-2 gap-3 items-start";
    box.innerHTML = head + results.map((e, i) => (entityKinds[cat] === "artist" ? artistCardHTML(e, i, navOf(e, "artist")) : plCardHTML(e, i, navOf(e, entityKinds[cat])))).join("");
  } else {
    box.className = "flex flex-col gap-1";
    setList("sres", results);
    box.innerHTML = head + results.slice(1).map((t, i) => rowHTML("sres", i + 1, t)).join("");
  }
  paintFavs();
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
    const saved = load(LIBRARY_KEY, []);
    const n = saved.filter((x) => x.local).length + 1;
    saved.unshift({ id: `local-${Date.now()}`, local: true, kind: "playlist", title: `New Playlist ${n}`, subtitle: "0 songs", tracks: [], image: "", ts: Date.now() });
    save(LIBRARY_KEY, saved);
    window.showToast(`Created "New Playlist ${n}"`);
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
  if (activeBlock) activeBlock.classList.add("hidden");

  const box = [...m.querySelectorAll("div")].find((d) => d.className.includes("rounded-xl") && d.className.includes("p-space-xs"));
  setList("dls", entries);
  if (box) {
    box.innerHTML = entries.length
      ? entries
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
            <button type="button" data-rm="${esc(e.path)}" class="w-8 h-8 flex items-center justify-center text-secondary hover:text-on-surface transition-colors" aria-label="Remove"><span class="material-symbols-outlined text-[18px]">delete</span></button>
            <button type="button" aria-label="More options" class="w-8 h-8 flex items-center justify-center text-secondary hover:text-on-surface transition-colors"><span class="material-symbols-outlined text-[18px]">more_vert</span></button>
            <button type="button" class="w-9 h-9 flex items-center justify-center rounded-full text-on-surface" aria-hidden="true"><span class="material-symbols-outlined text-[20px]">play_arrow</span></button>
          </div>
        </div>`,
          )
          .join("")
      : '<div class="py-space-md text-center font-body-sm text-secondary">No downloads yet</div>';
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
function paintDetail(m, kind, tracks, meta) {
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
  void paintMoreBy(m, tracks, t.lead.album_id, title);
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
    <div class="relative w-full aspect-square rounded-lg overflow-hidden mb-space-sm bg-surface-container-highest"><img alt="" loading="lazy" class="w-full h-full object-cover" ${art(it.image)}></div>
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
  if (row) row.innerHTML = releases.map((r) => shelfCardHTML(r, "album")).join("");
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
      paintDetail(m, kind, asTracks(await withSnap(`album:${token || id}`, () => invoke("album_tracks", { token }))), meta);
      wireHeaderDownload(m, "album tracks");
    } else if (kind === "playlist" && q.get("local")) {
      // Locally created playlists never reach the network — they live in
      // LIBRARY_KEY and previously opened nowhere at all.
      const rec = load(LIBRARY_KEY, []).find((x) => x.id === id);
      if (!rec) return toast("Playlist not found");
      paintDetail(
        m,
        kind,
        rec.tracks || [],
        meta.title ? meta : { title: rec.title, subtitle: rec.subtitle, image: rec.image, count: String((rec.tracks || []).length) },
      );
      wireHeaderDownload(m, "playlist tracks");
    } else if (kind === "playlist") {
      paintDetail(m, kind, asTracks(await withSnap(`playlist:${id}`, () => invoke("playlist_tracks", { id }))), meta);
      wireHeaderDownload(m, "playlist tracks");
    } else await mountArtist(m, token, meta);
  } catch (e) {
    console.error(e);
    if (String(e) === "Error: offline") toast("You're offline — open this again after connecting", 4000, "info");
    else toast(String(e).slice(0, 100), 5000, "error");
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
      box.innerHTML = '<span class="font-body-sm text-secondary italic">Nothing playing</span>';
    }
    return;
  }
  // Keyed per box as well as per track: remounting NowPlaying rebuilds the
  // card, and its placeholder lines must be replaced again for the same track.
  if (lyricsFor === t.id && lyricsBox === box) return;
  lyricsFor = t.id;
  lyricsBox = box;
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
    renderLyrics(box, r || {});
  } catch (e) {
    console.error(e);
    if (token !== lyricToken) return;
    lyricsFailed.add(t.id);
    box.innerHTML = LYRICS_UNAVAILABLE;
  }
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
    const title = m.querySelector('[class*="font-headline-lg"]');
    if (title && t.title) setTxt(title, t.title);
    // The artist line lives beside the title (p.font-body-md); the only
    // font-headline-md in <main> is the middle lyrics line — painting it
    // would overwrite the lyrics with the artist name.
    const titleEl = m.querySelector("h1.font-headline-lg");
    const headerArtist = titleEl && titleEl.parentElement && titleEl.parentElement.querySelector("p.font-body-md");
    const artist = headerArtist || m.querySelector("p.font-body-md");
    if (artist && t.artist) setTxt(artist, t.artist);
    // Only the header credit is stamped: the fallback match can land on a
    // lyric line, and a lyric tap must mean "seek", not "open artist".
    if (headerArtist && t.artist) {
      headerArtist.dataset.entityName = "";
      headerArtist.dataset.entityKind = "artist";
    }
    const artImg = m.querySelector("img");
    if (artImg && t.image) paintArt(artImg, t.image);
    const fi = document.getElementById("favorite-icon");
    if (fi) fi.dataset.favIcon = t.id || "";
    paintFavs();
  }

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

  const key = `${st.qi}:${st.queue.length}:${t ? t.id : ""}`;
  if (key !== upNextKey) {
    upNextKey = key;
    const row0 = m.querySelector('div[class*="p-2 rounded-xl"]');
    const host = row0 && row0.parentElement;
    if (host) {
      const rest = st.queue.slice(st.qi + 1);
      host.innerHTML = rest.length
        ? rest
            .map((x, i) => `<div data-list="npq" data-idx="${st.qi + 1 + i}" class="p-2 rounded-xl bg-surface-container-lowest border border-surface-container/60 cursor-pointer active:bg-surface-container-low transition-colors">
            <div class="flex items-center gap-3 min-w-0">
              <div class="w-10 h-10 rounded-lg bg-surface-container-highest overflow-hidden shrink-0"><img alt="" class="w-full h-full object-cover" ${art(x.image)}></div>
              <div class="flex flex-col min-w-0 flex-1">
                <span class="font-body-md font-medium text-on-surface truncate">${esc(x.title || "")}</span>
                <span class="font-body-sm text-[11px] text-secondary truncate">${esc(x.artist || "")}</span>
              </div>
            </div>
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

function mountNowplaying() {
  const m = main();
  if (!m) return;
  wireBack(m);
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
      const card = fullBtn.closest("div.rounded-xl");
      if (!card) return;
      const on = card.classList.toggle("tm-lyrics-full");
      fullBtn.textContent = on ? "Close" : "Full View";
      requestAnimationFrame(() => syncLyrics());
    });
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
    fresh.addEventListener("click", () => {
      const row0 = m.querySelector('div[class*="p-2 rounded-xl"]');
      const host = row0 && row0.parentElement;
      if (host) host.scrollIntoView({ behavior: "smooth", block: "end" });
      else toast("Nothing queued", 2500);
    });
  }
  document.getElementById("master-play-pause")?.addEventListener("click", () => toggle());
  m.querySelector('[aria-label="Next"]')?.addEventListener("click", () => next());
  m.querySelector('[aria-label="Previous"]')?.addEventListener("click", () => prev());
  document.getElementById("shuffle-btn")?.addEventListener("click", () => toggleShuffle());
  document.getElementById("repeat-btn")?.addEventListener("click", () => cycleRepeat());
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
    if (t) toggleFav(t);
  });
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
  const findBtn = (re) => [...m.querySelectorAll("button")].find((b) => re.test(b.getAttribute("aria-label") || ""));
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
const APP_VERSION = "0.3.0";

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

function mountSettings() {
  const m = main();
  if (!m) return;
  wireBack(m);
  paintSettings(m);
  paintVersion(m);
  wireLegal(m);
  pushPrefs();
  if (m.dataset.settingsWired) return;
  m.dataset.settingsWired = "1";

  const name = m.querySelector("#set-name");
  if (name)
    name.addEventListener("change", () => {
      const value = name.value.trim();
      save(NAME_KEY, value);
      name.value = value;
      toast(value ? `Display name: ${value}` : "Display name cleared", 3000, "success");
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
