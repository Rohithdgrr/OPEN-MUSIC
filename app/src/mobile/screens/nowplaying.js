// generated from design/screens/mobile/nowplaying/code.html — do not edit

/* global tailwind */

document.body.className = "bg-surface text-on-surface antialiased flex flex-col min-h-screen selection:bg-black selection:text-white";

tailwind.config = { darkMode: "class", theme: { extend: { colors: { "surface-dim": "#dadadb", "primary-fixed-dim": "#c6c6c6", "on-surface-variant": "#4c4546", "on-primary": "#ffffff", "on-surface": "#1a1c1d", "on-tertiary-fixed": "#1b1b1b", "on-secondary-container": "#656467", "on-secondary": "#ffffff", "primary": "#000000", "surface-container-low": "#f3f3f4", "on-secondary-fixed-variant": "#474649", "on-background": "#1a1c1d", "surface": "#f9f9fb", "secondary-fixed-dim": "#c8c6c9", "surface-container-lowest": "#ffffff", "on-primary-fixed-variant": "#474747", "inverse-on-surface": "#f0f0f2", "surface-container": "#eeeef0", "on-error": "#ffffff", "primary-container": "#1b1b1b", "secondary-container": "#e4e1e5", "tertiary": "#000000", "error": "#ba1a1a", "on-primary-container": "#848484", "outline-variant": "#c8c5cb", "surface-bright": "#f9f9fb", "tertiary-fixed-dim": "#c6c6c6", "on-secondary-fixed": "#1b1b1e", "surface-tint": "#5e5e5e", "surface-container-highest": "#e2e2e4", "tertiary-container": "#1b1b1b", "background": "#f9f9fa", "secondary-fixed": "#e4e1e5", "on-tertiary-fixed-variant": "#474747", "surface-variant": "#e2e2e3", "surface-container-high": "#e8e8ea", "outline": "#77767b", "on-tertiary-container": "#848484", "tertiary-fixed": "#e2e2e2", "inverse-primary": "#c6c6c6", "secondary": "#5f5e61", "primary-fixed": "#e2e2e2", "on-error-container": "#93000a", "on-tertiary": "#ffffff", "on-primary-fixed": "#1b1b1b", "error-container": "#ffdad6", "inverse-surface": "#2f3132" }, borderRadius: { "DEFAULT": "0.125rem", "lg": "0.25rem", "xl": "0.5rem", "full": "0.75rem" }, spacing: { "margin": "1.25rem", "space-xl": "2rem", "space-xs": "0.25rem", "space-sm": "0.5rem", "gutter": "1rem", "space-md": "0.75rem", "space-lg": "1.25rem" }, fontFamily: { "body-sm": ["Geist"], "label-md": ["Geist"], "headline-xl": ["Geist"], "label-sm": ["Geist"], "label-mono": ["JetBrains Mono"], "headline-lg": ["Geist"], "body-lg": ["Geist"], "headline-md": ["Geist"], "body-md": ["Geist"] }, fontSize: { "body-sm": ["12px", { lineHeight: "16px", letterSpacing: "0em", fontWeight: "400" }], "label-md": ["12px", { lineHeight: "16px", letterSpacing: "0.01em", fontWeight: "500" }], "headline-xl": ["32px", { lineHeight: "38px", letterSpacing: "-0.03em", fontWeight: "600" }], "label-sm": ["11px", { lineHeight: "14px", letterSpacing: "0.02em", fontWeight: "500" }], "label-mono": ["11px", { lineHeight: "14px", letterSpacing: "-0.01em", fontWeight: "400" }], "headline-lg": ["22px", { lineHeight: "28px", letterSpacing: "-0.02em", fontWeight: "600" }], "body-lg": ["15px", { lineHeight: "22px", letterSpacing: "-0.01em", fontWeight: "400" }], "headline-md": ["18px", { lineHeight: "24px", letterSpacing: "-0.015em", fontWeight: "500" }], "body-md": ["13px", { lineHeight: "19px", letterSpacing: "-0.005em", fontWeight: "400" }] } } } };

(function () {
(function() {
    // Play/Pause master button
    const playPauseBtn = document.getElementById('master-play-pause');
    const playPauseIcon = document.getElementById('play-pause-icon');
    let isPlaying = true;

    if (playPauseBtn && playPauseIcon) {
      playPauseBtn.addEventListener('click', function() {
        isPlaying = !isPlaying;
        playPauseIcon.textContent = isPlaying ? 'pause' : 'play_arrow';
      });
    }

    // Favorite heart toggle
    const favBtn = document.getElementById('favorite-btn');
    const favIcon = document.getElementById('favorite-icon');
    let isFav = false;
    if (favBtn && favIcon) {
      favBtn.addEventListener('click', function() {
        isFav = !isFav;
        favIcon.textContent = isFav ? 'favorite' : 'favorite_border';
        favIcon.style.fontVariationSettings = isFav ? "'FILL' 1" : "'FILL' 0";
        if (isFav) {
          favIcon.classList.add('text-error');
        } else {
          favIcon.classList.remove('text-error');
        }
      });
    }

    // Scrubber interaction
    const scrubber = document.getElementById('scrubber-container');
    const progressBar = document.getElementById('scrubber-bar');
    const needle = document.getElementById('scrubber-needle');
    const elapsedLabel = document.getElementById('elapsed-time');
    const remainingLabel = document.getElementById('remaining-time');
    const totalDurationSeconds = 258; // 4:18

    function updateScrub(e) {
      const rect = scrubber.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clickX = Math.max(0, Math.min(clientX - rect.left, rect.width));
      const percentage = (clickX / rect.width) * 100;
      progressBar.style.width = percentage + '%';
      needle.style.left = 'calc(' + percentage + '% - 7px)';

      const currentSeconds = Math.floor((percentage / 100) * totalDurationSeconds);
      const remSeconds = totalDurationSeconds - currentSeconds;
      
      const curM = Math.floor(currentSeconds / 60);
      const curS = String(currentSeconds % 60).padStart(2, '0');
      elapsedLabel.textContent = curM + ':' + curS;

      const remM = Math.floor(remSeconds / 60);
      const remS = String(remSeconds % 60).padStart(2, '0');
      remainingLabel.textContent = '-' + remM + ':' + remS;
    }

    if (scrubber && progressBar && needle && elapsedLabel && remainingLabel) {
      let isDragging = false;
      scrubber.addEventListener('mousedown', function(e) {
        isDragging = true;
        updateScrub(e);
      });
      window.addEventListener('mousemove', function(e) {
        if (isDragging) updateScrub(e);
      });
      window.addEventListener('mouseup', function() {
        isDragging = false;
      });
      scrubber.addEventListener('touchstart', function(e) {
        isDragging = true;
        updateScrub(e);
      }, { passive: true });
      window.addEventListener('touchmove', function(e) {
        if (isDragging) updateScrub(e);
      }, { passive: true });
      window.addEventListener('touchend', function() {
        isDragging = false;
      });
    }

    // Shuffle & repeat: the real toggles live in binders.js (playerState is
    // the source of truth). The design's local boolean versions fought it —
    // every paint flipped the class back — so they are gone.
  })();
})();

(function () {
(function(){const headerShuffle=document.getElementById('header-shuffle-btn');const shuffleBtn=document.getElementById('shuffle-btn');if(headerShuffle&&shuffleBtn){headerShuffle.addEventListener('click',function(){shuffleBtn.click();});}const dlBtn=document.getElementById('download-btn');if(dlBtn){let dlState=false;dlBtn.addEventListener('click',function(){dlState=!dlState;const icon=dlBtn.querySelector('.material-symbols-outlined');if(icon){icon.textContent=dlState?'check':'download';icon.classList.toggle('text-primary',dlState);}});}})();
})();
