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

/// "Artist · Album" where each half is a link to its own page.
export function metaLinks(t) {
  const one = (kind, value) =>
    `<span class="hover:underline cursor-pointer" data-entity-kind="${esc(kind)}" data-entity-name="${esc(value)}">${esc(value)}</span>`;
  const parts = [];
  if (t.artist) parts.push(one("artist", t.artist));
  if (t.album) parts.push(one("album", t.album));
  return parts.join('<span class="opacity-60"> · </span>');
}

/// Rows only carry plain names — one search turns the name into a token,
/// then the same artist/album screen the home cards open.
export async function openEntityByName(kind, name) {
  const raw = String(name || "").trim();
  if (!raw) return;
  // JioSaavn sometimes ships "Artist - Title" inside the artist field.
  const query = kind === "artist" ? raw.split(/\s+-\s+/)[0].trim() : raw;
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
  const hit = (page?.items || [])[0];
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
