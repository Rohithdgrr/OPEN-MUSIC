// notepad-music.js — Ganesha (Phase 4): the music moat inside the notepad.
//
// Attaches tracks + timestamps to plain-text notes, renders them as chips in
// the attachments rail, seeds review/session templates, parses rating/mood/
// replay back into a status line, grows a listening journal from real play
// history, and links a note to the open playlist. Everything hangs off the
// frozen notepad contract (`docs/notepad/README.md`); this module never edits
// the core or the player.
//
// Two hard rules shape the code:
//   1. ZERO static imports of app modules. Every player/library/home/core
//      dependency is resolved through a lazy dynamic `import()` inside an
//      injectable dep bag (`defaultDeps`). Node tests import this file and
//      exercise the pure logic without ever evaluating `dom.js`/`queue.js`
//      (whose top level dereferences `#audio` and would throw — the
//      qrview.js lesson, AGENTS.md 2026-10-07).
//   2. NO autoplay. Playback only ever fires from an explicit chip
//      activation (click / Enter). Panel open, note switch and save are all
//      render-only.
//
// Namespace: `npdm-` (CSS/ids). Storage key: `tm-notepad-music` (ours alone).

const KEY = "tm-notepad-music";

// ------------------------------------------------------------------ pure ---

export function emptySidecar() {
  return { tracks: {}, journal: {}, meta: {}, playlistNotes: {} };
}

/// Load-safe heal: keep only entries whose note still exists, and coerce every
/// field to a known-good shape. Corrupt / foreign storage collapses to empty.
export function healSidecar(raw, noteIds) {
  const base = emptySidecar();
  if (!raw || typeof raw !== "object") return base;
  const keep = new Set(
    Array.isArray(noteIds) ? noteIds : Object.keys(noteIds || {}),
  );

  const tracks = {};
  for (const [id, list] of Object.entries(raw.tracks || {})) {
    if (!keep.has(id) || !Array.isArray(list)) continue;
    const clean = list
      .filter((e) => e && typeof e.id === "string")
      .map((e) => {
        const out = {
          id: e.id,
          title: typeof e.title === "string" ? e.title : "",
          artist: typeof e.artist === "string" ? e.artist : "",
          kind: e.kind === "stamp" ? "stamp" : "track",
        };
        if (typeof e.image === "string" && e.image) out.image = e.image;
        if (Number.isFinite(e.atMs) && e.atMs > 0) out.atMs = e.atMs;
        return out;
      });
    tracks[id] = clean;
  }

  const meta = {};
  for (const [id, m] of Object.entries(raw.meta || {})) {
    if (!keep.has(id) || !m || typeof m !== "object") continue;
    const out = {
      rating: Number.isFinite(m.rating)
        ? Math.min(5, Math.max(0, Math.round(m.rating)))
        : 0,
      mood: typeof m.mood === "string" ? m.mood : "",
      replay: typeof m.replay === "string" ? m.replay : "",
    };
    if (typeof m.playlistId === "string" && m.playlistId) out.playlistId = m.playlistId;
    meta[id] = out;
  }

  const playlistNotes = {};
  for (const [plId, noteId] of Object.entries(raw.playlistNotes || {})) {
    if (typeof plId === "string" && plId && keep.has(noteId)) {
      playlistNotes[plId] = noteId;
    }
  }

  const journal = {};
  for (const [day, j] of Object.entries(raw.journal || {})) {
    if (!j || typeof j !== "object") continue;
    journal[day] = {
      plays: Number.isFinite(j.plays) ? j.plays : 0,
      topArtist: typeof j.topArtist === "string" ? j.topArtist : "",
      note: keep.has(j.note) ? j.note : "",
    };
  }

  return { tracks, journal, meta, playlistNotes };
}

/// Append one track to a note's sidecar list. De-dupes on id+atMs. Returns the
/// stored entry, or null when it was already attached / inputs were bad.
export function attachTrack(sidecar, noteId, track, atMs) {
  if (!sidecar || !noteId || !track || typeof track.id !== "string") return null;
  const entry = {
    id: track.id,
    title: typeof track.title === "string" ? track.title : "",
    artist: typeof track.artist === "string" ? track.artist : "",
    kind: "track",
  };
  if (typeof track.image === "string" && track.image) entry.image = track.image;
  if (Number.isFinite(atMs) && atMs > 0) entry.atMs = atMs;
  const list = sidecar.tracks[noteId] || (sidecar.tracks[noteId] = []);
  if (list.some((e) => e.id === entry.id && (e.atMs || 0) === (entry.atMs || 0))) {
    return null;
  }
  list.push(entry);
  return entry;
}

/// `154000` -> `2:34`; `3723000` -> `1:02:03`; `0` -> `0:00`.
export function fmtAt(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/// Parse an inline `@2:34` / `@1:02:03` / `@90` token to milliseconds.
export function parseAtToken(text) {
  const s = String(text || "");
  const hms = /(?:^|\s)@(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?(?!\d)/.exec(s);
  if (hms) {
    const a = +hms[1];
    const b = +hms[2];
    const c = hms[3] != null ? +hms[3] : null;
    if (c == null) return (a * 60 + b) * 1000;
    return (a * 3600 + b * 60 + c) * 1000;
  }
  const plain = /(?:^|\s)@(\d+)(?!\s*[:\d])/.exec(s);
  if (plain) return +plain[1] * 1000;
  return null;
}

const MARKER_RE = /\[track:([^\]@]+)@(\d+)\]\(([^)]*)\)/g;

/// Pull `[track:<id>@<ms>](<title>)` markers out of the note body. They are
/// plain text until surfaced here as chips.
export function parseMarkers(content) {
  const out = [];
  const s = String(content || "");
  MARKER_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_RE.exec(s))) {
    out.push({ id: m[1].trim(), atMs: +m[2], title: m[3].trim() || m[1].trim() });
  }
  return out;
}

/// Chip label: `▶ Title — Artist`.
export function chipLabel(e) {
  const title = (e && (e.title || e.id)) || "Untitled";
  const artist = e && e.artist ? ` — ${e.artist}` : "";
  return `▶ ${title}${artist}`;
}

/// Parse the review template's fields out of a note body.
export function parseReviewMeta(content) {
  const s = String(content || "");
  const out = { rating: 0, mood: "", replay: "" };
  const star = /^[ \t]*Rating[ \t]*:[ \t]*(★+)\s*☆*/im.exec(s);
  const num = /^[ \t]*Rating[ \t]*:[ \t]*(\d(?:\.5)?)\s*(?:\/\s*5)?/im.exec(s);
  if (star) out.rating = Math.min(5, star[1].length);
  else if (num) out.rating = Math.min(5, Math.round(parseFloat(num[1])));
  const mood = /^[ \t]*Mood[ \t]*:[ \t]*(.+)$/im.exec(s);
  if (mood) out.mood = mood[1].trim();
  const replay = /^[ \t]*Replay[ \t]*:[ \t]*(.+)$/im.exec(s);
  if (replay) out.replay = replay[1].trim();
  return out;
}

/// Compact status-bar summary: `★4 · chill · high replay`.
export function metaSummary(meta) {
  if (!meta) return "";
  const parts = [];
  if (meta.rating > 0) parts.push(`★${meta.rating}`);
  if (meta.mood) parts.push(meta.mood);
  if (meta.replay) parts.push(`${meta.replay} replay`);
  return parts.join(" · ");
}

/// Local `YYYY-MM-DD`.
export function todayKey(now = Date.now()) {
  const d = new Date(now);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

/// Journal seed from real play history (`home.js loadPlays`). Prefers today's
/// rows; falls back to the whole recent list when today is empty so the note
/// is still useful. `plays` is a play count (weighted), `topArtist` the
/// most-played artist.
export function journalSeed(plays, now = Date.now()) {
  const list = Array.isArray(plays) ? plays.filter((p) => p && p.id) : [];
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const start = day.getTime();
  const today = list.filter((p) => (Number(p.ts) || 0) >= start);
  const pool = today.length ? today : list;
  const weight = (p) => Number(p.count) || 1;
  const playsCount = pool.reduce((n, p) => n + weight(p), 0);
  const tally = new Map();
  for (const p of pool) {
    const a = String(p.artist || "").trim();
    if (!a) continue;
    tally.set(a, (tally.get(a) || 0) + weight(p));
  }
  let topArtist = "";
  let best = 0;
  for (const [a, n] of tally) {
    if (n > best) {
      best = n;
      topArtist = a;
    }
  }
  return { plays: playsCount, topArtist };
}

export function journalBody(key, seed) {
  return [
    `Listening journal — ${key}`,
    `Plays: ${seed.plays}`,
    `Top artist: ${seed.topArtist || "—"}`,
    "",
    "Tracks today:",
    "",
    "Notes:",
  ].join("\n");
}

/// Lyric sheet body (#75): one `mm:ss text` row per synced line. Editing stays
/// plain text — the notepad never owns a rich editor.
export function lyricSheetBody(track, synced) {
  const head = [
    `Lyric Sheet — ${track?.title || "Untitled"}`,
    track?.artist ? `Artist: ${track.artist}` : "",
    "",
  ].filter(Boolean);
  const rows = (Array.isArray(synced) ? synced : []).map(([sec, text]) => {
    const ms = Math.max(0, Math.round((Number(sec) || 0) * 1000));
    return `${fmtAt(ms)} ${String(text || "").trim()}`;
  });
  return [...head, ...rows, "\nNotes:"].join("\n");
}

/// Artist bio body (#82): name / listeners / first-paragraph bio / discography
/// lines, seeded from the catalog's `artist_overview`.
export function artistBioBody(ov, fallbackName) {
  const name = (ov && ov.name) || fallbackName || "Unknown artist";
  const lines = [`Artist Bio — ${name}`, ""];
  if (ov && Number.isFinite(ov.listeners) && ov.listeners > 0) {
    lines.push(`Listeners: ${ov.listeners}`);
  }
  if (ov && ov.verified) lines.push("Verified artist");
  lines.push("");
  lines.push(ov && ov.bio ? ov.bio : "No biography available yet.");
  const releases = (ov && Array.isArray(ov.releases) && ov.releases) || [];
  if (releases.length) {
    lines.push("", "Discography:");
    for (const r of releases.slice(0, 20)) {
      const item = r && r.item;
      if (!item) continue;
      const kind = r.kind ? ` (${r.kind})` : "";
      lines.push(`- ${item.title || "Untitled"}${kind}${item.year ? ` ${item.year}` : ""}`);
    }
  }
  return lines.join("\n");
}

/// Mood board items (#79): album-art URLs from a note's attached tracks.
export function moodBoardItems(sidecar, noteId) {
  const list = (sidecar && sidecar.tracks && sidecar.tracks[noteId]) || [];
  return list
    .filter((e) => e && e.image)
    .map((e) => ({ id: e.id, title: e.title || e.id, artist: e.artist || "", image: e.image }));
}

// Music-specific templates (features.md #74/#76). Devi owns the generic
// switcher template list; these live in my Alt+M menu and carry the marker
// syntax so chips attach straight into the skeleton.
export const TEMPLATES = {
  albumReview: [
    "Album Review",
    "Artist: ",
    "Album: ",
    "Rating: ☆☆☆☆☆",
    "Mood: ",
    "Favorite track: ",
    "Replay: ",
    "",
    "Notes:",
    "",
    "Marker: [track:<id>@<ms>](Track title) — surfaced in the rail, plays on tap.",
  ].join("\n"),
  sessionLog: [
    "Session Log",
    "Date: ",
    "Host: ",
    "",
    "Tracks:",
    "- [track:<id>@<ms>](Track title) @0:00",
    "",
    "Notes:",
  ].join("\n"),
  // ---- stretch set (#77/#83/#84/#85): plain-text scaffolds ----
  chordSnippet: [
    "Chord Snippet — ",
    "Key: ",
    "Tempo: ",
    "",
    "```",
    "e| ",
    "B| ",
    "G| ",
    "D| ",
    "A| ",
    "E| ",
    "```",
    "",
    "Notes:",
  ].join("\n"),
  sampleLog: [
    "Sample Log",
    "Sample: ",
    "Source track: ",
    "Source @: @0:00",
    "Used in: ",
    "",
    "Notes: where this sample came from and how it was transformed.",
  ].join("\n"),
  remixNotes: [
    "Remix Notes",
    "Original: ",
    "My version: ",
    "BPM: ",
    "Key: ",
    "",
    "Changes:",
    "- ",
    "",
    "Notes:",
  ].join("\n"),
  compareTakes: [
    "Compare Takes",
    "Track A: ",
    "Track B: ",
    "",
    "Differences:",
    "- ",
    "",
    "Verdict:",
  ].join("\n"),
};

// ------------------------------------------------------ playlist linking ---

export function linkPlaylist(sidecar, plId, noteId) {
  if (!sidecar || !plId || !noteId) return false;
  sidecar.playlistNotes[plId] = noteId;
  sidecar.meta[noteId] = sidecar.meta[noteId] || { rating: 0, mood: "", replay: "" };
  sidecar.meta[noteId].playlistId = plId;
  return true;
}

export function unlinkPlaylist(sidecar, plId) {
  if (!sidecar || !plId) return null;
  const noteId = sidecar.playlistNotes[plId];
  if (!noteId) return null;
  delete sidecar.playlistNotes[plId];
  if (sidecar.meta[noteId]) delete sidecar.meta[noteId].playlistId;
  return noteId;
}

export function noteForPlaylist(sidecar, plId) {
  return (sidecar && sidecar.playlistNotes[plId]) || null;
}

// ----------------------------------------------------------- module state ---

let coreRef = null;
let depsRef = null;
let sidecar = emptySidecar();
let inited = false;
let railEl = null;
let overlayEl = null;
let statusEl = null;
let menuEl = null;
let docRef = null;
let storageRef = null;

function safeLS() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function persist() {
  try {
    storageRef?.setItem(KEY, JSON.stringify(sidecar));
  } catch {}
}

function loadSidecar() {
  let raw;
  try {
    raw = JSON.parse(storageRef?.getItem(KEY) || "null");
  } catch {
    raw = null;
  }
  const notes = coreRef?.allNotes ? coreRef.allNotes() : {};
  return healSidecar(raw, Object.keys(notes || {}));
}

function prune() {
  const notes = coreRef?.allNotes ? coreRef.allNotes() : {};
  sidecar = healSidecar(sidecar, Object.keys(notes || {}));
  persist();
}

// ------------------------------------------------------------------ deps ---

let hqArtFn = null;
function ensureArtHelper() {
  if (hqArtFn) return;
  import("./art.js")
    .then((m) => {
      if (typeof m.hqArt === "function") hqArtFn = m.hqArt;
    })
    .catch(() => {});
}

function defaultDeps() {
  return {
    async playingTrack() {
      const q = await import("./queue.js");
      return q.queue[q.queueIndex]?.track ?? q.restoredTrack ?? null;
    },
    async currentTimeMs() {
      const { audio } = await import("./dom.js");
      return Math.round((Number(audio?.currentTime) || 0) * 1000);
    },
    // Play a note's track, optionally seeking to `atMs`. Uses only public,
    // read-only-imported player APIs: queue.js `enqueue`, playback.js
    // `playQueueItem`/`setResume`, dom.js `audio`.
    async playTrackAt(track, atMs) {
      const { audio } = await import("./dom.js");
      const q = await import("./queue.js");
      const { playQueueItem, setResume } = await import("./playback.js");
      const cur = q.queue[q.queueIndex]?.track;
      if (cur && cur.id === track.id && audio && audio.src) {
        if (atMs > 0 && Number.isFinite(audio.duration)) {
          audio.currentTime = Math.min(atMs / 1000, Math.max(0, audio.duration - 1));
        }
        if (audio.paused) {
          try {
            await audio.play();
          } catch {}
        }
        return;
      }
      if (atMs > 0) setResume(track.id, atMs / 1000);
      let idx = q.queue.findIndex((it) => it && it.track && it.track.id === track.id);
      if (idx >= 0) {
        await playQueueItem(idx);
        return;
      }
      q.enqueue(track);
      idx = q.queue.findIndex((it) => it && it.track && it.track.id === track.id);
      await playQueueItem(idx >= 0 ? idx : q.queue.length - 1);
    },
    async searchTracks(query) {
      const { invoke } = await import("./core.js");
      const payload = await invoke("search_songs", { query, limit: 8, page: 1 });
      return (payload && payload.tracks) || [];
    },
    async loadPlays() {
      const { loadPlays } = await import("./home.js");
      return loadPlays();
    },
    // Synced lyric lines for a track (#75). Returns [[sec, text], …] or [].
    async lyrics(track) {
      const { invoke } = await import("./core.js");
      const r = await invoke("get_lyrics", {
        id: track.id,
        title: track.title || "",
        artist: track.artist || "",
        album: track.album || "",
        duration: track.duration_secs || 0,
      });
      return (r && Array.isArray(r.synced) ? r.synced : []) || [];
    },
    // Artist overview (#82): resolve the playing track's artist NAME to a
    // token via search_entities, then fetch the bio. Returns null on miss.
    async artistBio(artistName) {
      if (!artistName) return null;
      const { invoke } = await import("./core.js");
      const page = await invoke("search_entities", {
        query: artistName,
        kind: "artist",
        limit: 1,
        page: 1,
      });
      const hit = (page && Array.isArray(page.items) && page.items[0]) || null;
      const token = hit && (hit.token || hit.id);
      if (!token) return null;
      const ov = await invoke("artist_overview", { token: String(token) });
      return ov || null;
    },
    // Album-art relay for the mood board (#79): route upstream covers through
    // art.js's proxy. art.js is imported once in the background; until it is
    // ready the raw URL is used, so this stays synchronous.
    artUrl(u) {
      ensureArtHelper();
      return hqArtFn ? hqArtFn(u, "300x300") : u;
    },
    async currentPlaylist() {
      const lib = await import("./library.js");
      const id = lib.pdCurrentId || "";
      if (!id) return null;
      let name = "";
      try {
        const item = lib.plItemById?.(id);
        name = (item && (item.title || item.name)) || "";
      } catch {}
      return { id, name };
    },
  };
}

// --------------------------------------------------------------- rendering ---

function mkEl(tag) {
  return docRef ? docRef.createElement(tag) : null;
}

function clear(el) {
  if (el) el.replaceChildren?.();
}

function activateChip(m) {
  const track = { id: m.id, title: m.title || m.id, artist: m.artist || "" };
  Promise.resolve(depsRef.playTrackAt(track, Number.isFinite(m.atMs) ? m.atMs : 0)).catch(
    (e) => {
      coreRef.diag?.("notepad-music", false, String(e));
      coreRef.toast?.("Could not play that track.", "error");
    },
  );
}

function mkChip(m) {
  const b = mkEl("button");
  if (!b) return null;
  b.type = "button";
  b.className = "npdm-chip";
  b.tabIndex = 0;
  b.textContent = chipLabel(m);
  b.addEventListener("click", () => activateChip(m));
  b.addEventListener("keydown", (ev) => {
    if (ev && ev.key === "Enter") {
      ev.preventDefault?.();
      activateChip(m);
    }
  });
  return b;
}

function mkAtLine(m) {
  const b = mkEl("button");
  if (!b) return null;
  b.type = "button";
  b.className = "npdm-chip-at";
  b.textContent = `@${fmtAt(m.atMs)}`;
  b.addEventListener("click", () => activateChip(m));
  return b;
}

/// Chip models for the active note: sidecar entries + inline markers the rail
/// parser surfaces (markers are just text until here).
function chipModels() {
  const note = coreRef.activeNote();
  if (!note) return [];
  const list = sidecar.tracks[note.id] || [];
  const seen = new Set(list.map((e) => `${e.id}@${e.atMs || 0}`));
  const models = list.map((e) => ({ ...e }));
  for (const mk of parseMarkers(note.content)) {
    const key = `${mk.id}@${mk.atMs || 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ id: mk.id, title: mk.title, artist: "", atMs: mk.atMs, kind: "marker" });
  }
  return models;
}

function renderRail() {
  if (!railEl) return;
  clear(railEl);
  const note = coreRef.activeNote();
  if (!note) return;
  const plId = (sidecar.meta[note.id] && sidecar.meta[note.id].playlistId) || "";
  if (plId) {
    const line = mkEl("div");
    if (line) {
      line.className = "npdm-rail-pl";
      line.textContent = `Playlist: ${plId}`;
      railEl.append(line);
    }
  }
  for (const m of chipModels()) {
    const chip = mkChip(m);
    if (chip) railEl.append(chip);
    if (Number.isFinite(m.atMs) && m.atMs > 0) {
      const at = mkAtLine(m);
      if (at) railEl.append(at);
    }
  }
  if (moodOpen) renderMoodBoard(note.id);
}

/// Mood board (#79): a grid of album-art tiles from the note's attached
/// tracks. URLs go through art.js's relay (`artUrl` dep) so no raw upstream
/// host is hit directly. Tiles are inert — no autoplay.
function renderMoodBoard(noteId) {
  const items = moodBoardItems(sidecar, noteId);
  const grid = mkEl("div");
  if (!grid) return;
  grid.className = "npdm-moodboard";
  for (const it of items) {
    const cell = mkEl("div");
    if (!cell) continue;
    cell.className = "npdm-mood-cell";
    const img = mkEl("img");
    if (img) {
      img.className = "npdm-mood-img";
      img.alt = it.title;
      img.src = depsRef.artUrl ? depsRef.artUrl(it.image) : it.image;
      cell.append(img);
    }
    const cap = mkEl("div");
    if (cap) {
      cap.className = "npdm-mood-cap";
      cap.textContent = it.title;
      cell.append(cap);
    }
    grid.append(cell);
  }
  if (!items.length) {
    const empty = mkEl("div");
    if (empty) {
      empty.className = "npdm-mood-empty";
      empty.textContent = "No artwork attached yet.";
      grid.append(empty);
    }
  }
  railEl.append(grid);
}

function renderStatus() {
  if (!statusEl) return;
  const note = coreRef.activeNote();
  const meta = note ? sidecar.meta[note.id] : null;
  statusEl.textContent = meta ? metaSummary(meta) : "";
}

// ------------------------------------------------------------------ menu ---

function mkRow(label, onClick) {
  const r = mkEl("button");
  if (!r) return null;
  r.type = "button";
  r.className = "npdm-row";
  r.textContent = label;
  r.addEventListener("click", onClick);
  return r;
}

function closeMenu() {
  clear(menuEl);
}

function paintMenuMain() {
  if (!menuEl) return;
  clear(menuEl);
  const rows = [
    ["Attach playing track", () => attachPlaying(false)],
    ["Attach playing track @ current time", () => attachPlaying(true)],
    ["Attach track by search…", () => paintMenuSearch()],
    ["New: Album Review", () => newFromTemplate("Album Review", TEMPLATES.albumReview)],
    ["New: Session Log", () => newFromTemplate("Session Log", TEMPLATES.sessionLog)],
    ["Today's journal", () => openJournal()],
    ["Note for current playlist", () => playlistNote()],
    ["New: Lyric sheet for playing track", () => seedLyricSheet()],
    ["New: Artist bio for playing track", () => seedArtistBio()],
    ["Show mood board", () => toggleMoodBoard()],
    ["New: Chord snippet", () => newFromTemplate("Chord Snippet", TEMPLATES.chordSnippet)],
    ["New: Sample log", () => newFromTemplate("Sample Log", TEMPLATES.sampleLog)],
    ["New: Remix notes", () => newFromTemplate("Remix Notes", TEMPLATES.remixNotes)],
    ["New: Compare takes", () => newFromTemplate("Compare Takes", TEMPLATES.compareTakes)],
  ];
  for (const [label, fn] of rows) {
    const r = mkRow(label, fn);
    if (r) menuEl.append(r);
  }
}

function openMenu() {
  if (!overlayEl) return;
  if (!menuEl) {
    menuEl = mkEl("div");
    if (!menuEl) return;
    menuEl.className = "npdm-menu";
    overlayEl.append(menuEl);
  }
  paintMenuMain();
}

async function attachPlaying(withTime) {
  const note = coreRef.activeNote();
  if (!note) {
    coreRef.toast?.("Open a note first.", "info");
    return;
  }
  let track = null;
  try {
    track = await depsRef.playingTrack();
  } catch {}
  if (!track || !track.id) {
    coreRef.toast?.("No track is playing.", "info");
    return;
  }
  let atMs;
  if (withTime) {
    try {
      atMs = await depsRef.currentTimeMs();
    } catch {
      atMs = 0;
    }
  }
  const entry = attachTrack(sidecar, note.id, track, atMs);
  if (!entry) {
    coreRef.toast?.("That track is already attached.", "info");
    return;
  }
  persist();
  renderRail();
  coreRef.toast?.(`Attached "${track.title || track.id}".`, "success");
}

async function runSearch(q) {
  try {
    const list = await depsRef.searchTracks(q);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function paintMenuSearch() {
  if (!menuEl) return;
  clear(menuEl);
  const input = mkEl("input");
  const results = mkEl("div");
  if (!input || !results) return;
  input.className = "npdm-search-input";
  input.placeholder = "Search tracks…";
  results.className = "npdm-search-results";
  menuEl.append(input);
  menuEl.append(results);
  input.focus?.();

  let rows = [];
  let sel = -1;
  const paintResults = () => {
    clear(results);
    rows.slice(0, 8).forEach((t, i) => {
      const r = mkEl("button");
      if (!r) return;
      r.type = "button";
      r.className = "npdm-search-row" + (i === sel ? " selected" : "");
      r.textContent = `${t.title || ""} — ${t.artist || ""}`;
      r.addEventListener("click", () => pickSearch(t));
      results.append(r);
    });
  };
  let deb;
  input.addEventListener("input", () => {
    clearTimeout(deb);
    deb = setTimeout(async () => {
      const q = String(input.value || "").trim();
      if (!q) {
        rows = [];
        sel = -1;
        paintResults();
        return;
      }
      rows = await runSearch(q);
      sel = rows.length ? 0 : -1;
      paintResults();
    }, 250);
  });
  input.addEventListener("keydown", (ev) => {
    if (!ev) return;
    if (ev.key === "ArrowDown") {
      ev.preventDefault?.();
      sel = Math.min(sel + 1, Math.min(rows.length, 8) - 1);
      paintResults();
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault?.();
      sel = Math.max(sel - 1, 0);
      paintResults();
    } else if (ev.key === "Enter") {
      ev.preventDefault?.();
      if (rows[sel]) pickSearch(rows[sel]);
    } else if (ev.key === "Escape") {
      paintMenuMain();
    }
  });
}

async function pickSearch(t) {
  const note = coreRef.activeNote();
  if (!note) {
    coreRef.toast?.("Open a note first.", "info");
    return;
  }
  const entry = attachTrack(sidecar, note.id, t);
  if (!entry) {
    coreRef.toast?.("That track is already attached.", "info");
    paintMenuMain();
    return;
  }
  persist();
  renderRail();
  paintMenuMain();
  coreRef.toast?.(`Attached "${t.title || t.id}".`, "success");
}

function newFromTemplate(title, body) {
  const id = coreRef.newNote?.(`${title} — ${todayKey()}`, body);
  if (id) coreRef.toast?.(`Created ${title}.`, "success");
  closeMenu();
}

async function openJournal() {
  const key = todayKey();
  const existing = sidecar.journal[key] && sidecar.journal[key].note;
  if (existing && coreRef.allNotes?.()[existing]) {
    coreRef.openNote(existing);
    closeMenu();
    return;
  }
  let plays;
  try {
    plays = await depsRef.loadPlays();
  } catch {
    plays = [];
  }
  const seed = journalSeed(plays, Date.now());
  const id = coreRef.newNote?.(`Journal ${key}`, journalBody(key, seed));
  if (!id) return;
  sidecar.journal[key] = { plays: seed.plays, topArtist: seed.topArtist, note: id };
  persist();
  closeMenu();
  coreRef.toast?.("Today's journal is ready.", "success");
}

async function playlistNote() {
  let pl = null;
  try {
    pl = await depsRef.currentPlaylist();
  } catch {}
  if (!pl || !pl.id) {
    coreRef.toast?.("No playlist is open.", "info");
    return;
  }
  const existing = noteForPlaylist(sidecar, pl.id);
  if (existing && coreRef.allNotes?.()[existing]) {
    coreRef.openNote(existing);
    closeMenu();
    return;
  }
  const name = pl.name || pl.id;
  const id = coreRef.newNote?.(`Playlist note — ${name}`, `Playlist: ${name}\n\nTrack-by-track notes:\n`);
  if (!id) return;
  linkPlaylist(sidecar, pl.id, id);
  persist();
  renderRail();
  closeMenu();
  coreRef.toast?.(`Linked a note to "${name}".`, "success");
}

// ------------------------------------------------- stretch: lyric sheet (#75) ---

async function seedLyricSheet() {
  let track = null;
  try {
    track = await depsRef.playingTrack();
  } catch {}
  if (!track || !track.id) {
    coreRef.toast?.("No track is playing.", "info");
    return;
  }
  let synced;
  try {
    synced = await depsRef.lyrics(track);
  } catch {
    synced = [];
  }
  const body = lyricSheetBody(track, synced);
  const id = coreRef.newNote?.(`Lyric Sheet — ${track.title || track.id}`, body);
  closeMenu();
  coreRef.toast?.(
    id ? `Lyric sheet created${synced.length ? "" : " (no synced timings)"}.` : "Could not create note.",
    id ? "success" : "error",
  );
}

// ------------------------------------------------- stretch: artist bio (#82) ---

async function seedArtistBio() {
  let track = null;
  try {
    track = await depsRef.playingTrack();
  } catch {}
  const name = (track && track.artist) || "";
  if (!name) {
    coreRef.toast?.("No artist to look up.", "info");
    return;
  }
  let ov;
  try {
    ov = await depsRef.artistBio(name);
  } catch {
    ov = null;
  }
  const body = artistBioBody(ov, name);
  const id = coreRef.newNote?.(`Artist Bio — ${(ov && ov.name) || name}`, body);
  closeMenu();
  coreRef.toast?.(id ? "Artist bio created." : "Could not create note.", id ? "success" : "error");
}

// ------------------------------------------------- stretch: mood board (#79) ---

let moodOpen = false;

function toggleMoodBoard() {
  const note = coreRef.activeNote();
  if (!note) {
    coreRef.toast?.("Open a note first.", "info");
    return;
  }
  moodOpen = !moodOpen;
  renderRail();
  closeMenu();
  if (moodOpen && !moodBoardItems(sidecar, note.id).length) {
    coreRef.toast?.("Attach tracks with artwork first.", "info");
  }
}

// ---------------------------------------------------------------- events ---

function onSaved(d) {
  const id = d && d.id;
  if (!id) return;
  const note = coreRef.allNotes?.()[id];
  if (!note) return;
  const meta = parseReviewMeta(note.content);
  const prev = sidecar.meta[id] || {};
  sidecar.meta[id] = { ...prev, ...meta };
  persist();
  if (coreRef.activeNote?.()?.id === id) renderStatus();
}

function onKeydown(ev) {
  if (!ev) return;
  if (ev.altKey && !ev.ctrlKey && !ev.metaKey && (ev.key === "m" || ev.key === "M")) {
    ev.preventDefault?.();
    openMenu();
  }
}

// ------------------------------------------------------------------ init ---

function injectCss() {
  if (!docRef || !docRef.head) return;
  const l = mkEl("link");
  if (!l) return;
  l.rel = "stylesheet";
  l.href = `notepad-music.css?v=${Date.now()}`;
  docRef.head.append(l);
}

export function initNotepadMusic(core, overrides) {
  if (inited || !core) return;
  inited = true;
  coreRef = core;
  const ov = overrides || {};
  docRef = ov.doc || (typeof document !== "undefined" ? document : null);
  storageRef = ov.storage || safeLS();
  depsRef = { ...defaultDeps(), ...ov };
  delete depsRef.doc;
  delete depsRef.storage;

  sidecar = loadSidecar();
  injectCss();

  railEl = core.mount?.("rail") || null;
  overlayEl = core.mount?.("overlay") || null;
  statusEl = core.mount?.("statusExtra") || null;

  prune();
  renderRail();
  renderStatus();

  core.on?.("note", () => {
    prune();
    renderRail();
    renderStatus();
  });
  core.on?.("saved", (d) => onSaved(d));
  core.on?.("keydown", (ev) => onKeydown(ev));
}
