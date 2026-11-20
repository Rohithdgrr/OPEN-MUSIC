// generated from design/screens/mobile/main-library/code.html — do not edit

/* global tailwind */

document.body.className = "bg-surface text-on-surface font-body-md text-body-md flex flex-col min-h-screen antialiased";

tailwind.config = { darkMode: "class", theme: { extend: { colors: { "on-secondary": "#ffffff", "inverse-surface": "#2f3132", "error-container": "#ffdad6", "on-primary-fixed": "#1b1b1b", "secondary-fixed": "#e4e1e5", "background": "#f9f9fa", "surface": "#f9f9fb", "surface-bright": "#f9f9fb", "surface-tint": "#5e5e5e", "secondary-fixed-dim": "#c8c6c9", "on-surface": "#1a1c1d", "error": "#ba1a1a", "on-secondary-container": "#656467", "surface-container": "#eeeeef", "surface-container-low": "#f3f3f4", "primary": "#000000", "tertiary-fixed": "#e2e2e2", "on-secondary-fixed": "#1b1b1e", "surface-variant": "#e2e2e3", "surface-container-lowest": "#ffffff", "on-primary-fixed-variant": "#474747", "primary-fixed": "#e2e2e2", "surface-container-highest": "#e2e2e4", "on-secondary-fixed-variant": "#474649", "tertiary": "#000000", "surface-dim": "#dadadb", "on-surface-variant": "#4c4546", "on-tertiary-fixed": "#1b1b1b", "secondary": "#5f5e61", "on-tertiary-container": "#848484", "on-background": "#1a1c1d", "primary-container": "#1b1b1e", "on-error-container": "#93000a", "on-tertiary": "#ffffff", "surface-container-high": "#e8e8e9", "on-primary": "#ffffff", "inverse-primary": "#c6c6c6", "tertiary-container": "#1b1b1b", "on-primary-container": "#858387", "outline": "#77767b", "inverse-on-surface": "#f1f1f1", "primary-fixed-dim": "#c6c6c6", "on-error": "#ffffff", "secondary-container": "#e4e1e5", "on-tertiary-fixed-variant": "#474747", "tertiary-fixed-dim": "#c6c6c6", "outline-variant": "#cfc4c5" }, borderRadius: { "DEFAULT": "0.125rem", "lg": "0.25rem", "xl": "0.5rem", "full": "0.75rem" }, spacing: { "gutter": "1rem", "space-xl": "2rem", "margin": "1.5rem", "space-xs": "0.25rem", "space-lg": "1.25rem", "space-md": "0.75rem", "space-sm": "0.5rem" }, fontFamily: { "body-lg": ["Geist"], "headline-md": ["Geist"], "label-mono": ["JetBrains Mono"], "label-md": ["Geist"], "body-md": ["Geist"], "body-sm": ["Geist"], "headline-xl": ["Geist"], "label-sm": ["Geist"], "headline-lg": ["Geist"] }, fontSize: { "body-lg": ["15px", { "lineHeight": "22px", "letterSpacing": "-0.01em", "fontWeight": "400" }], "headline-md": ["18px", { "lineHeight": "24px", "letterSpacing": "-0.015em", "fontWeight": "500" }], "label-mono": ["11px", { "lineHeight": "14px", "letterSpacing": "-0.01em", "fontWeight": "400" }], "label-md": ["12px", { "lineHeight": "16px", "letterSpacing": "0.01em", "fontWeight": "500" }], "body-md": ["13px", { "lineHeight": "19px", "letterSpacing": "-0.005em", "fontWeight": "400" }], "body-sm": ["12px", { "lineHeight": "16px", "letterSpacing": "0em", "fontWeight": "400" }], "headline-xl": ["32px", { "lineHeight": "38px", "letterSpacing": "-0.03em", "fontWeight": "600" }], "label-sm": ["11px", { "lineHeight": "14px", "letterSpacing": "0.02em", "fontWeight": "500" }], "headline-lg": ["24px", { "lineHeight": "30px", "letterSpacing": "-0.025em", "fontWeight": "600" }] } } } };

(function () {
let currentSort = 'recent';
  let currentView = 'list';
  let activeFilter = 'all';

  function toggleLibrarySearch() {
    const searchBar = document.getElementById('librarySearchBar');
    const input = document.getElementById('filterInput');
    if (searchBar.classList.contains('hidden')) {
      searchBar.classList.remove('hidden');
      input.focus();
    } else {
      searchBar.classList.add('hidden');
      input.value = '';
      filterLibraryList('');
    }
  }

  function clearLibrarySearch() {
    const input = document.getElementById('filterInput');
    input.value = '';
    filterLibraryList('');
    document.getElementById('librarySearchBar').classList.add('hidden');
  }

  function filterLibraryList(query) {
    const term = query.toLowerCase().trim();
    const items = document.querySelectorAll('.library-item');
    let visibleCount = 0;

    items.forEach(item => {
      const title = item.getAttribute('data-title').toLowerCase();
      const category = item.getAttribute('data-category');
      const isDownloaded = item.getAttribute('data-downloaded') === 'true';

      let matchesFilter = (activeFilter === 'all') || 
                          (activeFilter === 'downloaded' && isDownloaded) || 
                          (activeFilter === category);

      let matchesSearch = !term || title.includes(term);

      if (matchesFilter && matchesSearch) {
        item.classList.remove('hidden');
        visibleCount++;
      } else {
        item.classList.add('hidden');
      }
    });

    const emptyState = document.getElementById('libraryEmptyState');
    if (visibleCount === 0) {
      emptyState.classList.remove('hidden');
      emptyState.classList.add('flex');
    } else {
      emptyState.classList.add('hidden');
      emptyState.classList.remove('flex');
    }
  }

  function setActiveFilter(btn, category) {
    activeFilter = category;
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.classList.remove('bg-primary', 'text-on-primary');
      chip.classList.add('bg-surface-container', 'text-on-surface-variant');
    });
    btn.classList.add('bg-primary', 'text-on-primary');
    btn.classList.remove('bg-surface-container', 'text-on-surface-variant');

    const searchInput = document.getElementById('filterInput');
    filterLibraryList(searchInput ? searchInput.value : '');
  }

  function toggleSortMode() {
    const sortLabel = document.getElementById('currentSortLabel');
    if (currentSort === 'recent') {
      currentSort = 'alpha';
      sortLabel.textContent = 'Alphabetical';
    } else {
      currentSort = 'recent';
      sortLabel.textContent = 'Recently played';
    }
    showToast(`Sorted by ${sortLabel.textContent}`);
    sortItems(currentSort);
  }

  function cycleSort() {
    toggleSortMode();
  }

  function sortItems(mode) {
    const container = document.getElementById('libraryContainer');
    const items = Array.from(container.children);
    
    items.sort((a, b) => {
      if (mode === 'alpha') {
        return a.getAttribute('data-title').localeCompare(b.getAttribute('data-title'));
      } else {
        return 0; // Natural sequence
      }
    });

    items.forEach(item => container.appendChild(item));
  }

  function setViewMode(mode) {
    currentView = mode;
    const container = document.getElementById('libraryContainer');
    const gridBtn = document.getElementById('viewGridBtn');
    const listBtn = document.getElementById('viewListBtn');

    if (mode === 'grid') {
      container.className = 'grid grid-cols-2 gap-space-sm transition-all duration-200';
      gridBtn.classList.add('text-primary', 'bg-surface-container');
      gridBtn.classList.remove('text-secondary');
      listBtn.classList.remove('text-primary', 'bg-surface-container');
      listBtn.classList.add('text-secondary');
    } else {
      container.className = 'flex flex-col gap-space-xs transition-all duration-200';
      listBtn.classList.add('text-primary', 'bg-surface-container');
      listBtn.classList.remove('text-secondary');
      gridBtn.classList.remove('text-primary', 'bg-surface-container');
      gridBtn.classList.add('text-secondary');
    }
  }

  function openItemMenu(event, title) {
    event.stopPropagation();
    document.getElementById('sheetItemTitle').textContent = title;
    const sheet = document.getElementById('actionBottomSheet');
    sheet.classList.remove('hidden');
    sheet.classList.add('flex');
  }

  function closeItemMenu() {
    const sheet = document.getElementById('actionBottomSheet');
    sheet.classList.add('hidden');
    sheet.classList.remove('flex');
  }

  function handleMenuAction(action) {
    closeItemMenu();
    if (action === 'play_next') showToast('Added to play next');
    if (action === 'download') showToast('Downloading for offline playback...');
    if (action === 'edit') showToast('Editing metadata...');
    if (action === 'share') showToast('Share link copied');
    if (action === 'remove') showToast('Removed from your library');
  }

  function promptCreatePlaylist() {
    const name = prompt('Playlist name:', 'New Mood Session');
    if (name) {
      showToast(`Created "${name}"`);
    }
  }

  function showToast(message) {
    const toast = document.getElementById('toastNotification');
    const toastMessage = document.getElementById('toastMessage');
    toastMessage.textContent = message;
    toast.classList.remove('opacity-0', '-translate-y-4');
    toast.classList.add('opacity-100', 'translate-y-0');

    setTimeout(() => {
      toast.classList.remove('opacity-100', 'translate-y-0');
      toast.classList.add('opacity-0', '-translate-y-4');
    }, 2400);
  }
})();
