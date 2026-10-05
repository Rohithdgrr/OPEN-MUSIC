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
        "full": "0.75rem"
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

(function () {
  // Play/Pause Micro-interaction
  const playBtn = document.getElementById('mainPlayBtn');
  const playIcon = document.getElementById('playIcon');
  let isPlaying = true;
  if (playBtn && playIcon) {
    playBtn.addEventListener('click', () => {
      isPlaying = !isPlaying;
      playIcon.textContent = isPlaying ? 'pause' : 'play_arrow';
    });
  }

  // Favorite Heart Toggle
  const favBtn = document.getElementById('favoriteBtn');
  const favIcon = document.getElementById('favoriteIcon');
  let isFav = false;
  if (favBtn && favIcon) {
    favBtn.addEventListener('click', () => {
      isFav = !isFav;
      favIcon.style.fontVariationSettings = isFav ? "'FILL' 1" : "'FILL' 0";
      favIcon.classList.toggle('text-error', isFav);
    });
  }

  // Copy Join URI
  const copyBtn = document.getElementById('copyUriBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const originalContent = copyBtn.innerHTML;
      copyBtn.innerHTML = '<span class="material-symbols-outlined text-[12px] text-on-tertiary-container">check</span><span class="font-label-sm text-[9px] tracking-wide uppercase font-semibold text-on-tertiary-container">Copied</span>';
      setTimeout(() => {
        copyBtn.innerHTML = originalContent;
      }, 1500);
    });
  }
})();

(function () {
  // Solo vs Social Mode Toggle
  let isSocialMode = true;
  const modeToggleBtn = document.getElementById('modeToggleBtn');
  const headerSubtitle = document.getElementById('headerSubtitle');
  const headerTitle = document.getElementById('headerTitle');
  const headerModeDot = document.getElementById('headerModeDot');
  const jamSessionBanner = document.getElementById('jamSessionBanner');
  const artworkCollabTag = document.getElementById('artworkCollabTag');
  const skipVoteBadge = document.getElementById('skipVoteBadge');
  const chatTabBtn = document.getElementById('chatTabBtn');
  const jamDataTabBtn = document.getElementById('jamDataTabBtn');
  const queueSyncBadge = document.getElementById('queueSyncBadge');
  const queueHeaderLabel = document.getElementById('queueHeaderLabel');

  function applyMode(social) {
    isSocialMode = social;
    if (isSocialMode) {
      headerSubtitle.textContent = 'PLAYING FROM JAM';
      headerTitle.textContent = 'Late Night Resonance (Social Jam)';
      headerModeDot.className = 'w-1.5 h-1.5 rounded-full bg-on-tertiary-container animate-pulse shrink-0';
      if (jamSessionBanner) jamSessionBanner.classList.remove('hidden');
      if (artworkCollabTag) artworkCollabTag.textContent = 'COLLAB QUEUE';
      if (skipVoteBadge) skipVoteBadge.classList.remove('hidden');
      if (chatTabBtn) chatTabBtn.classList.remove('hidden');
      if (jamDataTabBtn) jamDataTabBtn.classList.remove('hidden');
      if (queueSyncBadge) queueSyncBadge.classList.remove('hidden');
      if (queueHeaderLabel) queueHeaderLabel.textContent = 'COLLABORATIVE QUEUE';
    } else {
      headerSubtitle.textContent = 'PLAYING FROM PLAYLIST';
      headerTitle.textContent = 'Late Night Resonance (Solo)';
      headerModeDot.className = 'w-1.5 h-1.5 rounded-full bg-secondary shrink-0';
      if (jamSessionBanner) jamSessionBanner.classList.add('hidden');
      if (artworkCollabTag) artworkCollabTag.textContent = 'SOLO PLAYBACK';
      if (skipVoteBadge) skipVoteBadge.classList.add('hidden');
      if (chatTabBtn) chatTabBtn.classList.add('hidden');
      if (jamDataTabBtn) jamDataTabBtn.classList.add('hidden');
      if (queueSyncBadge) queueSyncBadge.classList.add('hidden');
      if (queueHeaderLabel) queueHeaderLabel.textContent = 'PERSONAL QUEUE';

      // If current tab was chat or jam-data, fallback to queue
      const activeTab = document.querySelector('.tab-btn.bg-primary')?.getAttribute('data-tab');
      if (activeTab === 'chat' || activeTab === 'jam-data') {
        switchTab('queue');
      }
    }
  }

  if (modeToggleBtn) {
    modeToggleBtn.addEventListener('click', () => {
      applyMode(!isSocialMode);
    });
  }
})();

function switchTab(targetTab) {
  const tabs = ['queue', 'chat', 'jam-data', 'lyrics'];
  tabs.forEach(tab => {
    const view = document.getElementById('view-' + tab);
    const btn = document.querySelector(`[data-tab="${tab}"]`);
    if (tab === targetTab) {
      if (view) view.classList.remove('hidden');
      if (btn) {
        btn.className = 'tab-btn flex-1 bg-primary text-on-primary py-1 px-1.5 rounded-full font-label-md text-[11px] font-medium flex items-center justify-center gap-1 shadow-xs whitespace-nowrap transition-all';
      }
    } else {
      if (view) view.classList.add('hidden');
      if (btn) {
        btn.className = 'tab-btn flex-1 text-on-surface-variant hover:text-on-surface py-1 px-1.5 rounded-full font-label-md text-[11px] font-medium flex items-center justify-center gap-1 whitespace-nowrap transition-colors';
      }
    }
  });
}
