// generated from design/screens/mobile/search/code.html — do not edit

/* global tailwind */

document.body.className = "bg-surface font-body-md text-on-surface antialiased";

tailwind.config = { darkMode: "class", theme: { extend: { "colors": { "primary-fixed": "#e2e2e2", "error-container": "#ffdad6", "surface-container-low": "#f3f3f4", "surface-dim": "#d9dadc", "on-tertiary": "#ffffff", "secondary-fixed": "#e4e1e5", "secondary": "#5f5e61", "on-secondary": "#ffffff", "on-secondary-container": "#656467", "on-surface": "#1a1c1d", "surface-container-lowest": "#ffffff", "surface-container-high": "#e8e8ea", "primary": "#000000", "surface-container": "#eeeef0", "inverse-on-surface": "#f0f0f2", "on-error": "#ffffff", "outline": "#77767b", "inverse-surface": "#2f3132", "on-surface-variant": "#47464b", "on-tertiary-fixed": "#1b1b1b", "on-tertiary-fixed-variant": "#474747", "inverse-primary": "#c6c6c6", "primary-container": "#1b1b1e", "tertiary-container": "#1b1b1b", "on-primary": "#ffffff", "on-tertiary-container": "#848484", "on-error-container": "#93000a", "on-primary-fixed": "#1b1b1b", "surface-container-highest": "#e2e2e3", "surface-variant": "#e2e2e3", "background": "#f9f9fa", "tertiary-fixed": "#e2e2e2", "secondary-container": "#e4e1e5", "on-primary-container": "#858387", "on-background": "#1a1c1d", "tertiary-fixed-dim": "#c6c6c6", "error": "#ba1a1a", "surface-bright": "#f9f9fb", "primary-fixed-dim": "#c6c6c6", "outline-variant": "#cfc4c5", "surface-tint": "#5f5e61", "secondary-fixed-dim": "#c8c6c9", "on-primary-fixed-variant": "#474747", "surface": "#f9f9fb", "on-secondary-fixed": "#1b1b1e", "on-secondary-fixed-variant": "#474649", "tertiary": "#000000" }, "borderRadius": { "DEFAULT": "0.125rem", "lg": "0.25rem", "xl": "0.5rem", "full": "0.75rem" }, "spacing": { "margin": "1.5rem", "space-md": "0.75rem", "gutter": "1rem", "space-xl": "2rem", "space-lg": "1.25rem", "space-sm": "0.5rem", "space-xs": "0.25rem" }, "fontFamily": { "body-md": ["Geist", "sans-serif"], "headline-lg": ["Geist", "sans-serif"], "label-sm": ["Geist", "sans-serif"], "body-sm": ["Geist", "sans-serif"], "headline-md": ["Geist", "sans-serif"], "headline-xl": ["Geist", "sans-serif"], "body-lg": ["Geist", "sans-serif"], "label-mono": ["JetBrains Mono", "monospace"], "label-md": ["Geist", "sans-serif"] }, "fontSize": { "body-md": ["13px", { "lineHeight": "19px", "letterSpacing": "-0.005em", "fontWeight": "400" }], "headline-lg": ["24px", { "lineHeight": "30px", "letterSpacing": "-0.025em", "fontWeight": "600" }], "label-sm": ["11px", { "lineHeight": "14px", "letterSpacing": "0.02em", "fontWeight": "500" }], "body-sm": ["12px", { "lineHeight": "16px", "letterSpacing": "0em", "fontWeight": "400" }], "headline-md": ["18px", { "lineHeight": "24px", "letterSpacing": "-0.015em", "fontWeight": "500" }], "headline-xl": ["32px", { "lineHeight": "38px", "letterSpacing": "-0.03em", "fontWeight": "600" }], "body-lg": ["15px", { "lineHeight": "22px", "letterSpacing": "-0.01em", "fontWeight": "400" }], "label-mono": ["11px", { "lineHeight": "14px", "letterSpacing": "-0.01em", "fontWeight": "400" }], "label-md": ["12px", { "lineHeight": "16px", "letterSpacing": "0.01em", "fontWeight": "500" }] } } } };

(function () {
(function() {
    const input = document.getElementById('search-input');
    const clearBtn = document.getElementById('clear-search-btn');
    const clearAllQueries = document.getElementById('clear-all-queries');
    const recentBay = document.getElementById('recent-queries-bay');
    const filterChips = document.querySelectorAll('.filter-chip');

    // Input clearing micro-interaction
    if (clearBtn && input) {
      clearBtn.addEventListener('click', () => {
        input.value = '';
        input.focus();
      });
    }

    // Clear all recent queries
    if (clearAllQueries && recentBay) {
      clearAllQueries.addEventListener('click', () => {
        recentBay.innerHTML = '<span class="font-body-sm text-body-sm text-secondary italic py-1">No recent searches recorded</span>';
      });
    }

    // Toggle filter chip active states
    filterChips.forEach(chip => {
      chip.addEventListener('click', () => {
        filterChips.forEach(c => {
          c.classList.remove('bg-primary', 'text-on-primary', 'shadow-sm');
          c.classList.add('bg-surface-container-high', 'text-on-surface-variant');
        });
        chip.classList.remove('bg-surface-container-high', 'text-on-surface-variant');
        chip.classList.add('bg-primary', 'text-on-primary', 'shadow-sm');
      });
    });
  })();
})();
