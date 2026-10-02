// router.js — hash router for the mobile shell (Phase 4).
//
// Screens are static fragments (screens/<dir>.html) produced from the Stitch
// exports in design/screens/mobile/; each has a companion .js that re-applies
// that screen's body class + Tailwind theme and runs its interactions. The
// script is re-appended on every navigation so listeners bind to fresh DOM.
// ponytail: nowplaying's scrub listeners live on window and are never torn
// down (they touch detached nodes, so they are harmless) — a teardown hook is
// the upgrade path if they ever accumulate visibly.
(function () {
  "use strict";

  var mount = document.getElementById("screen");
  var seq = 0;

  // route key -> fragment dir: covers nav data-path values (library, vault,
  // profile, reon-listening-analytics) and friendly names.
  var SCREENS = {
    home: "home",
    search: "search",
    library: "main-library",
    vault: "main-library",
    "main-library": "main-library",
    profile: "settings",
    settings: "settings",
    analytics: "analytics",
    "reon-listening-analytics": "analytics",
    album: "album",
    artist: "artist",
    playlist: "playlist",
    liked: "liked-songs",
    "liked-songs": "liked-songs",
    download: "download",
    downloads: "download",
    history: "history",
    notification: "notification",
    notifications: "notification",
    nowplaying: "nowplaying",
  };

  function go(key) {
    location.hash = "#/" + key;
  }

  // ---------------------------------------------------------------- bottom nav
  // The screen fragments each ship their own copy of the tab bar (five variants
  // drifted apart across the design exports, and none of them recomputed the
  // active tab). The shell owns one canonical nav instead: every fragment's copy
  // is stripped on render and this one is injected in its place, with the
  // active tab derived from the route. NowPlaying is a full-screen player and
  // deliberately gets no nav.
  var TABS = [
    { path: "home", icon: "grid_view", label: "Home" },
    { path: "search", icon: "search", label: "Search" },
    { path: "library", icon: "library_music", label: "Library" },
  ];

  // Route key -> the tab it belongs to. Detail screens (album, artist, …) sit
  // under Library; screens that are not tabs at all (settings, analytics,
  // notifications) light nothing up rather than pretend to be one.
  var TAB_OF = {
    home: "home",
    search: "search",
    library: "library",
    vault: "library",
    "main-library": "library",
    album: "library",
    artist: "library",
    playlist: "library",
    liked: "library",
    "liked-songs": "library",
    download: "library",
    downloads: "library",
    history: "library",
  };

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function stripNavs(root) {
    root.querySelectorAll("nav").forEach(function (n) {
      if (n.classList.contains("fixed") && n.classList.contains("bottom-0")) n.remove();
    });
  }

  function navHTML(key) {
    var active = TAB_OF[key] || "";
    return (
      '<nav class="fixed bottom-0 w-full z-50 pb-safe bg-surface/90 backdrop-blur-xl shadow-[0_-1px_8px_rgba(0,0,0,0.03)]"><div class="h-16 px-space-sm flex items-center justify-around">' +
      TABS.map(function (t) {
        var on = t.path === active;
        return (
          '<a href="#" data-path="' +
          t.path +
          '"' +
          (on ? ' aria-current="page"' : "") +
          ' class="flex flex-col items-center justify-center w-16 h-12 gap-0.5 transition-colors ' +
          (on ? "text-primary font-medium" : "text-secondary hover:text-on-surface") +
          '"><span class="material-symbols-outlined text-[20px]">' +
          t.icon +
          '</span><span class="font-label-sm text-label-sm">' +
          esc(t.label) +
          "</span></a>"
        );
      }).join("") +
      "</div></nav>"
    );
  }

  function render(key, query) {
    var dir = SCREENS[key] || "home";
    var id = ++seq;
    fetch("screens/" + dir + ".html")
      .then(function (r) {
        return r.text();
      })
      .then(function (html) {
        if (id !== seq) return; // a newer navigation won the race
        mount.innerHTML = html;
        stripNavs(mount);
        if (dir !== "nowplaying") mount.insertAdjacentHTML("beforeend", navHTML(key));
        window.scrollTo(0, 0);
        var s = document.createElement("script");
        s.src = "screens/" + dir + ".js";
        s.onload = s.onerror = function () {
          if (id !== seq) return;
          document.dispatchEvent(new CustomEvent("smount", { detail: { dir: dir, key: key, query: query } }));
        };
        mount.appendChild(s);
      });
  }

  function route() {
    var raw = location.hash.replace(/^#\/?/, "");
    var qi = raw.indexOf("?");
    var key = (qi >= 0 ? raw.slice(0, qi) : raw).toLowerCase();
    var query = new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : "");
    render(key || "home", query);
  }

  window.addEventListener("hashchange", route);

  // Android hardware/gesture back (MainActivity calls this): step back one
  // screen when there is history, otherwise report false so the activity can
  // finish. Returning a value is what the Kotlin callback inspects.
  window.__tmBack = function () {
    if (history.length > 1) {
      history.back();
      return true;
    }
    return false;
  };

  // Bottom-nav data-path links + header bell/tune buttons drive the hash.
  // Placeholder href="#" anchors (legal links etc.) are swallowed so they
  // cannot reset the route to home.
  document.addEventListener("click", function (e) {
    var el = e.target.closest ? e.target.closest("a") : null;
    if (el && el.hasAttribute("data-path")) {
      e.preventDefault();
      go(el.getAttribute("data-path"));
      return;
    }
    if (el && el.getAttribute("href") === "#") {
      e.preventDefault();
      return;
    }
    var b = e.target.closest ? e.target.closest("button[aria-label]") : null;
    if (b) {
      var label = b.getAttribute("aria-label");
      if (label === "Notifications") go("notifications");
      else if (label === "Settings") go("settings");
      else if (label === "History") go("history");
      else if (label === "Analytics") go("analytics");
    }
  });

  route();
})();
