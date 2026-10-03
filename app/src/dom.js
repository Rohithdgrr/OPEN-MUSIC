// dom.js — shared DOM element refs ($, $$, views, navLinks, errorEl, audio, bar, np)
// Split from main.js (Phase 4 M1).


export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const views = $$("[data-view]");
export const navLinks = $$("header nav a[data-path]");
export const errorEl = $("#error");
// ------------------------------------------------------------------ player -
export const audio = $("#audio");
audio.volume = 0.75;
// Crossfade bed: silent until a fade starts, so a stray src can never blast.
export const audio2 = $("#audio2");
audio2.volume = 0;

export const bar = {
  cover: $("#bar-cover"),
  coverFallback: $("#bar-cover-fallback"),
  title: $("#bar-title"),
  artist: $("#bar-artist"),
  badge: $("#bar-badge"),
  play: $("#bar-play"),
  playIcon: $("#bar-play-icon"),
  shuffle: $("#bar-shuffle"),
  prev: $("#bar-prev"),
  next: $("#bar-next"),
  repeat: $("#bar-repeat"),
  progress: $("#bar-progress"),
  fill: $("#bar-progress-fill"),
  cur: $("#bar-time-cur"),
  total: $("#bar-time-total"),
  volTrack: $("#bar-vol-track"),
  volFill: $("#bar-vol-fill"),
  queue: $("#bar-queue"),
  // bt: $("#bar-bt"), // Bluetooth button parked; see transport.js
};
export const np = {
  badge: $("#np-badge"),
  format: $("#np-format"),
  play: $("#master-play-btn"),
  playIcon: $("#master-play-icon"),
  prev: $("#btn-prev"),
  next: $("#btn-next"),
  shuffle: $("#btn-shuffle"),
  repeat: $("#btn-repeat"),
  timeline: $("#timeline-bar"),
  buffered: $("#buffered-bar"),
  progress: $("#progress-bar"),
  thumb: $("#progress-thumb"),
  cur: $("#track-current"),
  total: $("#track-total"),
  title: $("#track-title-heading"),
  artist: $("#track-artist-heading"),
  cover: $("#master-album-cover"),
  vinyl: $("#spinning-vinyl-icon"),
  volTrack: $("#volume-track"),
  volFill: $("#volume-fill"),
  volMute: $("#vol-mute-btn"),
  volIcon: $("#vol-icon"),
  fav: $("#track-fav-btn"),
  favIcon: $("#fav-icon"),
};

