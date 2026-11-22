// radio.js — endless radio for the mobile player.
//
// Port of the desktop's src/radio.js: when the queue runs low (repeat off) a
// JioSaavn station seeded from the current song keeps feeding it. Batches land
// in JioSaavn's own order — local logic only gates eligibility (queued /
// recently heard / just-skipped), it never re-ranks (§8.8). The queue array
// is passed in by player.js, which owns it.
import { invoke, load, save, FAVS_KEY, PLAYS_KEY, LIBRARY_KEY, pushDiag } from "./shared.js";
import { buildSignals, pickBatch } from "../taste.js";
import { radioFallback } from "./radiofallback.js";

const RADIO_KEY = "tm-radio";
// Ids the radio has already served, persisted across sessions. The heard
// window only covers the last ~15 plays, so without this a station batch
// recycled the same songs into Up Next every cycle (2026-11-22).
const SEEN_KEY = "tm-radio-seen";
const SEEN_MAX = 400;
const BATCH_LIMIT = 20;
const ARTIST_CAP = 2;

function loadSeen() {
  const list = load(SEEN_KEY, []);
  return new Set((Array.isArray(list) ? list : []).map((v) => String(v && v.id ? v.id : v)).filter(Boolean));
}

function rememberSeen(tracks) {
  try {
    const cur = load(SEEN_KEY, []);
    const have = new Set(cur.map((v) => String(v && v.id ? v.id : v)));
    for (const t of tracks || []) {
      const id = t && t.id ? String(t.id) : "";
      if (id && !have.has(id)) {
        have.add(id);
        cur.push(id);
      }
    }
    save(SEEN_KEY, cur.slice(-SEEN_MAX));
  } catch {}
}

/// Stable spread: keep the station's order but never let one artist own more
/// than ARTIST_CAP seats in a batch. Greedy first-fit preserves upstream
/// order for everything that already fits (docs/recommendations.md §8.8 —
/// local logic gates, it does not re-rank).
function spreadByArtist(list, cap = ARTIST_CAP) {
  const pool = (Array.isArray(list) ? list : []).slice();
  const counts = new Map();
  const artistOf = (t) => String((t && (t.artist || t.subtitle)) || "").toLowerCase();
  const out = [];
  while (pool.length) {
    let idx = pool.findIndex((t) => (counts.get(artistOf(t)) || 0) < cap);
    if (idx < 0) idx = 0; // every artist capped: take the head anyway
    const t = pool.splice(idx, 1)[0];
    const a = artistOf(t);
    if (a) counts.set(a, (counts.get(a) || 0) + 1);
    out.push(t);
  }
  return out;
}

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
    const signals = await tasteSignals(queue, qi);
    // Permanently exclude everything the radio already served — the heard
    // tail alone let the same station songs cycle back into Up Next.
    for (const id of loadSeen()) signals.queued.add(id);
    added = spreadByArtist(pickBatch(fresh, signals, { limit: BATCH_LIMIT }));
    if (!added.length) {
      added = spreadByArtist(await radioFallback(seed, queue, invoke, (rows) => pickBatch(rows, signals, { limit: BATCH_LIMIT }), (command, error) => {
        pushDiag("radio_fallback", false, `${command}: ${String(error).split("\n")[0].slice(0, 80)}`);
      }));
    }
    // Three starved batches in a row: drop the exhausted station and re-seed
    // from the current track instead of dead-ending the queue.
    if (!added.length && seed && ++recoEmpty >= 3) {
      recoEmpty = 0;
      radioStation = "";
      try {
        const page = await invoke("recommend_songs", { song: seed.id, station: null });
        if (page && page.station) {
          radioStation = page.station;
          added = spreadByArtist(pickBatch(page.tracks || [], signals, { limit: BATCH_LIMIT }));
        }
      } catch {}
    } else if (added.length) {
      recoEmpty = 0;
    }
    for (const t of added) queue.push(t);
    if (added.length) rememberSeen(added);
  } finally {
    radioBusy = false;
  }
  return added.length;
}
