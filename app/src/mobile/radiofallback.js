const FALLBACK_CHART_LIMIT = 3;
const FALLBACK_TRACK_LIMIT = 20;

const rowId = (row) => (row && row.id != null ? String(row.id).trim() : "");

export async function radioFallback(seed, queue, doInvoke, select, onError) {
  if (typeof doInvoke !== "function" || typeof select !== "function") return [];

  const taken = new Set((Array.isArray(queue) ? queue : []).map(rowId).filter(Boolean));
  const fresh = (rows) => {
    const seen = new Set(taken);
    const out = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = rowId(row);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(row);
      if (out.length >= FALLBACK_TRACK_LIMIT) break;
    }
    return out;
  };
  const choose = (rows) => {
    const candidates = fresh(rows);
    return candidates.length ? select(candidates) : [];
  };

  const artist = String((seed && seed.artist) || "").trim();
  if (artist) {
    try {
      const page = await doInvoke("search_songs", { query: artist, limit: 20, page: 1 });
      const selected = choose(page && page.tracks);
      if (selected.length) return selected;
    } catch (error) {
      onError("search_songs", error);
    }
  }

  let feed;
  try {
    feed = await doInvoke("home_feed");
  } catch (error) {
    onError("home_feed", error);
    return [];
  }

  const charts = (Array.isArray(feed && feed.charts) ? feed.charts : []).slice(0, FALLBACK_CHART_LIMIT);
  for (let i = 0; i < charts.length; i++) {
    const chart = charts[i];
    const chartId = String((chart && chart.id) || "").trim();
    if (!chartId) continue;

    if (i === 0) {
      const topSelected = choose(feed.top_tracks);
      if (topSelected.length) return topSelected;
    }

    try {
      const tracks = await doInvoke("playlist_tracks", { id: chartId });
      const selected = choose(tracks);
      if (selected.length) return selected;
    } catch (error) {
      onError("playlist_tracks", error);
    }
  }
  return [];
}
