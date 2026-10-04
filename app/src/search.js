// search.js — results rendering, filters/sort/pagination, dedupe, doSearch, suggestions, control wiring
// Split from main.js (Phase 4 M1).
import { art } from "./art.js";
import { clearError, diag, esc, invoke, showError, showView, toast } from "./core.js";
import { $, $$, errorEl } from "./dom.js";
import { fuzzyScore, querySim } from "./fuzzy.js";
import { didYouMean, matchesFilters, parseQuery, rankTracks } from "./query.js";
import { loadHistory, pushHistory } from "./history.js";
import { loadFavs, ddCard, favFill, openDetail, openPlaylist, plCard, playTracksAt, toggleFavTrack } from "./library.js";
import { loadPlays } from "./home.js";
import { playQueueItem } from "./playback.js";
import { enqueue, insertNext, queue, queueIndex, renderQueue, setQueueTab } from "./queue.js";
import { filterLang, prefCountry } from "./settings.js";
import { metaLinks } from "./util.js";
import { downloadTrack } from "./vault.js";

export let lastResults = [];
/// Entity cards for the active search chip (artists / albums / playlists).
export let lastCards = [];
// ------------------------------------------------------------------ search -
export const resultsEl = $("#results");
export const resultsSub = $("#results-sub");

/// Shared "add this track to one of my local playlists" button. The whole
/// track rides in data attributes so one delegated listener can serve every
/// row builder on every screen.
export function addBtn(t) {
  return `<button type="button" data-add-id="${esc(t.id || "")}" data-add-title="${esc(t.title || "")}" data-add-artist="${esc(t.artist || "")}" data-add-album="${esc(t.album || "")}" data-add-image="${esc(t.image || "")}" data-add-dur="${esc(t.duration || "")}" title="Add to playlist" class="w-7 h-7 rounded-full hover:bg-surface-container flex items-center justify-center transition-colors"><span class="material-symbols-outlined text-[17px] text-on-surface-variant hover:text-on-surface">playlist_add</span></button>`;
}

// `variant = "search"` keeps the format/size columns of the catalog table;
// `"list"` swaps them for the album column the playlist table shows.
export function trackRow(t, i, isCurrent, variant = "search") {
  const list = variant === "list";
  const cells = list
    ? `<div class="col-span-3 min-w-0"><span class="text-[13px] text-on-surface-variant truncate block hover:underline cursor-pointer" data-entity-kind="album" data-entity-name="${esc(t.album || "")}">${esc(t.album || "—")}</span></div>
    <div class="col-span-1 text-right text-[12px] font-mono text-on-surface">${esc(t.duration)}</div>`
    : `<div class="col-span-2 flex items-center gap-2">
      <span class="px-2 py-0.5 rounded bg-surface-container text-[11px] font-mono text-on-surface font-medium">${t.hq ? "320 kbps" : "Standard"}</span>
    </div>
    <div class="col-span-1 text-right text-[11px] font-mono text-on-surface-variant">—</div>
    <div class="col-span-1 text-right text-[12px] font-mono text-on-surface">${esc(t.duration)}</div>`;
  return `
  <div class="group grid grid-cols-12 gap-4 items-center px-4 py-4 rounded-xl bg-surface-container-lowest shadow-sm hover:shadow-md transition-all cursor-pointer border border-surface-container-high" data-track-id="${esc(t.id)}" role="button" tabindex="0" aria-label="Play ${esc(t.title)}">
    <div class="col-span-1 flex items-center justify-center">
      ${
        isCurrent
          ? `<div class="flex items-end gap-0.5 h-4 w-4">
               <span class="w-0.5 bg-primary rounded-full animate-pulse h-2"></span>
               <span class="w-0.5 bg-primary rounded-full animate-pulse h-4" style="animation-delay: 150ms;"></span>
               <span class="w-0.5 bg-primary rounded-full animate-pulse h-3" style="animation-delay: 300ms;"></span>
               <span class="w-0.5 bg-primary rounded-full animate-pulse h-1" style="animation-delay: 450ms;"></span>
             </div>`
          : `<span class="text-[12px] font-mono text-on-surface-variant">${String(i + 1).padStart(2, "0")}</span>`
      }
    </div>
    <div class="col-span-5 flex items-center gap-4 min-w-0">
      <div class="relative w-24 h-24 rounded-lg overflow-hidden shrink-0 shadow-sm bg-surface-container">
        <img loading="lazy" alt="" class="w-full h-full object-cover group-hover:scale-105 transition-transform" ${art(t.image)} />
      </div>
      <div class="flex flex-col min-w-0">
        <span class="text-[15px] font-medium text-on-surface truncate" dir="auto">${esc(t.title)}</span>
        <span class="text-[13px] text-on-surface-variant truncate">${metaLinks(t)}</span>
      </div>
    </div>
    ${cells}
    <div class="col-span-2 flex items-center justify-end gap-1">
      <button type="button" data-row-action="next" title="Play next" class="w-6 h-6 rounded-full hover:bg-surface-container flex items-center justify-center transition-colors">
        <span class="material-symbols-outlined text-[17px] text-on-surface">skip_next</span>
      </button>
      <button type="button" data-row-action="queue" title="Add to queue" class="w-6 h-6 rounded-full hover:bg-surface-container flex items-center justify-center transition-colors">
        <span class="material-symbols-outlined text-[17px] text-on-surface">queue_music</span>
      </button>
      <button type="button" data-row-action="fav" title="Favorite this track" class="w-7 h-7 rounded-full hover:bg-surface-container flex items-center justify-center transition-colors">
        <span class="material-symbols-outlined text-[18px] text-on-surface" data-fav-icon="${esc(t.id)}"${favFill(t.id)}>favorite</span>
      </button>
      <button type="button" data-row-action="download" title="Download this track" class="w-7 h-7 rounded-full hover:bg-surface-container flex items-center justify-center transition-colors">
        <span class="material-symbols-outlined text-[18px] text-on-surface">download</span>
      </button>
      ${addBtn(t)}
    </div>
  </div>`;
}

/// Tracks behind the rows last painted into `resultsEl`, so the one
/// delegated listener below can resolve a click without a per-row closure.
let rowTracks = [];

export function renderResults(tracks) {
  paintResultsMode();
  rowTracks = tracks;
  // Build off-DOM, then attach once: N appendChild calls inside the live
  // document mean N reflows, a fragment means one (review 4.2).
  const frag = document.createDocumentFragment();
  tracks.forEach((t, i) => {
    const wrap = document.createElement("div");
    wrap.innerHTML = trackRow(t, i, i === queueIndex && queue[queueIndex]?.track.id === t.id);
    const row = wrap.firstElementChild;
    row.dataset.ri = String(i);
    frag.appendChild(row);
  });
  resultsEl.innerHTML = "";
  resultsEl.appendChild(frag);
  renderFeatured();
  updateLoadMore();
}

// One pair of listeners on the persistent container instead of click +
// keydown closures on every row (review 4.2: event delegation).
resultsEl.addEventListener("click", (e) => {
  const row = e.target.closest("[data-ri]");
  if (!row) return;
  const t = rowTracks[Number(row.dataset.ri)];
  if (!t) return;
  const action = e.target.closest("[data-row-action]")?.dataset.rowAction;
  if (action === "download") {
    e.stopPropagation();
    downloadTrack(t, e.target.closest("button"));
    return;
  }
  if (action === "fav") {
    e.stopPropagation();
    toggleFavTrack(t);
    return;
  }
  if (action === "queue" || action === "next") {
    e.stopPropagation();
    const where = action === "next" ? insertNext(t) : enqueue(t);
    toast(
      action === "next"
        ? `"${t.title}" plays next.`
        : `"${t.title}" queued at position ${where + 1}.`,
      "success",
      2200,
    );
    diag("queue", null, `${action}: ${t.title}`);
    return;
  }
  playTrack(t);
});
resultsEl.addEventListener("keydown", (e) => {
  const row = e.target.closest("[data-track-id]");
  if (!row || e.target !== row) return;
  const t = rowTracks[Number(row.dataset.ri)];
  if (!t) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    playTrack(t);
  }
});

// ---------------------------------------------------- filters, order, pages -
export const PAGE_SIZE = 20;
export const FEATURED_PER_PAGE = 3;
/// Singular backend kind + card label per non-track chip.
export const KIND_SPEC = {
  artists: { kind: "artist", one: "artist", many: "artists" },
  albums: { kind: "album", one: "album", many: "albums and movies" },
  playlists: { kind: "playlist", one: "playlist", many: "playlists" },
};
export const SORTS = [
  { key: "relevance", label: "Relevance: Best match" },
  { key: "bitrate", label: "Bitrate: Descending" },
  { key: "popular", label: "Popularity: Descending" },
  { key: "longest", label: "Duration: Longest" },
  { key: "title", label: "Title: A–Z" },
];
/// Which chip is active: "tracks" (the table) or a key of KIND_SPEC.
export let activeFilter = "tracks";
/// The parsed form of `searchQuery`: which filters the user typed, and the
/// text that is left to send upstream. `null` before the first search.
export let parsed = null;
export let sortIndex = 0;
export let searchPage = 1;
export let searchQuery = "";
export let loadingMore = false;
export let searchExhausted = false;
// Sequence guard: every new search supersedes in-flight ones, so a slow
// response can never overwrite the results of a newer query.
export let searchSeq = 0;
export let featuredPage = 0;

// ----------------------------------------------------- boot search snapshot -
// Last launch's first page, so the search screen the app opens on has rows
// before the network answers. Revalidated by the in-flight doSearch below.
const SEARCH_SNAP_KEY = "tm-search";
function searchSnapshot(q) {
  try {
    const s = JSON.parse(localStorage.getItem(SEARCH_SNAP_KEY) || "null");
    return s && s.q === q && s.f === activeFilter && Array.isArray(s.tracks) ? s : null;
  } catch {
    return null;
  }
}
function saveSearchSnapshot(q, tracks) {
  try {
    localStorage.setItem(SEARCH_SNAP_KEY, JSON.stringify({ q, f: activeFilter, tracks }));
  } catch {} // quota — a nicety, never an error
}

// Per-query client-side filters (review 3.1): text within results plus
// year / language / duration / artist / album / mood selects. They narrow
// `currentView()` only, never the stored `lastResults`, so pagination
// dedupe stays intact.
export let withinQuery = "";
export let yearFilter = "";
export let langFilter = "";
export let durFilter = "";
export let artistFilter = "";
export let albumFilter = "";
export let moodFilter = "";

export const filtersActive = () =>
  !!(withinQuery || yearFilter || langFilter || durFilter || artistFilter || albumFilter || moodFilter);

// ponytail: the catalog carries no mood metadata, so mood is derived from
// title/album keywords — the honest ceiling for this dataset.
const MOOD_KEYWORDS = {
  chill: ["chill", "relax", "ambient", "calm", "downtempo", "lofi", "lo-fi", "sleep", "dreamy"],
  party: ["party", "dance", "club", "remix", "edm", "festival", "hype"],
  energy: ["workout", "gym", "energy", "power", "run", "pump", "beast"],
  focus: ["focus", "study", "concentrate", "instrumental", "piano"],
  romantic: ["love", "romantic", "romance", "pyaar", "ishq", "crush", "heart"],
  sad: ["sad", "heartbreak", "breakup", "blue", "lonely", "miss you", "dard"],
};

export function moodOf(t) {
  const hay = `${t.title || ""} ${t.album || ""}`.toLowerCase();
  for (const [mood, words] of Object.entries(MOOD_KEYWORDS)) {
    if (words.some((w) => hay.includes(w))) return mood;
  }
  return "";
}

function passesFilters(t) {
  if (withinQuery) {
    const hay = `${t.title || ""} ${t.artist || ""} ${t.album || ""}`.toLowerCase();
    if (!hay.includes(withinQuery)) return false;
  }
  if (yearFilter) {
    const y = parseInt(t.year, 10);
    if (yearFilter === "unknown") {
      if (Number.isFinite(y)) return false;
    } else if (!Number.isFinite(y) || Math.floor(y / 10) * 10 !== Number(yearFilter)) {
      return false;
    }
  }
  if (langFilter) {
    const langs = String(t.language || "").toLowerCase().split(",");
    if (!langs.includes(langFilter)) return false;
  }
  if (durFilter) {
    const s = t.duration_secs || 0;
    if (durFilter === "short" && !(s > 0 && s < 180)) return false;
    if (durFilter === "mid" && !(s >= 180 && s <= 300)) return false;
    if (durFilter === "long" && !(s > 300)) return false;
  }
  if (artistFilter && (t.artist || "").toLowerCase() !== artistFilter) return false;
  if (albumFilter && (t.album || "").toLowerCase() !== albumFilter) return false;
  if (moodFilter && moodOf(t) !== moodFilter) return false;
  return true;
}

/// Rebuild the language select from what the current results actually carry,
/// keeping the user's pick when it still exists.
export function refreshLangOptions() {
  const sel = $("#filter-lang");
  if (!sel) return;
  const langs = [...new Set(lastResults.flatMap((t) =>
    String(t.language || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean),
  ))].sort();
  const keep = langFilter;
  sel.innerHTML =
    `<option value="">All languages</option>` +
    langs.map((l) => `<option value="${esc(l)}">${esc(l[0].toUpperCase() + l.slice(1))}</option>`).join("");
  langFilter = langs.includes(keep) ? keep : "";
  sel.value = langFilter;
  sel.disabled = langs.length === 0;
}

/// Artist + album selects rebuilt from the same page of results, keeping
/// the user's pick when it still exists (mirrors refreshLangOptions).
export function refreshFacetOptions() {
  for (const [selId, values, state] of [
    ["#filter-artist", [...new Set(lastResults.map((t) => (t.artist || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)), "artistFilter"],
    ["#filter-album", [...new Set(lastResults.map((t) => (t.album || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)), "albumFilter"],
  ]) {
    const sel = $(selId);
    if (!sel) continue;
    const label = state === "artistFilter" ? "Any artist" : "Any album";
    const keep = state === "artistFilter" ? artistFilter : albumFilter;
    const lower = values.map((v) => v.toLowerCase());
    sel.innerHTML =
      `<option value="">${label}</option>` +
      values.map((v, i) => `<option value="${esc(lower[i])}">${esc(v)}</option>`).join("");
    const still = lower.includes(keep) ? keep : "";
    if (state === "artistFilter") artistFilter = still;
    else albumFilter = still;
    sel.value = still;
    sel.disabled = values.length === 0;
  }
}

export const isTracks = () => activeFilter === "tracks";
/// Rows behind the active chip — the table and the card grid both page these.
export const currentItems = () => (isTracks() ? lastResults : lastCards);

/// Taste signals for the relevance boost, read once per repaint rather than
/// once per row: what this listener played, what they hearted, and how often
/// each artist shows up. ponytail: no negative signal yet — there is no
/// "dislike" store to read, and inventing one here would be a lie.
function tasteContext() {
  const played = new Set();
  const artistPlays = new Map();
  for (const p of loadPlays()) {
    played.add(p.id);
    if (p.artist) artistPlays.set(p.artist, (artistPlays.get(p.artist) || 0) + 1);
  }
  return { played, liked: new Set(loadFavs().map((f) => f.id)), artistPlays, region: prefCountry(), moodOf };
}

/// The tracks the table and the featured cards show right now:
/// filtered by the attribute selects *and* by whatever the query itself
/// asked for ("kesariya 2022"), then ordered by the active sort — relevance
/// being fuzzy text score plus the query's own filters and this listener's
/// taste.
export function currentView() {
  const list = lastResults.filter(passesFilters);
  const by = SORTS[sortIndex].key;
  if (by === "relevance") {
    if (!searchQuery.trim()) return list;
    const q = parsed || parseQuery(searchQuery);
    const opts = tasteContext();
    const scored = list.filter((t) => matchesFilters(t, q));
    // The query's filters can empty the page (a language nothing speaks).
    // Falling back beats showing the user nothing.
    return rankTracks(scored.length ? scored : list, q, textScoreFor(q), opts);
  }
  return list.sort((a, b) => {
    if (by === "bitrate") {
      return (b.hq ? 1 : 0) - (a.hq ? 1 : 0) || b.plays - a.plays;
    }
    if (by === "popular") return b.plays - a.plays;
    if (by === "longest") return b.duration_secs - a.duration_secs;
    return a.title.localeCompare(b.title);
  });
}

/// The text-score function query.js ranks with, bound to one parsed query.
function textScoreFor(q) {
  return (t) => fuzzyScore(q.text || q.raw, t.title, t.artist, t.album);
}

export function refreshResults() {
  if (!isTracks()) return; // a chip switch raced this repaint
  const list = currentView();
  renderResults(list);
  refreshLangOptions();
  refreshFacetOptions();
  if (!lastResults.length) {
    resultsSub.textContent = searchQuery
      ? `No track results for "${searchQuery}".`
      : "Search the catalog - results appear here.";
    return;
  }
  resultsSub.textContent = filtersActive() && list.length !== lastResults.length
    ? `Showing ${list.length} of ${lastResults.length} results for "${searchQuery}"`
    : `Showing ${list.length} results for "${searchQuery}"`;
  // A query filter that matched nothing must be said out loud rather than
  // silently dropped: the rows on screen are unfiltered, so claiming
  // "filtered by punjabi" would be a lie.
  const asked = parsed && (parsed.languages.length || parsed.year || parsed.decade || parsed.yearRange);
  if (asked && list.length === lastResults.length && queryFilterKeptNothing()) {
    const want = parsed.languages.length
      ? parsed.languages.join(" / ")
      : parsed.yearRange
        ? parsed.yearRange.join("–")
        : parsed.year || `${parsed.decade}s`;
    resultsSub.textContent = `No "${searchQuery}" results match ${want} — showing everything instead.`;
  }
}

/// Did the query's own filters reject every row? Kept separate from
/// `filtersActive()`, which is about the attribute selects, not the query.
function queryFilterKeptNothing() {
  if (!parsed) return false;
  return lastResults.length > 0 && !lastResults.some((t) => matchesFilters(t, parsed));
}

/// Table chrome only means anything for songs; chips swap it for a card grid.
export function paintResultsMode() {
  const cards = !isTracks();
  $("#results-head")?.classList.toggle("hidden", cards);
  $("#play-all")?.classList.toggle("hidden", cards);
  $("#sort-wrap")?.classList.toggle("hidden", cards);
  $("#filter-attrs")?.classList.toggle("hidden", cards);
  resultsEl.className = cards ? "grid grid-cols-2 sm:grid-cols-4 gap-4" : "flex flex-col gap-2";
}

/// The card grid behind the Artists / Albums / Playlists chips.
export function renderCards() {
  if (isTracks()) return; // a chip switch raced this repaint
  paintResultsMode();
  const spec = KIND_SPEC[activeFilter];
  resultsEl.innerHTML = lastCards.map(cardHtml).join("");
  updateLoadMore();
  if (!searchQuery) {
    resultsSub.textContent = `Search for ${spec.many}, then tap one to hear it.`;
  } else if (!lastCards.length) {
    resultsSub.textContent = `No ${spec.many} for "${searchQuery}".`;
  } else {
    resultsSub.textContent = `Showing ${lastCards.length} ${spec.many} for "${searchQuery}"`;
  }
}

/// One card in the grid: playlists open by id, albums/artists by token.
export function cardHtml(item) {
  return activeFilter === "playlists" ? plCard(item) : ddCard(KIND_SPEC[activeFilter].kind, item);
}

/// "View all" from Home: the home rows are only a taste of the feed, so hand
/// the whole list to the search grid, which already renders any card type.
export function browseCards(chip, items, label) {
  const list = uniqById(items || []);
  if (!list.length) return toast(`${label} unavailable right now.`, "info");
  activeFilter = chip;
  lastCards = list;
  searchQuery = "";
  searchPage = 1;
  searchExhausted = true; // the whole feed, so no "load more" behind it
  loadingMore = false;
  const input = $("#search-input");
  if (input) input.value = "";
  showView("search");
  renderCards(); // after the switch, so the grid is painted on arrival
  paintChips();
  resultsSub.textContent = `All ${list.length} ${label.toLowerCase()}.`;
  resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function paintChips() {
  for (const chip of $$(".filter-chip")) {
    const on = (chip.dataset.chip || "tracks") === activeFilter;
    chip.setAttribute("aria-pressed", String(on));
    chip.classList.toggle("bg-primary", on);
    chip.classList.toggle("text-on-primary", on);
    chip.classList.toggle("shadow-sm", on);
    chip.classList.toggle("bg-surface-container", !on);
    chip.classList.toggle("text-on-surface-variant", !on);
  }
}

export function paintSort() {
  const label = $("#sort-label");
  if (label) label.textContent = SORTS[sortIndex].label;
  const opts = $("#sort-opts");
  if (opts) {
    opts.innerHTML = SORTS.map(
      (s, i) =>
        `<button type="button" data-sort-i="${i}" class="text-left px-2.5 py-1.5 rounded-lg font-label-md text-label-md ${i === sortIndex ? "bg-primary text-on-primary" : "text-on-surface hover:bg-surface-container"}">${s.label}</button>`,
    ).join("");
  }
}

export function updateLoadMore() {
  const btn = $("#load-more");
  if (!btn) return;
  // `searchExhausted` is set from the backend's page_full flag — the deduped
  // list can be shorter than PAGE_SIZE while more pages still exist.
  const have = currentItems().length;
  btn.classList.toggle("hidden", !(have > 0 && !searchExhausted));
  const label = $("#load-more-label");
  if (label) {
    label.textContent = loadingMore ? "Loading…" : `Load more results (${have} so far)`;
  }
}

// ---------------------------------------------------------------- featured -
export function featuredCard(t) {
  return `
  <div class="group relative bg-surface-container-lowest rounded-xl p-4 shadow-sm hover:shadow-md transition-all duration-200 flex flex-col justify-between overflow-hidden" data-featured-id="${esc(t.id)}">
    <div class="flex flex-col gap-3.5">
      <div class="relative w-full aspect-square rounded-lg overflow-hidden bg-primary-container">
        <img alt="" loading="lazy" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" ${art(t.image)} />
        <div class="absolute top-2.5 left-2.5 px-2 py-0.5 rounded bg-primary/80 backdrop-blur text-on-primary font-label-mono text-[10px] tracking-wide uppercase">
          ${t.hq ? "320 kbps" : "Master"}
        </div>
        <button type="button" data-action="play" title="Play this track" class="absolute bottom-3 right-3 w-10 h-10 rounded-full bg-on-primary text-primary flex items-center justify-center shadow-lg opacity-90 group-hover:opacity-100 group-hover:scale-105 transition-all">
          <span class="material-symbols-outlined text-[20px]" style="font-variation-settings: 'FILL' 1;">play_arrow</span>
        </button>
      </div>
      <div>
        <div class="flex items-center justify-between gap-2">
          <h3 class="font-headline-md text-headline-md text-on-surface truncate">${esc(t.title)}</h3>
          <span class="font-label-mono text-label-mono text-on-surface-variant shrink-0">${esc(t.duration)}</span>
        </div>
        <p class="font-body-md text-body-md text-on-surface-variant truncate">${esc([t.artist, t.album].filter(Boolean).join(" · "))}</p>
      </div>
    </div>
    <div class="pt-3 mt-3 flex items-center justify-between bg-surface-container-low px-3 py-2 rounded-lg">
      <div class="flex items-center gap-1.5 min-w-0">
        <span class="material-symbols-outlined text-[14px] text-on-surface">graphic_eq</span>
        <span class="font-label-mono text-label-mono text-on-surface font-medium truncate">${t.hq ? "320 kbps" : "Standard"}</span>
      </div>
      <button type="button" data-action="fav" class="flex items-center justify-center w-7 h-7 rounded bg-surface-container-lowest hover:bg-primary hover:text-on-primary text-on-surface transition-colors shadow-xs" title="Favorite this track">
        <span class="material-symbols-outlined text-[15px]" data-fav-icon="${esc(t.id)}"${favFill(t.id)}>favorite</span>
      </button>
      <button type="button" data-action="download" class="download-action-btn flex items-center justify-center w-7 h-7 rounded bg-surface-container-lowest hover:bg-primary hover:text-on-primary text-on-surface transition-colors shadow-xs" title="Download this track">
        <span class="material-symbols-outlined text-[15px]">download</span>
      </button>
    </div>
  </div>`;
}

export function renderFeatured() {
  const grid = $("#featured-grid");
  if (!grid) return;
  const list = currentView();
  const pages = Math.max(1, Math.ceil(list.length / FEATURED_PER_PAGE));
  featuredPage = Math.min(Math.max(featuredPage, 0), pages - 1);
  const start = featuredPage * FEATURED_PER_PAGE;
  grid.innerHTML = list
    .slice(start, start + FEATURED_PER_PAGE)
    .map((t) => featuredCard(t))
    .join("");
  const prev = $("#featured-prev");
  const next = $("#featured-next");
  if (prev) prev.disabled = pages <= 1;
  if (next) next.disabled = pages <= 1;
}

// ------------------------------------------------------------------ search -
export function showErrorRetry(msg, retry) {
  errorEl.innerHTML = "";
  const span = document.createElement("span");
  span.textContent = msg;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "error-retry";
  btn.className =
    "ml-3 px-2.5 py-1 rounded border border-current font-label-md text-label-md transition-opacity hover:opacity-70";
  btn.textContent = "Retry";
  btn.addEventListener("click", retry);
  errorEl.append(span, btn);
  errorEl.classList.remove("hidden");
}

// ------------------------------------------------------- duplicate guard -
// Mirrors the backend `dedup_tracks` collapse (original vs remaster vs
// re-billed copies under different ids): candidates bucket by normalized
// title, then merge when the artist bills agree (order-insensitive, extra
// credits tolerated) and durations are within ±3s — keeping the 320 kbps
// copy, then most plays.
export const DEDUP_DURATION_TOL = 3;
export const DEDUP_KEEP_WORDS = new Set([
  "live", "remix", "remixed", "acoustic", "unplugged", "edit", "mix",
  "version", "cover", "karaoke", "instrumental", "demo", "reimagined",
  "rework", "slowed", "reverb", "sped", "nightcore", "extended", "club",
  "radio",
]);

export function normKeyText(s) {
  const lower = String(s || "").toLowerCase();
  // Bracketed groups are version tags ("(Remastered 2024)") and are
  // dropped — unless they mark a different recording ("(Live)").
  let kept = "";
  let depth = 0;
  let inner = "";
  for (const c of lower) {
    if (c === "(" || c === "[") {
      if (depth === 0) inner = "";
      depth += 1;
      if (depth > 1) inner += c;
    } else if (c === ")" || c === "]") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0) {
        if (inner.split(/[^\p{L}\p{N}]+/u).some((w) => DEDUP_KEEP_WORDS.has(w))) kept += " " + inner;
        inner = "";
      } else {
        inner += c;
      }
    } else if (depth === 0) {
      kept += c;
    } else {
      inner += c;
    }
  }
  if (depth > 0) kept += " " + inner;
  return kept
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !["remaster", "remastered", "remastering"].includes(w) && !/^\d{4}$/.test(w))
    .join(" ");
}

/// Split a credit string into comparable artist names (mirror of the
/// backend `credit_names`): lowercase, split on `, ; & /` and the
/// `feat`/`ft`/`featuring` markers; hyphenated billing stays one name.
export function artistNames(s) {
  const names = new Set();
  let cur = [];
  const flush = () => {
    if (cur.length) {
      names.add(cur.join(" "));
      cur = [];
    }
  };
  for (const segment of String(s || "").toLowerCase().split(/[,;&/]/)) {
    for (const raw of segment.split(/\s+/)) {
      const w = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      if (!w) continue;
      if (w === "feat" || w === "ft" || w === "featuring") flush();
      else cur.push(w);
    }
    flush();
  }
  return names;
}

/// True when two credit lists plausibly bill the same artist set: at least
/// half of the smaller list matches (order never matters; empty is no
/// evidence, so it never merges).
export function creditsOverlap(a, b) {
  if (!a.size || !b.size) return false;
  let common = 0;
  for (const name of a) if (b.has(name)) common += 1;
  return common * 2 >= Math.min(a.size, b.size);
}

/// title -> [{ i, dur, artists }] so duplicate lookups over a list are a
/// map hit instead of an O(n²) scan.
export function contentIndex(list) {
  const idx = new Map();
  list.forEach((t, i) => {
    if (!t.id || !(t.duration_secs > 0)) return;
    const key = normKeyText(t.title);
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push({ i, dur: t.duration_secs, artists: artistNames(t.artist) });
  });
  return idx;
}

/// Index of the kept track that `t` duplicates, else -1. Fingerprint-less
/// tracks (no id or no duration) only ever match themselves, like backend.
export function findDuplicate(index, t) {
  if (!t.id || !(t.duration_secs > 0)) return -1;
  const cands = index.get(normKeyText(t.title));
  if (!cands) return -1;
  const artists = artistNames(t.artist);
  const hit = cands.find(
    (c) =>
      Math.abs(c.dur - t.duration_secs) <= DEDUP_DURATION_TOL &&
      creditsOverlap(c.artists, artists),
  );
  return hit ? hit.i : -1;
}

/// Refresh the index entry for position `i` after its track was replaced
/// with a better copy (duration/credits may differ).
export function reindexEntry(index, t, i) {
  const bucket = index.get(normKeyText(t.title));
  if (!bucket) return;
  const at = bucket.findIndex((c) => c.i === i);
  const entry = { i, dur: t.duration_secs, artists: artistNames(t.artist) };
  if (at >= 0) bucket[at] = entry;
  else bucket.push(entry);
}

export function betterCopy(a, b) {
  if (!!a.hq !== !!b.hq) return !!a.hq;
  if ((a.plays || 0) !== (b.plays || 0)) return (a.plays || 0) > (b.plays || 0);
  if (String(a.title).length !== String(b.title).length) {
    return String(a.title).length < String(b.title).length;
  }
  return false;
}

/// Collapse same-id repeats and same-recording/different-id copies.
/// Returns `{ list, removed }` so callers can report the cleanup.
export function dedupeTracks(tracks) {
  const seenIds = new Set();
  const index = new Map();
  const out = [];
  let removed = 0;
  for (const t of tracks) {
    if (t.id && seenIds.has(t.id)) {
      removed += 1;
      continue;
    }
    if (t.id) seenIds.add(t.id);
    const at = findDuplicate(index, t);
    if (at >= 0) {
      removed += 1;
      if (betterCopy(t, out[at])) {
        out[at] = t;
        reindexEntry(index, t, at);
      }
      continue;
    }
    if (t.id && t.duration_secs > 0) {
      const key = normKeyText(t.title);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({
        i: out.length,
        dur: t.duration_secs,
        artists: artistNames(t.artist),
      });
    }
    out.push(t);
  }
  return { list: out, removed };
}

/// First copy of each id wins — card/row level insurance, mirrors the
/// backend `dedup_feed`. Id-less entries pass through (nothing to collide).
export function uniqById(list) {
  const seen = new Set();
  return (list || []).filter((x) => {
    if (!x) return false;
    if (!x.id) return true;
    if (seen.has(x.id)) return false;
    seen.add(x.id);
    return true;
  });
}

export async function doSearch(opts = {}) {
  const append = !!opts.append;
  const silent = !!opts.silent;
  const q = String(opts.query ?? $("#search-input").value).trim();
  hideSuggest();
  if (!q) {
    resultsSub.textContent = "Type a query, then press Search.";
    return;
  }
  if (append && (loadingMore || searchExhausted || !currentItems().length)) return;

  if (append) loadingMore = true;
  else {
    featuredPage = 0;
    searchExhausted = false;
    hideDidYouMean();
  }
  clearError();
  updateLoadMore();
  searchQuery = q;
  // Understand the query before anything is sent: "arijit singh punjabi 2022"
  // is a search for "arijit singh" *plus* two filters, and forwarding the
  // whole string upstream returns nothing at all.
  parsed = parseQuery(q);
  const upstream = parsed.text;
  if (parsed.wantsEntity && parsed.wantsEntity !== "tracks") {
    const kind = KIND_SPEC[parsed.wantsEntity]?.kind;
    if (kind && activeFilter !== parsed.wantsEntity) {
      activeFilter = parsed.wantsEntity;
      paintChips();
    }
  }
  const navInput = $("#nav-search-input");
  if (navInput) navInput.value = q;
  // Fresh searches navigate to the view (top of results). Appends stay
  // exactly where the user clicked Load more — showView() would toTop().
  if (!silent && !append) {
    pushHistory(q);
    showView("search");
  }
  // Tell the user what was understood, so a stripped filter is visible rather
  // than silently applied.
  const understood = [];
  if (parsed.languages.length) understood.push(parsed.languages.join(" / "));
  if (parsed.year) understood.push(String(parsed.year));
  if (parsed.decade) understood.push(`${parsed.decade}s`);
  if (parsed.yearRange) understood.push(parsed.yearRange.join("–"));
  if (parsed.region) understood.push(parsed.region);
  if (parsed.artist) understood.push(`@${parsed.artist}`);
  if (parsed.album) understood.push(`#${parsed.album}`);
  if (parsed.mood) understood.push(`${parsed.mood} mood`);
  resultsSub.textContent = append
    ? `Loading page ${searchPage + 1} for "${q}"…`
    : understood.length
      ? `Searching for "${upstream}" — filtered by ${understood.join(", ")}`
      : `Searching for "${q}"…`;

  // Capture the scope before awaiting: a chip click mid-flight must not
  // route entity rows into the track table (or vice versa).
  const cards = !isTracks();
  const kind = cards ? KIND_SPEC[activeFilter].kind : null;
  const seq = ++searchSeq;
  // Instant first paint: last launch's rows go up now; the fetch below
  // supersedes them through the searchSeq guard above.
  if (!append && !cards && !lastResults.length) {
    const snap = searchSnapshot(q);
    if (snap) {
      lastResults = snap.tracks;
      refreshResults();
    }
  }
  let payload;
  try {
    payload = cards
      ? await invoke("search_entities", { query: upstream, kind, limit: PAGE_SIZE, page: append ? searchPage + 1 : 1 })
      : await invoke("search_songs", { query: upstream, limit: PAGE_SIZE, page: append ? searchPage + 1 : 1 });
  } catch (err) {
    loadingMore = false;
    updateLoadMore();
    if (seq !== searchSeq) return; // a newer search owns the UI now
    diag(`search "${q}"`, false, String(err));
    resultsSub.textContent = append
      ? `Could not load more results for "${q}".`
      : "Search failed.";
    showErrorRetry(`Search failed: ${err}`, () => doSearch({ append, query: q }));
    return;
  }
  loadingMore = false;
  updateLoadMore();
  if (seq !== searchSeq) return; // stale response: a newer search superseded it
  // Both commands answer with `page_full`, measured BEFORE dedup shrank the
  // page, so it — never the list length — decides whether more exist upstream.
  const pageFull = !!(payload && payload.page_full);
  if (cards) return applyEntityPage(payload, append, q, pageFull, KIND_SPEC[activeFilter]);

  const tracks = (payload && payload.tracks) || [];

  if (!append) {
    searchPage = 1;
    // Backend collapses upstream repeats, but a stale page can still hand
    // us dupes — dedupe defensively before first paint.
    const clean = dedupeTracks(tracks);
    lastResults = filterLang(clean.list);
    searchExhausted = !pageFull;
    if (!lastResults.length) {
      resultsEl.innerHTML = "";
      paintResultsMode();
      renderFeatured();
      updateLoadMore();
      resultsSub.textContent = `No tracks found for "${q}".`;
      showErrorRetry(`No tracks found for "${q}".`, () => doSearch({ query: q }));
      showDidYouMean(q, seq);
      return;
    }
    diag(
      `search "${q}"`,
      true,
      `${lastResults.length} tracks${clean.removed ? ` (${clean.removed} dupes removed)` : ""}`,
    );
    refreshResults();
    saveSearchSnapshot(q, lastResults);
    // SQLite song cache: search pages feed offline lists + instant repaints.
    try {
      const page = lastResults.slice(0, 50);
      import("./store_db.js").then((m) => m.cacheSongs(page).catch(() => {}));
    } catch {}
    return;
  }

  // Append: drop anything already shown (by id or by content) and collapse
  // repeats inside the new page itself.
  const known = new Set(lastResults.map((t) => t.id));
  const index = contentIndex(lastResults);
  const base = lastResults.length;
  const fresh = [];
  for (const t of tracks) {
    if (t.id && known.has(t.id)) continue;
    const at = findDuplicate(index, t);
    if (at >= 0) {
      const stored = at >= base ? fresh[at - base] : lastResults[at];
      if (stored && betterCopy(t, stored)) {
        if (at >= base) fresh[at - base] = t;
        else lastResults[at] = t;
        reindexEntry(index, t, at);
      }
      continue;
    }
    if (t.id) known.add(t.id);
    if (t.id && t.duration_secs > 0) {
      const key = normKeyText(t.title);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({
        i: base + fresh.length,
        dur: t.duration_secs,
        artists: artistNames(t.artist),
      });
    }
    fresh.push(t);
  }
  searchPage += 1;
  if (!pageFull || !fresh.length) searchExhausted = true;
  if (!fresh.length) {
    diag(`search "${q}"`, true, "no further pages");
    updateLoadMore();
    resultsSub.textContent = `End of results — ${lastResults.length} tracks for "${q}".`;
    return;
  }
  lastResults = lastResults.concat(filterLang(fresh));
  diag(`search "${q}" page ${searchPage}`, true, `+${fresh.length} tracks`);
  refreshResults();
  try {
    import("./store_db.js").then((m) => m.cacheSongs(fresh.slice(0, 50)).catch(() => {}));
  } catch {}
}

/// Fold one entity page into `lastCards` and repaint the card grid.
/// `spec` is the chip that issued the request, not whatever is active now.
export function applyEntityPage(payload, append, q, pageFull, spec) {
  const items = (payload && payload.items) || [];
  if (!append) {
    searchPage = 1;
    lastCards = uniqById(items);
    searchExhausted = !pageFull;
    diag(`search "${q}" ${activeFilter}`, true, `${lastCards.length} cards`);
    if (!lastCards.length) {
      renderCards();
      showErrorRetry(`No ${spec.many} found for "${q}".`, () => doSearch({ query: q }));
      return;
    }
    renderCards();
    return;
  }
  const known = new Set(lastCards.map((c) => c.id));
  const fresh = items.filter((c) => !known.has(c.id));
  searchPage += 1;
  if (!pageFull || !fresh.length) searchExhausted = true;
  if (!fresh.length) {
    diag(`search "${q}" ${activeFilter}`, true, "no further pages");
    updateLoadMore();
    resultsSub.textContent = `End of results — ${lastCards.length} ${spec.many} for "${q}".`;
    return;
  }
  lastCards = lastCards.concat(fresh);
  diag(`search "${q}" ${activeFilter} page ${searchPage}`, true, `+${fresh.length} cards`);
  renderCards();
}

// ------------------------------------------------- did you mean + groups -
export function hideDidYouMean() {
  $("#did-you-mean")?.classList.add("hidden");
}

/// Typo recovery: when a query returns nothing, ask the autocomplete endpoint
/// for nearby titles and offer the closest as a one-tap re-search. The
/// listener's own earlier queries are a second source — they cost nothing and
/// are the likeliest thing they meant to type.
export async function showDidYouMean(q, seq) {
  let s;
  try {
    s = await invoke("search_suggestions", { query: q });
  } catch {
    return;
  }
  if (seq !== searchSeq || lastResults.length) return;
  const remote = [s?.top, ...(s?.songs || [])].filter(Boolean);
  const cands = didYouMean(q, [...remote, ...loadHistory().map((t) => ({ title: t }))], (a, b) =>
    querySim(a, b),
  );
  const box = $("#did-you-mean");
  if (!box || !cands.length) return;
  box.innerHTML =
    `<span class="font-body-sm text-body-sm text-on-surface-variant">Did you mean</span>` +
    cands.map((c) =>
      `<button type="button" data-dym="${esc(c.title)}" class="px-3 py-1 rounded-full bg-surface-container text-on-surface font-label-md text-label-md hover:bg-surface-container-high transition-colors underline">${esc(c.title)}</button>`,
    ).join("");
  box.classList.remove("hidden");
}

$("#did-you-mean")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-dym]");
  if (!btn) return;
  $("#search-input").value = btn.dataset.dym;
  doSearch();
});

/// Open whichever entity a suggestion row stands for — shared by the
/// dropdown's keyboard/click handlers.
export function activateSuggestion(kind, item) {
  hideSuggest();
  if (kind === "song") playTracksAt([{ ...item, artist: item.subtitle, album: "", duration: 0 }], 0);
  else if (kind === "playlist") openPlaylist(item);
  else openDetail(kind, item);
  diag("suggest pick", null, `${kind}: ${item.title}`);
}

// ---------------------------------------------------- inline suggestions -
export const suggestEl = $("#search-suggest");
export let suggestTimer = 0;
export let suggestSeq = 0;

export function hideSuggest() {
  suggestEl?.classList.add("hidden");
}

export const sugLabel = (label) =>
  `<div class="px-4 pt-2.5 pb-1 font-label-mono text-label-mono text-on-surface-variant">${esc(label)}</div>`;

/// One dropdown row: thumb, title, credit — carrying everything the click
/// handler needs to act without a lookup.
export function suggestRow(it, kind) {
  const icon =
    { song: "music_note", album: "album", artist: "person", playlist: "queue_music" }[kind] ||
    "music_note";
  const thumb = it.image
    ? `<img alt="" loading="lazy" class="w-9 h-9 rounded object-cover shrink-0" ${art(it.image)} />`
    : `<span class="w-9 h-9 rounded bg-surface-container-high flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-[18px] text-on-surface-variant">${icon}</span></span>`;
  return `<button type="button" data-sug-kind="${esc(kind)}" data-sug-id="${esc(it.id)}" data-sug-token="${esc(it.token || "")}" data-sug-title="${esc(it.title)}" data-sug-sub="${esc(it.subtitle || "")}" data-sug-img="${esc(it.image || "")}" class="w-full flex items-center gap-3 px-4 py-2 hover:bg-surface-container-low transition-colors text-left">
    ${thumb}
    <span class="min-w-0 flex-1">
      <span class="block font-body-md text-body-md font-medium text-on-surface truncate">${esc(it.title)}</span>
      <span class="block font-body-sm text-body-sm text-on-surface-variant truncate">${esc(it.subtitle || kind)}</span>
    </span>
    <span class="font-label-mono text-[10px] uppercase tracking-wider text-on-surface-variant shrink-0">${esc(kind)}</span>
  </button>`;
}

export function suggestHtml(s) {
  const parts = [];
  // The standalone "Top result" header is gone; its row is folded into the
  // group it belongs to instead of being dropped, so the best match is still
  // listed first — just without its own section, and never twice.
  const groups = {
    songs: [...((s && s.songs) || [])],
    albums: [...((s && s.albums) || [])],
    artists: [...((s && s.artists) || [])],
    playlists: [...((s && s.playlists) || [])],
  };
  const top = s && s.top;
  if (top) {
    const key = `${(s && s.top_kind) || "song"}s`;
    const bucket = groups[key] || groups.songs;
    if (bucket && !bucket.some((it) => it.id === top.id)) bucket.unshift(top);
  }
  for (const [key, label] of [
    ["songs", "Songs"],
    ["albums", "Albums"],
    ["artists", "Artists"],
    ["playlists", "Playlists"],
  ]) {
    const items = groups[key];
    if (!items.length) continue;
    const kind = key.slice(0, -1);
    parts.push(sugLabel(label), items.map((it) => suggestRow(it, kind)).join(""));
  }
  return parts.length
    ? parts.join("")
    : `<div class="px-4 py-3 font-body-sm text-body-sm text-on-surface-variant">No suggestions.</div>`;
}

/// Empty box ? the last searched queries, one tap from re-running them.
export function renderRecentSuggest() {
  if (!suggestEl) return;
  const recent = [...new Set(loadHistory())].slice(0, 6);
  if (!recent.length) {
    hideSuggest();
    return;
  }
  suggestEl.innerHTML =
    sugLabel("Recent searches") +
    recent
      .map(
        (q) =>
          `<button type="button" data-sug-q="${esc(q)}" class="w-full flex items-center gap-3 px-4 py-2 hover:bg-surface-container-low transition-colors text-left">
            <span class="w-9 h-9 rounded bg-surface-container-high flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-[18px] text-on-surface-variant">history</span></span>
            <span class="font-body-md text-body-md text-on-surface truncate">${esc(q)}</span>
          </button>`,
      )
      .join("");
  suggestEl.classList.remove("hidden");
}

export async function fetchSuggest(q) {
  const seq = ++suggestSeq;
  try {
    const s = await invoke("search_suggestions", { query: q });
    if (seq !== suggestSeq) return; // a newer keystroke already superseded this
    suggestEl.innerHTML = suggestHtml(s);
    suggestEl.classList.remove("hidden");
    diag(
      "suggest",
      true,
      `${(s.top ? 1 : 0) + s.songs.length + s.albums.length + s.artists.length + s.playlists.length} rows`,
    );
  } catch (err) {
    diag("suggest", false, String(err).slice(0, 90));
  }
}

$("#search-input").addEventListener("input", () => {
  const q = $("#search-input").value.trim();
  clearTimeout(suggestTimer);
  if (q.length >= 2) suggestTimer = setTimeout(() => fetchSuggest(q), 250);
  else if (!q) renderRecentSuggest();
  else hideSuggest();
});
$("#search-input")?.addEventListener("focus", () => {
  const q = $("#search-input").value.trim();
  if (!q) renderRecentSuggest();
  else if (q.length >= 2) fetchSuggest(q);
});

suggestEl?.addEventListener("click", (e) => {
  const qbtn = e.target.closest("[data-sug-q]");
  if (qbtn) {
    $("#search-input").value = qbtn.dataset.sugQ;
    hideSuggest();
    doSearch();
    return;
  }
  const btn = e.target.closest("[data-sug-kind]");
  if (!btn) return;
  activateSuggestion(btn.dataset.sugKind, {
    id: btn.dataset.sugId,
    token: btn.dataset.sugToken,
    title: btn.dataset.sugTitle,
    subtitle: btn.dataset.sugSub,
    image: btn.dataset.sugImg,
  });
});

// Clicking away closes the dropdown (inputs/buttons inside it stay live).
document.addEventListener("click", (e) => {
  if (!suggestEl || suggestEl.classList.contains("hidden")) return;
  if (e.target.closest("#search-suggest") || e.target.closest("#search-input")) return;
  hideSuggest();
});

// --------------------------------------------------------- control wiring -
for (const chip of $$(".filter-chip")) {
  chip.addEventListener("click", () => {
    const next = chip.dataset.chip || "tracks";
    if (next === activeFilter) return;
    activeFilter = next;
    featuredPage = 0;
    paintChips();
    const q = $("#search-input").value.trim();
    if (q) doSearch({ query: q });
    else if (isTracks()) refreshResults();
    else renderCards();
    diag("search scope", null, next);
  });
}
paintChips();
paintSort();

const sortMenu = $("#sort-menu");
function hideSortMenu() {
  sortMenu?.classList.add("hidden");
  $("#sort-btn")?.setAttribute("aria-expanded", "false");
}
$("#sort-btn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = sortMenu?.classList.toggle("hidden") ?? true;
  $("#sort-btn").setAttribute("aria-expanded", String(!open));
  if (open) return;
  const r = e.currentTarget.getBoundingClientRect();
  sortMenu.style.top = `${r.bottom + 4}px`;
  sortMenu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  paintSort();
});
sortMenu?.addEventListener("click", (e) => {
  e.stopPropagation();
  const b = e.target.closest("[data-sort-i]");
  if (!b) return;
  sortIndex = Number(b.dataset.sortI);
  paintSort();
  refreshResults();
  hideSortMenu();
  diag("sort", null, SORTS[sortIndex].label);
});
document.addEventListener("click", (e) => {
  if (!sortMenu || sortMenu.classList.contains("hidden")) return;
  if (e.target.closest("#sort-menu") || e.target.closest("#sort-btn")) return;
  hideSortMenu();
});

$("#refine-btn")?.addEventListener("click", () => {
  const bar = $("#filter-bar");
  const btn = $("#refine-btn");
  if (!bar || !btn) return;
  const hidden = bar.classList.toggle("hidden");
  btn.setAttribute("aria-expanded", String(!hidden));
  const label = $("#refine-label");
  if (label) label.textContent = hidden ? "Show Types" : "Hide Types";
  if (!hidden) $(".filter-chip")?.focus();
});

// Attribute filters (review 3.1): client-side narrowing of the loaded page.
$("#filter-within")?.addEventListener("input", (e) => {
  withinQuery = e.target.value.toLowerCase().trim();
  refreshResults();
});
$("#filter-year")?.addEventListener("change", (e) => {
  yearFilter = e.target.value;
  refreshResults();
});
$("#filter-lang")?.addEventListener("change", (e) => {
  langFilter = e.target.value;
  refreshResults();
});
$("#filter-dur")?.addEventListener("change", (e) => {
  durFilter = e.target.value;
  refreshResults();
});
$("#filter-artist")?.addEventListener("change", (e) => {
  artistFilter = e.target.value;
  refreshResults();
});
$("#filter-album")?.addEventListener("change", (e) => {
  albumFilter = e.target.value;
  refreshResults();
});
$("#filter-mood")?.addEventListener("change", (e) => {
  moodFilter = e.target.value;
  refreshResults();
});

$("#featured-prev")?.addEventListener("click", () => {
  featuredPage -= 1;
  renderFeatured();
  diag("featured", null, `page ${featuredPage + 1}`);
});
$("#featured-next")?.addEventListener("click", () => {
  featuredPage += 1;
  renderFeatured();
  diag("featured", null, `page ${featuredPage + 1}`);
});
$("#featured-grid")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  // Resolve by id, never by position: re-sorting between render and click
  // must not point the index at the wrong track.
  const holder = btn.closest("[data-featured-id]");
  const id = holder ? holder.dataset.featuredId : null;
  const track = id ? currentView().find((t) => t.id === id) : null;
  if (!track) {
    // Static placeholders only exist before the first search resolves.
    const input = $("#search-input");
    if (input && !input.value.trim()) input.value = "trance";
    doSearch({ query: input ? input.value : "" });
    return;
  }
  if (btn.dataset.action === "download") downloadTrack(track, btn);
  else if (btn.dataset.action === "fav") toggleFavTrack(track);
  else playTrack(track);
});

$("#load-more")?.addEventListener("click", () => doSearch({ append: true }));

export function playTrack(track) {
  playQueueItem(enqueue(track));
}

$("#search-btn").addEventListener("click", doSearch);
$("#nav-search-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#nav-search-input").value.trim();
  if (!v) return;
  $("#search-input").value = v;
  doSearch();
});
$("#nav-search-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("#nav-search-input").value = "";
});
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    showView("search");
    $("#nav-search-input")?.focus();
  }
});
$("#search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doSearch();
  if (e.key === "Escape") {
    $("#search-input").value = "";
    hideSuggest();
  }
});
$("#search-clear").addEventListener("click", () => {
  $("#search-input").value = "";
  $("#search-input").focus();
});
$("#play-all").addEventListener("click", () => {
  const list = currentView();
  if (!list.length) {
    showError("Nothing to play — run a search first.");
    return;
  }
  queue.length = 0;
  for (const t of list) queue.push({ track: t, state: null });
  setQueueTab("next");
  renderQueue();
  playQueueItem(0);
});


// Setters for state rebound from other modules (ESM imports are read-only).
export function setActiveFilter(v) { activeFilter = v; }
