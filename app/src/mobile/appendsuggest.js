// appendsuggest.js — the Now Playing queue tab's append-search browser, pure half.
// docs/mobile/06-features.md "Queue append search browser" (2026-10-17e): pick
// the song rows out of one `search_songs` page and render them with the three
// queue actions where the search screen's rows show a type label. jam.js owns
// the input, the fetch and the clicks; this module keeps ZERO imports so the
// suite exercises it without a mock window (the 2026-10-07 mobile→core-graph
// lesson), and takes the artwork resolver as an argument instead of importing
// shared.js — jam.js passes the shell's `art()`.
//
// The buttons map one-to-one onto mobile/player.js's queue verbs:
//   now   → playList([t], 0)   "Play now"
//   next  → insertNext(t)      "Play next"
//   queue → enqueue(t)         "Add to queue"

/// How many rows the dropdown shows — "show only some results directly".
export const APPEND_CAP = 5;

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/// Suite fallback for the art resolver: real src when there is one, nothing
/// when there is none (that row then carries the music glyph). In the app
/// jam.js passes shared.js's `art()`, which adds the logo fallback, the hq
/// swap and the relay hop exactly like every other row painter.
const plainArt = (url) => (url ? `src="${esc(url)}"` : "");

/// Keep song-shaped rows only, deduped by title, capped. Rows without an
/// id + title are unusable as queue entries (entity results there) and can
/// never leak in; the catalog repeats the same record on reissues, so the
/// title key drops those echoes while upstream order is kept.
export function pickSongs(payload, cap = APPEND_CAP) {
  const raw = Array.isArray(payload && payload.tracks) ? payload.tracks : [];
  const out = [];
  const seen = new Set();
  for (const t of raw) {
    if (!t || !t.id || !t.title) continue;
    const key = String(t.title).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: String(t.id),
      title: String(t.title),
      artist: String(t.artist || ""),
      image: String(t.image || ""),
    });
    if (out.length >= cap) break;
  }
  return out;
}

/// The three actions, in the user's own order, as compact icon buttons —
/// the slot where the search screen's rows show their type label.
const ACTIONS = [
  { k: "now", icon: "play_arrow", label: "Play now" },
  { k: "next", icon: "playlist_play", label: "Play next" },
  { k: "queue", icon: "playlist_add", label: "Add to queue" },
];

export function appendRowHTML(track, index, artFn = plainArt) {
  const t = track || {};
  return `<div class="flex items-center gap-3 px-3 py-2 text-left border-b border-surface-container/60 last:border-b-0">
      <div class="w-9 h-9 rounded bg-surface-container-highest overflow-hidden shrink-0 flex items-center justify-center">${
        t.image
          ? `<img alt="" class="w-full h-full object-cover" ${artFn(t.image)}>`
          : `<span class="material-symbols-outlined text-[18px] text-on-surface-variant">music_note</span>`
      }</div>
      <div class="flex flex-col min-w-0 flex-1">
        <span class="font-body-md text-body-md text-on-surface truncate">${esc(t.title || "")}</span>
        <span class="font-body-sm text-[11px] text-secondary truncate">${esc(t.artist || "")}</span>
      </div>
      <div class="flex items-center gap-0.5 shrink-0">${ACTIONS.map(
        (a) =>
          `<button type="button" data-append-action="${a.k}" data-append-row="${index}" aria-label="${a.label}" title="${a.label}" class="w-7 h-7 flex items-center justify-center text-secondary hover:text-on-surface active:bg-surface-container rounded-lg transition-colors"><span class="material-symbols-outlined text-[16px]">${a.icon}</span></button>`,
      ).join("")}</div>
    </div>`;
}
