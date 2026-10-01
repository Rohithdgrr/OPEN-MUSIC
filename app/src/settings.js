// settings.js — settings dialog, widget prefs, user preferences
// Split from main.js (Phase 4 M1).
import { diag, esc, invoke, toast } from "./core.js";
import { $, errorEl } from "./dom.js";
import { loadHome } from "./home.js";
import { doSearch } from "./search.js";
import { npText } from "./util.js";

// ---------------------------------------------------------------- settings -
// One native <dialog>, three entries and nothing else. The body swaps between
// the menu and a single section, so a nested dialog is never needed.
export const APP = { name: "TRANCE MUSIC", version: "0.1.0", id: "com.openmusic.trancemusic" };

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
];

export const kv = (k, v) => `
  <div class="flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-3">
    <dt class="font-label-mono text-[10px] uppercase tracking-wider text-on-surface-variant sm:w-28 shrink-0">${esc(k)}</dt>
    <dd class="text-sm text-on-surface min-w-0">${esc(v)}</dd>
  </div>`;

export const clause = (n, h, body) => `
  <li class="flex flex-col gap-1">
    <h3 class="text-sm font-semibold text-on-surface">${esc(n)}. ${esc(h)}</h3>
    <p class="text-[13px] leading-relaxed text-on-surface-variant">${body}</p>
  </li>`;

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
export const LANG_KEY = "tm-lang"; // "all" or a JioSaavn language slug
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
  } catch {}
}
export const prefName = () => prefStr(NAME_KEY, "Listener");
export const prefLang = () => prefStr(LANG_KEY, "all");
export const prefCountry = () => prefStr(COUNTRY_KEY, "");
export const autostartPref = () => prefStr(AUTOSTART_KEY, "1") !== "0";

export function paintGreeting() {
  const el = $("#home-name");
  if (el) el.textContent = prefName();
}

/// Registry Run entry (startup) + the language/country every catalog request
/// is built with.
export function applySysPrefs() {
  invoke("autostart_set", { on: autostartPref() }).catch((e) => diag("autostart", false, String(e)));
  invoke("content_prefs_set", { lang: prefLang(), country: prefCountry() }).catch((e) =>
    diag("prefs", false, String(e)),
  );
}

/// Search results, load-more pages and Home's rankings all flow through here:
/// keep the selected language, but only when the source actually speaks it -
/// an all-English query under a Telugu preference would otherwise paint an
/// empty page instead of the results the user asked for.
export function filterLang(list) {
  const lang = prefLang();
  if (lang === "all" || !Array.isArray(list)) return list;
  const hit = list.filter((t) =>
    String(t.language || "")
      .toLowerCase()
      .split(",")
      .some((s) => s.trim() === lang),
  );
  return hit.length ? hit : list;
}

export const SETTINGS_VIEWS = {
  general: {
    eyebrow: "Settings / General",
    body: () => {
      const name = prefName();
      const startOn = autostartPref();
      const lang = prefLang();
      const country = prefCountry();
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
      const row = (icon, label, sub, control) => `
      <div class="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-container transition-colors">
        <span class="material-symbols-outlined text-[20px] text-on-surface-variant">${icon}</span>
        <span class="min-w-0 flex-1">
          <span class="block text-sm font-medium text-on-surface">${label}</span>
          <span class="block text-xs text-on-surface-variant">${sub}</span>
        </span>
        ${control}
      </div>`;
      const selectCls =
        "max-w-[9.5rem] shrink-0 bg-surface-container-lowest border border-surface-container-highest/60 rounded-lg px-2 py-1.5 text-sm text-on-surface";
      return `
    <div class="flex flex-col gap-3">
      <div class="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-container transition-colors">
        <span class="material-symbols-outlined text-[20px] text-on-surface-variant">person</span>
        <span class="min-w-0 flex-1">
          <span class="block text-sm font-medium text-on-surface">Display name</span>
          <span class="block text-xs text-on-surface-variant">Shown in the greeting on Home.</span>
        </span>
        <input id="set-name" type="text" maxlength="32" value="${esc(name)}" placeholder="Listener"
          class="w-40 shrink-0 bg-surface-container-lowest border border-surface-container-highest/60 rounded-lg px-2 py-1.5 text-sm text-on-surface" />
      </div>
      ${row(
        "power_settings_new",
        "Open at startup",
        startOn ? "Starts with Windows" : "Off - start it yourself",
        `<button type="button" role="switch" aria-checked="${startOn}" data-autostart class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${startOn ? "bg-primary" : "bg-surface-container-highest"}"><span class="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${startOn ? "translate-x-4" : "translate-x-0.5"}"></span></button>`,
      )}
      ${row(
        "translate",
        "Music language",
        "Songs are filtered to the language you pick",
        `<select id="set-lang" class="${selectCls}">${options(LANGS, lang)}</select>`,
      )}
      ${row(
        "public",
        "Country",
        "Sets the region the catalog is read from",
        `<select id="set-country" class="${selectCls}">${options(COUNTRIES, country)}</select>`,
      )}
      <p class="text-xs leading-relaxed text-on-surface-variant">Language and country apply to new searches and refresh Home straight away; favourites and downloads you already saved are never filtered.</p>
    </div>`;
    },
  },

  licenses: {
    eyebrow: "Settings / Licences",
    body: () => `
    <div class="flex flex-col gap-3">
      <p class="text-[13px] leading-relaxed text-on-surface-variant">TRANCE MUSIC itself is MIT licensed &mdash; see <span class="font-label-mono">LICENSE</span> in the repository. The Rust core links the direct dependencies below; every one is MIT or dual MIT&nbsp;/&nbsp;Apache-2.0.</p>
      <table class="w-full font-label-mono text-[11px] border-collapse">
        <thead>
          <tr class="text-on-surface-variant">
            <th class="text-left font-normal py-1.5">Crate</th>
            <th class="text-left font-normal py-1.5 w-20">Version</th>
            <th class="text-left font-normal py-1.5">Licence</th>
          </tr>
        </thead>
        <tbody>
          ${LICENSES.map(
            ([n, v, l]) => `
          <tr class="border-t border-surface-container-high">
            <td class="py-1.5 pr-2 text-on-surface">${esc(n)}</td>
            <td class="py-1.5 pr-2 text-on-surface-variant">${esc(v)}</td>
            <td class="py-1.5 text-on-surface-variant">${esc(l)}</td>
          </tr>`,
          ).join("")}
          <tr class="border-t border-surface-container-high">
            <td class="py-1.5 pr-2 text-on-surface">@tauri-apps/cli</td>
            <td class="py-1.5 pr-2 text-on-surface-variant">^2 (dev)</td>
            <td class="py-1.5 text-on-surface-variant">MIT OR Apache-2.0</td>
          </tr>
        </tbody>
      </table>
      <p class="text-xs leading-relaxed text-on-surface-variant">The complete dependency tree is 469 crates and lives in <span class="font-label-mono">app/src-tauri/Cargo.lock</span>. Full licence texts: <span class="font-label-mono">LICENSE</span> for this project, and each upstream repository for its crate. No copyleft licences are linked.</p>
    </div>`,
  },

  about: {
    eyebrow: "Settings / About",
    body: () => `
    <div class="flex flex-col gap-3">
      <div>
        <p class="text-base font-semibold text-on-surface">${esc(APP.name)}</p>
        <p class="font-label-mono text-[11px] text-on-surface-variant mt-0.5">v${esc(APP.version)} &middot; ${esc(APP.id)} &middot; Windows</p>
      </div>
      <p class="text-[13px] leading-relaxed text-on-surface-variant">A desktop music player that streams from JioSaavn through a local range relay, keeps an offline vault on your disk, and never lets the webview talk to a third-party CDN directly.</p>
      <dl class="flex flex-col gap-2">
        ${kv("Shell", "Tauri 2, Rust 1.77+")}
        ${kv("Front end", "Vanilla ES modules, no build step, Tailwind via CDN")}
        ${kv("Catalog", "JioSaavn first-party, 5 community mirrors as fallback")}
        ${kv("Playback", "Local axum relay on 127.0.0.1, Range forwarded verbatim")}
        ${kv("Lyrics", "LRCLIB, then JioSaavn, then LRCLIB search")}
        ${kv("Vault", "~/Downloads/TRANCE MUSIC")}
        ${kv("Licence", "MIT")}
      </dl>
      <p class="text-xs text-on-surface-variant">No installer and no code signing yet &mdash; this build runs from source. Development status is in <span class="font-label-mono">CHANGELOG.md</span>.</p>
    </div>`,
  },

  terms: {
    eyebrow: "Settings / Terms",
    body: () => `
    <div class="flex flex-col gap-3">
      <p class="text-[13px] leading-relaxed text-on-surface-variant">Last updated 30 September 2026. By using ${esc(APP.name)} you accept these terms.</p>
      <ol class="flex flex-col gap-3 list-none">
        ${clause(1, "Personal, non-commercial use", "You may use TRANCE MUSIC for your own personal, non-commercial listening. Reselling access, redistributing the application, or operating a public service built on it requires written permission.")}
        ${clause(2, "No content is bundled", "TRANCE MUSIC ships no audio. It is a player: tracks, artwork and lyrics are fetched at request time from third-party services. Rights to that content stay with their owners, and those services' own terms also apply to you.")}
        ${clause(3, "Your downloads are yours", "Anything you save lands in your own Downloads folder and is your responsibility to keep, back up and delete. TRANCE MUSIC is not liable for lost or damaged files.")}
        ${clause(4, "No warranty", `The software is provided "as is", without warranty of any kind, to the maximum extent the law allows. It is pre-release: expect bugs, data-loss bugs included. ${esc(APP.name)} is an independent project and is not affiliated with, endorsed by, or sponsored by JioSaavn, LRCLIB, or any mirror listed in the source.`)}
        ${clause(5, "Limitation of liability", "To the fullest extent permitted by law, the authors and contributors are not liable for any indirect, incidental or consequential damages arising from use of the software, including lost data, lost profits, or unavailable services.")}
        ${clause(6, "Copyright complaints", "Copyright holders may ask for stored media to be removed. Contact the maintainers through the repository and the relevant item will be deleted from the vault promptly.")}
        ${clause(7, "Changes", "These terms may change as the project matures. The date above and the copy in the repository are authoritative; material changes will be noted in the changelog.")}
      </ol>
      <p class="text-xs text-on-surface-variant">This summary is provided for convenience and is not legal advice.</p>
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
      return `
    <div class="flex flex-col gap-3">
      <p class="text-[13px] leading-relaxed text-on-surface-variant">A now-playing card for your Windows desktop: cover art, title, artist, progress and transport controls, fed live from the player. It is a separate window, so it stays where you leave it.</p>
      <button type="button" role="switch" aria-checked="${on}" data-widget-toggle class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-surface-container transition-colors">
        <span class="material-symbols-outlined text-[20px] text-on-surface-variant">widgets</span>
        <span class="min-w-0 flex-1">
          <span class="block text-sm font-medium text-on-surface">Show desktop widget</span>
          <span class="block text-xs text-on-surface-variant truncate">${
            on ? "Added to your desktop" : "Not on the desktop yet"
          }</span>
        </span>
        <span class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${on ? "bg-primary" : "bg-surface-container-highest"}">
          <span class="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${on ? "translate-x-4" : "translate-x-0.5"}"></span>
        </span>
      </button>
      <div class="flex flex-col gap-1 ${on ? "" : "opacity-50 pointer-events-none"}">
        <span class="font-label-mono text-[10px] uppercase tracking-wider text-on-surface-variant">Placement</span>
        ${modes
          .map(
            ([id, icon, label, sub]) => `
        <button type="button" role="radio" aria-checked="${mode === id}" data-widget-mode="${id}" class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined text-[20px] text-on-surface-variant">${icon}</span>
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium text-on-surface">${label}</span>
            <span class="block text-xs text-on-surface-variant truncate">${sub}</span>
          </span>
          <span class="material-symbols-outlined text-[18px] ${mode === id ? "text-on-surface" : "opacity-0"}">check</span>
        </button>`,
          )
          .join("")}
        <button type="button" data-widget-reset class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined text-[20px] text-on-surface-variant">my_location</span>
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium text-on-surface">Reset position</span>
            <span class="block text-xs text-on-surface-variant truncate">Put the card back above the miniplayer</span>
          </span>
        </button>
      </div>
      <p class="text-xs leading-relaxed text-on-surface-variant">Drag the card by its header; the X hides it here. The card follows playback only while this app is running.</p>
    </div>`;
    },
  },
};

export const SETTINGS_MENU = [
  ["tune", "General", "Name, startup, language &amp; country", "general"],
  ["widgets", "Desktop Widget", "Now-playing card on your desktop", "widget"],
  ["policy", "Open-Source Licences", "MIT &amp; Apache-2.0", "licenses"],
  ["info", "About the Project", `v${APP.version} &middot; Windows desktop`, "about"],
  ["gavel", "Terms &amp; Conditions", "Personal use, no warranty", "terms"],
];

export function openSettings(view = "menu") {
  let dlg = $("#tm-settings");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "tm-settings";
    dlg.innerHTML = `
    <div class="w-[min(34rem,calc(100vw-2rem))] max-h-[calc(100vh-3rem)] rounded-xl bg-surface-container-lowest border border-surface-container-highest/60 shadow-xl overflow-hidden flex flex-col">
      <div class="flex items-center gap-2 px-5 py-3.5 border-b border-surface-container-high shrink-0">
        <button type="button" id="tm-settings-back" title="Back" class="hidden">
          <span class="material-symbols-outlined text-[18px]">arrow_back</span>
        </button>
        <span id="tm-settings-eyebrow" class="font-label-mono text-[10px] uppercase tracking-wider text-on-surface-variant">Settings</span>
      </div>
      <div id="tm-settings-body" class="px-5 py-4 overflow-y-auto"></div>
    </div>`;
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) dlg.close();
    });
    dlg.addEventListener("click", (e) => {
      const row = e.target.closest("[data-settings-view]");
      if (row) return openSettings(row.dataset.settingsView);
      if (e.target.closest("#tm-settings-back")) return openSettings("menu");
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
      const start = e.target.closest("[data-autostart]");
      if (start) {
        savePref(AUTOSTART_KEY, autostartPref() ? "0" : "1");
        applySysPrefs();
        return openSettings("general");
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
      if (e.target.id === "set-lang") {
        savePref(LANG_KEY, e.target.value);
        applySysPrefs();
        loadHome();
        if ($("#search-input")?.value.trim()) doSearch({ silent: true });
        toast(`Songs filtered to ${e.target.selectedOptions[0]?.textContent}.`, "info");
      } else if (e.target.id === "set-country") {
        savePref(COUNTRY_KEY, e.target.value);
        applySysPrefs();
        loadHome();
        if ($("#search-input")?.value.trim()) doSearch({ silent: true });
        toast(`Reading charts for ${e.target.selectedOptions[0]?.textContent}.`, "info");
      }
    });
    document.body.appendChild(dlg);
  }
  const back = $("#tm-settings-back", dlg);
  const section = view === "menu" ? null : SETTINGS_VIEWS[view];
  if (section) {
    npText("tm-settings-eyebrow", section.eyebrow);
    $("#tm-settings-body", dlg).innerHTML = section.body();
    // Swap the whole class string, never add/remove `flex` on top of `hidden`:
    // Tailwind emits `.hidden` after `.flex`, so the two cannot coexist.
    if (back) back.className = "flex items-center text-on-surface-variant hover:text-on-surface transition-colors";
  } else {
    npText("tm-settings-eyebrow", "Settings");
    $("#tm-settings-body", dlg).innerHTML = `
    <div class="flex flex-col gap-1">
      ${SETTINGS_MENU.map(
        ([icon, label, sub, view]) => `
      <button type="button" data-settings-view="${view}" class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left hover:bg-surface-container transition-colors group">
        <span class="material-symbols-outlined text-[20px] text-on-surface-variant">${icon}</span>
        <span class="min-w-0 flex-1">
          <span class="block text-sm font-medium text-on-surface">${label}</span>
          <span class="block text-xs text-on-surface-variant truncate">${sub}</span>
        </span>
        <span class="material-symbols-outlined text-[18px] text-on-surface-variant opacity-0 group-hover:opacity-100 transition-opacity">chevron_right</span>
      </button>`,
      ).join("")}
    </div>`;
    if (back) back.className = "hidden";
  }
  if (!dlg.open) dlg.showModal(); // showModal() throws if already open
}
$("#settings-btn")?.addEventListener("click", () => openSettings());

// The #error banner ships inside the search view, which hid failures for
// downloads triggered from Now Playing / queue / home. Hoist it to <body>
// once so showError/showErrorRetry are visible from every view.
if (errorEl && !errorEl.dataset.hoisted) {
  errorEl.dataset.hoisted = "1";
  errorEl.classList.add("tm-global");
  document.body.appendChild(errorEl);
}

