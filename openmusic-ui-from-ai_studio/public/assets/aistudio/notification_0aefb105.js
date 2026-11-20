// generated from design/screens/mobile/notification/code.html — do not edit

/* global tailwind */

document.body.className = "bg-surface text-on-surface font-body-md text-body-md flex flex-col min-h-screen antialiased";

tailwind.config = { darkMode: "class", theme: { extend: { colors: { "on-secondary": "#ffffff", "inverse-surface": "#2f3132", "error-container": "#ffdad6", "on-primary-fixed": "#1b1b1b", "secondary-fixed": "#e4e1e5", "background": "#f9f9fa", "surface": "#f9f9fb", "surface-bright": "#f9f9fb", "surface-tint": "#5e5e5e", "secondary-fixed-dim": "#c8c6c9", "on-surface": "#1a1c1d", "error": "#ba1a1a", "on-secondary-container": "#656467", "surface-container": "#eeeeef", "surface-container-low": "#f3f3f4", "primary": "#000000", "tertiary-fixed": "#e2e2e2", "on-secondary-fixed": "#1b1b1e", "surface-variant": "#e2e2e3", "surface-container-lowest": "#ffffff", "on-primary-fixed-variant": "#474747", "primary-fixed": "#e2e2e2", "surface-container-highest": "#e2e2e4", "on-secondary-fixed-variant": "#474649", "tertiary": "#000000", "surface-dim": "#dadadb", "on-surface-variant": "#4c4546", "on-tertiary-fixed": "#1b1b1b", "secondary": "#5f5e61", "on-tertiary-container": "#848484", "on-background": "#1a1c1d", "primary-container": "#1b1b1e", "on-error-container": "#93000a", "on-tertiary": "#ffffff", "surface-container-high": "#e8e8e9", "on-primary": "#ffffff", "inverse-primary": "#c6c6c6", "tertiary-container": "#1b1b1b", "on-primary-container": "#858387", "outline": "#77767b", "inverse-on-surface": "#f1f1f1", "primary-fixed-dim": "#c6c6c6", "on-error": "#ffffff", "secondary-container": "#e4e1e5", "on-tertiary-fixed-variant": "#474747", "tertiary-fixed-dim": "#c6c6c6", "outline-variant": "#cfc4c5" }, borderRadius: { "DEFAULT": "0.125rem", "lg": "0.25rem", "xl": "0.5rem", "full": "0.75rem" }, spacing: { "gutter": "1rem", "space-xl": "2rem", "margin": "1.5rem", "space-xs": "0.25rem", "space-lg": "1.25rem", "space-md": "0.75rem", "space-sm": "0.5rem" }, fontFamily: { "body-lg": ["Geist"], "headline-md": ["Geist"], "label-mono": ["JetBrains Mono"], "label-md": ["Geist"], "body-md": ["Geist"], "body-sm": ["Geist"], "headline-xl": ["Geist"], "label-sm": ["Geist"], "headline-lg": ["Geist"] }, fontSize: { "body-lg": ["15px", { "lineHeight": "22px", "letterSpacing": "-0.01em", "fontWeight": "400" }], "headline-md": ["18px", { "lineHeight": "24px", "letterSpacing": "-0.015em", "fontWeight": "500" }], "label-mono": ["11px", { "lineHeight": "14px", "letterSpacing": "-0.01em", "fontWeight": "400" }], "label-md": ["12px", { "lineHeight": "16px", "letterSpacing": "0.01em", "fontWeight": "500" }], "body-md": ["13px", { "lineHeight": "19px", "letterSpacing": "-0.005em", "fontWeight": "400" }], "body-sm": ["12px", { "lineHeight": "16px", "letterSpacing": "0em", "fontWeight": "400" }], "headline-xl": ["32px", { "lineHeight": "38px", "letterSpacing": "-0.03em", "fontWeight": "600" }], "label-sm": ["11px", { "lineHeight": "14px", "letterSpacing": "0.02em", "fontWeight": "500" }], "headline-lg": ["24px", { "lineHeight": "30px", "letterSpacing": "-0.025em", "fontWeight": "600" }] } } } };

(function () {
// Filter interaction
  const pills = document.querySelectorAll('.filter-pill');
  const cards = document.querySelectorAll('.notification-card');
  const groups = document.querySelectorAll('.notification-group');

  pills.forEach(pill => {
    pill.addEventListener('click', () => {
      // Toggle pill styles
      pills.forEach(p => {
        p.classList.remove('bg-primary', 'text-on-primary', 'shadow-sm');
        p.classList.add('bg-surface-container-low', 'text-on-surface');
      });
      pill.classList.remove('bg-surface-container-low', 'text-on-surface');
      pill.classList.add('bg-primary', 'text-on-primary', 'shadow-sm');

      const filter = pill.dataset.category;

      cards.forEach(card => {
        if (filter === 'all' || card.dataset.type === filter) {
          card.style.display = 'block';
        } else {
          card.style.display = 'none';
        }
      });

      // Hide empty groups
      groups.forEach(group => {
        const visibleCards = group.querySelectorAll('.notification-card[style="display: block;"], .notification-card:not([style*="display: none"])');
        let anyVisible = false;
        cards.forEach(c => {
          if (group.contains(c) && c.style.display !== 'none') anyVisible = true;
        });
        group.style.display = anyVisible ? 'flex' : 'none';
      });
    });
  });

  // Mark all as read micro-interaction
  const markReadBtn = document.getElementById('markAllReadBtn');
  markReadBtn.addEventListener('click', () => {
    const dots = document.querySelectorAll('.status-dot');
    dots.forEach(dot => {
      dot.style.opacity = '0';
      setTimeout(() => dot.remove(), 200);
    });
    markReadBtn.innerHTML = `
      <span class="material-symbols-outlined text-[16px]">check</span>
      <span class="font-label-md text-label-md">All read</span>
    `;
    markReadBtn.classList.add('opacity-50', 'pointer-events-none');
  });
})();
