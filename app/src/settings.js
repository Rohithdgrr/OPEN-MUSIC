// settings.js — settings dialog, widget prefs, user preferences
// Split from main.js (Phase 4 M1).
import { diag, esc, invoke, notifyLocalChange, toast } from "./core.js";
import { $, errorEl } from "./dom.js";
import { loadHome } from "./home.js";
import {
  loadFavs,
  loadLocalPls,
  paintFavHearts,
  renderFavs,
  renderLibrary,
  saveFavs,
  saveLocalPls,
} from "./library.js";
import {
  // LAST_SYNC_KEY belongs to the parked Google Drive UI below.
  // LAST_SYNC_KEY,
  applyBackup,
  backupFilename,
  buildBackup,
  parseBackupFile,
  playlistFilename,
  playlistToCsv,
  playlistToM3u,
  readSettings,
  writeSettings,
} from "./sync.js";
// Google Drive sync engine (gsync.js) — parked with the Drive UI; uncomment
// this import to re-enable the Sync now button.
// import { isSyncing, syncRound } from "./gsync.js";
import { doSearch } from "./search.js";
import { fmtBytes, npText } from "./util.js";
import { DL_QUALITY_KEY, prefDlQuality } from "./vault.js";
import { NET_MODE_KEY, setModePref } from "./net.js";
import { importCsvToPlaylist, readCsvFile } from "./importer.js";

// ---------------------------------------------------------------- settings -
// One native <dialog>, three entries and nothing else. The body swaps between
// the menu and a single section, so a nested dialog is never needed.
export const APP = { name: "TRANCE MUSIC", version: "0.3.0", id: "com.openmusic.trancemusic" };

/// What to call this machine wherever the copy used to hard-code "Windows".
export const PLATFORM = /windows/i.test(navigator.userAgent)
  ? "Windows"
  : /mac/i.test(navigator.userAgent)
    ? "macOS"
    : /linux|x11/i.test(navigator.userAgent)
      ? "Linux"
      : "Desktop";

/// Direct Rust dependencies, read off Cargo.lock — the list an attribution
/// page is expected to carry. The full transitive tree is 469 crates and is not
/// useful on screen; the lock file is the authoritative copy.
export const LICENSES = [
  ["tauri", "2.12.0", "MIT OR Apache-2.0"],
  ["serde", "1.0.229", "MIT"],
  ["serde_json", "1.0.151", "MIT OR Apache-2.0"],
  ["tokio", "1.53.1", "MIT"],
  ["axum", "0.8.9", "MIT"],
  ["reqwest", "0.12.28", "MIT OR Apache-2.0"],
  ["url", "2.5.8", "MIT OR Apache-2.0"],
  ["futures", "0.3.34", "MIT OR Apache-2.0"],
  ["des", "0.8.1", "MIT OR Apache-2.0"],
  ["base64", "0.22.1", "MIT OR Apache-2.0"],
  ["tauri-plugin-global-shortcut", "2.4.0", "MIT OR Apache-2.0"],
  ["tauri-plugin-single-instance", "2.5.2", "MIT OR Apache-2.0"],
];

export const kv = (k, v) => `
  <div class="flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-3 px-3.5 py-2.5">
    <dt class="font-label-mono text-[10px] uppercase tracking-wider text-on-surface-variant sm:w-28 shrink-0">${esc(k)}</dt>
    <dd class="text-sm text-on-surface min-w-0">${esc(v)}</dd>
  </div>`;

export const clause = (n, h, body) => `
  <li class="flex gap-3 px-4 py-3.5">
    <span class="w-6 h-6 shrink-0 mt-0.5 rounded-md bg-primary text-on-primary font-label-mono text-[11px] flex items-center justify-center">${esc(n)}</span>
    <span class="min-w-0 flex flex-col gap-1">
      <h3 class="text-sm font-semibold text-on-surface">${esc(h)}</h3>
      <p class="text-[13px] leading-relaxed text-on-surface-variant">${body}</p>
    </span>
  </li>`;

// ------------------------------------------------------------- view chrome -
// Every Settings view is built from these five shapes, so the nine sections
// read as one dialog rather than nine hand-styled screens: a card, a row with
// a tile, a switch, a select, and a note pinned off the left edge.
export const setCard = (rows) =>
  `<div class="rounded-xl border border-surface-container-highest/60 bg-surface-container-lowest overflow-hidden divide-y divide-surface-container-high/70">${rows}</div>`;

export const setTile = (icon) => `
        <span class="w-8 h-8 shrink-0 rounded-lg bg-surface-container border border-surface-container-highest/60 flex items-center justify-center text-on-surface-variant">
          <span class="material-symbols-outlined text-[18px]">${icon}</span>
        </span>`;

export const setRow = (icon, label, sub, control = "") => `
      <div class="flex items-center gap-3 px-3.5 py-3 transition-colors">
        ${setTile(icon)}
        <span class="min-w-0 flex-1">
          <span class="block text-sm font-medium text-on-surface">${label}</span>
          <span class="block text-xs text-on-surface-variant mt-0.5">${sub}</span>
        </span>
        ${control}
      </div>`;

export const setSwitch = (on, attrs = "", tag = "button") => `
        <${tag}${tag === "button" ? ` type="button" role="switch" aria-checked="${on}"` : ""} ${attrs} class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
          on ? "bg-primary" : "bg-surface-container-highest"
        }"><span class="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${on ? "translate-x-4" : "translate-x-0.5"}"></span></${tag}>`;

export const setSelect =
  "max-w-[9.5rem] shrink-0 bg-surface-container-lowest border border-surface-container-highest/70 rounded-lg px-2 py-1.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/20";

export const setBtnCls =
  "px-3 py-1.5 rounded-lg border border-surface-container-highest/70 bg-surface-container-lowest text-xs font-medium text-on-surface hover:bg-surface-container transition-colors";

export const setBtn = (label, attrs = "", cls = "") =>
  `<button type="button" ${attrs} class="${setBtnCls} ${cls}">${label}</button>`;

export const setGroup = (label) =>
  `<span class="font-label-mono text-[10px] uppercase tracking-[0.16em] text-on-surface-variant px-1 block">${label}</span>`;

export const setNote = (html) =>
  `<p class="text-xs leading-relaxed text-on-surface-variant border-l-2 border-primary/40 pl-3">${html}</p>`;

// ----------------------------------------------------------- desktop widget -
// The card is its own Tauri window (label "widget", declared in
// tauri.conf.json and hidden at boot). All window work happens in Rust so the
// main window needs no extra `core:window` permissions - only events, which
// `core:event:default` already allows.
export const DESKTOP_WIDGET_KEY = "tm-desk-widget";
export const DESKTOP_WIDGET_MODE = "tm-desk-widget-mode";
/// Where the card was dragged to; shared through localStorage so the card can
/// restore itself before the main window ever talks to it.
export const DESKTOP_WIDGET_POS = "tm-desk-widget-pos";

export function widgetPref() {
  try {
    return localStorage.getItem(DESKTOP_WIDGET_KEY) === "1";
  } catch {
    return false;
  }
}
/// "top" floats above everything; "desktop" parks it on the wallpaper.
export function widgetMode() {
  try {
    return localStorage.getItem(DESKTOP_WIDGET_MODE) === "desktop" ? "desktop" : "top";
  } catch {
    return "top";
  }
}
export async function applyWidget({ show = widgetPref(), embed = widgetMode() === "desktop" } = {}) {
  try {
    await invoke("widget_show", { show, embed });
  } catch (err) {
    diag("widget", false, String(err));
  }
}

// -------------------------------------------------------------- preferences -
// Profile + catalog preferences live in localStorage (shared with the card
// window); the pieces the backend needs are pushed over once at boot.
export const NAME_KEY = "tm-name";
export const AUTOSTART_KEY = "tm-autostart"; // missing = on, so first run starts with Windows
export const LANG_KEY = "tm-lang"; // JSON array of JioSaavn language slugs; empty = all
export const COUNTRY_KEY = "tm-country"; // ISO code, "" = source default

export function prefStr(key, dflt) {
  try {
    return localStorage.getItem(key) || dflt;
  } catch {
    return dflt;
  }
}
export function savePref(key, value) {
  try {
    localStorage.setItem(key, value);
    notifyLocalChange();
  } catch {}
}
export const prefName = () => prefStr(NAME_KEY, "Listener");
/// Every language the listener picked. A bare slug (the pre-multi format) is
/// read as a one-language list, so nothing is lost on upgrade.
export function prefLangs() {
  const raw = prefStr(LANG_KEY, "");
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.filter((s) => typeof s === "string" && s && s !== "all");
  } catch {}
  return raw === "all" ? [] : [raw];
}
export function saveLangs(list) {
  savePref(LANG_KEY, JSON.stringify([...new Set(list.filter((s) => s && s !== "all"))]));
}
/// The one language the catalog itself is asked for — the first pick. The rest
/// are applied client-side by `filterLang`, which is the only place that can
/// keep a multi-language set.
export const prefLang = () => prefLangs()[0] || "all";
export const prefCountry = () => prefStr(COUNTRY_KEY, "");
export const autostartPref = () => prefStr(AUTOSTART_KEY, "1") !== "0";

// ------------------------------------------------- playback prefs (new) -
export const STREAM_QUALITY_KEY = "tm-stream-quality";
export const GAPLESS_KEY = "tm-gapless";
export const REMEMBER_POS_KEY = "tm-remember-pos";
export const PLAY_SPEED_KEY = "tm-play-speed";
export const XFADE_KEY = "tm-xfade";
export const GEMINI_KEY = "tm-gemini-key";
export const prefStreamQuality = () => prefStr(STREAM_QUALITY_KEY, "320kbps");
export const gaplessPref = () => prefStr(GAPLESS_KEY, "0") === "1";
export const rememberPosPref = () => prefStr(REMEMBER_POS_KEY, "1") !== "0";
export const prefPlaySpeed = () => {
  const v = Number(prefStr(PLAY_SPEED_KEY, "1"));
  return [0.75, 0.9, 1, 1.1, 1.25, 1.5].includes(v) ? v : 1;
};
export function applyPlaySpeed() {
  const els = [document.getElementById("audio"), document.getElementById("audio2")].filter(Boolean);
  for (const a of els) {
    try {
      a.playbackRate = prefPlaySpeed();
      a.preservesPitch = true;
    } catch {}
  }
}

// ------------------------------------------------ appearance prefs (new) -
export const THEME_KEY = "tm-theme";
export const DENSITY_KEY = "tm-density";
export const prefTheme = () => prefStr(THEME_KEY, "dark");
export const prefDensity = () => prefStr(DENSITY_KEY, "comfortable");
export function applyTheme() {
  const t = prefTheme();
  const dark =
    t === "dark" ? true : t === "light" ? false : window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  document.documentElement.classList.toggle("dark", !!dark);
  try {
    document.body.dataset.density = prefDensity();
  } catch {}
}
try {
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if (prefTheme() === "system") applyTheme();
  });
} catch {}

// --------------------------------------------------- lyrics prefs (new) -
export const LYRICS_AUTOSCROLL_KEY = "tm-lyrics-autoscroll";
export const LYRICS_GLOSS_KEY = "tm-lyrics-gloss";
export const LYRICS_SIZE_KEY = "tm-lyrics-size";
export const lyricsAutoScrollPref = () => prefStr(LYRICS_AUTOSCROLL_KEY, "1") !== "0";
export const lyricsGlossPref = () => prefStr(LYRICS_GLOSS_KEY, "0") === "1";
export const prefLyricsSize = () => {
  const v = prefStr(LYRICS_SIZE_KEY, "m");
  return ["s", "m", "l"].includes(v) ? v : "m";
};
export const lyricsSizePx = () => ({ s: "13px", m: "15px", l: "18px" })[prefLyricsSize()];

export function paintGreeting() {
  const el = $("#home-name");
  if (el) el.textContent = prefName();
}

/// Registry Run entry (startup) + the language/country every catalog request
/// is built with. The whole language set goes over so the backend cache key
/// changes whenever *any* pick changes, not just the leading one.
export function applySysPrefs() {
  invoke("autostart_set", { on: autostartPref() }).catch((e) => diag("autostart", false, String(e)));
  invoke("content_prefs_set", { lang: prefLangs().join(","), country: prefCountry() }).catch((e) =>
    diag("prefs", false, String(e)),
  );
  try {
    applyTheme();
  } catch {}
  try {
    applyPlaySpeed();
  } catch {}
}

/// Search results, load-more pages and Home's rankings all flow through here:
/// keep the selected languages, but only when the source actually speaks one
/// of them - an all-English query under a Telugu-only preference would
/// otherwise paint an empty page instead of the results the user asked for.
/// A track in any one of the picked languages passes; when nothing matches,
/// the unfiltered list is returned rather than an empty screen.
export function filterLang(list) {
  const langs = prefLangs();
  if (!langs.length || !Array.isArray(list)) return list;
  const hit = list.filter((t) =>
    String(t.language || "")
      .toLowerCase()
      .split(",")
      .some((s) => langs.includes(s.trim())),
  );
  return hit.length ? hit : list;
}

/// Display label for a language slug — "telugu" → "Telugu".
export function langLabel(slug) {
  const hit = LANGS.find(([v]) => v === slug);
  if (hit) return hit[1];
  return slug ? slug[0].toUpperCase() + slug.slice(1) : "";
}

/// Home's own filter, stricter than `filterLang`: rows that carry a language
/// must match the picks, rows that carry none are kept (nothing to filter
/// them by). A shelf is only emptied when its source *does* speak another
/// language — which `langShelves` in home.js then refills from a
/// language-scoped search.
export function filterLangHome(list) {
  const langs = prefLangs();
  if (!langs.length || !Array.isArray(list)) return list;
  if (!list.some((t) => String(t.language || "").trim())) return list;
  return list.filter((t) =>
    String(t.language || "")
      .toLowerCase()
      .split(",")
      .some((s) => langs.includes(s.trim())),
  );
}

/// JioSaavn language slugs the catalog speaks. Module scope (not scoped to the
/// General view) because the chip handler names the picked languages in its
/// toast after the panel is repainted.
const LANGS = [
  ["all", "All languages"],
  ["telugu", "Telugu"],
  ["hindi", "Hindi"],
  ["tamil", "Tamil"],
  ["bengali", "Bengali"],
  ["kannada", "Kannada"],
  ["malayalam", "Malayalam"],
  ["english", "English"],
  ["chinese", "Chinese"],
  ["german", "German"],
  ["marathi", "Marathi"],
  ["punjabi", "Punjabi"],
  ["gujarati", "Gujarati"],
  ["odia", "Odia"],
  ["urdu", "Urdu"],
  ["spanish", "Spanish"],
  ["french", "French"],
  ["japanese", "Japanese"],
  ["korean", "Korean"],
];

// Inline Spotify mark (green circle + three bars) for the Settings menu and
// the Spotify section tile. Inline SVG, not a font glyph or a dependency.
export const SPOTIFY_LOGO = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#1DB954"/><path d="M7.2 10.3Q11.5 8.8 16.2 10.6" stroke="#191414" stroke-width="1.4" stroke-linecap="round" fill="none"/><path d="M7.4 12.7Q11.3 11.5 15.4 13" stroke="#191414" stroke-width="1.2" stroke-linecap="round" fill="none"/><path d="M7.6 15Q10.8 14.1 13.9 15.1" stroke="#191414" stroke-width="1" stroke-linecap="round" fill="none"/></svg>`;

export const SETTINGS_VIEWS = {
  general: {
    eyebrow: "Settings / General",
    body: () => {
      const name = prefName();
      const startOn = autostartPref();
      const langs = prefLangs();
      const country = prefCountry();
      const COUNTRIES = [
        ["", "Automatic"],
        ["IN", "India"],
        ["BD", "Bangladesh"],
        ["NP", "Nepal"],
        ["LK", "Sri Lanka"],
        ["PK", "Pakistan"],
        ["AE", "United Arab Emirates"],
        ["SA", "Saudi Arabia"],
        ["QA", "Qatar"],
        ["US", "United States"],
        ["CA", "Canada"],
        ["GB", "United Kingdom"],
        ["AU", "Australia"],
        ["SG", "Singapore"],
        ["MY", "Malaysia"],
        ["DE", "Germany"],
        ["FR", "France"],
        ["JP", "Japan"],
        ["ZA", "South Africa"],
        ["BR", "Brazil"],
      ];
      const options = (rows, value) =>
        rows
          .map(([v, l]) => `<option value="${esc(v)}"${v === value ? " selected" : ""}>${esc(l)}</option>`)
          .join("");
      const activeLangs = langs.length ? langs : [];
      const isAll = !activeLangs.length;
      const langChip = (v, l, on) =>
        `<button type="button" data-lang="${esc(v)}" aria-pressed="${on}" class="px-3 py-1.5 rounded-lg text-xs font-medium shrink-0 transition-all flex items-center gap-1.5 border ${
          on
            ? "bg-black text-white border-black shadow-sm font-semibold"
            : "bg-white text-neutral-800 border-neutral-200/80 hover:border-black/30 hover:bg-neutral-50"
        }">
          <span>${esc(l)}</span>
          ${on ? '<span class="material-symbols-outlined text-[14px]">check</span>' : ""}
        </button>`;

      const langChips = `
      <div class="flex flex-col gap-2.5 w-full pt-1">
        <div class="flex items-center justify-between text-xs text-neutral-500 pb-0.5">
          <span>Active filter: <strong class="text-black font-semibold">${isAll ? "All languages" : `${activeLangs.length} selected`}</strong></span>
          ${!isAll ? '<button type="button" data-lang="all" class="text-xs text-neutral-600 hover:text-black hover:underline cursor-pointer">Reset to All</button>' : ''}
        </div>
        <div id="set-langs" class="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto pr-1">
          ${langChip("all", "All Languages", isAll)}
          ${LANGS.filter(([v]) => v !== "all")
            .map(([v, l]) => langChip(v, l, activeLangs.includes(v)))
            .join("")}
        </div>
      </div>`;

      return `
    <div class="flex flex-col gap-4">
      <div>
        ${setGroup("Profile")}
        <div class="mt-1.5">${setCard(
          setRow(
            "person",
            "Display name",
            "Shown in the greeting on Home.",
            `<input id="set-name" type="text" maxlength="32" value="${esc(name)}" placeholder="Listener"
              class="w-40 shrink-0 bg-surface-container-lowest border border-surface-container-highest/70 rounded-lg px-2 py-1.5 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/20" />`,
          ) +
            setRow(
            "power_settings_new",
            "Open at startup",
            startOn ? `Starts with ${PLATFORM}` : "Off - start it yourself",
            setSwitch(startOn, "data-autostart"),
          ),
        )}</div>
      </div>
      <div>
        ${setGroup("Catalog")}
        <div class="mt-1.5">${setCard(
          `<div class="flex flex-col gap-2 px-4 py-3.5 border-b border-surface-container-high/70">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                ${setTile("translate")}
                <div>
                  <span class="block text-sm font-semibold text-neutral-900">Music Languages</span>
                  <span class="block text-xs text-neutral-500 mt-0.5">Filter songs, charts, and recommendations by language</span>
                </div>
              </div>
            </div>
            ${langChips}
          </div>` +
            setRow(
              "public",
              "Country",
              "Sets the region the catalog is read from",
              `<select id="set-country" class="${setSelect}">${options(COUNTRIES, country)}</select>`,
            ) +
            setRow(
              "wifi",
              "Network mode",
              "Auto probes the link and switches modes; force online/offline to pin it",
              `<select id="set-net-mode" class="${setSelect}">${options(
                [
                  ["auto", "Auto"],
                  ["online", "Force online"],
                  ["offline", "Force offline"],
                ],
                prefStr(NET_MODE_KEY, "auto"),
              )}</select>`,
            ) +
            setRow(
              "high_quality",
              "Download quality",
              "Opus bitrate for new downloads (normalized to −16 LUFS)",
              `<select id="set-dl-quality" class="${setSelect}">${options(
                [
                  ["320kbps", "320 kbps — max"],
                  ["160kbps", "160 kbps"],
                  ["96kbps", "96 kbps"],
                  ["64kbps", "64 kbps — small"],
                  ["48kbps", "48 kbps — tiny"],
                ],
                prefDlQuality(),
              )}</select>`,
            ),
        )}</div>
      </div>
      ${setNote("Language and country apply to new searches and refresh Home straight away; favourites and downloads you already saved are never filtered.")}
    </div>`;
    },
  },

  playback: {
    eyebrow: "Settings / Playback",
    body: () => {
      const streamQ = prefStreamQuality();
      const xf = prefStr(XFADE_KEY, "0");
      const gapless = gaplessPref();
      const remember = rememberPosPref();
      const speed = String(prefPlaySpeed());
      const options = (rows, value) =>
        rows
          .map(([v, l]) => `<option value="${esc(v)}"${v === value ? " selected" : ""}>${esc(l)}</option>`)
          .join("");
      return `
    <div class="flex flex-col gap-4">
      <div>
        ${setGroup("Streaming")}
        <div class="mt-1.5">${setCard(
          setRow(
            "cell_tower",
            "Streaming quality",
            "Requested when a track resolves; falls back when the source lacks it",
            `<select id="set-stream-quality" class="${setSelect}">${options(
              [
                ["320kbps", "320 kbps — max"],
                ["160kbps", "160 kbps"],
                ["96kbps", "96 kbps"],
                ["64kbps", "64 kbps — data saver"],
              ],
              streamQ,
            )}</select>`,
          ) +
            setRow(
              "swap_horiz",
              "Crossfade",
              "Blend the handover between tracks",
              `<select id="set-xfade-pref" class="${setSelect}">${options(
                [
                  ["0", "Off"],
                  ["2", "2s fade"],
                  ["4", "4s fade"],
                  ["6", "6s fade"],
                ],
                xf,
              )}</select>`,
            ) +
            setRow(
              "bolt",
              "Gapless",
              gapless ? "Next track starts instantly (no pause)" : "Small pause between tracks",
              setSwitch(gapless, "data-gapless"),
            ),
        )}</div>
      </div>
      <div>
        ${setGroup("Resume & Speed")}
        <div class="mt-1.5">${setCard(
          setRow(
            "history",
            "Remember position",
            remember ? "Reopen picks up where you stopped" : "Always start tracks from the top",
            setSwitch(remember, "data-remember-pos"),
          ) +
            setRow(
              "speed",
              "Playback speed",
              "Applies to streaming and vault files now",
              `<select id="set-play-speed" class="${setSelect}">${options(
                [
                  ["0.75", "0.75x — slower"],
                  ["0.9", "0.9x"],
                  ["1", "1x — normal"],
                  ["1.1", "1.1x"],
                  ["1.25", "1.25x"],
                  ["1.5", "1.5x — fast"],
                ],
                speed,
              )}</select>`,
            ),
        )}</div>
      </div>
      ${setNote("Streaming quality never touches your vault — downloads keep their own quality above. Crossfade and speed apply immediately.")}
    </div>`;
    },
  },

  appearance: {
    eyebrow: "Settings / Appearance",
    body: () => {
      const theme = prefTheme();
      const density = prefDensity();
      const options = (rows, value) =>
        rows
          .map(([v, l]) => `<option value="${esc(v)}"${v === value ? " selected" : ""}>${esc(l)}</option>`)
          .join("");
      return `
    <div class="flex flex-col gap-4">
      <div>
        ${setGroup("Theme")}
        <div class="mt-1.5">${setCard(
          setRow(
            "dark_mode",
            "Color theme",
            theme === "system" ? "Follows your OS" : theme === "dark" ? "Dark on" : "Light on",
            `<select id="set-theme" class="${setSelect}">${options(
              [
                ["system", "System"],
                ["light", "Light"],
                ["dark", "Dark"],
              ],
              theme,
            )}</select>`,
          ) +
            setRow(
              "density_medium",
              "Density",
              density === "compact" ? "Tighter rows, more on screen" : "Comfortable spacing",
              `<select id="set-density" class="${setSelect}">${options(
                [
                  ["comfortable", "Comfortable"],
                  ["compact", "Compact"],
                ],
                density,
              )}</select>`,
            ),
        )}</div>
      </div>
      ${setNote("Theme applies instantly and is remembered across restarts. Compact density tightens list rows and cards.")}
    </div>`;
    },
  },

  lyrics: {
    eyebrow: "Settings / Lyrics",
    body: () => {
      const auto = lyricsAutoScrollPref();
      const karaoke = prefStr(LYRICS_GLOSS_KEY, "1") !== "0";
      const size = prefLyricsSize();
      const options = (rows, value) =>
        rows
          .map(([v, l]) => `<option value="${esc(v)}"${v === value ? " selected" : ""}>${esc(l)}</option>`)
          .join("");
      return `
    <div class="flex flex-col gap-4">
      <div>
        ${setGroup("Lyrics")}
        <div class="mt-1.5">${setCard(
          setRow(
            "arrow_downward",
            "Auto-scroll",
            auto ? "Follows the playhead line by line" : "Stays where you leave it",
            setSwitch(auto, "data-lyrics-auto"),
          ) +
            setRow(
              "graphic_eq",
              "Karaoke highlight",
              karaoke ? "Words light up as they are sung" : "Whole lines light up only",
              setSwitch(karaoke, "data-lyrics-gloss"),
            ) +
            setRow(
              "format_size",
              "Lyric text size",
              "Base size for synced lines",
              `<select id="set-lyrics-size" class="${setSelect}">${options(
                [
                  ["s", "Small"],
                  ["m", "Medium"],
                  ["l", "Large"],
                ],
                size,
              )}</select>`,
            ),
        )}</div>
      </div>
      ${setNote("Per-track timing nudges (±ms in Now Playing) are kept per song and are never reset by these defaults.")}
    </div>`;
    },
  },

  storage: {
    eyebrow: "Settings / Storage",
    body: () => {
      // Usage arrives async (disk walk), so the line fills after render —
      // same pattern as fillShortcutMode.
      setTimeout(fillStorage, 0);
      return `
    <div class="flex flex-col gap-4">
      <div>
        ${setGroup("Usage")}
        <div id="set-storage-usage" class="mt-1.5 rounded-xl border border-surface-container-highest/60 bg-surface-container px-3.5 py-3 font-label-mono text-[11px] leading-relaxed text-on-surface-variant">Reading usage&hellip;</div>
      </div>
      <div>
        ${setGroup("Cache")}
        <div class="mt-1.5">${setCard(
          setRow(
            "hard_drive",
            "Cache size",
            "Cap for covers, lyrics and stream metadata kept on disk.",
            `<select id="set-cache-size" class="${setSelect}">
              <option value="100">100 MB</option>
              <option value="500">500 MB &mdash; default</option>
              <option value="1024">1 GB</option>
              <option value="2048">2 GB</option>
              <option value="5120">5 GB &mdash; max</option>
            </select>`,
          ) +
            `<button type="button" data-cache-clear class="w-full flex items-center gap-3 px-3.5 py-3 text-left transition-colors">
              ${setTile("delete_sweep")}
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-medium text-on-surface">Clear cache</span>
                <span class="block text-xs text-on-surface-variant mt-0.5">Frees covers, lyrics and metadata now; they re-download on demand.</span>
              </span>
              <span id="set-cache-clearing" class="text-xs text-on-surface-variant hidden">Clearing&hellip;</span>
            </button>`,
        )}</div>
      </div>
      ${setNote("Saved downloads live in the vault outside this cache and are never affected. Entries also expire on their own: stream links after 30 minutes, metadata after 6 hours, lyrics after 7 days.")}
    </div>`;
    },
  },

  backup: {
    eyebrow: "Settings / Backup & Export",
    body: () => {
      // Counts arrive after render — same skeleton pattern as fillStorage.
      // refreshGDrive() is parked with the Google Drive UI below.
      setTimeout(fillBackupInfo, 0);
      return `
    <div class="flex flex-col gap-4">
      <div>
        ${setGroup("Backup file")}
        <div id="set-backup-info" class="mt-1.5 rounded-xl border border-surface-container-highest/60 bg-surface-container px-3.5 py-3 font-label-mono text-[11px] leading-relaxed text-on-surface-variant">Reading&hellip;</div>
        <div class="mt-1.5 flex flex-wrap gap-2">
          ${setBtn("Save backup&hellip;", "data-backup-export")}
          ${setBtn("Restore&hellip;", "data-backup-restore")}
        </div>
      </div>
      <div>
        ${setGroup("Playlists")}
        <div class="mt-1.5 rounded-xl border border-surface-container-highest/60 bg-surface-container-lowest px-3.5 py-3 flex flex-col gap-2.5">
          <select id="set-backup-pl" class="${setSelect}">
            <option value="">Loading&hellip;</option>
          </select>
          <div class="flex flex-wrap gap-2">
            ${setBtn("Export CSV", "data-pl-csv")}
            ${setBtn("Export M3U", "data-pl-m3u")}
          </div>
        </div>
      </div>
      <!-- GOOGLE DRIVE (optional) — parked 2026-10: the OAuth consent screen is
           stuck in Google "testing" mode, so sign-in 403s for anyone but the
           listed testers. The backend (gdrive.rs) and the sync engine
           (gsync.js) stay in the tree; uncomment below to bring the UI back. -->
      ${setNote("A backup holds favorites, local playlists and settings — downloads, cache and history stay on this machine. The file stays the manual path.")}
    </div>`;
    },
  },

  spotify: {
    eyebrow: "Settings / Spotify",
    body: () => {
      setTimeout(fillSpotifyStatus, 0);
      return `
    <div class="flex flex-col gap-4">
      <div>
        ${setGroup("Spotify account")}
        <div class="mt-1.5">${setCard(
          setRow(
            SPOTIFY_LOGO,
            "Connection status",
            `<span id="set-spotify-status">Checking&hellip;</span>`,
            `${setBtn("Sign in", 'id="set-spotify-signin"', "hidden")}` +
            `${setBtn("Sign out", 'id="set-spotify-signout"', "hidden")}`,
          ),
        )}</div>
      </div>
      <div>
        ${setGroup("Import from Spotify")}
        <div class="mt-1.5">${setCard(
          setRow(
            "upload_file",
            "Import CSV",
            "Upload an Exportify CSV to build a playlist",
            `<input type="file" id="set-spotify-csv" accept=".csv" class="hidden" />
             <label for="set-spotify-csv" class="${setBtnCls} cursor-pointer">Choose CSV</label>`,
          ) +
          setRow(
            "library_music",
            "Import top tracks",
            "Import your most played tracks from Spotify",
            `${setBtn("Import", 'id="set-spotify-top"')}`,
          ),
        )}</div>
      </div>
      ${setNote("CSV import works without signing in. For top tracks import, you need to sign in with your Spotify account. Tracks are matched to the JioSaavn catalog.")}
    </div>`;
    },
  },

  updates: {
    eyebrow: "Settings / Updates",
    body: () => {
      // The check is a network round-trip, so the panel paints a skeleton
      // first — same pattern as fillStorage / fillShortcutMode.
      setTimeout(fillUpdates, 0);
      return `
    <div class="flex flex-col gap-4">
      <div class="rounded-xl border border-surface-container-highest/60 bg-surface-container px-3.5 py-3 flex flex-col gap-2.5">
        <div id="set-update-status" class="text-xs leading-relaxed text-on-surface-variant">Checking for updates&hellip;</div>
        <div id="set-update-progress" class="hidden">
          <div class="flex items-center justify-between text-xs text-on-surface-variant mb-1">
            <span id="set-update-phase">Downloading&hellip;</span>
            <span id="set-update-pct" class="font-label-mono">0%</span>
          </div>
          <div class="h-1.5 rounded-full bg-surface-container-high overflow-hidden">
            <div id="set-update-bar" class="h-full w-0 bg-primary transition-all"></div>
          </div>
        </div>
      </div>
      <div class="flex gap-2">
        ${setBtn("Check again", "data-update-check")}
        ${setBtn("Releases page", "data-update-page")}
      </div>
      <div>
        ${setGroup("Previous releases")}
        <div id="set-update-releases" class="mt-1.5 rounded-xl border border-surface-container-highest/60 bg-surface-container-lowest overflow-hidden p-1">Waiting for the check&hellip;</div>
      </div>
      ${setNote("Updates install over the current copy; the vault is never touched. Picking an older release steps the app back to it &mdash; every package is signature-checked against this build's key before it runs.")}
    </div>`;
    },
  },

  licenses: {
    eyebrow: "Settings / Licences",
    body: () => `
    <div class="flex flex-col gap-4">
      <p class="text-[13px] leading-relaxed text-on-surface-variant">TRANCE MUSIC itself is MIT licensed &mdash; see <span class="font-label-mono">LICENSE</span> in the repository. The Rust core links the direct dependencies below; every one is MIT or dual MIT&nbsp;/&nbsp;Apache-2.0.</p>
      <div class="rounded-xl border border-surface-container-highest/60 bg-surface-container-lowest overflow-hidden">
        <table class="w-full font-label-mono text-[11px] border-collapse">
          <thead>
            <tr class="bg-surface-container text-on-surface-variant">
              <th class="text-left font-normal uppercase tracking-wider text-[10px] px-3.5 py-2">Crate</th>
              <th class="text-left font-normal uppercase tracking-wider text-[10px] px-3.5 py-2 w-20">Version</th>
              <th class="text-left font-normal uppercase tracking-wider text-[10px] px-3.5 py-2 w-36">Licence</th>
            </tr>
          </thead>
          <tbody>
            ${LICENSES.map(
              ([n, v, l]) => `
          <tr class="border-t border-surface-container-high/70">
            <td class="px-3.5 py-2 text-on-surface">${esc(n)}</td>
            <td class="px-3.5 py-2 text-on-surface-variant">${esc(v)}</td>
            <td class="px-3.5 py-2 text-on-surface-variant">${esc(l)}</td>
          </tr>`,
            ).join("")}
            <tr class="border-t border-surface-container-high/70">
              <td class="px-3.5 py-2 text-on-surface">@tauri-apps/cli</td>
              <td class="px-3.5 py-2 text-on-surface-variant">^2 (dev)</td>
              <td class="px-3.5 py-2 text-on-surface-variant">MIT OR Apache-2.0</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="text-xs leading-relaxed text-on-surface-variant">The complete dependency tree is 469 crates and lives in <span class="font-label-mono">app/src-tauri/Cargo.lock</span>. Full licence texts: <span class="font-label-mono">LICENSE</span> for this project, and each upstream repository for its crate. No copyleft licences are linked.</p>
    </div>`,
  },

  about: {
    eyebrow: "Settings / About",
    body: () => `
    <div class="flex flex-col gap-4">
      <div class="flex items-center gap-3.5">
        <span class="w-11 h-11 shrink-0 rounded-xl bg-primary flex items-center justify-center">
          <span class="material-symbols-outlined text-[22px] text-on-primary" style="font-variation-settings: &quot;FILL&quot; 1;">graphic_eq</span>
        </span>
        <div class="min-w-0">
          <p class="text-base font-semibold text-on-surface">${esc(APP.name)}</p>
          <p class="font-label-mono text-[11px] text-on-surface-variant mt-0.5">v${esc(APP.version)} &middot; ${esc(APP.id)} &middot; ${PLATFORM}</p>
        </div>
      </div>
      <p class="text-[13px] leading-relaxed text-on-surface-variant">A desktop music player that streams from JioSaavn through a local range relay, keeps an offline vault on your disk, and never lets the webview talk to a third-party CDN directly.</p>
      <dl class="rounded-xl border border-surface-container-highest/60 bg-surface-container-lowest overflow-hidden divide-y divide-surface-container-high/70">
        ${kv("Shell", "Tauri 2, Rust 1.77+")}
        ${kv("Front end", "Vanilla ES modules, no build step, Tailwind via CDN")}
        ${kv("Catalog", "JioSaavn first-party, 5 community mirrors as fallback")}
        ${kv("Playback", "Local axum relay on 127.0.0.1, Range forwarded verbatim")}
        ${kv("Lyrics", "LRCLIB, Better Lyrics, then JioSaavn, LRCLIB search")}
        ${kv("Vault", "App data folder · TRANCE MUSIC")}
        ${kv("Licence", "MIT")}
      </dl>
      ${setNote("No installer and no code signing yet &mdash; this build runs from source. Development status is in <span class='font-label-mono'>CHANGELOG.md</span>.")}
    </div>`,
  },

  terms: {
    eyebrow: "Settings / Terms",
    body: () => `
    <div class="flex flex-col gap-4">
      <p class="text-[13px] leading-relaxed text-on-surface-variant">Last updated 30 September 2026. By using ${esc(APP.name)} you accept these terms.</p>
      <ol class="rounded-xl border border-surface-container-highest/60 bg-surface-container-lowest overflow-hidden divide-y divide-surface-container-high/70 list-none">
        ${clause(1, "Personal, non-commercial use", "You may use TRANCE MUSIC for your own personal, non-commercial listening. Reselling access, redistributing the application, or operating a public service built on it requires written permission.")}
        ${clause(2, "No content is bundled", "TRANCE MUSIC ships no audio. It is a player: tracks, artwork and lyrics are fetched at request time from third-party services. Rights to that content stay with their owners, and those services' own terms also apply to you.")}
        ${clause(3, "Your downloads are yours", "Anything you save lands in this app's own data folder on your disk and is your responsibility to keep, back up and delete. TRANCE MUSIC is not liable for lost or damaged files.")}
        ${clause(4, "No warranty", `The software is provided "as is", without warranty of any kind, to the maximum extent the law allows. It is pre-release: expect bugs, data-loss bugs included. ${esc(APP.name)} is an independent project and is not affiliated with, endorsed by, or sponsored by JioSaavn, LRCLIB, or any mirror listed in the source.`)}
        ${clause(5, "Limitation of liability", "To the fullest extent permitted by law, the authors and contributors are not liable for any indirect, incidental or consequential damages arising from use of the software, including lost data, lost profits, or unavailable services.")}
        ${clause(6, "Copyright complaints", "Copyright holders may ask for stored media to be removed. Contact the maintainers through the repository and the relevant item will be deleted from the vault promptly.")}
        ${clause(7, "Changes", "These terms may change as the project matures. The date above and the copy in the repository are authoritative; material changes will be noted in the changelog.")}
      </ol>
      ${setNote("This summary is provided for convenience and is not legal advice.")}
    </div>`,
  },

  widget: {
    eyebrow: "Settings / Desktop Widget",
    body: () => {
      const on = widgetPref();
      const mode = widgetMode();
      const modes = [
        ["top", "open_in_full", "Always on top", "Floats above every window, wherever you drag it."],
        ["desktop", "desktop_windows", "On the wallpaper", "Sits behind every window - visible only on your desktop."],
      ];
      const modeBtn = (id, icon, label, sub) => `
        <button type="button" role="radio" aria-checked="${mode === id}" data-widget-mode="${id}" class="w-full flex items-center gap-3 px-3.5 py-3 text-left transition-colors ${
          mode === id ? "bg-surface-container" : "hover:bg-surface-container-low"
        }">
          ${setTile(icon)}
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium text-on-surface">${label}</span>
            <span class="block text-xs text-on-surface-variant mt-0.5 truncate">${sub}</span>
          </span>
          <span class="material-symbols-outlined text-[18px] ${mode === id ? "text-on-surface" : "opacity-0"}">check</span>
        </button>`;
      return `
    <div class="flex flex-col gap-4">
      <p class="text-[13px] leading-relaxed text-on-surface-variant">A now-playing card for your ${PLATFORM} desktop: cover art, title, artist, progress and transport controls, fed live from the player. It is a separate window, so it stays where you leave it.</p>
      <div class="rounded-xl border border-surface-container-highest/60 bg-surface-container-lowest overflow-hidden divide-y divide-surface-container-high/70">
        <button type="button" role="switch" aria-checked="${on}" data-widget-toggle class="w-full flex items-center gap-3 px-3.5 py-3 text-left transition-colors">
          ${setTile("widgets")}
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium text-on-surface">Show desktop widget</span>
            <span class="block text-xs text-on-surface-variant mt-0.5 truncate">${
              on ? "Added to your desktop" : "Not on the desktop yet"
            }</span>
          </span>
          ${setSwitch(on, "", "span")}
        </button>
        <div class="${on ? "" : "opacity-50 pointer-events-none"}">
          <div class="px-3.5 pt-3 pb-1">${setGroup("Placement")}</div>
          ${modes.map(([id, icon, label, sub]) => modeBtn(id, icon, label, sub)).join("")}
          <button type="button" data-widget-reset class="w-full flex items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-surface-container-low">
            ${setTile("my_location")}
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-medium text-on-surface">Reset position</span>
              <span class="block text-xs text-on-surface-variant mt-0.5 truncate">Put the card back above the miniplayer</span>
            </span>
          </button>
        </div>
      </div>
      ${setNote("Drag the card by its header; the X hides it here. The card follows playback only while this app is running.")}
    </div>`;
    },
  },

  shortcuts: {
    eyebrow: "Settings / Keyboard Shortcuts",
    body: () => {
      setTimeout(fillShortcutMode, 0);
      const rows = [
        ["Play / pause", "Caps + Space", "Ctrl + Alt + Space"],
        ["Search", "Caps + F", "Ctrl + Alt + F"],
        ["Now Playing", "Caps + N", "Ctrl + Alt + N"],
        ["Desktop widget", "Caps + W", "Ctrl + Alt + W"],
        ["Download this track", "Caps + D", "Ctrl + Alt + D"],
        ["Track credits", "Caps + I", "Ctrl + Alt + I"],
        ["Media play / pause", "Media key", "Media key"],
        ["Next track", "Media key", "Media key"],
        ["Previous track", "Media key", "Media key"],
      ];
      return `
    <div class="flex flex-col gap-4">
      <p class="text-[13px] leading-relaxed text-on-surface-variant">Global shortcuts: they fire even when another window has focus. Caps Lock is used as a Hyper key (Ctrl + Alt + Shift + Win) when a remap tool is running, with Ctrl + Alt as the fallback so every action works either way.</p>
      <div id="set-shortcut-mode" class="rounded-xl border border-surface-container-highest/60 bg-surface-container px-3.5 py-2.5 text-xs leading-relaxed text-on-surface-variant">Checking&hellip;</div>
      <div class="rounded-xl border border-surface-container-highest/60 bg-surface-container-lowest overflow-x-auto">
        <table class="w-full font-label-mono text-[11px] border-collapse">
          <thead>
            <tr class="bg-surface-container text-on-surface-variant">
              <th class="text-left font-normal uppercase tracking-wider text-[10px] px-3.5 py-2">Action</th>
              <th class="text-left font-normal uppercase tracking-wider text-[10px] px-3.5 py-2">Hyper (remapped Caps)</th>
              <th class="text-left font-normal uppercase tracking-wider text-[10px] px-3.5 py-2">Fallback</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                ([a, h, f]) => `
          <tr class="border-t border-surface-container-high/70">
            <td class="px-3.5 py-2 text-on-surface">${esc(a)}</td>
            <td class="px-3.5 py-2 text-on-surface-variant">${esc(h)}</td>
            <td class="px-3.5 py-2 text-on-surface-variant">${esc(f)}</td>
          </tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </div>
      <div>
        ${setGroup("Test")}
        <div class="mt-1.5 rounded-xl border border-surface-container-highest/60 bg-surface-container px-3.5 py-3 flex flex-col gap-2">
          <span id="set-shortcut-test" class="text-xs text-on-surface-variant">Press a shortcut to see it arrive here.</span>
          ${setBtn("Listen for shortcuts (8s)", "data-shortcut-test", "self-start")}
        </div>
      </div>
      ${setNote(
        `In-app keys (window focused): <span class="font-label-mono">Space</span> play / pause &middot; <span class="font-label-mono">Ctrl + &larr; / Ctrl + &rarr;</span> previous / next &middot; <span class="font-label-mono">Ctrl + D</span> download &middot; <span class="font-label-mono">L</span> like &middot; <span class="font-label-mono">Ctrl + K</span> focus search. Typing in a field never triggers them.`,
      )}
    </div>`;
    },
  },
};

export const SETTINGS_MENU = [
  ["tune", "General", "Name, startup, language &amp; country", "general"],
  ["play_arrow", "Playback", "Streaming quality, crossfade &amp; speed", "playback"],
  ["palette", "Appearance", "Theme &amp; density", "appearance"],
  ["lyrics", "Lyrics", "Auto-scroll, translation &amp; size", "lyrics"],
  ["widgets", "Desktop Widget", "Now-playing card on your desktop", "widget"],
  ["keyboard_shortcut", "Keyboard Shortcuts", "Caps Lock Hyper &amp; media keys", "shortcuts"],
  ["hard_drive", "Storage", "Cache size, usage &amp; clear", "storage"],
  ["backup", "Backup &amp; Export", "Save, restore, CSV &amp; M3U", "backup"],
  [SPOTIFY_LOGO, "Spotify", "Import playlists &amp; top tracks", "spotify"],
  ["system_update", "Updates", "New releases &amp; revert to an older one", "updates"],
  ["policy", "Open-Source Licences", "MIT &amp; Apache-2.0", "licenses"],
  ["info", "About the Project", `v${APP.version} &middot; ${PLATFORM} desktop`, "about"],
  ["gavel", "Terms &amp; Conditions", "Personal use, no warranty", "terms"],
];

// ---------------------------------------------------------------- backup -
// Phase 1: portable backup/restore + CSV/M3U export. Cancellation of the
// native dialog is silent (Rust reports "cancelled"); everything else
// surfaces as a toast + diag line.
function backupSnapshot() {
  return buildBackup(
    { favorites: loadFavs(), playlists: loadLocalPls(), settings: readSettings() },
    Date.now(),
  );
}

function fillBackupInfo() {
  const box = $("#set-backup-info");
  if (box) {
    const favs = loadFavs().length;
    const pls = loadLocalPls();
    box.textContent = `${favs} favorites · ${pls.length} local playlists · ${Object.keys(readSettings()).length} settings`;
  }
  const sel = $("#set-backup-pl");
  if (sel) {
    const list = loadLocalPls();
    sel.innerHTML = list.length
      ? list
          .map(
            (p) => `<option value="${esc(p.id)}">${esc(p.title)} (${(p.tracks || []).length})</option>`,
          )
          .join("")
      : '<option value="">No local playlists yet</option>';
  }
}

async function fillSpotifyStatus() {
  const statusEl = $("#set-spotify-status");
  const signinBtn = $("#set-spotify-signin");
  const signoutBtn = $("#set-spotify-signout");

  if (!statusEl) return;

  try {
    const signedIn = await invoke("spotify_is_signedin");
    if (signedIn) {
      statusEl.textContent = "Signed in";
      statusEl.classList.add("text-primary");
      signinBtn?.classList.add("hidden");
      signoutBtn?.classList.remove("hidden");
    } else {
      statusEl.textContent = "Not signed in";
      statusEl.classList.remove("text-primary");
      signinBtn?.classList.remove("hidden");
      signoutBtn?.classList.add("hidden");
    }
  } catch (err) {
    statusEl.textContent = "Spotify not configured";
    signinBtn?.classList.add("hidden");
    signoutBtn?.classList.add("hidden");
  }
}

function cancelledByUser(err) {
  return /cancelled/.test(String((err && err.message) || err || ""));
}

async function doBackupExport() {
  const doc = backupSnapshot();
  try {
    const path = await invoke("export_file", {
      content: JSON.stringify(doc, null, 2),
      suggestedName: backupFilename(doc.exportedAt),
      filterLabel: "TRANCE MUSIC backup",
      extensions: ["json"],
    });
    toast(`Backup saved (${doc.favorites.records.length} favorites, ${doc.playlists.records.length} playlists).`, "success");
    diag("backup", true, `wrote ${path}`);
  } catch (err) {
    if (cancelledByUser(err)) return;
    diag("backup", false, String(err));
    toast(`Backup failed: ${err}`, "error");
  }
}

async function doBackupRestore() {
  let text;
  try {
    text = await invoke("read_import_file");
  } catch (err) {
    if (cancelledByUser(err)) return;
    diag("restore", false, String(err));
    toast(`Restore failed: ${err}`, "error");
    return;
  }
  let doc;
  try {
    doc = parseBackupFile(text);
  } catch (err) {
    diag("restore", false, String(err && err.message ? err.message : err));
    toast(`Restore failed: ${err && err.message ? err.message : err}`, "error");
    return;
  }
  const applied = applyBackup(doc);
  saveFavs(applied.favorites);
  saveLocalPls(applied.playlists);
  writeSettings(applied.settings);
  paintFavHearts();
  renderFavs();
  renderLibrary();
  toast(
    `Restored ${applied.counts.favorites} favorites and ${applied.counts.playlists} playlists.`,
    "success",
  );
  diag("restore", true, `${applied.counts.favorites} favorites, ${applied.counts.playlists} playlists`);
  openSettings("backup");
}

async function doPlaylistExport(format) {
  const sel = $("#set-backup-pl");
  const picked = sel ? sel.value : "";
  const playlist = loadLocalPls().find((p) => p.id === picked);
  if (!playlist) {
    toast("Pick a playlist first — or create one in Library.", "info");
    return;
  }
  const isCsv = format === "csv";
  try {
    const path = await invoke("export_file", {
      content: isCsv ? playlistToCsv(playlist) : playlistToM3u(playlist),
      suggestedName: playlistFilename(playlist.title, format),
      filterLabel: isCsv ? "CSV spreadsheet" : "M3U playlist",
      extensions: [format],
    });
    toast(`Exported ${playlist.title} (${(playlist.tracks || []).length} tracks).`, "success");
    diag("export", true, `${format} -> ${path}`);
  } catch (err) {
    if (cancelledByUser(err)) return;
    diag("export", false, String(err));
    toast(`Export failed: ${err}`, "error");
  }
}

// function gdriveBtn(name, show) {
//   const btn = document.querySelector(`[data-gdrive-${name}]`);
//   if (btn) btn.style.display = show ? "" : "none";
// }
// 
// function lastSyncLine() {
//   let ts = 0;
//   try {
//     ts = Number(localStorage.getItem(LAST_SYNC_KEY)) || 0;
//   } catch {}
//   return ts ? `Last synced ${new Date(ts).toLocaleString()}.` : "Never synced on this machine.";
// }
// 
// /// Paint the Drive row from backend status: sign-in/out/sync buttons show
// /// only when they can act; an unconfigured build says so plainly.
// async function refreshGDrive() {
//   const box = $("#set-gdrive-status");
//   let status = { configured: false, signed_in: false };
//   try {
//     status = await invoke("gdrive_status");
//   } catch (err) {
//     diag("gdrive", false, String(err));
//   }
//   gdriveBtn("signin", status.configured && !status.signed_in);
//   gdriveBtn("sync", status.configured && status.signed_in);
//   gdriveBtn("signout", status.configured && status.signed_in);
//   if (box) {
//     box.textContent = !status.configured
//       ? "Google Drive sync is not configured in this build."
//       : status.signed_in
//         ? `Signed in. ${lastSyncLine()}`
//         : "Not signed in. Sign-in is optional — backup files always work.";
//   }
// }
// 
// async function doGDriveSignIn() {
//   toast("Browser opened — complete the Google sign-in there.", "info");
//   try {
//     await invoke("gdrive_sign_in");
//     toast("Signed in with Google.", "success");
//     diag("gdrive", true, "sign-in complete");
//   } catch (err) {
//     diag("gdrive", false, String(err));
//     toast(`Google sign-in failed: ${err}`, "error");
//   }
//   refreshGDrive();
// }
// 
// async function doGDriveSignOut() {
//   try {
//     await invoke("gdrive_sign_out");
//     toast("Signed out — your local data stays.", "info");
//     diag("gdrive", true, "signed out");
//   } catch (err) {
//     diag("gdrive", false, String(err));
//     toast(`Sign-out failed: ${err}`, "error");
//   }
//   refreshGDrive();
// }
// 
// /// Manual full sync: the shared engine round, with toasts. Auto runs stay
// /// silent; the button reports.
// async function doGDriveSyncNow() {
//   if (isSyncing()) {
//     toast("A sync is already running.", "info");
//     return;
//   }
//   try {
//     const counts = await syncRound();
//     toast(`Synced (${counts.favorites} favorites, ${counts.playlists} playlists).`, "success");
//     diag("gdrive", true, "sync complete");
//   } catch (err) {
//     diag("gdrive", false, String(err));
//     toast(`Sync failed: ${err}`, "error");
//   } finally {
//     openSettings("backup");
//   }
// }
// 
// ------------------------------------------------------ keyboard shortcuts -
/// Linux (xremap) recipe for Caps Lock as Hyper: held = Ctrl+Alt+Shift+Super,
/// tap = Escape. Shown as a copyable snippet; Windows gets PowerToys' own
/// deep link and macOS the Karabiner page.
const XREMAP_SNIPPET = `keymap:
  - remap:
      CapsLock:
        held: [Control_L, Alt_L, Shift_L, Super_L]
        alone: Escape`;

/// Fills the mode line after the panel renders: Hyper when a remap tool was
/// detected at boot, Ctrl+Alt fallback otherwise (with the setup buttons).
async function fillShortcutMode() {
  const box = $("#set-shortcut-mode");
  if (!box) return;
  let mode = "default";
  try {
    mode = (await invoke("get_shortcut_mode")) === "hyper" ? "hyper" : "default";
  } catch {}
  if (mode === "hyper") {
    box.innerHTML =
      '<span class="text-primary font-medium">Hyper active.</span> Hold Caps Lock and press a key from the table. Restart the app after changing the remap.';
    return;
  }
  const ua = navigator.userAgent;
  const enable = /windows/i.test(ua)
    ? `<button type="button" data-shortcut-open class="mt-2 px-3 py-1.5 rounded-lg border border-surface-container-highest/60 text-xs font-medium text-on-surface hover:bg-surface-container transition-colors">Open PowerToys Keyboard Manager</button>
       <span class="block mt-1.5">In Keyboard Manager pick <b>Remap a key</b>: key <span class="font-label-mono">Caps Lock</span> &rarr; to send <span class="font-label-mono">Ctrl + Alt + Shift + Win</span>.</span>`
    : /mac/i.test(ua)
      ? `<button type="button" data-shortcut-open class="mt-2 px-3 py-1.5 rounded-lg border border-surface-container-highest/60 text-xs font-medium text-on-surface hover:bg-surface-container transition-colors">Open Karabiner setup</button>
         <span class="block mt-1.5">In Karabiner, add a rule: <span class="font-label-mono">caps_lock</span> &rarr; <span class="font-label-mono">left_control | left_option | left_shift | left_command</span>.</span>`
      : `<button type="button" data-shortcut-copy class="mt-2 px-3 py-1.5 rounded-lg border border-surface-container-highest/60 text-xs font-medium text-on-surface hover:bg-surface-container transition-colors">Copy xremap snippet</button>
         <span class="block mt-1.5">Run it with <span class="font-label-mono">xremap ~/.config/xremap.yaml</span>, then restart this app.</span>`;
  box.innerHTML = `<span>Fallback active</span> &mdash; <span class="font-label-mono">Ctrl + Alt + key</span> works right now. To use Caps Lock as the Hyper key:<span class="block mt-1">${enable}</span><span class="block mt-1.5">Restart the app after installing the remap tool; it is detected at startup.</span>`;
}

/// Storage view: live usage line plus the active disk-budget value. The
/// budget comes back as bytes and is matched onto the select's MB options,
/// with a "(custom)" option injected when the file holds an out-of-range
/// or hand-edited value.
async function fillStorage() {
  const box = $("#set-storage-usage");
  if (!box) return;
  try {
    const s = await invoke("cache_stats");
    if (!box.isConnected) return;
    box.innerHTML = storageLine(s);
    const sel = $("#set-cache-size");
    const mb = String(Math.round(s.budget_bytes / (1024 * 1024)));
    if (sel && sel.value !== mb) {
      if (![...sel.options].some((o) => o.value === mb)) sel.add(new Option(`${mb} MB — custom`, mb));
      sel.value = mb;
    }
  } catch (err) {
    if (box.isConnected) box.textContent = "Usage unavailable.";
    diag("cache", false, String(err));
  }
}

function storageLine(s) {
  const disk = s.art_bytes + s.lyrics_bytes;
  return `Cache: <span class="font-label-mono">${fmtBytes(disk)}</span> on disk (${s.art_count} cover${s.art_count === 1 ? "" : "s"}, ${s.lyrics_count} lyric file${s.lyrics_count === 1 ? "" : "s"}) &middot; vault: <span class="font-label-mono">${fmtBytes(s.vault_bytes)}</span>${s.disk_enabled ? "" : " &middot; disk cache disabled"}`;
}

/// Where the "Releases page" button goes; refreshed by every successful check.
let lastUpdatePage = "https://github.com/Rohithdgrr/OPEN-MUSIC/releases";

/// Updates view: one call returns the whole story — signed manifest first,
/// GitHub metadata as the fallback, plus the rollback list.
async function fillUpdates() {
  const box = $("#set-update-status");
  const list = $("#set-update-releases");
  if (!box) return;
  let r;
  try {
    r = await invoke("update_check");
  } catch (err) {
    if (box.isConnected) box.textContent = "Could not reach GitHub — check the connection and try again.";
    if (list?.isConnected) list.textContent = "";
    diag("update", false, String(err));
    return;
  }
  if (!box.isConnected) return;
  lastUpdatePage = r.page || lastUpdatePage;
  if (r.latest) {
    const v = `v${esc(r.latest.version)}`;
    const notes = r.latest.notes ? ` — ${esc(r.latest.notes.split("\n")[0])}` : "";
    box.innerHTML = r.latest.installable
      ? `<span class="text-primary font-medium">${v} is available.</span> You are on ${esc(r.current)}${notes}
         <button type="button" data-update-install class="block mt-2 px-3 py-1.5 rounded-lg bg-primary text-on-primary text-xs font-medium hover:opacity-90 transition-opacity">Install ${v} &amp; restart</button>`
      : `<span class="text-primary font-medium">${v} is out,</span> but it was published before in-app updates — install it from the releases page.${notes}`;
  } else {
    box.textContent = `You are up to date on ${r.current}.`;
  }
  const row = (rel) => `
  <div class="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-container transition-colors">
    <span class="min-w-0 flex-1">
      <span class="block text-sm text-on-surface">${esc(rel.name || rel.tag)}</span>
      <span class="block text-xs text-on-surface-variant">${esc(rel.tag)}${rel.published ? " · " + esc(rel.published.slice(0, 10)) : ""}</span>
    </span>
    ${
      rel.current
        ? '<span class="text-[11px] font-medium text-primary shrink-0">Current</span>'
        : `<button type="button" data-update-revert="${esc(rel.tag)}" class="px-2.5 py-1 rounded-lg border border-surface-container-highest/60 text-[11px] font-medium text-on-surface hover:bg-surface-container-high transition-colors shrink-0">Revert</button>`
    }
  </div>`;
  if (list?.isConnected) {
    list.innerHTML = r.releases.length
      ? r.releases.map(row).join("")
      : '<span class="text-xs text-on-surface-variant">Release list unavailable (offline or rate-limited).</span>';
  }
}

let updateOff = null;
let updating = false;

/// Progress for install / revert: the Rust side streams `update:progress`
/// while the package downloads and verifies. On Windows the app exits into
/// the installer at the end of that stream, so this listener is also the
/// last thing the panel paints before the new version relaunches.
function watchUpdateProgress() {
  if (updateOff) return;
  updateOff = window.__TAURI__?.event?.listen("update:progress", (e) => {
    const wrap = $("#set-update-progress");
    const bar = $("#set-update-bar");
    if (!bar) return;
    wrap?.classList.remove("hidden");
    const p = e.payload || {};
    if (p.phase === "download" && p.total) {
      const n = Math.min(100, Math.round((p.received / p.total) * 100));
      bar.style.width = `${n}%`;
      const pct = $("#set-update-pct");
      if (pct) pct.textContent = `${n}%`;
      const phase = $("#set-update-phase");
      if (phase) phase.textContent = "Downloading…";
    } else if (p.phase === "verify") {
      bar.style.width = "100%";
      const pct = $("#set-update-pct");
      if (pct) pct.textContent = "100%";
      const phase = $("#set-update-phase");
      if (phase) phase.textContent = "Verifying signature…";
    } else if (p.phase === "done") {
      const phase = $("#set-update-phase");
      if (phase) phase.textContent = "Installed — restart the app.";
    }
  });
  if (updateOff && typeof updateOff.catch === "function") {
    updateOff.catch(() => {
      updateOff = null;
    });
  }
}

function stopUpdateProgress() {
  const p = updateOff;
  updateOff = null;
  if (p && typeof p.then === "function") p.then((un) => un()).catch(() => {});
}

function runUpdateInstall() {
  if (updating) return;
  updating = true;
  watchUpdateProgress();
  $("#set-update-progress")?.classList.remove("hidden");
  invoke("update_install")
    .then(() => toast("Update installed — restart the app to switch versions.", "success"))
    .catch((err) => {
      updating = false;
      diag("update", false, String(err));
      toast(String(err), "error");
      $("#set-update-progress")?.classList.add("hidden");
    });
}

function runUpdateRollback(tag) {
  if (updating) return;
  updating = true;
  watchUpdateProgress();
  $("#set-update-progress")?.classList.remove("hidden");
  toast(`Installing ${tag}…`, "info");
  invoke("update_rollback", { tag })
    .then(() => toast(`${tag} installed — restart the app to switch versions.`, "success"))
    .catch((err) => {
      updating = false;
      diag("update", false, String(err));
      toast(String(err), "error");
      $("#set-update-progress")?.classList.add("hidden");
    });
}

const SHORTCUT_TEST_EVENTS = [
  ["shortcut:play", "Play / pause"],
  ["shortcut:search", "Search"],
  ["shortcut:now-playing", "Now Playing"],
  ["shortcut:widget", "Desktop widget"],
  ["shortcut:download", "Download"],
  ["shortcut:info", "Track credits"],
];
let testTimer = 0;
let testOff = [];

function stopShortcutTest() {
  clearTimeout(testTimer);
  testTimer = 0;
  testOff.forEach((p) => {
    if (p && typeof p.then === "function") p.then((un) => un()).catch(() => {});
  });
  testOff = [];
}

/// Arms the six shortcut events for 8 seconds and paints what arrives. The
/// unlisten promises are kept so re-running or closing the dialog cleans up.
function startShortcutTest() {
  stopShortcutTest();
  const box = $("#set-shortcut-test");
  if (!box) return;
  const heard = new Set();
  box.textContent = "Listening for 8 seconds - press Caps + Space (or Ctrl + Alt + Space)...";
  SHORTCUT_TEST_EVENTS.forEach(([ev, label]) => {
    const p = window.__TAURI__?.event?.listen(ev, () => {
      heard.add(label);
      box.textContent = `Heard: ${[...heard].join(", ")} (${heard.size}/6)`;
    });
    if (p) testOff.push(p);
  });
  testTimer = setTimeout(() => {
    const n = heard.size;
    stopShortcutTest();
    toast(
      n ? `Heard ${n} of 6 shortcuts.` : "Nothing heard - check the remap and the fallback keys.",
      n ? "success" : "error",
    );
    const dlg = $("#tm-settings");
    if (dlg?.open && dlg.dataset.view === "shortcuts") openSettings("shortcuts");
  }, 8000);
}

export function openSettings(view = "general") {
  let dlg = $("#tm-settings");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "tm-settings";
    dlg.innerHTML = `
    <div class="settings-modal-box">
      <!-- Left Sidebar Column: Category Sections & Search -->
      <aside class="settings-sidebar">
        <div class="settings-sidebar-header">
          <div class="flex items-center justify-between">
            <span class="font-bold text-neutral-900 tracking-tight text-base">Settings</span>
            <span class="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-neutral-200 text-neutral-700 font-semibold">v${APP.version}</span>
          </div>
          <div class="settings-search-bar">
            <span class="material-symbols-outlined text-[16px] text-on-surface-variant">search</span>
            <input id="set-filter-input" type="text" placeholder="Search settings..." class="w-full bg-transparent text-xs text-on-surface placeholder:text-outline focus:outline-none" />
          </div>
        </div>
        <nav class="settings-nav-scroll" id="settings-nav-list">
          <!-- Rendered dynamically by openSettings -->
        </nav>
      </aside>

      <!-- Right Main Content Column -->
      <section class="settings-content-pane">
        <header class="settings-content-header">
          <div class="flex items-center gap-2.5 min-w-0">
            <button type="button" id="tm-settings-back" title="Back to menu" class="hidden md:hidden p-1 rounded-lg text-on-surface-variant hover:text-on-surface">
              <span class="material-symbols-outlined text-[18px]">arrow_back</span>
            </button>
            <h2 id="tm-settings-eyebrow" class="text-base font-bold text-neutral-900 dark:text-white tracking-tight truncate">General</h2>
          </div>
          <button type="button" id="tm-settings-close" title="Close Settings (Esc)" class="settings-close-btn">
            <span class="material-symbols-outlined text-[20px]">close</span>
          </button>
        </header>
        <div id="tm-settings-body" class="settings-content-scroll"></div>
      </section>
    </div>`;
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg || e.target.closest("#tm-settings-close")) dlg.close();
    });
    dlg.addEventListener("close", () => {
      stopShortcutTest();
      stopUpdateProgress();
    });
    dlg.addEventListener("click", (e) => {
      const row = e.target.closest("[data-settings-view]");
      if (row) return openSettings(row.dataset.settingsView);
      if (e.target.closest("#tm-settings-back")) return openSettings("general");
      // Each of these flips one stored value, applies it through Rust, then
      // re-renders so the switch/radios and their labels read one source.
      const toggle = e.target.closest("[data-widget-toggle]");
      if (toggle) {
        const on = !widgetPref();
        try {
          localStorage.setItem(DESKTOP_WIDGET_KEY, on ? "1" : "0");
        } catch {}
        applyWidget({ show: on });
        return openSettings("widget");
      }
      const mode = e.target.closest("[data-widget-mode]");
      if (mode) {
        try {
          localStorage.setItem(DESKTOP_WIDGET_MODE, mode.dataset.widgetMode);
        } catch {}
        invoke("widget_embed", { embed: mode.dataset.widgetMode === "desktop" }).catch((err) =>
          diag("widget", false, String(err)),
        );
        return openSettings("widget");
      }
      if (e.target.closest("[data-widget-reset]")) {
        try {
          localStorage.removeItem(DESKTOP_WIDGET_POS);
        } catch {}
        const reset = window.__TAURI__?.event?.emit("widget:reset", null);
        if (reset && typeof reset.catch === "function") reset.catch(() => {});
        toast("Desktop widget moved back to the default spot.", "info");
        return;
      }
      // Keyboard shortcuts view: open the remap tool, copy the Linux snippet,
      // or arm the listener. The tool URL follows the current platform.
      if (e.target.closest("[data-shortcut-open]")) {
        const ua = navigator.userAgent;
        const url = /windows/i.test(ua)
          ? "powertoys://keyboardmanager"
          : /mac/i.test(ua)
            ? "https://karabiner-elements.pqrs.org/"
            : "https://github.com/karubon/xremap";
        invoke("open_external", { url }).catch((err) => diag("shortcut", false, String(err)));
        return;
      }
      if (e.target.closest("[data-shortcut-copy]")) {
        navigator.clipboard
          ?.writeText(XREMAP_SNIPPET)
          .then(() => toast("xremap snippet copied to the clipboard.", "success"))
          .catch((err) => diag("shortcut", false, String(err)));
        return;
      }
      if (e.target.closest("[data-shortcut-test]")) {
        startShortcutTest();
        return;
      }
      // Storage view: clear every cache tier (never the vault) in place.
      if (e.target.closest("[data-cache-clear]")) {
        const flag = $("#set-cache-clearing");
        if (flag) flag.classList.remove("hidden");
        invoke("cache_clear")
          .then((s) => {
            const box = $("#set-storage-usage");
            if (box) box.innerHTML = storageLine(s);
            toast("Cache cleared — covers and lyrics re-download as you browse.", "success");
          })
          .catch((err) => diag("cache", false, String(err)))
          .finally(() => {
            const f = $("#set-cache-clearing");
            if (f) f.classList.add("hidden");
          });
        return;
      }
      // Backup view: portable file in / out, plus per-playlist CSV / M3U.
      if (e.target.closest("[data-backup-export]")) {
        doBackupExport();
        return;
      }
      if (e.target.closest("[data-backup-restore]")) {
        doBackupRestore();
        return;
      }
      if (e.target.closest("[data-pl-csv]")) {
        doPlaylistExport("csv");
        return;
      }
      if (e.target.closest("[data-pl-m3u]")) {
        doPlaylistExport("m3u");
        return;
      }
      // Spotify sign-in / sign-out
      if (e.target.closest("#set-spotify-signin")) {
        doSpotifySignIn();
        return;
      }
      if (e.target.closest("#set-spotify-signout")) {
        doSpotifySignOut();
        return;
      }
      // Spotify top tracks import
      if (e.target.closest("#set-spotify-top")) {
        doSpotifyTopImport();
        return;
      }
      // Google Drive (optional sign-in): parked with the rest of the Drive
      // feature while the consent screen sits in Google "testing" mode.
      // if (e.target.closest("[data-gdrive-signin]")) {
      //   doGDriveSignIn();
      //   return;
      // }
      // if (e.target.closest("[data-gdrive-signout]")) {
      //   doGDriveSignOut();
      //   return;
      // }
      // if (e.target.closest("[data-gdrive-sync]")) {
      //   doGDriveSyncNow();
      //   return;
      // }
      // Updates view: re-check, open the releases page, install the signed
      // update, or step back to a published older release.
      if (e.target.closest("[data-update-check]")) {
        fillUpdates();
        return;
      }
      if (e.target.closest("[data-update-page]")) {
        invoke("open_external", { url: lastUpdatePage }).catch((err) =>
          diag("update", false, String(err)),
        );
        return;
      }
      if (e.target.closest("[data-update-install]")) {
        runUpdateInstall();
        return;
      }
      const revert = e.target.closest("[data-update-revert]");
      if (revert) {
        runUpdateRollback(revert.dataset.updateRevert);
        return;
      }
      const start = e.target.closest("[data-autostart]");
      if (start) {
        savePref(AUTOSTART_KEY, autostartPref() ? "0" : "1");
        applySysPrefs();
        return openSettings("general");
      }
      if (e.target.closest("[data-gapless]")) {
        savePref(GAPLESS_KEY, gaplessPref() ? "0" : "1");
        toast(gaplessPref() ? "Gapless on — next track starts instantly." : "Gapless off.", "info", 2500);
        return openSettings("playback");
      }
      if (e.target.closest("[data-remember-pos]")) {
        savePref(REMEMBER_POS_KEY, rememberPosPref() ? "0" : "1");
        toast(rememberPosPref() ? "Reopen resumes where you stopped." : "Tracks always start from the top.", "info", 2500);
        return openSettings("playback");
      }
      if (e.target.closest("[data-lyrics-auto]")) {
        savePref(LYRICS_AUTOSCROLL_KEY, lyricsAutoScrollPref() ? "0" : "1");
        try {
          document.dispatchEvent(new CustomEvent("tm:lyrics-auto", { detail: lyricsAutoScrollPref() }));
        } catch {}
        return openSettings("lyrics");
      }
      if (e.target.closest("[data-lyrics-gloss]")) {
        savePref(LYRICS_GLOSS_KEY, lyricsGlossPref() ? "0" : "1");
        return openSettings("lyrics");
      }
      // Music language: one tap toggles a language in or out of the set.
      const chip = e.target.closest("[data-lang]");
      if (chip) {
        const v = chip.dataset.lang;
        const cur = prefLangs();
        const next = v === "all" ? [] : cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
        saveLangs(next);
        applySysPrefs();
        // Repaint the panel so the chips show the new state, then re-read the
        // catalog under it.
        openSettings("general");
        loadHome();
        if ($("#search-input")?.value.trim()) doSearch({ silent: true });
        toast(
          next.length
            ? `Filtering to ${next.map((x) => LANGS.find(([k]) => k === x)?.[1] || x).join(", ")}.`
            : "Showing songs in every language.",
          "info",
        );
        return;
      }
    });
    // Text and selects commit on change so typing a name never re-renders the
    // panel under the cursor; only a finished edit repaints anything.
    dlg.addEventListener("input", (e) => {
      if (e.target.id !== "set-name") return;
      savePref(NAME_KEY, e.target.value);
      paintGreeting();
    });
    dlg.addEventListener("change", (e) => {
      if (e.target.id === "set-country") {
        savePref(COUNTRY_KEY, e.target.value);
        applySysPrefs();
        loadHome();
        if ($("#search-input")?.value.trim()) doSearch({ silent: true });
        toast(`Reading charts for ${e.target.selectedOptions[0]?.textContent}.`, "info");
      } else if (e.target.id === "set-stream-quality") {
        savePref(STREAM_QUALITY_KEY, e.target.value);
        toast(`Streaming at ${e.target.selectedOptions[0]?.textContent} from now on.`, "info");
      } else if (e.target.id === "set-xfade-pref") {
        savePref(XFADE_KEY, e.target.value);
        try {
          localStorage.setItem(XFADE_KEY, e.target.value);
        } catch {}
        const q = $("#set-xfade");
        if (q) q.value = e.target.value;
        toast(e.target.value === "0" ? "Crossfade off." : `Crossfade ${e.target.value}s.`, "info", 2500);
        openSettings("playback");
      } else if (e.target.id === "set-play-speed") {
        savePref(PLAY_SPEED_KEY, e.target.value);
        applyPlaySpeed();
        toast(`Playback speed ${Number(e.target.value)}x.`, "info", 2500);
      } else if (e.target.id === "set-theme") {
        savePref(THEME_KEY, e.target.value);
        applyTheme();
        toast(`Theme: ${e.target.selectedOptions[0]?.textContent}.`, "info", 2500);
        openSettings("appearance");
      } else if (e.target.id === "set-density") {
        savePref(DENSITY_KEY, e.target.value);
        applyTheme();
        toast(`Density: ${e.target.selectedOptions[0]?.textContent}.`, "info", 2500);
      } else if (e.target.id === "set-lyrics-size") {
        savePref(LYRICS_SIZE_KEY, e.target.value);
        toast(`Lyric size: ${e.target.selectedOptions[0]?.textContent}.`, "info", 2500);
      } else if (e.target.id === "set-dl-quality") {
        savePref(DL_QUALITY_KEY, e.target.value);
        toast(`New downloads will be saved at ${e.target.selectedOptions[0]?.textContent}.`, "info");
      } else if (e.target.id === "set-net-mode") {
        savePref(NET_MODE_KEY, e.target.value);
        setModePref(e.target.value); // toast + queue refresh live in net.js
      } else if (e.target.id === "set-cache-size") {
        // Applies immediately (evicts down to the new cap) so the number on
        // screen matches what is actually kept.
        invoke("cache_set_budget", { mb: Number(e.target.value) })
          .then((s) => {
            const box = $("#set-storage-usage");
            if (box) box.innerHTML = storageLine(s);
            toast(`Cache capped at ${e.target.selectedOptions[0]?.textContent}.`, "info");
          })
          .catch((err) => diag("cache", false, String(err)));
      } else if (e.target.id === "set-spotify-csv") {
        if (e.target.files?.[0]) doSpotifyCsvImport(e.target.files[0]);
      } else if (e.target.id === "set-filter-input") {
        const query = (e.target.value || "").toLowerCase().trim();
        const items = dlg.querySelectorAll("[data-settings-view]");
        items.forEach((item) => {
          const text = (item.textContent || "").toLowerCase();
          item.style.display = !query || text.includes(query) ? "flex" : "none";
        });
      }
    });

    const filterInput = $("#set-filter-input", dlg);
    if (filterInput) {
      filterInput.addEventListener("input", (e) => {
        const query = (e.target.value || "").toLowerCase().trim();
        const items = dlg.querySelectorAll("[data-settings-view]");
        items.forEach((item) => {
          const text = (item.textContent || "").toLowerCase();
          item.style.display = !query || text.includes(query) ? "flex" : "none";
        });
      });
    }

    document.body.appendChild(dlg);
  }

  // Fallback if an obsolete "menu" view is passed
  const activeView = view === "menu" ? "general" : view;
  const section = SETTINGS_VIEWS[activeView] || SETTINGS_VIEWS.general;
  dlg.dataset.view = activeView;

  // Render Sidebar Navigation
  const navList = $("#settings-nav-list", dlg);
  if (navList) {
    const groups = [
      ["Preferences", SETTINGS_MENU.slice(0, 6)],
      ["Storage & Imports", SETTINGS_MENU.slice(6, 9)],
      ["About Project", SETTINGS_MENU.slice(9)],
    ];
    navList.innerHTML = groups
      .map(
        ([title, items]) => `
      <div class="flex flex-col gap-0.5">
        <span class="settings-nav-group-title">${title}</span>
        ${items
          .map(
            ([icon, label, _sub, viewKey]) => `
          <button type="button" data-settings-view="${viewKey}" class="settings-nav-item ${
            viewKey === activeView ? "active" : ""
          }">
            ${
              icon.startsWith("<svg")
                ? `<span class="w-[18px] h-[18px] flex items-center justify-center shrink-0">${icon}</span>`
                : `<span class="material-symbols-outlined">${icon}</span>`
            }
            <span class="truncate">${label}</span>
          </button>`,
          )
          .join("")}
      </div>`,
      )
      .join("");
  }

  // Update Header Title and Body Content
  const eyebrow = section.eyebrow.replace(/^Settings\s*\/\s*/, "");
  npText("tm-settings-eyebrow", eyebrow);
  const bodyEl = $("#tm-settings-body", dlg);
  if (bodyEl) {
    bodyEl.innerHTML = section.body();
  }

  if (!dlg.open) dlg.showModal(); // showModal() throws if already open
}
$("#settings-btn")?.addEventListener("click", () => openSettings());

// --------------------------------------------------------------- Spotify -
async function doSpotifySignIn() {
  const statusEl = $("#set-spotify-status");
  const signinBtn = $("#set-spotify-signin");
  // The browser round-trip can take a while (or never come back when the
  // redirect URI is not allowlisted) — say so up front instead of sitting on
  // a stale "Not signed in" while the invoke is in flight.
  if (statusEl) {
    statusEl.textContent = "Waiting for browser\u2026";
    statusEl.classList.remove("text-primary");
  }
  signinBtn?.setAttribute("disabled", "");
  try {
    if (await invoke("spotify_signin")) {
      toast("Signed in to Spotify", "success");
      await fillSpotifyStatus();
    }
  } catch (err) {
    diag("spotify", false, String(err));
    toast(`Spotify sign-in failed: ${err}`, "error");
    // Persist the reason in the status line: a fading toast is not enough
    // when the browser round-trip is the thing failing.
    if (statusEl) {
      statusEl.textContent = `Sign-in failed: ${err}`;
      statusEl.classList.remove("text-primary");
    }
  } finally {
    signinBtn?.removeAttribute("disabled");
  }
}

async function doSpotifySignOut() {
  try {
    await invoke("spotify_signout");
    toast("Signed out from Spotify", "success");
    fillSpotifyStatus();
  } catch (err) {
    diag("spotify", false, String(err));
    toast(`Spotify sign-out failed: ${err}`, "error");
  }
}

async function doSpotifyCsvImport(file) {
  try {
    const csvText = await readCsvFile(file);
    const { playlist, matched, missed, errors } = await importCsvToPlaylist(csvText, `Imported ${file.name.replace(/\.csv$/i, "")}`);

    if (errors.length > 0) {
      console.warn("CSV import warnings:", errors);
    }

    // Save the playlist
    const pls = loadLocalPls();
    pls.push(playlist);
    saveLocalPls(pls);

    toast(`Imported ${matched} tracks from Spotify CSV (${missed} not found)`, "success");
    diag("spotify-import", true, `matched ${matched}, missed ${missed}`);
    renderLibrary();
  } catch (err) {
    diag("spotify-import", false, String(err));
    toast(`CSV import failed: ${err}`, "error");
  }
}

async function doSpotifyTopImport() {
  try {
    const signedIn = await invoke("spotify_is_signedin");
    if (!signedIn) {
      toast("Please sign in to Spotify first", "error");
      return;
    }

    toast("Importing top tracks from Spotify...", "info");

    // Tauri 2 maps snake_case Rust args to camelCase keys on the wire.
    const tracks = await invoke("spotify_import_top", { timeRange: "medium_term", limit: 20 });

    if (tracks.length === 0) {
      toast("No top tracks found in your Spotify library", "info");
      return;
    }

    // Match to JioSaavn catalog
    const matched = [];
    const missed = [];

    for (const t of tracks) {
      try {
        const query = t.isrc || `${t.name} ${t.artists[0]}`;
        const results = await invoke("search_songs", { query, limit: 1 });

        if (results.tracks && results.tracks.length > 0) {
          matched.push({
            ...results.tracks[0],
            original: t,
          });
        } else {
          missed.push(t);
        }
      } catch (err) {
        console.error(`Failed to match track: ${t.name} - ${err}`);
        missed.push(t);
      }
    }

    // Create playlist
    const playlist = {
      id: `spotify-top-${Date.now()}`,
      title: "Spotify Top Tracks",
      tracks: matched.map(m => ({
        id: m.id,
        title: m.title || m.name,
        artist: m.artist,
        album: m.album,
        image: m.image,
        duration: m.duration || m.duration_ms,
      })),
      imported: true,
      source: "spotify-top",
      createdAt: new Date().toISOString(),
    };

    const pls = loadLocalPls();
    pls.push(playlist);
    saveLocalPls(pls);

    toast(`Imported ${matched.length} top tracks from Spotify (${missed.length} not found)`, "success");
    diag("spotify-top", true, `matched ${matched.length}, missed ${missed.length}`);
    renderLibrary();
  } catch (err) {
    diag("spotify-top", false, String(err));
    toast(`Spotify import failed: ${err}`, "error");
  }
}

// The #error banner ships inside the search view, which hid failures for
// downloads triggered from Now Playing / queue / home. Hoist it to <body>
// once so showError/showErrorRetry are visible from every view.
if (errorEl && !errorEl.dataset.hoisted) {
  errorEl.dataset.hoisted = "1";
  errorEl.classList.add("tm-global");
  document.body.appendChild(errorEl);
}

