// radio.js — endless radio recommendation logic
// Split from main.js (Phase 4 M1).
import { diag, invoke } from "./core.js";
import { homeFeed, loadLibrary, loadPlays } from "./home.js";
import { queue, queueIndex, renderQueue } from "./queue.js";

// ---------------------------------------------------------- endless radio -
// When the queue runs out (repeat off) playback never just stops: a JioSaavn
// radio station seeded from the current song keeps feeding the queue, and the
// batch is re-ranked against local taste before it lands.
export let radioStation = "";
export let radioBusy = false;
export let recoEmpty = 0;

/// Rank one radio batch: favorites first, then artists the user actually
/// plays, never anything already queued or heard in the last 15 plays.
export function scoreReco(cands) {
  const queued = new Set(queue.map((q) => q.track.id));
  const heard = new Set(loadPlays().slice(0, 15).map((p) => p.id));
  const weight = new Map();
  for (const f of loadLibrary()) if (f.artist) weight.set(f.artist, (weight.get(f.artist) || 0) + 3);
  for (const p of loadPlays()) if (p.artist) weight.set(p.artist, (weight.get(p.artist) || 0) + 1);
  const album = queue[queueIndex]?.track.album;
  const scored = [];
  const taken = new Set();
  for (const t of cands) {
    if (!t?.id || queued.has(t.id) || heard.has(t.id) || taken.has(t.id)) continue;
    taken.add(t.id);
    let s = weight.get(t.artist) || 0;
    if (album && t.album === album) s += 1;
    scored.push({ t, s });
  }
  if (!scored.length) {
    // The batch was all repeats â€” endless mode prefers a rerun over silence,
    // so fall back to whatever at least is not sitting in the queue right now.
    for (const t of cands) {
      if (!t?.id || queued.has(t.id) || taken.has(t.id)) continue;
      taken.add(t.id);
      scored.push({ t, s: -1 });
    }
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, 12).map((x) => x.t);
}

/// Last resort when the radio answers with nothing: everything else by this
/// artist, then whatever the home charts hold.
export async function recoFallback(track) {
  const taken = new Set(queue.map((q) => q.track.id));
  const fresh = (list) => list.filter((t) => t?.id && !taken.has(t.id));
  try {
    if (track?.artist) {
      const page = await invoke("search_songs", { query: track.artist, limit: 20, page: 1 });
      const hits = fresh((page && page.tracks) || []);
      if (hits.length) return hits;
    }
  } catch (err) {
    diag("radio-fallback", false, String(err));
  }
  return fresh(homeFeed?.top_tracks || []);
}

/// Top the queue up before it runs dry (or when the end is already here).
/// One flight at a time; radio first, artist/chart fallback behind it.
export async function ensureReco() {
  if (radioBusy) return;
  const seed = queue[queueIndex]?.track;
  if (!seed && !radioStation) return;
  radioBusy = true;
  try {
    let fresh = [];
    try {
      const page = await invoke("recommend_songs", {
        song: seed ? seed.id : null,
        station: radioStation || null,
      });
      if (page && page.station) {
        radioStation = page.station;
        fresh = page.tracks || [];
      }
      diag("radio", !!fresh.length, fresh.length ? `${fresh.length} songs Â· station kept` : "empty batch");
    } catch (err) {
      diag("radio", false, String(err));
    }
    if (!fresh.length) fresh = await recoFallback(seed);
    let added = scoreReco(fresh);
    // Three starved batches in a row means the station is exhausted: drop it
    // and re-seed from the current track so the radio can restart itself
    // instead of dead-ending at "No more recommendations".
    if (!added.length && seed && ++recoEmpty >= 3) {
      recoEmpty = 0;
      radioStation = null;
      diag("radio", null, "station exhausted - re-seeding");
      try {
        const page = await invoke("recommend_songs", { song: seed.id, station: null });
        if (page && page.station) {
          radioStation = page.station;
          added = scoreReco(page.tracks || []);
        }
      } catch (err) {
        diag("radio", false, String(err));
      }
    } else if (added.length) {
      recoEmpty = 0;
    }
    for (const t of added) queue.push({ track: t, state: null, reco: true });
    if (added.length) {
      renderQueue();
      diag("radio-queue", true, `+${added.length} recommended`);
    }
  } catch (err) {
    diag("radio", false, String(err));
  } finally {
    radioBusy = false;
  }
}


// Setters for state rebound from other modules (ESM imports are read-only).
export function setRadioStation(v) { radioStation = v; }
