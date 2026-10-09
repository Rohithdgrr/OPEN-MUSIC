// notepad-music.test.mjs — Ganesha's music moat (DOM-free pure logic + a
// fake-core / fake-deps drive of the Alt+M menu, chips, review parse, journal
// and playlist link). No real app module is ever evaluated here: every
// player/library/home/core dependency is injected, which is exactly why
// notepad-music.js resolves them lazily.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  emptySidecar,
  healSidecar,
  attachTrack,
  fmtAt,
  parseAtToken,
  parseMarkers,
  chipLabel,
  parseReviewMeta,
  metaSummary,
  todayKey,
  journalSeed,
  journalBody,
  lyricSheetBody,
  artistBioBody,
  moodBoardItems,
  TEMPLATES,
  linkPlaylist,
  unlinkPlaylist,
  noteForPlaylist,
  initNotepadMusic,
} from "../src/notepad-music.js";

const DAY = 24 * 3600 * 1000;
const NOW = 1_700_000_000_000;

// ------------------------------------------------------------- fake DOM ---

function fakeEl(tag = "div") {
  return {
    tagName: tag.toUpperCase(),
    children: [],
    className: "",
    textContent: "",
    tabIndex: 0,
    type: "",
    placeholder: "",
    value: "",
    listeners: {},
    addEventListener(t, fn) {
      (this.listeners[t] ||= []).push(fn);
    },
    append(...n) {
      this.children.push(...n);
    },
    replaceChildren() {
      this.children = [];
    },
    focus() {},
    fire(t, ev = {}) {
      (this.listeners[t] || []).forEach((fn) => fn({ preventDefault() {}, ...ev }));
    },
  };
}

function fakeDoc() {
  return { head: fakeEl("head"), createElement: (t) => fakeEl(t) };
}

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function makeCore(activeId, notes) {
  const subs = {};
  const mounts = { rail: fakeEl(), overlay: fakeEl(), statusExtra: fakeEl() };
  const toasts = [];
  let active = activeId;
  return {
    subs,
    mounts,
    toasts,
    mount: (n) => mounts[n] || fakeEl(),
    on: (t, fn) => {
      (subs[t] ||= []).push(fn);
      return () => {};
    },
    activeNote: () => (active && notes[active] ? { id: active, ...notes[active] } : null),
    allNotes: () => ({ ...notes }),
    newNote: (name, content) => {
      const id = `n${Object.keys(notes).length + 1}`;
      notes[id] = { name, content, updated: Date.now() };
      active = id;
      return id;
    },
    openNote: (id) => {
      active = id;
    },
    setActive: (id) => {
      active = id;
    },
    setNoteContent: (id, text) => {
      if (notes[id]) notes[id].content = text;
    },
    refresh: () => {},
    toast: (m, k) => toasts.push([m, k]),
    diag: () => {},
  };
}

function clickRow(overlay, label) {
  const menu = overlay.children[0];
  const row = menu.children.find((r) => r.textContent === label);
  assert.ok(row, `menu row "${label}" not found`);
  row.fire("click");
  return row;
}

async function flush(ms = 320) {
  await new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------- task 1: store ---

test("healSidecar round-trips valid data and prunes vanished notes", () => {
  const raw = {
    tracks: {
      kept: [{ id: "T1", title: "A", artist: "B", kind: "track" }],
      gone: [{ id: "T9", title: "X", artist: "Y", kind: "track" }],
    },
    meta: { kept: { rating: 4, mood: "chill", replay: "high" }, gone: { rating: 1 } },
    journal: { "2026-10-10": { plays: 5, topArtist: "Z", note: "kept" } },
    playlistNotes: { PL1: "kept", PL2: "gone" },
  };
  const out = healSidecar(raw, ["kept"]);
  assert.deepEqual(out.tracks.kept.map((t) => t.id), ["T1"]);
  assert.equal(out.tracks.gone, undefined, "vanished note's tracks pruned");
  assert.deepEqual(out.meta.gone, undefined);
  assert.equal(out.playlistNotes.PL2, undefined);
  assert.equal(out.playlistNotes.PL1, "kept");
  assert.equal(out.journal["2026-10-10"].note, "kept");
});

test("healSidecar survives corrupt / non-object storage", () => {
  assert.deepEqual(healSidecar(null, ["a"]), emptySidecar());
  assert.deepEqual(healSidecar("junk", ["a"]), emptySidecar());
  assert.deepEqual(healSidecar(42, ["a"]), emptySidecar());
  const weird = healSidecar({ tracks: { a: "not-an-array" } }, ["a"]);
  assert.equal(weird.tracks.a, undefined, "non-array track list is dropped");
  const coerced = healSidecar({ meta: { a: { rating: "NaN", mood: 5 } } }, ["a"]);
  assert.deepEqual(coerced.meta.a, { rating: 0, mood: "", replay: "" }, "bad meta coerced to safe shape");
});

test("attachTrack stores a track, de-dupes on id+atMs, rejects bad input", () => {
  const s = emptySidecar();
  const e = attachTrack(s, "n1", { id: "T1", title: "A", artist: "B" }, undefined);
  assert.equal(e.atMs, undefined);
  assert.equal(s.tracks.n1.length, 1);
  // same id, no timestamp -> dupe
  assert.equal(attachTrack(s, "n1", { id: "T1", title: "A", artist: "B" }), null);
  // same id, different timestamp -> kept
  assert.ok(attachTrack(s, "n1", { id: "T1", title: "A" }, 154000));
  assert.equal(s.tracks.n1.length, 2);
  assert.equal(attachTrack(s, "n1", null), null);
  assert.equal(attachTrack(s, "", { id: "T1" }), null);
});

// -------------------------------------------------- task 4: time formats ---

test("fmtAt renders m:ss and h:mm:ss edge forms", () => {
  assert.equal(fmtAt(0), "0:00");
  assert.equal(fmtAt(5000), "0:05");
  assert.equal(fmtAt(154000), "2:34");
  assert.equal(fmtAt(60000), "1:00");
  assert.equal(fmtAt(3723000), "1:02:03");
  assert.equal(fmtAt(3600000), "1:00:00");
});

test("parseAtToken parses @2:34, @1:02:03 and @90", () => {
  assert.equal(parseAtToken("@2:34"), 154000);
  assert.equal(parseAtToken("@1:02:03"), 3723000);
  assert.equal(parseAtToken("@90"), 90000);
  assert.equal(parseAtToken("solo @0:05 intro"), 5000);
  assert.equal(parseAtToken("no time here"), null);
});

test("parseMarkers pulls [track:id@ms](title) out of the body", () => {
  const body = "see [track:abc123@154000](Song One) and [track:zz@0](Intro)";
  const mk = parseMarkers(body);
  assert.equal(mk.length, 2);
  assert.deepEqual(mk[0], { id: "abc123", atMs: 154000, title: "Song One" });
  assert.equal(mk[1].id, "zz");
});

// ------------------------------------------- tasks 3/6: labels + summary ---

test("chipLabel renders the ▶ Title — Artist block", () => {
  assert.equal(chipLabel({ title: "Song", artist: "Artist" }), "▶ Song — Artist");
  assert.equal(chipLabel({ title: "Song" }), "▶ Song");
  assert.equal(chipLabel({ id: "T9" }), "▶ T9");
});

test("parseReviewMeta reads rating (stars + n/5), mood, replay", () => {
  const m = parseReviewMeta("Album\nRating: ★★★★☆\nMood: chill\nReplay: high\n");
  assert.equal(m.rating, 4);
  assert.equal(m.mood, "chill");
  assert.equal(m.replay, "high");
  assert.equal(parseReviewMeta("Rating: 3/5").rating, 3);
  assert.deepEqual(parseReviewMeta("nothing here"), { rating: 0, mood: "", replay: "" });
});

test("metaSummary compacts the status line", () => {
  assert.equal(metaSummary({ rating: 4, mood: "chill", replay: "high" }), "★4 · chill · high replay");
  assert.equal(metaSummary({ rating: 0, mood: "", replay: "" }), "");
  assert.equal(metaSummary(null), "");
});

// ------------------------------------------------- task 5: templates ---

test("album review + session log templates carry the agreed skeleton", () => {
  const ar = TEMPLATES.albumReview;
  for (const field of ["Artist:", "Album:", "Rating:", "Mood:", "Favorite track:", "Replay:", "[track:"]) {
    assert.ok(ar.includes(field), `album review missing "${field}"`);
  }
  const sl = TEMPLATES.sessionLog;
  for (const field of ["Date:", "Host:", "Tracks:", "[track:"]) {
    assert.ok(sl.includes(field), `session log missing "${field}"`);
  }
});

test("stretch templates (#77/#83/#84/#85) carry their scaffolds", () => {
  for (const f of ["Key:", "Tempo:", "```"]) {
    assert.ok(TEMPLATES.chordSnippet.includes(f), `chord snippet missing "${f}"`);
  }
  for (const f of ["Sample:", "Source track:", "Source @: @0:00"]) {
    assert.ok(TEMPLATES.sampleLog.includes(f), `sample log missing "${f}"`);
  }
  for (const f of ["Original:", "My version:", "BPM:", "Key:"]) {
    assert.ok(TEMPLATES.remixNotes.includes(f), `remix notes missing "${f}"`);
  }
  for (const f of ["Track A:", "Track B:", "Differences:"]) {
    assert.ok(TEMPLATES.compareTakes.includes(f), `compare takes missing "${f}"`);
  }
});

// ------------------------------------------- stretch: lyric sheet (#75) ---

test("lyricSheetBody renders mm:ss rows and survives no-sync", () => {
  const track = { id: "T1", title: "Song", artist: "Artist" };
  const body = lyricSheetBody(track, [[0, "Intro line"], [83.5, "Chorus"], [3723, "Outro"]]);
  assert.ok(body.includes("Lyric Sheet — Song"));
  assert.ok(body.includes("Artist: Artist"));
  assert.ok(body.includes("0:00 Intro line"));
  assert.ok(body.includes("1:23 Chorus"));
  assert.ok(body.includes("1:02:03 Outro"));
  // no synced timings -> header only, no crash
  const bare = lyricSheetBody(track, []);
  assert.ok(bare.includes("Lyric Sheet — Song"));
  assert.ok(!bare.includes("0:00"));
  assert.ok(lyricSheetBody(null, null).includes("Untitled"));
});

// ------------------------------------------- stretch: artist bio (#82) ---

test("artistBioBody seeds name/listeners/bio/discography, falls back to name", () => {
  const ov = {
    name: "Fleetwood Mac",
    listeners: 12345,
    verified: true,
    bio: "A British-American band.",
    releases: [
      { item: { title: "Rumours", year: "1977" }, kind: "album" },
      { item: { title: "The Chain", year: "" }, kind: "single" },
    ],
  };
  const body = artistBioBody(ov, "ignored");
  assert.ok(body.includes("Artist Bio — Fleetwood Mac"));
  assert.ok(body.includes("Listeners: 12345"));
  assert.ok(body.includes("Verified artist"));
  assert.ok(body.includes("A British-American band."));
  assert.ok(body.includes("Discography:"));
  assert.ok(body.includes("- Rumours (album) 1977"));
  // no overview -> fall back to the passed artist name + placeholder bio
  const bare = artistBioBody(null, "Solo Artist");
  assert.ok(bare.includes("Artist Bio — Solo Artist"));
  assert.ok(bare.includes("No biography available yet."));
  assert.ok(!bare.includes("Listeners:"));
});

// ------------------------------------------- stretch: mood board (#79) ---

test("moodBoardItems picks only attached tracks that carry artwork", () => {
  const s = emptySidecar();
  s.tracks.n1 = [
    { id: "a", title: "A", artist: "X", image: "http://img/a.jpg" },
    { id: "b", title: "B", artist: "Y" },
    { id: "c", title: "C", artist: "Z", image: "http://img/c.jpg" },
  ];
  const items = moodBoardItems(s, "n1");
  assert.deepEqual(items.map((i) => i.id), ["a", "c"]);
  assert.equal(items[0].image, "http://img/a.jpg");
  assert.deepEqual(moodBoardItems(s, "missing"), []);
  assert.deepEqual(moodBoardItems(null, "n1"), []);
});

test("attachTrack carries an artwork image through to the sidecar", () => {
  const s = emptySidecar();
  const e = attachTrack(s, "n1", { id: "T1", title: "A", artist: "B", image: "http://img/t.jpg" });
  assert.equal(e.image, "http://img/t.jpg");
  const noArt = attachTrack(s, "n2", { id: "T2", title: "C" });
  assert.equal(noArt.image, undefined);
  // image survives the heal round-trip
  const healed = healSidecar(JSON.parse(JSON.stringify(s)), ["n1", "n2"]);
  assert.equal(healed.tracks.n1[0].image, "http://img/t.jpg");
  assert.equal(healed.tracks.n2[0].image, undefined);
});

// ------------------------------------------------- task 7: journal ---

test("journalSeed counts today's plays and picks the top artist", () => {
  const plays = [
    { id: "a", artist: "ArtistA", count: 3, ts: NOW },
    { id: "b", artist: "ArtistB", count: 1, ts: NOW },
    { id: "c", artist: "ArtistA", count: 2, ts: NOW },
    { id: "old", artist: "OldOne", count: 99, ts: NOW - 40 * DAY },
  ];
  const seed = journalSeed(plays, NOW);
  assert.equal(seed.plays, 6, "old play excluded from today's count");
  assert.equal(seed.topArtist, "ArtistA");
});

test("journalSeed falls back to the whole list when today is empty", () => {
  const plays = [{ id: "a", artist: "A", count: 2, ts: NOW - 2 * DAY }];
  const seed = journalSeed(plays, NOW);
  assert.equal(seed.plays, 2);
  assert.equal(seed.topArtist, "A");
});

test("todayKey and journalBody shape the daily note", () => {
  assert.match(todayKey(NOW), /^\d{4}-\d{2}-\d{2}$/);
  const body = journalBody("2026-10-10", { plays: 7, topArtist: "Zed" });
  assert.ok(body.includes("Plays: 7"));
  assert.ok(body.includes("Top artist: Zed"));
});

// ------------------------------------------- task 8: playlist linking ---

test("playlist notes link and unlink both ways", () => {
  const s = emptySidecar();
  assert.ok(linkPlaylist(s, "PL1", "n1"));
  assert.equal(noteForPlaylist(s, "PL1"), "n1");
  assert.equal(s.meta.n1.playlistId, "PL1");
  assert.equal(unlinkPlaylist(s, "PL1"), "n1");
  assert.equal(noteForPlaylist(s, "PL1"), null);
  assert.equal(s.meta.n1.playlistId, undefined);
  assert.equal(unlinkPlaylist(s, "PL1"), null, "second unlink is a no-op");
  assert.equal(linkPlaylist(s, "", "n2"), false);
});

// --------------------------------- tasks 2/3/6/7/8: full Alt+M drive ---

test("Alt+M menu attaches, chips render, activation seeks, review/journal/playlist work", async () => {
  const notes = { n1: { name: "Review", content: "Album Review\nRating: ★★★★☆\nMood: chill\nReplay: high\n", updated: NOW } };
  const core = makeCore("n1", notes);

  const calls = [];
  let searchQueries = [];
  const deps = {
    doc: fakeDoc(),
    storage: fakeStorage(),
    playingTrack: async () => ({ id: "T1", title: "Song One", artist: "ArtistX" }),
    currentTimeMs: async () => 154000,
    playTrackAt: (t, ms) => {
      calls.push([t, ms]);
      return Promise.resolve();
    },
    searchTracks: async (q) => {
      searchQueries.push(q);
      return [{ id: "S1", title: "Search Hit", artist: "Searcher" }];
    },
    loadPlays: async () => [
      { id: "a", artist: "JournalTop", count: 4, ts: Date.now() },
      { id: "b", artist: "Other", count: 1, ts: Date.now() },
    ],
    currentPlaylist: async () => ({ id: "PL1", name: "My Mix" }),
  };

  initNotepadMusic(core, deps);

  // No autoplay on open / render.
  assert.equal(calls.length, 0, "init must not trigger playback");

  // Open the menu with Alt+M.
  core.subs.keydown.forEach((fn) => fn({ altKey: true, ctrlKey: false, metaKey: false, key: "m" }));
  const overlay = core.mounts.overlay;
  const menu = overlay.children[0];
  assert.equal(menu.className, "npdm-menu");
  const labels = menu.children.map((r) => r.textContent);
  assert.deepEqual(labels, [
    "Attach playing track",
    "Attach playing track @ current time",
    "Attach track by search…",
    "New: Album Review",
    "New: Session Log",
    "Today's journal",
    "Note for current playlist",
    "New: Lyric sheet for playing track",
    "New: Artist bio for playing track",
    "Show mood board",
    "New: Chord snippet",
    "New: Sample log",
    "New: Remix notes",
    "New: Compare takes",
  ]);

  const rail = core.mounts.rail;

  // Attach the playing track (no timestamp).
  clickRow(overlay, "Attach playing track");
  await flush(5);
  assert.equal(rail.children.length, 1);
  assert.equal(rail.children[0].className, "npdm-chip");
  assert.equal(rail.children[0].textContent, "▶ Song One — ArtistX");
  assert.equal(calls.length, 0, "attaching must not autoplay");

  // Attach the playing track @ current time -> a timestamped chip + @2:34 line.
  clickRow(overlay, "Attach playing track @ current time");
  await flush(5);
  assert.equal(rail.children.length, 3);
  assert.equal(rail.children[1].textContent, "▶ Song One — ArtistX");
  assert.equal(rail.children[2].className, "npdm-chip-at");
  assert.equal(rail.children[2].textContent, "@2:34");

  // DOM-level activation of the timestamped chip calls the (stubbed) transport.
  rail.children[2].fire("click");
  assert.equal(calls.length, 1, "chip activation must call playTrackAt");
  assert.equal(calls[0][0].id, "T1");
  assert.equal(calls[0][1], 154000);

  // Attach by search: open the search row, type, pick a result.
  clickRow(overlay, "Attach track by search…");
  const searchMenu = overlay.children[0];
  const input = searchMenu.children[0];
  const results = searchMenu.children[1];
  input.value = "hit";
  input.fire("input");
  await flush();
  assert.deepEqual(searchQueries, ["hit"]);
  assert.equal(results.children.length, 1);
  assert.equal(results.children[0].textContent, "Search Hit — Searcher");
  results.children[0].fire("click");
  await flush(5);
  // The search chip is now in the rail (3 prior children + 1 new chip).
  assert.equal(rail.children.length, 4);
  assert.equal(rail.children[3].textContent, "▶ Search Hit — Searcher");

  // Review meta parse -> status-bar summary.
  core.subs.saved.forEach((fn) => fn({ id: "n1" }));
  assert.equal(core.mounts.statusExtra.textContent, "★4 · chill · high replay");

  // Listening journal seeds a note from fixture plays.
  const before = Object.keys(core.allNotes()).length;
  clickRow(overlay, "Today's journal");
  await flush(5);
  const after = Object.keys(core.allNotes());
  assert.equal(after.length, before + 1, "journal created a new note");
  const jn = core.allNotes()[after[after.length - 1]];
  assert.ok(jn.content.includes("Top artist: JournalTop"));
  assert.ok(core.toasts.some(([m]) => m.includes("journal")));

  // Playlist note links both ways and paints the rail's playlist line.
  // (openJournal closed the menu, so re-open it with Alt+M.)
  core.setActive("n1");
  core.subs.keydown.forEach((fn) => fn({ altKey: true, ctrlKey: false, metaKey: false, key: "m" }));
  clickRow(overlay, "Note for current playlist");
  await flush(5);
  const store = JSON.parse(deps.storage.getItem("tm-notepad-music"));
  const plNote = store.playlistNotes.PL1;
  assert.ok(plNote, "playlist note id recorded");
  assert.equal(store.meta[plNote].playlistId, "PL1");
  // The linked note now renders a "Playlist:" line in the rail.
  core.setActive(plNote);
  core.subs.note.forEach((fn) => fn({ id: plNote }));
  assert.equal(rail.children[0].className, "npdm-rail-pl");
  assert.equal(rail.children[0].textContent, "Playlist: PL1");
});

// ----------------------------------------- static contract (markup ↔ CSS ↔ JS) ---

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, "..", "src");
const moduleSrc = fs.readFileSync(path.join(src, "notepad-music.js"), "utf8");
const css = fs.readFileSync(path.join(src, "notepad-music.css"), "utf8");

test("module has no static app imports (only lazy dynamic import in deps)", () => {
  // A static `import { x } from "./queue.js"` at top level would drag dom.js'
  // side effects into Node (the qrview.js lesson). Only `import("...")` inside
  // functions is allowed.
  const statics = [...moduleSrc.matchAll(/^import[ {*/]/gm)];
  assert.equal(statics.length, 0, "no top-level static imports allowed");
  assert.ok(/await import\("\.\/queue\.js"\)/.test(moduleSrc), "lazy queue import expected");
  assert.ok(/await import\("\.\/playback\.js"\)/.test(moduleSrc), "lazy playback import expected");
});

test("every npdm- class used in the module has a CSS rule", () => {
  const used = new Set([...moduleSrc.matchAll(/className = "([^"]*)"/g)]
    .flatMap((m) => m[1].split(/\s+/))
    .filter((c) => c.startsWith("npdm-")));
  // classes built by string concat (search-row selected) — cover the base too
  for (const c of ["npdm-search-row", "npdm-chip", "npdm-chip-at", "npdm-menu", "npdm-row", "npdm-rail-pl", "npdm-search-input", "npdm-search-results", "npdm-moodboard", "npdm-mood-cell", "npdm-mood-img", "npdm-mood-cap", "npdm-mood-empty"]) used.add(c);
  assert.ok(used.size >= 8, `expected the npdm class set, found ${used.size}`);
  const missing = [...used].filter((c) => !css.includes(`.${c}`));
  assert.deepEqual(missing, [], `npdm classes without a CSS rule: ${missing.join(", ")}`);
});

test("CSS uses only npdm- namespace and carries dark parity", () => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = [...stripped.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim());
  const firstClasses = [];
  for (const sel of selectors) {
    const m = /\.([\w-]+)/.exec(sel);
    if (m) firstClasses.push(m[1]);
  }
  const foreign = [...new Set(firstClasses)].filter((c) => !c.startsWith("npdm-") && c !== "dark");
  assert.deepEqual(foreign, [], `non-npdm selectors leaked: ${foreign.join(", ")}`);
  assert.ok(css.includes("html.dark .npdm-"), "dark-mode overrides missing");
});
