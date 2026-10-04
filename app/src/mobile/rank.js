// rank.js — mobile search ordering. Pure (no DOM) so it is unit-tested the
// way fuzzy.js is: the desktop keeps its identical SORTS table inline in
// search.js, which nothing can import.

import { fuzzyScore } from "../fuzzy.js";

export const SEARCH_SORTS = ["relevance", "bitrate", "popular", "longest", "az"];
export const SORT_LABEL = { relevance: "RELEVANCE", bitrate: "QUALITY", popular: "POPULAR", longest: "LENGTH", az: "A–Z" };

/// Next sort in the cycle (relevance → quality → popular → length → A–Z).
export function nextSort(sort) {
  const i = SEARCH_SORTS.indexOf(sort);
  return SEARCH_SORTS[(i + 1) % SEARCH_SORTS.length];
}

/// Order one page of tracks. `relevance` ranks by fuzzy text score against the
/// query (the same score the desktop uses), ties broken by popularity and then
/// by catalog order so the page never reshuffles for equal scores.
export function rankTracks(q, tracks, sort = "relevance") {
  if (!tracks || !tracks.length) return tracks || [];
  if (sort !== "relevance") {
    return [...tracks].sort((a, b) => {
      if (sort === "bitrate") return (b.hq ? 1 : 0) - (a.hq ? 1 : 0) || num(b.plays) - num(a.plays);
      if (sort === "popular") return num(b.plays) - num(a.plays);
      if (sort === "longest") return num(b.duration_secs) - num(a.duration_secs);
      return String(a.title || "").localeCompare(String(b.title || ""));
    });
  }
  return tracks
    .map((t, i) => ({ t, i, s: q ? fuzzyScore(q, t.title, t.artist, t.album) : 0 }))
    .sort((a, b) => b.s - a.s || num(b.t.plays) - num(a.t.plays) || a.i - b.i)
    .map((x) => x.t);
}

const num = (v) => Number(v || 0);