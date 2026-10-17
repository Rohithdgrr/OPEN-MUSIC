// radio.js — endless radio recommendation logic
// Split from main.js (Phase 4 M1).
import { diag, invoke } from "./core.js";
import { homeFeed, loadLibrary, loadPlays } from "./home.js";
import { loadFavs } from "./library.js";
import { queue, queueIndex, renderQueue } from "./queue.js";
import { getPlayEvents } from "./store_db.js";
import { buildSignals, pickBatch } from "./taste.js";

// ---------------------------------------------------------- endless radio -
// When the queue runs out (repeat off) playback never just stops: a JioSaavn
// radio station seeded from the current song keeps feeding the queue. Batches
// land in JioSaavn's own order — local logic only gates eligibility (queued /
// recently heard / just-skipped), it never re-ranks (docs/recommendations.md
// §8.8).
export let radioStation = "";
export let radioBusy = false;
export let recoEmpty = 0;

/// Everything the eligibility gate reads: local logs + the play-event log
/// (docs/recommendations.md §8.8). Events are best-effort — without the store
/// the gate still drops queued and heard tracks.
async function tasteSignals() {
  const plays = loadPlays();
  let events = [];
  try {
    events = await getPlayEvents(400);
  } catch {}
  return buildSignals({
    plays,
    favs: loadFavs(),
    library: loadLibrary(),
    events,
    queuedIds: queue.map((q) => q.track && q.track.id),
    heardIds: plays.slice(0, 15).map((p) => p.id),
    current: queue[queueIndex] && queue[queueIndex].track,
  });
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
      diag("radio", !!fresh.length, fresh.length ? `${fresh.length} songs · station kept` : "empty batch");
    } catch (err) {
      diag("radio", false, String(err));
    }
    if (!fresh.length) fresh = await recoFallback(seed);
    const signals = await tasteSignals();
    let added = pickBatch(fresh, signals);
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
          added = pickBatch(page.tracks || [], signals);
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
