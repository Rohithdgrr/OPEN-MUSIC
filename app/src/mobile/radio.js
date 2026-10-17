// radio.js — endless radio for the mobile player.
//
// Port of the desktop's src/radio.js: when the queue runs low (repeat off) a
// JioSaavn station seeded from the current song keeps feeding it. Batches land
// in JioSaavn's own order — local logic only gates eligibility (queued /
// recently heard / just-skipped), it never re-ranks (§8.8). The queue array
// is passed in by player.js, which owns it.
import { invoke, load, save, FAVS_KEY, PLAYS_KEY, LIBRARY_KEY } from "./shared.js";
import { buildSignals, pickBatch } from "../taste.js";

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

/// Everything the eligibility gate reads: local logs + the play-event log
/// (docs/recommendations.md §8.8). Events are best-effort — without the store
/// the gate still drops queued and heard tracks.
async function tasteSignals(queue, qi) {
  const plays = load(PLAYS_KEY, []);
  let events = [];
  try {
    const db = await import("../store_db.js");
    events = await db.getPlayEvents(400);
  } catch {}
  return buildSignals({
    plays,
    favs: load(FAVS_KEY, []),
    library: load(LIBRARY_KEY, []),
    events,
    queuedIds: queue.map((t) => t && t.id),
    heardIds: plays.slice(0, 15).map((p) => p.id),
    current: queue[qi] || null,
  });
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
    const signals = await tasteSignals(queue, qi);
    added = pickBatch(fresh, signals);
    // Three starved batches in a row: drop the exhausted station and re-seed
    // from the current track instead of dead-ending the queue.
    if (!added.length && seed && ++recoEmpty >= 3) {
      recoEmpty = 0;
      radioStation = "";
      try {
        const page = await invoke("recommend_songs", { song: seed.id, station: null });
        if (page && page.station) {
          radioStation = page.station;
          added = pickBatch(page.tracks || [], signals);
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
