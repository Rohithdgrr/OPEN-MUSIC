// generated from design/screens/mobile/download/code.html — do not edit

/* global tailwind */

document.body.className = "bg-surface text-on-surface font-body-md text-body-md flex flex-col min-h-screen antialiased";

tailwind.config = { darkMode: "class", theme: { extend: { colors: { "on-secondary": "#ffffff", "inverse-surface": "#2f3132", "error-container": "#ffdad6", "on-primary-fixed": "#1b1b1b", "secondary-fixed": "#e4e1e5", "background": "#f9f9fa", "surface": "#f9f9fb", "surface-bright": "#f9f9fb", "surface-tint": "#5e5e5e", "secondary-fixed-dim": "#c8c6c9", "on-surface": "#1a1c1d", "error": "#ba1a1a", "on-secondary-container": "#656467", "surface-container": "#eeeeef", "surface-container-low": "#f3f3f4", "primary": "#000000", "tertiary-fixed": "#e2e2e2", "on-secondary-fixed": "#1b1b1e", "surface-variant": "#e2e2e3", "surface-container-lowest": "#ffffff", "on-primary-fixed-variant": "#474747", "primary-fixed": "#e2e2e2", "surface-container-highest": "#e2e2e4", "on-secondary-fixed-variant": "#474649", "tertiary": "#000000", "surface-dim": "#dadadb", "on-surface-variant": "#4c4546", "on-tertiary-fixed": "#1b1b1b", "secondary": "#5f5e61", "on-tertiary-container": "#848484", "on-background": "#1a1c1d", "primary-container": "#1b1b1e", "on-error-container": "#93000a", "on-tertiary": "#ffffff", "surface-container-high": "#e8e8e9", "on-primary": "#ffffff", "inverse-primary": "#c6c6c6", "tertiary-container": "#1b1b1b", "on-primary-container": "#858387", "outline": "#77767b", "inverse-on-surface": "#f1f1f1", "primary-fixed-dim": "#c6c6c6", "on-error": "#ffffff", "secondary-container": "#e4e1e5", "on-tertiary-fixed-variant": "#474747", "tertiary-fixed-dim": "#c6c6c6", "outline-variant": "#cfc4c5" }, borderRadius: { "DEFAULT": "0.125rem", "lg": "0.25rem", "xl": "0.5rem", "full": "0.75rem" }, spacing: { "gutter": "1rem", "space-xl": "2rem", "margin": "1.5rem", "space-xs": "0.25rem", "space-lg": "1.25rem", "space-md": "0.75rem", "space-sm": "0.5rem" }, fontFamily: { "body-lg": ["Geist"], "headline-md": ["Geist"], "label-mono": ["JetBrains Mono"], "label-md": ["Geist"], "body-md": ["Geist"], "body-sm": ["Geist"], "headline-xl": ["Geist"], "label-sm": ["Geist"], "headline-lg": ["Geist"] }, fontSize: { "body-lg": ["15px", { "lineHeight": "22px", "letterSpacing": "-0.01em", "fontWeight": "400" }], "headline-md": ["18px", { "lineHeight": "24px", "letterSpacing": "-0.015em", "fontWeight": "500" }], "label-mono": ["11px", { "lineHeight": "14px", "letterSpacing": "-0.01em", "fontWeight": "400" }], "label-md": ["12px", { "lineHeight": "16px", "letterSpacing": "0.01em", "fontWeight": "500" }], "body-md": ["13px", { "lineHeight": "19px", "letterSpacing": "-0.005em", "fontWeight": "400" }], "body-sm": ["12px", { "lineHeight": "16px", "letterSpacing": "0em", "fontWeight": "400" }], "headline-xl": ["32px", { "lineHeight": "38px", "letterSpacing": "-0.03em", "fontWeight": "600" }], "label-sm": ["11px", { "lineHeight": "14px", "letterSpacing": "0.02em", "fontWeight": "500" }], "headline-lg": ["24px", { "lineHeight": "30px", "letterSpacing": "-0.025em", "fontWeight": "600" }] } } } };

(function () {
// Interactive micro-behavior for Wi-Fi toggle
  const wifiToggle = document.getElementById('wifiToggle');
  const wifiThumb = document.getElementById('wifiToggleThumb');
  let isWifiOnly = true;

  if (wifiToggle && wifiThumb) {
    wifiToggle.addEventListener('click', () => {
      isWifiOnly = !isWifiOnly;
      wifiToggle.setAttribute('aria-checked', isWifiOnly.toString());
      if (isWifiOnly) {
        wifiToggle.classList.remove('bg-surface-container-highest');
        wifiToggle.classList.add('bg-primary');
        wifiThumb.classList.remove('translate-x-0');
        wifiThumb.classList.add('translate-x-5');
      } else {
        wifiToggle.classList.remove('bg-primary');
        wifiToggle.classList.add('bg-surface-container-highest');
        wifiThumb.classList.remove('translate-x-5');
        wifiThumb.classList.add('translate-x-0');
      }
    });
  }

  // Interactive Filter Pills
  const filterPills = document.querySelectorAll('.filter-pill');
  filterPills.forEach(pill => {
    pill.addEventListener('click', () => {
      filterPills.forEach(p => {
        p.classList.remove('bg-primary', 'text-on-primary');
        p.classList.add('bg-surface-container-low', 'text-secondary');
      });
      pill.classList.remove('bg-surface-container-low', 'text-secondary');
      pill.classList.add('bg-primary', 'text-on-primary');
    });
  });

  // Sync refresh animation
  const refreshBtn = document.getElementById('refreshSyncBtn');
  const syncIcon = document.getElementById('syncIcon');
  if (refreshBtn && syncIcon) {
    refreshBtn.addEventListener('click', () => {
      syncIcon.classList.add('rotate-180');
      setTimeout(() => {
        syncIcon.classList.remove('rotate-180');
      }, 700);
    });
  }
})();
