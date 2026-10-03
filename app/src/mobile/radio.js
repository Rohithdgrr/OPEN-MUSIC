// radio.js — endless radio for the mobile player.
//
// Port of the desktop's src/radio.js: when the queue runs low (repeat off) a
// JioSaavn station seeded from the current song keeps feeding it, and each
// batch is re-ranked against local taste before it lands. The queue array is
// passed in by player.js, which owns it.
import { invoke, load, save, FAVS_KEY, PLAYS_KEY, LIBRARY_KEY } from "./shared.js";

const RADIO_KEY = "tm-radio";

export function isRadioOn() {
  return String(load(RADIO_KEY, "1")) === "1";
}

export function setRadioOn(on) {
  save(RADIO_KEY, on ? "1" : "0");
  return on;
}

export let radioStation = "";
let radioBusy = false;
let recoEmpty = 0;

/// Rank one batch: favourites first, then artists the user actually plays,
/// never anything already queued or heard in the last 15 plays.
function scoreReco(cands, queue, qi) {
  const queued = new Set(queue.map((t) => t && t.id));
  const plays = load(PLAYS_KEY, []);
  const heard = new Set(plays.slice(0, 15).map((p) => p.id));
  const weight = new Map();
  for (const f of load(LIBRARY_KEY, [])) if (f && f.artist) weight.set(f.artist, (weight.get(f.artist) || 0) + 3);
  for (const f of load(FAVS_KEY, [])) if (f && f.artist) weight.set(f.artist, (weight.get(f.artist) || 0) + 3);
  for (const p of plays) if (p && p.artist) weight.set(p.artist, (weight.get(p.artist) || 0) + 1);
  const album = queue[qi] && queue[qi].album;
  const scored = [];
  const taken = new Set();
  for (const t of cands) {
    if (!t || !t.id || queued.has(t.id) || heard.has(t.id) || taken.has(t.id)) continue;
    taken.add(t.id);
    let s = weight.get(t.artist) || 0;
    if (album && t.album === album) s += 1;
    scored.push({ t, s });
  }
  if (!scored.length) {
    // The batch was all repeats — endless mode prefers a rerun over silence.
    for (const t of cands) {
      if (!t || !t.id || queued.has(t.id) || taken.has(t.id)) continue;
      taken.add(t.id);
      scored.push({ t, s: -1 });
    }
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, 12).map((x) => x.t);
}

/// Last resort when the radio answers with nothing: everything else by this
/// artist, then the day's chart.
async function recoFallback(seed, queue) {
  const taken = new Set(queue.map((t) => t && t.id));
  const fresh = (list) => (list || []).filter((t) => t && t.id && !taken.has(t.id));
  try {
    if (seed && seed.artist) {
      const page = await invoke("search_songs", { query: seed.artist, limit: 20, page: 1 });
      const hits = fresh(page && page.tracks);
      if (hits.length) return hits;
    }
  } catch {}
  return [];
}

/// Top the queue up before it runs dry. Resolves with how many were added.
export async function ensureReco(queue, qi) {
  if (radioBusy || !invoke || !isRadioOn()) return 0;
  const seed = queue[qi] || null;
  if (!seed && !radioStation) return 0;
  radioBusy = true;
  let added;
  try {
    let fresh = [];
    try {
      const page = await invoke("recommend_songs", { song: seed ? seed.id : null, station: radioStation || null });
      if (page && page.station) {
        radioStation = page.station;
        fresh = page.tracks || [];
      }
    } catch {}
    if (!fresh.length) fresh = await recoFallback(seed, queue);
    added = scoreReco(fresh, queue, qi);
    // Three starved batches in a row: drop the exhausted station and re-seed
    // from the current track instead of dead-ending the queue.
    if (!added.length && seed && ++recoEmpty >= 3) {
      recoEmpty = 0;
      radioStation = "";
      try {
        const page = await invoke("recommend_songs", { song: seed.id, station: null });
        if (page && page.station) {
          radioStation = page.station;
          added = scoreReco(page.tracks || [], queue, qi);
        }
      } catch {}
    } else if (added.length) {
      recoEmpty = 0;
    }
    for (const t of added) queue.push(t);
  } finally {
    radioBusy = false;
  }
  return added.length;
}
