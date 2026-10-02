// util.js — fmt helpers, np text, entity meta links
// Split from main.js (Phase 4 M1).
import { diag, esc, invoke, showError } from "./core.js";
import { openDetail } from "./library.js";

/// One-line text fill for the Now Playing metadata tiles.
export function npText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

/// Remember which entity a plain text element stands for, so the shared
/// capture-phase click handler can open its screen later.
export function stampEntity(el, kind, name) {
  if (!el) return;
  if (name) {
    el.dataset.entityKind = kind;
    el.dataset.entityName = name;
  } else {
    delete el.dataset.entityKind;
    delete el.dataset.entityName;
  }
}

/// Split a credits string the way the catalog indexes it — "Arijit Singh,
/// Nikhita Gandhi" or "Sonu Nigam & Shreya Ghoshal" are three artists, and
/// handing the whole line to a search returns one arbitrary page for every
/// row on screen.
export function creditNames(s) {
  return String(s || "")
    .split(/,|&/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/// Per-name artist links for a row that has room for them; the first names
/// only, since a truncated cell has none to spare.
export function artistLinks(artist, max = 3) {
  const names = creditNames(artist);
  const one = (n) =>
    `<span class="hover:underline cursor-pointer" data-entity-kind="artist" data-entity-name="${esc(n)}">${esc(n)}</span>`;
  const shown = names.slice(0, max).map(one).join('<span class="opacity-60">, </span>');
  const rest = names.length > max ? `<span class="opacity-60"> +${names.length - max}</span>` : "";
  return shown + rest;
}

/// "Artist · Album" where each half is a link to its own page.
export function metaLinks(t) {
  const one = (kind, value) =>
    `<span class="hover:underline cursor-pointer" data-entity-kind="${esc(kind)}" data-entity-name="${esc(value)}">${esc(value)}</span>`;
  const parts = creditNames(t.artist).map((n) => one("artist", n));
  if (t.album) parts.push(one("album", t.album));
  return parts.join('<span class="opacity-60"> · </span>');
}

/// Rows only carry plain names — one search turns the name into a token,
/// then the same artist/album screen the home cards open.
export async function openEntityByName(kind, name) {
  const raw = String(name || "").trim();
  if (!raw) return;
  // JioSaavn sometimes ships "Artist - Title" inside the artist field, and a
  // row stamped with a whole credits line looks up its first name — the same
  // first name `creditNames` hands `metaLinks`.
  const query =
    kind === "artist" ? (creditNames(raw)[0] || "").split(/\s+-\s+/)[0].trim() : raw;
  if (!query) return;
  diag("entity", null, `${kind}: ${query}`);
  let page;
  try {
    page = await invoke("search_entities", { query, kind, limit: 8, page: 1 });
  } catch (err) {
    diag("entity", false, String(err));
    showError(`Could not look up that ${kind}: ${err}`);
    return;
  }
  const items = page?.items || [];
  // Exact title wins: a fuzzy first hit is how every artist used to open the
  // same page. Falls back to a prefix match, then to the old first hit.
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const want = norm(query);
  const hit = items.find((it) => norm(it.title) === want) ||
    items.find((it) => norm(it.title).startsWith(want)) ||
    items[0];
  if (!hit) {
    showError(`No ${kind} found for "${query}".`);
    return;
  }
  openDetail(kind, hit);
}

export function fmtBytes(n) {
  if (!n) return "?";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}
export function fmtTime(s) {
  if (!Number.isFinite(s)) return "00:00";
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}
