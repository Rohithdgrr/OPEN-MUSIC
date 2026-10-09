// generated from design/screens/mobile/nowplaying/code.html — do not edit

/* global tailwind */

document.body.className = "bg-surface text-on-surface flex flex-col min-h-screen font-body-md antialiased selection:bg-primary selection:text-on-primary";

tailwind.config = {
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "secondary-fixed": "#e1e2e7",
        "on-secondary-container": "#626468",
        "surface-container-highest": "#e2e2e2",
        "outline-variant": "#c4c7c7",
        "secondary-container": "#e1e2e7",
        "on-primary-container": "#858383",
        "on-primary-fixed": "#1c1b1b",
        "on-tertiary": "#ffffff",
        "on-primary-fixed-variant": "#474646",
        "on-tertiary-container": "#e65131",
        "error": "#ba1a1a",
        "tertiary-fixed": "#ffdad3",
        "outline": "#747878",
        "secondary": "#5c5e62",
        "on-error-container": "#93000a",
        "tertiary-container": "#3e0500",
        "inverse-on-surface": "#f1f1f0",
        "surface-container-high": "#e8e8e7",
        "inverse-primary": "#c8c6c5",
        "primary": "#000000",
        "on-tertiary-fixed": "#3e0500",
        "primary-fixed": "#e5e2e1",
        "secondary-fixed-dim": "#c5c6cb",
        "inverse-surface": "#2f3130",
        "on-error": "#ffffff",
        "surface-bright": "#f9f9f8",
        "primary-container": "#1c1b1b",
        "surface": "#f9f9f8",
        "surface-variant": "#e2e2e2",
        "error-container": "#ffdad6",
        "tertiary": "#000000",
        "surface-tint": "#5f5e5e",
        "surface-container-lowest": "#ffffff",
        "surface-container": "#eeeeed",
        "on-secondary": "#ffffff",
        "surface-dim": "#dadad9",
        "on-secondary-fixed-variant": "#45474b",
        "on-tertiary-fixed-variant": "#8c1700",
        "primary-fixed-dim": "#c8c6c5",
        "tertiary-fixed-dim": "#ffb4a4",
        "on-primary": "#ffffff",
        "background": "#f9f9f8",
        "surface-container-low": "#f3f4f3",
        "on-surface": "#1a1c1c",
        "on-surface-variant": "#444748",
        "on-background": "#1a1c1c",
        "on-secondary-fixed": "#191c1f"
      },
      borderRadius: {
        "DEFAULT": "0.125rem",
        "lg": "0.25rem",
        "xl": "0.5rem",
        "full": "9999px"
      },
      spacing: {
        "gutter": "0.75rem",
        "margin": "1rem",
        "space-xs": "0.25rem",
        "space-sm": "0.5rem",
        "space-md": "0.75rem",
        "space-xl": "2rem",
        "space-lg": "1.25rem"
      },
      fontFamily: {
        "headline-lg": ["Geist", "sans-serif"],
        "label-lg": ["JetBrains Mono", "monospace"],
        "headline-sm": ["Geist", "sans-serif"],
        "headline-md": ["Geist", "sans-serif"],
        "display-lg": ["Geist", "sans-serif"],
        "label-sm": ["JetBrains Mono", "monospace"],
        "body-lg": ["Geist", "sans-serif"],
        "label-md": ["JetBrains Mono", "monospace"],
        "body-sm": ["Geist", "sans-serif"],
        "body-md": ["Geist", "sans-serif"]
      },
      fontSize: {
        "headline-lg": ["26px", { "lineHeight": "32px", "letterSpacing": "-0.025em", "fontWeight": "600" }],
        "label-lg": ["13px", { "lineHeight": "16px", "letterSpacing": "0.02em", "fontWeight": "500" }],
        "headline-sm": ["17px", { "lineHeight": "22px", "letterSpacing": "-0.015em", "fontWeight": "600" }],
        "headline-md": ["20px", { "lineHeight": "26px", "letterSpacing": "-0.02em", "fontWeight": "500" }],
        "display-lg": ["36px", { "lineHeight": "40px", "letterSpacing": "-0.03em", "fontWeight": "600" }],
        "label-sm": ["10px", { "lineHeight": "12px", "letterSpacing": "0.06em", "fontWeight": "600" }],
        "body-lg": ["16px", { "lineHeight": "24px", "letterSpacing": "-0.01em", "fontWeight": "400" }],
        "label-md": ["11px", { "lineHeight": "14px", "letterSpacing": "0.04em", "fontWeight": "500" }],
        "body-sm": ["12px", { "lineHeight": "16px", "letterSpacing": "0em", "fontWeight": "400" }],
        "body-md": ["14px", { "lineHeight": "20px", "letterSpacing": "-0.005em", "fontWeight": "400" }]
      }
    }
  }
};
// The design export's demo scripts — a fake play/pause toggle, a fake
// favourite, a fake "Copied" flash and a fake Solo↔Social switch — are removed
// here on purpose: `jam.js` owns the mode + room chrome and `binders.js` owns
// the real player, and both write only values that came back from the backend
// (docs/listen-together.md §8/§13.2). What stays is the tab switcher the tab
// buttons call.
//
// Bound with listeners, not inline `onclick`: the mobile CSP allows inline
// handlers only when their sha256 is listed ('unsafe-hashes'), the regenerated
// screen shipped four that were never hashed, and the WebView refused every
// tap on a real device (docs/mobile/09-problems-solutions.md P24). A listener
// has no hash to keep in sync.
function switchTab(targetTab) {
  const tabs = ["queue", "chat", "jam-data", "lyrics"];
  tabs.forEach((tab) => {
    const view = document.getElementById("view-" + tab);
    const btn = document.querySelector('[data-tab="' + tab + '"]');
    if (!view || !btn) return;
    const active = tab === targetTab;
    view.classList.toggle("hidden", !active);
    view.classList.toggle("flex", active);
    // The class rewrite must not clear `hidden`: Chat / Jam Data are room-only
    // and their visibility belongs to paintJam's show(…, social, "flex")
    // (P25) — dropping it flashed them in Solo until the next repaint.
    const roomOnly = btn.classList.contains("hidden");
    const base = active
      ? "tab-btn flex-1 bg-on-surface text-surface py-1.5 px-2 rounded-full font-label-md text-[11px] font-semibold flex items-center justify-center gap-1 whitespace-nowrap transition-all"
      : "tab-btn flex-1 text-on-surface-variant py-1.5 px-2 rounded-full font-label-md text-[11px] font-medium flex items-center justify-center gap-1 whitespace-nowrap transition-colors";
    btn.className = roomOnly ? `${base} hidden` : base;
  });
}
// The router re-runs this script on every navigation against fresh DOM, so
// these bind once per mount and never stack.
document.querySelectorAll("#tabBar .tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

// Mockup action row: every button reuses an existing path, no new IPC.
function scrollSheet() {
  document.getElementById("np-sheet")?.scrollIntoView({ behavior: "smooth", block: "start" });
}
function sheetTab(tab) {
  const btn = document.querySelector('#tabBar [data-tab="' + tab + '"]');
  if (btn) btn.click();
  scrollSheet();
}
document.getElementById("np-action-like")?.addEventListener("click", () => {
  document.getElementById("favorite-btn")?.click();
});
document.getElementById("np-action-lyrics")?.addEventListener("click", () => sheetTab("lyrics"));
document.getElementById("np-action-queue")?.addEventListener("click", () => sheetTab("queue"));
document.getElementById("np-action-chat")?.addEventListener("click", () => {
  // The Chat pill only exists in Social mode (jam.js paintJam unhides it),
  // so in Solo the bare click hit a display:none element and the sheet
  // bounced back to the queue — "chat UI is missing". Enter Social first
  // (same path the Jam action uses), then open Chat for real, so the
  // unread pill still clears via jam.js' wiring.
  const chat = document.getElementById("chatTabBtn");
  if (!chat || chat.classList.contains("hidden")) {
    document.getElementById("modeSocialTab")?.click();
  }
  document.getElementById("chatTabBtn")?.click();
  scrollSheet();
});
document.getElementById("np-action-jam")?.addEventListener("click", () => {
  // In a room → Jam Data; in Solo → social chrome + the create/join CTA.
  document.getElementById("modeSocialTab")?.click();
  scrollSheet();
});
document.getElementById("np-sheet-collapse")?.addEventListener("click", () => {
  document.getElementById("np-top")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

// Jam sub-tabs (mockup segmented control): Session Info / Listeners toggle
// panes inside the Jam view; Chat jumps to the real Chat tab.
function paintJamSub(active) {
  document.querySelectorAll("#jamSubBar [data-jam-sub]").forEach((b) => {
    const on = b.dataset.jamSub === active;
    b.className = on
      ? "flex-1 py-1.5 rounded-full font-label-md text-[11px] font-semibold transition-all bg-on-surface text-surface"
      : "flex-1 py-1.5 rounded-full font-label-md text-[11px] font-medium transition-all text-on-surface-variant";
  });
  const info = document.getElementById("jamInfoWrap");
  const listeners = document.getElementById("jamListenersWrap");
  if (info) {
    info.classList.toggle("hidden", active !== "info");
    info.classList.toggle("flex", active === "info");
  }
  if (listeners) {
    listeners.classList.toggle("hidden", active !== "listeners");
    listeners.classList.toggle("flex", active === "listeners");
  }
}
document.querySelectorAll("#jamSubBar [data-jam-sub]").forEach((b) => {
  b.addEventListener("click", () => {
    if (b.dataset.jamSub === "chat") {
      document.getElementById("chatTabBtn")?.click();
      return;
    }
    paintJamSub(b.dataset.jamSub);
  });
});
