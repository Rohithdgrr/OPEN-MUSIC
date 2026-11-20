// OpenMusic pure HTML template renderers for all 17 screens + shell + modals (vanilla JS)
import {
  EQ_LABELS,
  EQ_PRESETS,
  GENRE_CARDS,
  escapeHtml,
  formatDurationLong,
  formatRelativeTime,
  formatTime,
  getGreeting,
  renderArtwork,
} from './data.js';

/* ============================================================================
 * SHARED FRAGMENTS
 * ========================================================================== */

function icon(name, { filled = false, size = 20, cls = '' } = {}) {
  return `<span class="material-symbols-outlined ${filled ? 'icon-filled' : ''} ${cls}" style="font-size:${size}px;" aria-hidden="true">${name}</span>`;
}

function renderTopBar({ title = '', showBack = true, narrow = false, rightHtml = '', brandMode = false }) {
  return `
    <header class="topbar ${narrow ? 'topbar-narrow' : ''}">
      <div class="topbar-inner">
        <div class="topbar-left">
          ${
            brandMode
              ? `<button class="brand-btn mobile-only" data-action="nav" data-route="home" aria-label="OpenMusic Home">
                   <span class="brand-mark">${icon('graphic_eq', { size: 18 })}</span>
                   <span class="brand-title">OpenMusic</span>
                 </button>
                 <span class="topbar-title desktop-only truncate">${escapeHtml(title)}</span>`
              : `${
                  showBack
                    ? `<button class="back-btn" data-action="back" aria-label="Go back" title="Go back">${icon('arrow_back', { size: 19 })}</button>`
                    : ''
                }
                 <h1 class="topbar-title truncate">${escapeHtml(title)}</h1>`
          }
        </div>
        <div class="topbar-right">${rightHtml}</div>
      </div>
    </header>
  `;
}

function renderVaultHeroArt(tracks, { iconName, code, label }) {
  const covers = tracks.filter((t) => t && t.artwork).slice(0, 4);
  return `
    <div class="vault-badge">
      ${
        covers.length > 0
          ? `<div class="vault-mosaic" aria-hidden="true">
               ${covers
                 .map(
                   (t) =>
                     `<img src="${escapeHtml(t.artwork)}" alt="" referrerpolicy="no-referrer" />`
                 )
                 .join('')}
             </div>`
          : ''
      }
      <div class="vault-scrim" aria-hidden="true"></div>
      <div class="vault-badge-top">
        <span class="vault-icon-pill">${icon(iconName, { filled: true, size: 28 })}</span>
        <span class="mono" style="font-size:11px;letter-spacing:0.12em;opacity:0.85;">${escapeHtml(code)}</span>
      </div>
      <div class="vault-badge-bottom">
        <span class="mono" style="font-size:11px;letter-spacing:0.16em;opacity:0.8;">OPENMUSIC ARCHIVE</span>
        <span style="font-size:22px;font-weight:800;letter-spacing:-0.02em;">${escapeHtml(label)}</span>
      </div>
    </div>
  `;
}

function renderWordSyncedLyrics(track, activeIdx, lineClass) {
  if (!track || !Array.isArray(track.lyrics)) return '';
  return track.lyrics
    .map((line, idx) => {
      const next = track.lyrics[idx + 1];
      const start = line.time;
      const rawEnd = next ? next.time : Math.min(track.duration, start + 10);
      const span = Math.max(1.2, (rawEnd - start) * 0.9);
      const words = line.text.trim().split(/\s+/).filter(Boolean);
      const weights = words.map((w) => Math.max(2, w.length) + 1.2);
      const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;

      let cursor = start;
      const wordsHtml = words
        .map((word, wIdx) => {
          const wDur = (weights[wIdx] / totalWeight) * span;
          const wStart = cursor;
          const wEnd = cursor + wDur;
          cursor = wEnd;
          return `<span class="lyric-word" data-w-start="${wStart.toFixed(3)}" data-w-end="${wEnd.toFixed(3)}">${escapeHtml(word)}</span>`;
        })
        .join(' ');

      const stateCls = idx === activeIdx ? 'active' : idx < activeIdx ? 'is-past' : '';
      return `
        <button class="${lineClass} ${stateCls}" data-lyric-idx="${idx}" data-action="seek-to" data-time="${line.time}">
          ${wordsHtml}
        </button>
      `;
    })
    .join('');
}

function renderTrackRow(
  store,
  track,
  {
    index = null,
    contextQueue = null,
    playlistId = null,
    showAlbum = false,
    trailingMeta = '',
    showRemoveDownload = false,
    subtitleOverride = '',
    showRank = false,
    rankDelta = '',
  } = {}
) {
  const current = store.getCurrentTrack();
  const isCurrent = current && current.id === track.id;
  const isPlayingHere = isCurrent && store.isPlaying;
  const liked = store.isLiked(track.id);
  const downloaded = store.isDownloaded(track.id);
  const queueAttr = contextQueue ? `data-queue="${escapeHtml(contextQueue.join(','))}"` : '';
  const staggerAttr = typeof index === 'number' ? `style="--stagger-i:${Math.min(index, 10)};"` : '';

  const deltaClass = rankDelta.startsWith('▲')
    ? 'is-up'
    : rankDelta.startsWith('▼')
      ? 'is-down'
      : rankDelta === 'NEW'
        ? 'is-new'
        : 'is-flat';

  return `
    <div class="song-row stagger-item ${isCurrent ? 'is-current' : ''}" ${staggerAttr}>
      ${
        showRank && typeof index === 'number'
          ? `<div class="chart-rank-col" aria-label="Rank ${index + 1}">
               <span class="chart-rank-num ${index < 3 ? 'is-top' : ''}">${String(index + 1).padStart(2, '0')}</span>
               ${rankDelta ? `<span class="chart-delta ${deltaClass}">${escapeHtml(rankDelta)}</span>` : ''}
             </div>`
          : `<span class="np-grip" aria-hidden="true">${icon('drag_indicator', { size: 17 })}</span>`
      }
      <button class="list-row-main" style="gap:11px;" data-action="${isCurrent ? 'toggle-play' : 'play-track'}" data-track-id="${escapeHtml(track.id)}" ${queueAttr}>
        ${renderArtwork({
          src: track.artwork,
          alt: track.title,
          seed: track.artworkSeed,
          size: '52px',
          round: 'round-sm',
          playing: isPlayingHere,
        })}
        <div style="min-width:0;flex:1;">
          <div class="list-row-title truncate">${escapeHtml(track.title)}</div>
          <div class="list-row-sub truncate">
            ${
              subtitleOverride
                ? escapeHtml(subtitleOverride)
                : `${escapeHtml(track.artistName)}${showAlbum ? ` · ${escapeHtml(track.albumTitle)}` : ` · ${track.year}`}`
            }
            ${track.hiRes ? `<span class="tag-mono">HI-RES</span>` : ''}
            ${downloaded && !showRemoveDownload ? `<span class="tag-mono">OFFLINE</span>` : ''}
          </div>
        </div>
      </button>
      <div class="song-row-right">
        ${trailingMeta ? `<span class="section-meta song-meta-extra">${escapeHtml(trailingMeta)}</span>` : ''}
        <span class="section-meta song-duration">${formatTime(track.duration)}</span>
        <button class="icon-btn icon-btn-sm song-act-secondary ${liked ? 'icon-btn-accent' : ''}" data-action="toggle-like" data-track-id="${escapeHtml(track.id)}" aria-label="${liked ? 'Unlike' : 'Like'} ${escapeHtml(track.title)}">
          ${icon('favorite', { filled: liked, size: 17 })}
        </button>
        ${
          playlistId
            ? `<button class="icon-btn icon-btn-sm" data-action="remove-from-playlist" data-playlist-id="${escapeHtml(playlistId)}" data-track-id="${escapeHtml(track.id)}" aria-label="Remove from playlist">${icon('remove_circle_outline', { size: 17 })}</button>`
            : ''
        }
        ${
          showRemoveDownload
            ? `<button class="icon-btn icon-btn-sm" data-action="remove-download" data-track-id="${escapeHtml(track.id)}" aria-label="Remove offline copy">${icon('delete_outline', { size: 17 })}</button>`
            : `<button class="icon-btn icon-btn-sm song-act-more" data-action="open-track-menu" data-track-id="${escapeHtml(track.id)}" aria-label="More options for ${escapeHtml(track.title)}">${icon('more_horiz', { size: 18 })}</button>`
        }
        <button class="np-queue-play" data-action="${isCurrent ? 'toggle-play' : 'play-track'}" data-track-id="${escapeHtml(track.id)}" ${queueAttr} aria-label="${isPlayingHere ? 'Pause' : 'Play'} ${escapeHtml(track.title)}">
          ${icon(isPlayingHere ? 'pause' : 'play_arrow', { filled: true, size: 18 })}
        </button>
      </div>
    </div>
  `;
}

/* ============================================================================
 * DESKTOP SIDEBAR, DESKTOP DOCK, MOBILE CHROME
 * ========================================================================== */

export function renderSidebar(store) {
  const route = store.getRoute();
  const unread = store.getUnreadCount();

  const navItem = (routeName, label, iconName, badge = '') => `
    <button class="nav-item ${route.name === routeName ? 'active' : ''}" data-action="nav" data-route="${routeName}">
      <span class="nav-item-left">
        ${icon(iconName, { filled: route.name === routeName, size: 19 })}
        <span class="truncate">${escapeHtml(label)}</span>
      </span>
      ${badge ? `<span class="section-meta" style="color:inherit;opacity:0.85;">${escapeHtml(badge)}</span>` : ''}
    </button>
  `;

  return `
    <div class="sidebar-head">
      <button class="brand-btn" data-action="nav" data-route="home">
        <span class="brand-mark">${icon('graphic_eq', { size: 19 })}</span>
        <span class="brand-title">OpenMusic</span>
      </button>
      <button class="icon-btn icon-btn-sm" data-action="nav" data-route="notifications" aria-label="Notifications">
        ${icon('notifications', { size: 19 })}
        ${unread > 0 ? `<span class="unread-dot"></span>` : ''}
      </button>
    </div>

    <nav class="sidebar-nav no-scrollbar">
      ${navItem('home', 'Home', 'home')}
      ${navItem('search', 'Search', 'search')}
      ${navItem('library', 'Your Library', 'library_music')}
      ${navItem('charts', 'Global Charts', 'leaderboard')}

      <div class="sidebar-divider">
        <div class="sidebar-section-head"><span>VAULT &amp; TELEMETRY</span></div>
        ${navItem('liked-songs', 'Liked Songs', 'favorite', String(store.likedTrackIds.length))}
        ${navItem('downloads', 'Offline Vault', 'download_done', String(store.downloadedTrackIds.length))}
        ${navItem('history', 'Listening History', 'history')}
        ${navItem('analytics', 'Listening Insights', 'monitoring')}
        ${navItem('settings', 'Settings', 'tune')}
      </div>

      <div class="sidebar-divider">
        <div class="sidebar-section-head">
          <span>PLAYLISTS</span>
          <button class="icon-btn icon-btn-sm" style="width:26px;height:26px;" data-action="open-create-playlist" aria-label="Create playlist">
            ${icon('add', { size: 16 })}
          </button>
        </div>
        ${store.playlists
          .map(
            (pl) => `
          <button class="sidebar-playlist-btn ${route.name === 'playlist' && route.id === pl.id ? 'active' : ''}" data-action="nav" data-route="playlist" data-id="${escapeHtml(pl.id)}">
            ${renderArtwork({ src: pl.artwork, alt: pl.title, seed: pl.artworkSeed, size: '24px', round: 'round-sm' })}
            <span class="truncate">${escapeHtml(pl.title)}</span>
          </button>
        `
          )
          .join('')}
      </div>
    </nav>

    <div class="sidebar-jam-foot">
      <button class="sidebar-jam-card" data-action="open-jam">
        <div style="display:flex;align-items:center;gap:10px;min-width:0;">
          <span class="shortcut-icon ${store.jam.active ? 'tint-emerald' : 'tint-indigo'}" style="width:32px;height:32px;border-radius:10px;">
            ${icon('podcasts', { size: 17 })}
          </span>
          <div style="min-width:0;">
            <div style="font-size:12.5px;font-weight:700;" class="truncate">${store.jam.active ? `Jam · ${escapeHtml(store.jam.code)}` : 'Start a Jam Room'}</div>
            <div style="font-size:11px;color:var(--secondary);" class="truncate">${store.jam.active ? `${store.jam.listeners.length} synced · ${store.jam.driftMs}ms` : 'Listen live with friends'}</div>
          </div>
        </div>
        ${icon('chevron_right', { size: 18 })}
      </button>
    </div>
  `;
}

export function renderDesktopDock(store) {
  const track = store.getCurrentTrack();
  const liked = store.isLiked(track.id);
  const pct = track.duration > 0 ? Math.min(100, (store.currentTime / track.duration) * 100) : 0;

  return `
    <div class="dock-left">
      <button class="list-row-main" style="gap:10px;" data-action="nav" data-route="nowplaying" aria-label="Open Now Playing">
        ${renderArtwork({
          src: track.artwork,
          alt: track.title,
          seed: track.artworkSeed,
          size: '48px',
          round: 'round-sm',
          playing: store.isPlaying,
        })}
        <div style="min-width:0;">
          <div class="list-row-title truncate">${escapeHtml(track.title)}</div>
          <div class="list-row-sub truncate">${escapeHtml(track.artistName)}</div>
        </div>
      </button>
      <button class="icon-btn icon-btn-sm ${liked ? 'icon-btn-accent' : ''}" data-action="toggle-like" data-track-id="${escapeHtml(track.id)}" aria-label="Toggle Like">
        ${icon('favorite', { filled: liked, size: 18 })}
      </button>
    </div>

    <div class="dock-center">
      <div class="dock-controls">
        <button class="icon-btn icon-btn-sm ${store.shuffle ? 'icon-btn-accent' : ''}" data-action="toggle-shuffle" aria-label="Shuffle">
          ${icon('shuffle', { size: 18 })}
        </button>
        <button class="icon-btn icon-btn-sm" data-action="prev-track" aria-label="Previous track">
          ${icon('skip_previous', { filled: true, size: 22 })}
        </button>
        <button class="icon-btn icon-btn-primary" data-action="toggle-play" aria-label="${store.isPlaying ? 'Pause' : 'Play'}">
          ${icon(store.isPlaying ? 'pause' : 'play_arrow', { filled: true, size: 22 })}
        </button>
        <button class="icon-btn icon-btn-sm" data-action="next-track" aria-label="Next track">
          ${icon('skip_next', { filled: true, size: 22 })}
        </button>
        <button class="icon-btn icon-btn-sm ${store.repeat !== 'off' ? 'icon-btn-accent' : ''}" data-action="cycle-repeat" aria-label="Repeat">
          ${icon(store.repeat === 'one' ? 'repeat_one' : 'repeat', { size: 18 })}
        </button>
      </div>
      <div class="dock-scrubber">
        <span class="section-meta" data-bind-elapsed>${formatTime(store.currentTime)}</span>
        <input
          type="range"
          min="0"
          max="${track.duration}"
          step="1"
          value="${Math.floor(store.currentTime)}"
          data-action="seek"
          data-bind-range
          aria-label="Seek track position"
          style="flex:1;"
        />
        <span class="section-meta" data-bind-duration>${formatTime(track.duration)}</span>
      </div>
    </div>

    <div class="dock-right">
      <button class="icon-btn icon-btn-sm" data-action="open-eq" aria-label="Equalizer" title="5-Band Equalizer">
        ${icon('equalizer', { size: 18 })}
      </button>
      <button class="icon-btn icon-btn-sm" data-action="open-np-tab" data-tab="lyrics" aria-label="Lyrics" title="Synced Lyrics">
        ${icon('lyrics', { size: 18 })}
      </button>
      <button class="icon-btn icon-btn-sm" data-action="open-np-tab" data-tab="queue" aria-label="Queue" title="Up Next Queue">
        ${icon('queue_music', { size: 18 })}
      </button>
      <button class="icon-btn icon-btn-sm" data-action="toggle-mute" aria-label="Mute or unmute">
        ${icon(store.volume === 0 ? 'volume_off' : store.volume < 0.5 ? 'volume_down' : 'volume_up', { size: 18 })}
      </button>
      <input
        type="range"
        class="volume-range"
        min="0"
        max="1"
        step="0.02"
        value="${store.volume}"
        data-action="volume"
        aria-label="Volume"
        style="width:76px;"
      />
      <button class="icon-btn icon-btn-sm" data-action="nav" data-route="nowplaying" aria-label="Expand Now Playing" title="Open Studio View">
        ${icon('open_in_full', { size: 17 })}
      </button>
      <span class="sr-only" data-bind-dock-pct="${pct.toFixed(1)}"></span>
    </div>
  `;
}

export function renderMobileChrome(store) {
  const route = store.getRoute();
  if (route.name === 'nowplaying') return '';

  const track = store.getCurrentTrack();
  const pct = track.duration > 0 ? Math.min(100, (store.currentTime / track.duration) * 100) : 0;

  const homeRoutes = new Set(['home', 'charts', 'history', 'analytics', 'notifications']);
  const libraryRoutes = new Set([
    'library',
    'playlists',
    'playlist',
    'albums',
    'album',
    'artists',
    'artist',
    'liked-songs',
    'downloads',
  ]);

  const activeTab =
    route.name === 'search'
      ? 'search'
      : libraryRoutes.has(route.name)
        ? 'library'
        : homeRoutes.has(route.name)
          ? 'home'
          : '';

  const tabs = [
    { route: 'home', label: 'Home', icon: 'home' },
    { route: 'search', label: 'Search', icon: 'search' },
    { route: 'library', label: 'Library', icon: 'library_music' },
  ];

  return `
    <div class="mini-player-wrap">
      <div class="mini-player">
        <div class="mini-body">
          <button class="list-row-main mini-track-trigger" data-action="nav" data-route="nowplaying" aria-label="Open Now Playing">
            ${renderArtwork({
              src: track.artwork,
              alt: track.title,
              seed: track.artworkSeed,
              size: '44px',
              round: 'round-sm',
              playing: store.isPlaying,
            })}
            <div style="min-width:0;flex:1;">
              <div class="list-row-title truncate">${escapeHtml(track.title)}</div>
              <div class="list-row-sub truncate">${escapeHtml(track.artistName)}${store.jam.active ? ` · Jam ${escapeHtml(store.jam.code)}` : ''}</div>
            </div>
          </button>
          <div class="mini-actions">
            <button class="mini-play-btn" data-action="toggle-play" aria-label="${store.isPlaying ? 'Pause' : 'Play'}">
              ${icon(store.isPlaying ? 'pause' : 'play_arrow', { filled: true, size: 20 })}
            </button>
            <button class="icon-btn icon-btn-sm" data-action="next-track" aria-label="Next track">
              ${icon('skip_next', { filled: true, size: 22 })}
            </button>
          </div>
        </div>
        <div class="mini-progress" aria-hidden="true">
          <div class="mini-progress-fill" data-bind-mini-progress style="width:${pct.toFixed(2)}%;"></div>
        </div>
      </div>
    </div>

    <nav class="mobile-tabs" aria-label="Primary navigation">
      ${tabs
        .map((t) => {
          const isActive = activeTab === t.route;
          return `
        <button
          class="mobile-tab ${isActive ? 'active' : ''}"
          data-action="nav"
          data-route="${t.route}"
          aria-current="${isActive ? 'page' : 'false'}"
        >
          <span class="mobile-tab-pill">
            ${icon(t.icon, { filled: isActive, size: 21 })}
          </span>
          <span class="mobile-tab-label">${t.label}</span>
        </button>
      `;
        })
        .join('')}
    </nav>
  `;
}

/* ============================================================================
 * 17 INDIVIDUAL SCREENS
 * ========================================================================== */

// 1. HOME
function renderHomeScreen(store) {
  const cat = store.ui.homeCategory || 'All';
  const categories = ['All', 'Charts', 'Playlists', 'Albums', 'Artists', 'Genres', 'Heavy Rotation'];
  const unread = store.getUnreadCount();
  const spotlight = store.playlists[0];
  const currentTrack = store.getCurrentTrack();
  const currentLiked = currentTrack ? store.isLiked(currentTrack.id) : false;
  const pct =
    currentTrack && currentTrack.duration > 0
      ? Math.min(100, (store.currentTime / currentTrack.duration) * 100)
      : 0;
  const remaining = currentTrack ? Math.max(0, currentTrack.duration - store.currentTime) : 0;

  const isPlayingSpotlight =
    Boolean(spotlight && currentTrack) &&
    spotlight.trackIds.includes(currentTrack.id) &&
    store.isPlaying;

  const nextQueueId = store.queue[(store.queueIndex + 1) % Math.max(1, store.queue.length)];
  const upNextTrack = nextQueueId && nextQueueId !== currentTrack?.id ? store.getTrackById(nextQueueId) : null;

  const recentIds = Array.from(new Set(store.history.map((h) => h.trackId))).slice(0, 8);
  const recentTracks = recentIds.map((id) => store.getTrackById(id)).filter(Boolean);
  const chartTracks = store.tracks
    .filter((t) => typeof t.chartRank === 'number')
    .sort((a, b) => a.chartRank - b.chartRank);
  const quickPicks = store.tracks.slice(0, 6);
  const quickPickIds = quickPicks.map((t) => t.id).join(',');
  const show = (section) => cat === 'All' || cat === section;
  const ambientArt = (currentTrack && currentTrack.artwork) || (spotlight && spotlight.artwork) || '';

  const rightHtml = `
    <button class="icon-btn" data-action="nav" data-route="history" aria-label="Listening History" title="Listening History">${icon('history', { size: 20 })}</button>
    <button class="icon-btn" data-action="nav" data-route="analytics" aria-label="Listening Insights" title="Listening Insights">${icon('monitoring', { size: 20 })}</button>
    <button class="icon-btn" data-action="nav" data-route="notifications" aria-label="Notifications" title="Notifications">
      ${icon('notifications', { size: 20 })}
      ${unread > 0 ? `<span class="unread-dot"></span>` : ''}
    </button>
    <button class="icon-btn mobile-only" data-action="nav" data-route="settings" aria-label="Settings" title="Settings">${icon('tune', { size: 20 })}</button>
  `;

  return `
    ${renderTopBar({ title: 'Home', brandMode: true, rightHtml })}

    <section class="home-header-bleed">
      ${
        ambientArt
          ? `<div class="album-ambient-bg" aria-hidden="true"><img src="${escapeHtml(ambientArt)}" alt="" referrerpolicy="no-referrer" /></div>`
          : ''
      }
      <div class="container home-header-inner">
        <div class="home-greeting-bar">
          <div class="home-greeting-copy">
            <h1 class="home-greeting-title">${escapeHtml(getGreeting())}, ${escapeHtml(store.settings.displayName)}</h1>
            <p class="home-greeting-sub">${store.tracks.length} studio masters · ${store.downloadedTrackIds.length} synced offline</p>
          </div>

          <button class="home-search-trigger" data-action="nav" data-route="search" aria-label="Search tracks, albums, and artists">
            ${icon('search', { size: 18 })}
            <span class="truncate">Search tracks, albums, artists…</span>
            <span class="home-search-kbd desktop-only mono">/</span>
          </button>
        </div>

        <div class="chip-row no-scrollbar" role="tablist" aria-label="Home categories">
          ${categories
            .map(
              (c) => `
            <button class="chip ${cat === c ? 'active' : ''}" role="tab" aria-selected="${cat === c}" data-action="set-ui" data-key="homeCategory" data-value="${escapeHtml(c)}">${escapeHtml(c)}</button>
          `
            )
            .join('')}
        </div>

        ${
          store.jam.active
            ? `
          <div class="jam-banner home-jam-banner">
            <div style="display:flex;align-items:center;gap:12px;min-width:0;">
              <span class="shortcut-icon tint-emerald">${icon('podcasts', { size: 19 })}</span>
              <div style="min-width:0;">
                <div style="font-size:13.5px;font-weight:700;">Live Jam Session · <span class="mono">${escapeHtml(store.jam.code)}</span></div>
                <div style="font-size:12px;color:var(--secondary);" class="truncate">
                  ${store.jam.listeners.map((l) => escapeHtml(l.name)).join(' · ')}
                </div>
              </div>
            </div>
            <button class="btn btn-primary btn-sm" data-action="open-jam">Open Room</button>
          </div>
        `
            : ''
        }
      </div>
    </section>

    <main class="container home-body-stack">
      <div class="section-stack" data-tab-panel="home-cat">
        ${
          cat === 'All'
            ? `
          <section class="home-quick-grid" aria-label="Quick access">
            <button class="home-quick-item stagger-item" style="--stagger-i:0;" data-action="nav" data-route="liked-songs">
              <span class="home-quick-icon tint-rose">${icon('favorite', { filled: true, size: 20 })}</span>
              <div class="home-quick-text">
                <div class="home-quick-title truncate">Liked Songs</div>
                <div class="home-quick-meta truncate">${store.likedTrackIds.length} saved</div>
              </div>
              <span class="home-quick-arrow" aria-hidden="true">${icon('chevron_right', { size: 17 })}</span>
            </button>

            <button class="home-quick-item stagger-item" style="--stagger-i:1;" data-action="nav" data-route="downloads">
              <span class="home-quick-icon tint-emerald">${icon('download_done', { size: 20 })}</span>
              <div class="home-quick-text">
                <div class="home-quick-title truncate">Offline Vault</div>
                <div class="home-quick-meta truncate">${store.downloadedTrackIds.length} verified</div>
              </div>
              <span class="home-quick-arrow" aria-hidden="true">${icon('chevron_right', { size: 17 })}</span>
            </button>

            <button class="home-quick-item stagger-item" style="--stagger-i:2;" data-action="nav" data-route="analytics">
              <span class="home-quick-icon tint-amber">${icon('monitoring', { size: 20 })}</span>
              <div class="home-quick-text">
                <div class="home-quick-title truncate">Insights</div>
                <div class="home-quick-meta truncate">${store.history.length} plays</div>
              </div>
              <span class="home-quick-arrow" aria-hidden="true">${icon('chevron_right', { size: 17 })}</span>
            </button>

            <button class="home-quick-item stagger-item" style="--stagger-i:3;" data-action="open-jam">
              <span class="home-quick-icon tint-indigo">${icon('podcasts', { size: 20 })}</span>
              <div class="home-quick-text">
                <div class="home-quick-title truncate">Jam Room</div>
                <div class="home-quick-meta truncate">${store.jam.active ? escapeHtml(store.jam.code) : 'Sync live'}</div>
              </div>
              <span class="home-quick-arrow" aria-hidden="true">${icon('chevron_right', { size: 17 })}</span>
            </button>
          </section>

          <section class="home-hero-grid">
            <article class="home-spotlight stagger-item" style="--stagger-i:1;">
              ${renderArtwork({
                src: spotlight.artwork,
                alt: spotlight.title,
                seed: spotlight.artworkSeed,
                extraClass: 'fill-abs home-spotlight-art',
              })}
              <div class="home-spotlight-scrim" aria-hidden="true"></div>
              <div class="home-spotlight-content">
                <div class="home-spotlight-top">
                  <span class="home-spotlight-kicker">CURATED SPOTLIGHT · ${spotlight.trackIds.length} TRACKS</span>
                  <button class="home-spotlight-open" data-action="nav" data-route="playlist" data-id="${escapeHtml(spotlight.id)}" aria-label="Open ${escapeHtml(spotlight.title)}">
                    <span>Explore</span>
                    ${icon('arrow_outward', { size: 15 })}
                  </button>
                </div>

                <div class="home-spotlight-main">
                  <button class="home-spotlight-title-btn" data-action="nav" data-route="playlist" data-id="${escapeHtml(spotlight.id)}">
                    <h2>${escapeHtml(spotlight.title)}</h2>
                  </button>
                  <p>${escapeHtml(spotlight.description)}</p>

                  <div class="home-spotlight-actions">
                    <button
                      class="btn home-spot-play"
                      data-action="${isPlayingSpotlight ? 'toggle-play' : 'play-playlist'}"
                      data-id="${escapeHtml(spotlight.id)}"
                    >
                      ${icon(isPlayingSpotlight ? 'pause' : 'play_arrow', { filled: true, size: 19 })}
                      ${isPlayingSpotlight ? 'Pause Session' : 'Play Session'}
                    </button>
                    <button class="btn home-spot-ghost" data-action="shuffle-playlist" data-id="${escapeHtml(spotlight.id)}">
                      ${icon('shuffle', { size: 17 })} Shuffle
                    </button>
                  </div>
                </div>
              </div>
            </article>

            ${
              currentTrack
                ? `
              <aside class="home-resume-card stagger-item" style="--stagger-i:2;" aria-label="Continue listening">
                <div class="home-resume-head">
                  <span class="section-meta">${store.isPlaying ? 'NOW PLAYING' : 'CONTINUE LISTENING'}</span>
                  <button class="text-link-btn" data-action="nav" data-route="nowplaying">
                    Studio View ${icon('open_in_full', { size: 14 })}
                  </button>
                </div>

                <div class="home-resume-track">
                  <button class="home-resume-art-btn" data-action="nav" data-route="nowplaying" aria-label="Open ${escapeHtml(currentTrack.title)} in Studio View">
                    ${renderArtwork({
                      src: currentTrack.artwork,
                      alt: currentTrack.title,
                      seed: currentTrack.artworkSeed,
                      size: '74px',
                      round: 'round-md',
                      playing: store.isPlaying,
                    })}
                  </button>

                  <div class="home-resume-meta">
                    <button class="home-resume-title truncate" data-action="nav" data-route="nowplaying">${escapeHtml(currentTrack.title)}</button>
                    <div class="list-row-sub truncate">${escapeHtml(currentTrack.artistName)} · ${escapeHtml(currentTrack.albumTitle)}</div>
                    <div class="home-resume-codec mono">${escapeHtml(currentTrack.format || 'FLAC')} · ${escapeHtml(currentTrack.bitrate || '24-bit')}</div>
                  </div>

                  <button
                    class="icon-btn icon-btn-sm ${currentLiked ? 'icon-btn-accent' : ''}"
                    data-action="toggle-like"
                    data-track-id="${escapeHtml(currentTrack.id)}"
                    aria-label="${currentLiked ? 'Unlike' : 'Like'} ${escapeHtml(currentTrack.title)}"
                  >
                    ${icon('favorite', { filled: currentLiked, size: 19 })}
                  </button>
                </div>

                <div class="home-resume-progress">
                  <div class="home-resume-bar">
                    <div class="home-resume-bar-fill" data-bind-progress style="width:${pct.toFixed(2)}%;"></div>
                  </div>
                  <div class="home-resume-times mono">
                    <span data-bind-elapsed>${formatTime(store.currentTime)}</span>
                    <span data-bind-remaining>-${formatTime(remaining)}</span>
                  </div>
                </div>

                <div class="home-resume-controls">
                  <div class="home-resume-transport">
                    <button class="icon-btn icon-btn-sm" data-action="prev-track" aria-label="Previous track">
                      ${icon('skip_previous', { filled: true, size: 22 })}
                    </button>
                    <button class="btn btn-primary btn-sm home-resume-play-btn" data-action="toggle-play" aria-label="${store.isPlaying ? 'Pause' : 'Resume'}">
                      ${icon(store.isPlaying ? 'pause' : 'play_arrow', { filled: true, size: 19 })}
                      ${store.isPlaying ? 'Pause' : 'Resume'}
                    </button>
                    <button class="icon-btn icon-btn-sm" data-action="next-track" aria-label="Next track">
                      ${icon('skip_next', { filled: true, size: 22 })}
                    </button>
                  </div>

                  <div class="home-resume-shortcuts">
                    <button class="icon-btn icon-btn-sm" data-action="open-np-tab" data-tab="lyrics" aria-label="Open Lyrics" title="Synced Lyrics">
                      ${icon('lyrics', { size: 18 })}
                    </button>
                    <button class="icon-btn icon-btn-sm" data-action="open-np-tab" data-tab="queue" aria-label="Open Queue" title="Up Next Queue">
                      ${icon('queue_music', { size: 18 })}
                    </button>
                  </div>
                </div>

                ${
                  upNextTrack
                    ? `
                  <button class="home-upnext-strip" data-action="play-track" data-track-id="${escapeHtml(upNextTrack.id)}">
                    <span class="section-meta home-upnext-label">UP NEXT</span>
                    <span class="home-upnext-title truncate">${escapeHtml(upNextTrack.title)}</span>
                    <span class="home-upnext-artist truncate">${escapeHtml(upNextTrack.artistName)}</span>
                    <span class="home-upnext-play" aria-hidden="true">${icon('play_arrow', { filled: true, size: 16 })}</span>
                  </button>
                `
                    : ''
                }
              </aside>
            `
                : ''
            }
          </section>
        `
            : ''
        }

        ${
          show('Heavy Rotation') && recentTracks.length > 0
            ? `
          <section class="block-stack">
            <div class="section-header">
              <div>
                <h2 class="section-title">Jump Back In</h2>
              </div>
              <button class="text-link-btn" data-action="nav" data-route="history">History ${icon('chevron_right', { size: 16 })}</button>
            </div>
            <div class="h-scroll no-scrollbar">
              ${recentTracks
                .map((t, idx) => {
                  const isCurrent = currentTrack && currentTrack.id === t.id;
                  const isPlayingHere = isCurrent && store.isPlaying;
                  return `
                <button
                  class="track-tile home-tile stagger-item ${isCurrent ? 'is-current' : ''}"
                  style="--stagger-i:${idx};"
                  data-action="${isCurrent ? 'toggle-play' : 'play-track'}"
                  data-track-id="${escapeHtml(t.id)}"
                  data-queue="${escapeHtml(recentTracks.map((x) => x.id).join(','))}"
                >
                  <div class="tile-art-wrap">
                    ${renderArtwork({
                      src: t.artwork,
                      alt: t.title,
                      seed: t.artworkSeed,
                      square: true,
                      round: 'round-md',
                      playing: isPlayingHere,
                    })}
                    <span class="tile-play-fab ${isCurrent ? 'is-visible' : ''}" aria-hidden="true">
                      ${icon(isPlayingHere ? 'pause' : 'play_arrow', { filled: true, size: 19 })}
                    </span>
                  </div>
                  <div class="list-row-title truncate" style="margin-top:9px;">${escapeHtml(t.title)}</div>
                  <div class="list-row-sub truncate">${escapeHtml(t.artistName)}</div>
                </button>
              `;
                })
                .join('')}
            </div>
          </section>
        `
            : ''
        }

        ${
          show('Charts')
            ? `
          <section class="block-stack">
            <div class="section-header">
              <div>
                <h2 class="section-title">Top Charts &amp; Hot Hits</h2>
              </div>
              <button class="text-link-btn" data-action="nav" data-route="charts">View All ${icon('chevron_right', { size: 16 })}</button>
            </div>
            <div class="h-scroll no-scrollbar">
              ${chartTracks
                .map((t, idx) => {
                  const isCurrent = currentTrack && currentTrack.id === t.id;
                  const isPlayingHere = isCurrent && store.isPlaying;
                  return `
                <button
                  class="track-tile home-tile stagger-item ${isCurrent ? 'is-current' : ''}"
                  style="--stagger-i:${idx};"
                  data-action="${isCurrent ? 'toggle-play' : 'play-track'}"
                  data-track-id="${escapeHtml(t.id)}"
                  data-queue="${escapeHtml(chartTracks.map((x) => x.id).join(','))}"
                >
                  <div class="tile-art-wrap">
                    ${renderArtwork({
                      src: t.artwork,
                      alt: t.title,
                      seed: t.artworkSeed,
                      square: true,
                      round: 'round-md',
                      badge: `#${t.chartRank}`,
                      playing: isPlayingHere,
                    })}
                    <span class="tile-play-fab ${isCurrent ? 'is-visible' : ''}" aria-hidden="true">
                      ${icon(isPlayingHere ? 'pause' : 'play_arrow', { filled: true, size: 19 })}
                    </span>
                  </div>
                  <div class="list-row-title truncate" style="margin-top:9px;">${escapeHtml(t.title)}</div>
                  <div class="list-row-sub truncate">${escapeHtml(t.artistName)}</div>
                </button>
              `;
                })
                .join('')}
            </div>
          </section>
        `
            : ''
        }

        ${
          show('Playlists')
            ? `
          <section class="block-stack">
            <div class="section-header">
              <h2 class="section-title">Featured Playlists</h2>
              <button class="text-link-btn" data-action="nav" data-route="playlists">All Playlists ${icon('chevron_right', { size: 16 })}</button>
            </div>
            <div class="card-grid-4">
              ${store.playlists
                .slice(0, 4)
                .map((pl, idx) => {
                  const isPlPlaying = Boolean(currentTrack) && pl.trackIds.includes(currentTrack.id) && store.isPlaying;
                  return `
                <article class="media-card home-media-card stagger-item" style="--stagger-i:${idx};">
                  <div class="tile-art-wrap">
                    <button class="home-media-cover-btn" data-action="nav" data-route="playlist" data-id="${escapeHtml(pl.id)}" aria-label="Open ${escapeHtml(pl.title)}">
                      ${renderArtwork({ src: pl.artwork, alt: pl.title, seed: pl.artworkSeed, square: true, round: 'round-md' })}
                    </button>
                    <button
                      class="tile-play-fab ${isPlPlaying ? 'is-visible' : ''}"
                      data-action="${isPlPlaying ? 'toggle-play' : 'play-playlist'}"
                      data-id="${escapeHtml(pl.id)}"
                      aria-label="${isPlPlaying ? 'Pause' : 'Play'} ${escapeHtml(pl.title)}"
                    >
                      ${icon(isPlPlaying ? 'pause' : 'play_arrow', { filled: true, size: 19 })}
                    </button>
                  </div>
                  <button class="home-media-meta-btn" data-action="nav" data-route="playlist" data-id="${escapeHtml(pl.id)}">
                    <div class="list-row-title truncate">${escapeHtml(pl.title)}</div>
                    <div class="list-row-sub truncate">${escapeHtml(pl.subtitle)} · ${pl.trackIds.length} tracks</div>
                  </button>
                </article>
              `;
                })
                .join('')}
            </div>
          </section>
        `
            : ''
        }

        ${
          show('Artists')
            ? `
          <section class="block-stack">
            <div class="section-header">
              <h2 class="section-title">Top Artists</h2>
              <button class="text-link-btn" data-action="nav" data-route="artists">See All ${icon('chevron_right', { size: 16 })}</button>
            </div>
            <div class="h-scroll no-scrollbar">
              ${store.artists
                .map(
                  (a, idx) => `
                <button class="artist-bubble home-artist-bubble stagger-item" style="--stagger-i:${idx};" data-action="nav" data-route="artist" data-id="${escapeHtml(a.id)}">
                  <div class="home-artist-ring">
                    ${renderArtwork({ src: a.avatar, alt: a.name, seed: a.artworkSeed, size: '124px', round: 'round-full' })}
                  </div>
                  <div class="list-row-title truncate" style="width:100%;margin-top:10px;">${escapeHtml(a.name)}</div>
                  <div class="list-row-sub truncate" style="width:100%;">${escapeHtml(a.origin)}</div>
                </button>
              `
                )
                .join('')}
            </div>
          </section>
        `
            : ''
        }

        ${
          show('Albums')
            ? `
          <section class="block-stack">
            <div class="section-header">
              <h2 class="section-title">Studio Albums</h2>
              <button class="text-link-btn" data-action="nav" data-route="albums">All Albums ${icon('chevron_right', { size: 16 })}</button>
            </div>
            <div class="card-grid-4">
              ${store.albums
                .slice(0, 4)
                .map((al, idx) => {
                  const alTrackIds = store.tracks.filter((t) => t.albumId === al.id).map((t) => t.id);
                  const isAlPlaying = Boolean(currentTrack) && alTrackIds.includes(currentTrack.id) && store.isPlaying;
                  return `
                <article class="media-card home-media-card stagger-item" style="--stagger-i:${idx};">
                  <div class="tile-art-wrap">
                    <button class="home-media-cover-btn" data-action="nav" data-route="album" data-id="${escapeHtml(al.id)}" aria-label="Open ${escapeHtml(al.title)}">
                      ${renderArtwork({ src: al.artwork, alt: al.title, seed: al.artworkSeed, square: true, round: 'round-md' })}
                    </button>
                    ${
                      alTrackIds.length > 0
                        ? `<button
                             class="tile-play-fab ${isAlPlaying ? 'is-visible' : ''}"
                             data-action="${isAlPlaying ? 'toggle-play' : 'play-queue'}"
                             data-queue="${escapeHtml(alTrackIds.join(','))}"
                             aria-label="${isAlPlaying ? 'Pause' : 'Play'} ${escapeHtml(al.title)}"
                           >
                             ${icon(isAlPlaying ? 'pause' : 'play_arrow', { filled: true, size: 19 })}
                           </button>`
                        : ''
                    }
                  </div>
                  <button class="home-media-meta-btn" data-action="nav" data-route="album" data-id="${escapeHtml(al.id)}">
                    <div class="list-row-title truncate">${escapeHtml(al.title)}</div>
                    <div class="list-row-sub truncate">${escapeHtml(al.artistName)} · ${al.year}</div>
                  </button>
                </article>
              `;
                })
                .join('')}
            </div>
          </section>
        `
            : ''
        }

        ${
          show('Genres')
            ? `
          <section class="block-stack">
            <div class="section-header">
              <h2 class="section-title">Genres &amp; Moods</h2>
              <span class="section-meta">EXPLORE SPECTRUM</span>
            </div>
            <div class="genre-grid">
              ${GENRE_CARDS.map(
                (g, idx) => `
                <button class="genre-card home-genre-card stagger-item" style="--stagger-i:${idx};background:${g.bg};" data-action="nav" data-route="search" data-query="${escapeHtml(g.query)}">
                  <div class="home-genre-top">
                    <span class="home-genre-icon">${icon(g.icon, { size: 20 })}</span>
                    <span class="home-genre-arrow" aria-hidden="true">${icon('arrow_outward', { size: 16 })}</span>
                  </div>
                  <span class="home-genre-label">${escapeHtml(g.label)}</span>
                </button>
              `
              ).join('')}
            </div>
          </section>
        `
            : ''
        }

        ${
          cat === 'All' || cat === 'Heavy Rotation'
            ? `
          <section class="block-stack">
            <div class="section-header">
              <div>
                <h2 class="section-title">Quick Picks</h2>
              </div>
              <div style="display:flex;align-items:center;gap:8px;">
                <button class="btn btn-secondary btn-sm" data-action="shuffle-queue" data-queue="${escapeHtml(quickPickIds)}" aria-label="Shuffle Quick Picks">
                  ${icon('shuffle', { size: 16 })} Shuffle
                </button>
                <button class="btn btn-primary btn-sm" data-action="play-queue" data-queue="${escapeHtml(quickPickIds)}">
                  ${icon('play_arrow', { filled: true, size: 16 })} Play All
                </button>
              </div>
            </div>
            <div class="list-card list-sheet">
              ${quickPicks.map((t, i) => renderTrackRow(store, t, { index: i, contextQueue: quickPicks.map((x) => x.id), showAlbum: true })).join('')}
            </div>
          </section>
        `
            : ''
        }
      </div>
    </main>
  `;
}

// 2. SEARCH
function renderSearchScreen(store) {
  const q = (store.ui.searchQuery || '').trim();
  const qLow = q.toLowerCase();
  const cat = store.ui.searchCategory;
  const filters = ['All', 'Tracks', 'Albums', 'Artists', 'Playlists', 'Hi-Res'];

  const matchedTracks = store.tracks.filter((t) => {
    if (cat === 'Hi-Res' && !t.hiRes) return false;
    if (!qLow) return true;
    return (
      t.title.toLowerCase().includes(qLow) ||
      t.artistName.toLowerCase().includes(qLow) ||
      t.albumTitle.toLowerCase().includes(qLow) ||
      t.genre.toLowerCase().includes(qLow)
    );
  });

  const matchedAlbums = store.albums.filter((a) => {
    if (!qLow) return false;
    return (
      a.title.toLowerCase().includes(qLow) ||
      a.artistName.toLowerCase().includes(qLow) ||
      a.label.toLowerCase().includes(qLow)
    );
  });

  const matchedArtists = store.artists.filter((a) => {
    if (!qLow) return false;
    return a.name.toLowerCase().includes(qLow) || a.origin.toLowerCase().includes(qLow);
  });

  const matchedPlaylists = store.playlists.filter((p) => {
    if (!qLow) return false;
    return (
      p.title.toLowerCase().includes(qLow) ||
      p.description.toLowerCase().includes(qLow) ||
      p.subtitle.toLowerCase().includes(qLow)
    );
  });

  const topResult =
    qLow
      ? matchedArtists[0]
        ? { type: 'artist', item: matchedArtists[0] }
        : matchedTracks[0]
          ? { type: 'track', item: matchedTracks[0] }
          : matchedAlbums[0]
            ? { type: 'album', item: matchedAlbums[0] }
            : null
      : null;

  const hasAnyResults =
    matchedTracks.length > 0 || matchedAlbums.length > 0 || matchedArtists.length > 0 || matchedPlaylists.length > 0;

  return `
    ${renderTopBar({ title: 'Search Catalog', showBack: true })}
    <main class="container section-stack">
      <div class="block-stack">
        <div class="search-box">
          ${icon('search', { size: 20 })}
          <input
            id="search-main-input"
            type="text"
            placeholder="Search tracks, albums, artists, genres..."
            value="${escapeHtml(store.ui.searchQuery)}"
            data-input-ui="searchQuery"
            autocomplete="off"
          />
          ${
            store.ui.searchQuery
              ? `<button class="icon-btn icon-btn-sm" data-action="clear-search" aria-label="Clear search">${icon('close', { size: 18 })}</button>`
              : ''
          }
        </div>
        <div class="chip-row no-scrollbar">
          ${filters
            .map(
              (f) => `
            <button class="chip ${cat === f ? 'active' : ''}" data-action="set-ui" data-key="searchCategory" data-value="${escapeHtml(f)}">${escapeHtml(f)}</button>
          `
            )
            .join('')}
        </div>
      </div>

      ${
        !q && cat !== 'Hi-Res'
          ? `
        ${
          store.recentSearches.length > 0
            ? `
          <section class="block-stack">
            <div class="section-header">
              <h2 class="section-title">Recent Searches</h2>
              <button class="text-link-btn" data-action="clear-recent-searches">Clear All</button>
            </div>
            <div class="chip-row" style="flex-wrap:wrap;overflow:visible;">
              ${store.recentSearches
                .map(
                  (term) => `
                <span class="chip" style="padding-right:6px;">
                  <button data-action="apply-search" data-query="${escapeHtml(term)}">${escapeHtml(term)}</button>
                  <button class="icon-btn" style="width:22px;height:22px;" data-action="remove-recent-search" data-query="${escapeHtml(term)}" aria-label="Remove ${escapeHtml(term)}">${icon('close', { size: 14 })}</button>
                </span>
              `
                )
                .join('')}
            </div>
          </section>
        `
            : ''
        }

        <section class="block-stack">
          <div class="section-header">
            <h2 class="section-title">Browse Genres</h2>
            <span class="section-meta">CURATED SPECTRUM</span>
          </div>
          <div class="genre-grid">
            ${GENRE_CARDS.map(
              (g) => `
              <button class="genre-card" style="background:${g.bg};" data-action="apply-search" data-query="${escapeHtml(g.query)}">
                ${icon(g.icon, { size: 22 })}
                <span>${escapeHtml(g.label)}</span>
              </button>
            `
            ).join('')}
          </div>
        </section>
      `
          : !hasAnyResults
            ? `
          <div class="empty-state surface-card">
            <div class="empty-icon">${icon('search_off', { size: 26 })}</div>
            <h3 class="section-title">No matches for "${escapeHtml(q)}"</h3>
            <p class="page-subtitle">Try searching for Solaris, Monolith, Ambient, or switch the filter to All.</p>
          </div>
        `
            : `
          ${
            topResult && cat === 'All'
              ? `
            <section class="block-stack">
              <h2 class="section-title">Top Result</h2>
              <div class="surface-card" style="padding:18px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;">
                <div style="display:flex;align-items:center;gap:16px;min-width:0;flex:1;">
                  ${renderArtwork({
                    src: topResult.type === 'artist' ? topResult.item.avatar : topResult.item.artwork,
                    alt: topResult.type === 'artist' ? topResult.item.name : topResult.item.title,
                    seed: topResult.item.artworkSeed,
                    size: '74px',
                    round: topResult.type === 'artist' ? 'round-full' : 'round-md',
                  })}
                  <div style="min-width:0;">
                    <span class="tag-mono" style="margin-left:0;">${topResult.type.toUpperCase()}</span>
                    <div style="font-size:20px;font-weight:800;margin-top:4px;" class="truncate">
                      ${escapeHtml(topResult.type === 'artist' ? topResult.item.name : topResult.item.title)}
                    </div>
                    <div class="list-row-sub truncate">
                      ${
                        topResult.type === 'artist'
                          ? `${escapeHtml(topResult.item.monthlyListeners)} monthly listeners · ${escapeHtml(topResult.item.origin)}`
                          : escapeHtml(topResult.item.artistName)
                      }
                    </div>
                  </div>
                </div>
                ${
                  topResult.type === 'track'
                    ? `<button class="btn btn-primary" data-action="play-track" data-track-id="${escapeHtml(topResult.item.id)}">${icon('play_arrow', { filled: true, size: 19 })} Play Track</button>`
                    : topResult.type === 'artist'
                      ? `<button class="btn btn-primary" data-action="nav" data-route="artist" data-id="${escapeHtml(topResult.item.id)}">Open Artist</button>`
                      : `<button class="btn btn-primary" data-action="nav" data-route="album" data-id="${escapeHtml(topResult.item.id)}">Open Album</button>`
                }
              </div>
            </section>
          `
              : ''
          }

          ${
            (cat === 'All' || cat === 'Tracks' || cat === 'Hi-Res') && matchedTracks.length > 0
              ? `
            <section class="block-stack">
              <div class="section-header">
                <h2 class="section-title">${cat === 'Hi-Res' ? 'Hi-Res 24-Bit & 320 kbps Masters' : 'Tracks'}</h2>
                <span class="section-meta">${matchedTracks.length} RESULTS</span>
              </div>
              <div class="list-card">
                ${matchedTracks
                  .map((t, i) => renderTrackRow(store, t, { index: i, contextQueue: matchedTracks.map((x) => x.id), showAlbum: true }))
                  .join('')}
              </div>
            </section>
          `
              : ''
          }

          ${
            (cat === 'All' || cat === 'Artists') && matchedArtists.length > 0
              ? `
            <section class="block-stack">
              <h2 class="section-title">Artists</h2>
              <div class="artist-grid">
                ${matchedArtists
                  .map(
                    (a) => `
                  <button class="artist-card" data-action="nav" data-route="artist" data-id="${escapeHtml(a.id)}">
                    ${renderArtwork({ src: a.avatar, alt: a.name, seed: a.artworkSeed, size: '86px', round: 'round-full' })}
                    <div class="list-row-title truncate" style="width:100%;margin-top:10px;">${escapeHtml(a.name)}</div>
                    <div class="list-row-sub truncate" style="width:100%;">${escapeHtml(a.origin)}</div>
                  </button>
                `
                  )
                  .join('')}
              </div>
            </section>
          `
              : ''
          }

          ${
            (cat === 'All' || cat === 'Albums') && matchedAlbums.length > 0
              ? `
            <section class="block-stack">
              <h2 class="section-title">Albums</h2>
              <div class="card-grid-4">
                ${matchedAlbums
                  .map(
                    (al) => `
                  <button class="media-card" data-action="nav" data-route="album" data-id="${escapeHtml(al.id)}">
                    ${renderArtwork({ src: al.artwork, alt: al.title, seed: al.artworkSeed, square: true, round: 'round-md' })}
                    <div class="list-row-title truncate" style="margin-top:10px;">${escapeHtml(al.title)}</div>
                    <div class="list-row-sub truncate">${escapeHtml(al.artistName)} · ${al.year}</div>
                  </button>
                `
                  )
                  .join('')}
              </div>
            </section>
          `
              : ''
          }

          ${
            (cat === 'All' || cat === 'Playlists') && matchedPlaylists.length > 0
              ? `
            <section class="block-stack">
              <h2 class="section-title">Playlists</h2>
              <div class="card-grid-4">
                ${matchedPlaylists
                  .map(
                    (pl) => `
                  <button class="media-card" data-action="nav" data-route="playlist" data-id="${escapeHtml(pl.id)}">
                    ${renderArtwork({ src: pl.artwork, alt: pl.title, seed: pl.artworkSeed, square: true, round: 'round-md' })}
                    <div class="list-row-title truncate" style="margin-top:10px;">${escapeHtml(pl.title)}</div>
                    <div class="list-row-sub truncate">${pl.trackIds.length} tracks · ${escapeHtml(pl.curator)}</div>
                  </button>
                `
                  )
                  .join('')}
              </div>
            </section>
          `
              : ''
          }
        `
      }
    </main>
  `;
}

// 3. YOUR LIBRARY
function renderLibraryScreen(store) {
  const filter = store.ui.libraryFilter;
  const sort = store.ui.librarySort;
  const view = store.ui.libraryView;
  const q = (store.ui.librarySearchQuery || '').trim().toLowerCase();
  const chips = ['All', 'Playlists', 'Downloaded', 'Albums', 'Artists'];

  let items = [];
  if (filter === 'All' || filter === 'Playlists') {
    store.playlists.forEach((pl) => {
      items.push({
        type: 'playlist',
        id: pl.id,
        title: pl.title,
        subtitle: `Playlist · ${pl.trackIds.length} tracks · ${pl.curator}`,
        artwork: pl.artwork,
        seed: pl.artworkSeed,
        round: 'round-md',
      });
    });
  }
  if (filter === 'All' || filter === 'Albums') {
    store.albums.forEach((al) => {
      items.push({
        type: 'album',
        id: al.id,
        title: al.title,
        subtitle: `Album · ${al.artistName} · ${al.year}`,
        artwork: al.artwork,
        seed: al.artworkSeed,
        round: 'round-md',
      });
    });
  }
  if (filter === 'All' || filter === 'Artists') {
    store.artists
      .filter((a) => store.isFollowed(a.id) || filter === 'Artists')
      .forEach((ar) => {
        items.push({
          type: 'artist',
          id: ar.id,
          title: ar.name,
          subtitle: `Artist · ${ar.origin}${store.isFollowed(ar.id) ? ' · Following' : ''}`,
          artwork: ar.avatar,
          seed: ar.artworkSeed,
          round: 'round-full',
        });
      });
  }
  if (filter === 'Downloaded') {
    store.downloadedTrackIds
      .map((id) => store.getTrackById(id))
      .filter(Boolean)
      .forEach((t) => {
        items.push({
          type: 'track',
          id: t.id,
          title: t.title,
          subtitle: `Offline · ${t.artistName} · ${t.bitrate}`,
          artwork: t.artwork,
          seed: t.artworkSeed,
          round: 'round-sm',
        });
      });
  }

  if (q) {
    items = items.filter(
      (it) => it.title.toLowerCase().includes(q) || it.subtitle.toLowerCase().includes(q)
    );
  }
  if (sort === 'alpha') {
    items.sort((a, b) => a.title.localeCompare(b.title));
  }

  const rightHtml = `
    <button class="icon-btn" data-action="toggle-ui-bool" data-key="librarySearchOpen" aria-label="Search library">${icon('search', { size: 20 })}</button>
    <button class="btn btn-primary btn-sm" data-action="open-create-playlist">${icon('add', { size: 17 })} New Playlist</button>
    <button class="icon-btn mobile-only" data-action="nav" data-route="settings" aria-label="Settings">${icon('tune', { size: 20 })}</button>
  `;

  return `
    ${renderTopBar({ title: 'Your Library', showBack: true, rightHtml })}
    <main class="container section-stack">
      ${
        store.ui.librarySearchOpen
          ? `
        <div class="search-box">
          ${icon('search', { size: 19 })}
          <input
            id="library-search-input"
            type="text"
            placeholder="Filter your playlists, albums, artists..."
            value="${escapeHtml(store.ui.librarySearchQuery)}"
            data-input-ui="librarySearchQuery"
          />
          ${
            store.ui.librarySearchQuery
              ? `<button class="icon-btn icon-btn-sm" data-action="set-ui" data-key="librarySearchQuery" data-value="">${icon('close', { size: 17 })}</button>`
              : ''
          }
        </div>
      `
          : ''
      }

      <div class="pinned-grid">
        <button class="pinned-card pinned-card-primary" data-action="nav" data-route="liked-songs">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            ${icon('favorite', { filled: true, size: 24 })}
            <span class="section-meta" style="color:inherit;opacity:0.75;">VAULT 01</span>
          </div>
          <div>
            <div style="font-size:17px;font-weight:800;">Liked Songs</div>
            <div class="section-meta" style="color:inherit;opacity:0.8;margin-top:2px;">${store.likedTrackIds.length} tracks pinned</div>
          </div>
        </button>

        <button class="pinned-card pinned-card-light" data-action="nav" data-route="downloads">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            ${icon('download_done', { size: 24 })}
            <span class="section-meta">LOCAL</span>
          </div>
          <div>
            <div style="font-size:17px;font-weight:800;">Downloaded</div>
            <div class="section-meta" style="margin-top:2px;">${store.downloadedTrackIds.length} offline masters</div>
          </div>
        </button>
      </div>

      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
        <div class="chip-row no-scrollbar">
          ${chips
            .map(
              (c) => `
            <button class="chip ${filter === c ? 'active' : ''}" data-action="set-ui" data-key="libraryFilter" data-value="${escapeHtml(c)}">${escapeHtml(c)}</button>
          `
            )
            .join('')}
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <button class="btn btn-secondary btn-sm" data-action="toggle-library-sort">
            ${icon('swap_vert', { size: 16 })} ${sort === 'recent' ? 'Recently played' : 'Alphabetical'}
          </button>
          <button class="icon-btn icon-btn-bordered icon-btn-sm" data-action="toggle-library-view" aria-label="Toggle list or grid view">
            ${icon(view === 'list' ? 'grid_view' : 'view_list', { size: 18 })}
          </button>
        </div>
      </div>

      ${
        items.length === 0
          ? `
        <div class="empty-state surface-card">
          <div class="empty-icon">${icon('library_music', { size: 24 })}</div>
          <h3 class="section-title">No matching library items</h3>
          <p class="page-subtitle">Adjust your filter or create a new playlist.</p>
        </div>
      `
          : view === 'grid'
            ? `
          <div class="card-grid-4">
            ${items
              .map(
                (it) => `
              <button class="media-card" data-action="${it.type === 'track' ? 'play-track' : 'nav'}" ${it.type === 'track' ? `data-track-id="${escapeHtml(it.id)}"` : `data-route="${it.type}" data-id="${escapeHtml(it.id)}"`}>
                ${renderArtwork({ src: it.artwork, alt: it.title, seed: it.seed, square: true, round: it.round })}
                <div class="list-row-title truncate" style="margin-top:10px;">${escapeHtml(it.title)}</div>
                <div class="list-row-sub truncate">${escapeHtml(it.subtitle)}</div>
              </button>
            `
              )
              .join('')}
          </div>
        `
            : `
          <div class="list-card">
            ${items
              .map((it) => {
                if (it.type === 'track') {
                  const t = store.getTrackById(it.id);
                  if (t) {
                    const trackQueue = items.filter((x) => x.type === 'track').map((x) => x.id);
                    return renderTrackRow(store, t, { contextQueue: trackQueue, showAlbum: true });
                  }
                }
                return `
              <div class="list-row">
                <button class="list-row-main" data-action="nav" data-route="${it.type}" data-id="${escapeHtml(it.id)}">
                  ${renderArtwork({ src: it.artwork, alt: it.title, seed: it.seed, size: '50px', round: it.round })}
                  <div style="min-width:0;flex:1;">
                    <div class="list-row-title truncate">${escapeHtml(it.title)}</div>
                    <div class="list-row-sub truncate">${escapeHtml(it.subtitle)}</div>
                  </div>
                </button>
                ${icon('chevron_right', { size: 19 })}
              </div>
            `;
              })
              .join('')}
          </div>
        `
      }
    </main>
  `;
}

// 4. NOW PLAYING STUDIO
function renderNowPlayingScreen(store) {
  const track = store.getCurrentTrack();
  const liked = store.isLiked(track.id);
  const pct = track.duration > 0 ? Math.min(100, (store.currentTime / track.duration) * 100) : 0;
  const remaining = Math.max(0, track.duration - store.currentTime);
  const tab = store.ui.npActiveTab;
  const activeLyricIdx = store.getActiveLyricIndex(track);
  const codecLabel = track.hiRes ? 'FLAC 24/192' : track.bitrate;
  const appendQ = (store.ui.npAppendQuery || '').trim().toLowerCase();
  const appendCandidates = appendQ
    ? store.tracks.filter(
        (t) => t.title.toLowerCase().includes(appendQ) || t.artistName.toLowerCase().includes(appendQ)
      )
    : [];
  const relatedTracks = store.tracks
    .filter((t) => t.id !== track.id && (t.genre === track.genre || t.artistId === track.artistId))
    .concat(store.tracks.filter((t) => t.id !== track.id && t.genre !== track.genre && t.artistId !== track.artistId))
    .slice(0, 6);

  const isChatSheet = tab === 'chat';
  const isJamSheet = tab === 'jam';

  return `
    <div class="np-wrap">
      <div class="np-backdrop" aria-hidden="true">
        ${track.artwork ? `<img src="${escapeHtml(track.artwork)}" alt="" style="width:100%;height:100%;object-fit:cover;" referrerpolicy="no-referrer" />` : ''}
      </div>

      <!-- TOP BAR: CHEVRON | • NOW PLAYING | MORE -->
      <header class="topbar" style="background:transparent;border-bottom:none;">
        <div class="topbar-inner">
          <div class="topbar-left">
            <button class="icon-btn" style="background:var(--surface-container);" data-action="back" aria-label="Collapse Now Playing">
              ${icon('keyboard_arrow_down', { size: 22 })}
            </button>
          </div>

          <div class="np-topbar-status">
            <span class="np-status-dot ${store.isPlaying ? 'live' : ''}"></span>
            <span>NOW PLAYING</span>
          </div>

          <div class="topbar-right">
            <button class="icon-btn" style="background:var(--surface-container);" data-action="open-track-menu" data-track-id="${escapeHtml(track.id)}" aria-label="Track options">
              ${icon('more_horiz', { size: 20 })}
            </button>
          </div>
        </div>
      </header>

      <div class="np-grid">
        <!-- LEFT / PRIMARY PLAYER STACK -->
        <section class="np-left">
          <div class="np-art-frame ${store.ui.npShowLyrics ? 'is-lyrics' : ''}">
            ${
              store.ui.npShowLyrics
                ? `
              <div class="np-lyrics-stage" role="region" aria-label="Live synced lyrics">
                <div class="np-lyrics-stage-inner">
                  <div class="np-lyrics-stage-head">
                    <div class="np-lyrics-badge">
                      <span class="np-status-dot ${store.isPlaying ? 'live' : ''}"></span>
                      <span>LYRICS</span>
                    </div>
                    <div class="np-lyrics-head-controls">
                      <button class="np-lyrics-chip" data-action="lyric-offset" data-delta="-100" title="Shift lyrics -100ms">-100ms</button>
                      <span class="mono" style="font-size:10px;opacity:0.7;">${store.ui.npLyricOffsetMs >= 0 ? '+' : ''}${store.ui.npLyricOffsetMs}ms</span>
                      <button class="np-lyrics-chip" data-action="lyric-offset" data-delta="100" title="Shift lyrics +100ms">+100ms</button>
                      <button class="np-lyrics-icon-btn" data-action="toggle-ui-bool" data-key="npLyricsFullView" aria-label="Full screen lyrics" title="Expand Full Screen">
                        ${icon('open_in_full', { size: 15 })}
                      </button>
                      <button class="np-lyrics-chip np-lyrics-close" data-action="toggle-ui-bool" data-key="npShowLyrics" aria-label="Show album artwork" title="Show Album Cover">
                        ${icon('image', { size: 14 })} Cover
                      </button>
                    </div>
                  </div>
                  ${
                    !store.settings.syncedLyrics
                      ? `
                    <div class="np-lyrics-disabled">
                      <p>Synced lyrics are turned off in Settings.</p>
                      <button class="btn btn-primary btn-sm" data-action="toggle-setting" data-key="syncedLyrics">Enable Synced Lyrics</button>
                    </div>
                  `
                      : `
                    <div class="np-lyrics-stage-scroll no-scrollbar" data-lyrics-scroller="stage" data-track-id="${escapeHtml(track.id)}">
                      ${renderWordSyncedLyrics(track, activeLyricIdx, 'np-stage-lyric-line')}
                    </div>
                  `
                  }
                </div>
              </div>
            `
                : `
              ${renderArtwork({
                src: track.artwork,
                alt: track.title,
                seed: track.artworkSeed,
                square: true,
                round: 'round-lg',
              })}
              <canvas id="np-visualizer" class="np-visualizer-overlay" width="420" height="28" aria-label="Live audio frequency spectrum"></canvas>
            `
            }
          </div>

          <!-- TITLE + ARTIST + CODEC BADGE (CLICKABLE FOR 5-BAND EQ) -->
          <div class="np-title-row">
            <div style="min-width:0;flex:1;">
              <h1 class="np-track-title truncate">${escapeHtml(track.title)}</h1>
              <button class="np-track-artist truncate" data-action="nav" data-route="artist" data-id="${escapeHtml(track.artistId)}">
                ${escapeHtml(track.artistName)}
              </button>
            </div>
            <button class="codec-badge" data-action="open-eq" title="Open 5-Band Equalizer">
              <span>${escapeHtml(codecLabel)}</span>
            </button>
          </div>

          <!-- SCRUBBER WITH FLOATING TIME PILL -->
          <div class="scrubber-stage">
            <div class="scrubber-bubble" data-bind-bubble style="left:${pct.toFixed(2)}%;">${formatTime(store.currentTime)}</div>
            <div class="scrubber-track">
              <div class="scrubber-rail np-scrubber-rail">
                <div class="scrubber-fill" data-bind-progress style="width:${pct.toFixed(2)}%;"></div>
              </div>
              <div class="scrubber-thumb np-scrubber-thumb" data-bind-thumb style="left:${pct.toFixed(2)}%;"></div>
              <input
                type="range"
                class="scrubber-input"
                min="0"
                max="${track.duration}"
                step="0.5"
                value="${Math.floor(store.currentTime)}"
                data-action="seek"
                data-bind-range
                aria-label="Seek track timeline"
              />
            </div>
            <div class="scrubber-times">
              <span data-bind-elapsed>${formatTime(store.currentTime)}</span>
              <span data-bind-remaining>-${formatTime(remaining)}</span>
            </div>
          </div>

          <!-- TRANSPORT CONTROLS WITH SHUFFLE & REPEAT INDICATOR DOTS -->
          <div class="np-transport">
            <div class="transport-btn-wrap">
              <button class="icon-btn" data-action="toggle-shuffle" aria-label="Shuffle">
                ${icon('shuffle', { size: 22 })}
              </button>
              ${store.shuffle ? `<span class="transport-dot"></span>` : ''}
            </div>

            <button class="icon-btn" data-action="prev-track" aria-label="Previous track">
              ${icon('skip_previous', { filled: true, size: 30 })}
            </button>

            <button class="play-master-btn" data-action="toggle-play" aria-label="${store.isPlaying ? 'Pause' : 'Play'}">
              ${icon(store.isPlaying ? 'pause' : 'play_arrow', { filled: true, size: 36 })}
            </button>

            <button class="icon-btn" data-action="next-track" aria-label="Next track">
              ${icon('skip_next', { filled: true, size: 30 })}
            </button>

            <div class="transport-btn-wrap">
              <button class="icon-btn" data-action="cycle-repeat" aria-label="Repeat mode">
                ${icon(store.repeat === 'one' ? 'repeat_one' : 'repeat', { size: 22 })}
              </button>
              ${store.repeat !== 'off' ? `<span class="transport-dot"></span>` : ''}
            </div>
          </div>

          <!-- 5 CIRCULAR ACTION BUTTONS (LIKE, LYRICS, QUEUE, CHAT, JAM) -->
          <div class="np-actions-5">
            <button class="np-act ${liked ? 'is-liked' : ''}" data-action="toggle-like" data-track-id="${escapeHtml(track.id)}">
              <span class="np-act-circle">${icon('favorite', { filled: liked, size: 20 })}</span>
              <span>Like</span>
            </button>

            <button class="np-act ${store.ui.npShowLyrics ? 'is-active' : ''}" data-action="toggle-ui-bool" data-key="npShowLyrics" aria-pressed="${store.ui.npShowLyrics}">
              <span class="np-act-circle">${icon('subject', { size: 20 })}</span>
              ${store.ui.npShowLyrics ? `<span class="np-act-dot"></span>` : ''}
              <span>Lyrics</span>
            </button>

            <button class="np-act ${tab === 'queue' ? 'is-active' : ''}" data-action="set-ui" data-key="npActiveTab" data-value="queue">
              <span class="np-act-circle">
                ${icon('queue_music', { size: 20 })}
                <span class="count-pill">${store.queue.length}</span>
              </span>
              ${tab === 'queue' ? `<span class="np-act-dot"></span>` : ''}
              <span>Queue</span>
            </button>

            <button class="np-act ${tab === 'chat' ? 'is-active' : ''}" data-action="set-ui" data-key="npActiveTab" data-value="chat">
              <span class="np-act-circle">${icon('chat_bubble_outline', { size: 19 })}</span>
              ${tab === 'chat' ? `<span class="np-act-dot"></span>` : ''}
              <span>Chat</span>
            </button>

            <button class="np-act ${tab === 'jam' ? 'is-active' : ''}" data-action="set-ui" data-key="npActiveTab" data-value="jam">
              <span class="np-act-circle">${icon('group', { size: 20 })}</span>
              ${tab === 'jam' || store.jam.active ? `<span class="np-act-dot"></span>` : ''}
              <span>Jam</span>
            </button>
          </div>
        </section>

        <!-- RIGHT / BOTTOM ELEVATED STUDIO SHEET -->
        <section class="np-sheet-elevated">
          <div class="np-sheet-handle-bar" aria-hidden="true">
            <div class="np-sheet-handle"></div>
          </div>

          ${
            isChatSheet
              ? renderNowPlayingChatSheet(store)
              : isJamSheet
                ? renderNowPlayingJamSheet(store)
                : renderNowPlayingDefaultSheet(store, track, tab, appendCandidates, relatedTracks)
          }
        </section>
      </div>
    </div>
  `;
}

function renderNowPlayingDefaultSheet(store, track, tab, appendCandidates, relatedTracks) {
  const activeLyricIdx = store.getActiveLyricIndex ? store.getActiveLyricIndex(track) : -1;
  return `
    <div class="np-sheet-top">
      <div class="np-sheet-pills no-scrollbar" role="tablist">
        <button class="np-pill-tab ${tab === 'queue' || tab === 'lyrics' ? 'active' : ''}" data-action="set-ui" data-key="npActiveTab" data-value="queue">UP NEXT</button>
        <button class="np-pill-tab ${tab === 'jam' ? 'active' : ''}" data-action="set-ui" data-key="npActiveTab" data-value="jam">JAM</button>
        <button class="np-pill-tab ${tab === 'chat' ? 'active' : ''}" data-action="set-ui" data-key="npActiveTab" data-value="chat">CHAT</button>
        <button class="np-pill-tab ${tab === 'related' ? 'active' : ''}" data-action="set-ui" data-key="npActiveTab" data-value="related">RELATED</button>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
        <span class="section-meta">${store.queue.length} TRACKS</span>
        <button class="icon-btn icon-btn-sm" data-action="toggle-ui-bool" data-key="npAppendOpen" aria-label="Add tracks to queue" title="Add tracks to queue">
          ${icon(store.ui.npAppendOpen ? 'keyboard_arrow_down' : 'keyboard_arrow_up', { size: 19 })}
        </button>
      </div>
    </div>

    ${
      tab === 'queue'
        ? `
      ${
        store.ui.npAppendOpen
          ? `
        <div style="padding:0 16px 10px;display:flex;flex-direction:column;gap:8px;">
          <div class="search-box search-box-pill">
            ${icon('add_circle', { size: 18 })}
            <input
              id="np-append-input"
              type="text"
              placeholder="Search catalog to append to Up Next..."
              value="${escapeHtml(store.ui.npAppendQuery)}"
              data-input-ui="npAppendQuery"
            />
            ${
              store.ui.npAppendQuery
                ? `<button class="icon-btn icon-btn-sm" data-action="set-ui" data-key="npAppendQuery" data-value="">${icon('close', { size: 16 })}</button>`
                : ''
            }
          </div>
          ${
            appendCandidates.length > 0
              ? `
            <div class="list-card">
              ${appendCandidates
                .slice(0, 4)
                .map(
                  (c) => `
                <div class="list-row">
                  <div class="list-row-main">
                    ${renderArtwork({ src: c.artwork, alt: c.title, seed: c.artworkSeed, size: '36px', round: 'round-sm' })}
                    <div style="min-width:0;">
                      <div class="list-row-title truncate">${escapeHtml(c.title)}</div>
                      <div class="list-row-sub truncate">${escapeHtml(c.artistName)}</div>
                    </div>
                  </div>
                  <button class="btn btn-secondary btn-sm" data-action="add-to-queue" data-track-id="${escapeHtml(c.id)}">Append</button>
                </div>
              `
                )
                .join('')}
            </div>
          `
              : ''
          }
        </div>
      `
          : ''
      }

      <div class="np-queue-list">
        ${store.queue
          .map((tid, idx) => {
            const t = store.getTrackById(tid);
            if (!t) return '';
            const isCur = idx === store.queueIndex;
            return `
              <div class="np-queue-row ${isCur ? 'is-current' : ''}">
                <span class="np-grip" aria-hidden="true">${icon('drag_indicator', { size: 18 })}</span>
                <button class="list-row-main" style="gap:11px;" data-action="play-queue-index" data-index="${idx}">
                  ${renderArtwork({
                    src: t.artwork,
                    alt: t.title,
                    seed: t.artworkSeed,
                    size: '44px',
                    round: 'round-sm',
                    playing: isCur && store.isPlaying,
                  })}
                  <div style="min-width:0;flex:1;">
                    <div class="list-row-title truncate">${escapeHtml(t.title)}</div>
                    <div class="list-row-sub truncate">${escapeHtml(t.artistName)} (${t.year} Master)</div>
                  </div>
                </button>
                <span class="section-meta" style="margin-right:4px;">${formatTime(t.duration)}</span>
                <button class="np-queue-play" data-action="${isCur ? 'toggle-play' : 'play-queue-index'}" data-index="${idx}" aria-label="${isCur && store.isPlaying ? 'Pause' : 'Play'} ${escapeHtml(t.title)}">
                  ${icon(isCur && store.isPlaying ? 'pause' : 'play_arrow', { filled: true, size: 18 })}
                </button>
              </div>
            `;
          })
          .join('')}
      </div>
    `
        : tab === 'lyrics'
          ? `
      <div class="sheet-body" style="padding-top:4px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:6px;">
            <button class="btn btn-secondary btn-sm" data-action="lyric-offset" data-delta="-100">-100ms</button>
            <span class="section-meta" style="min-width:68px;text-align:center;">${store.ui.npLyricOffsetMs >= 0 ? '+' : ''}${store.ui.npLyricOffsetMs}ms</span>
            <button class="btn btn-secondary btn-sm" data-action="lyric-offset" data-delta="100">+100ms</button>
          </div>
          <button class="btn btn-secondary btn-sm" data-action="toggle-ui-bool" data-key="npLyricsFullView">
            ${icon('fullscreen', { size: 16 })} Full View
          </button>
        </div>

        ${
          !store.settings.syncedLyrics
            ? `<div class="empty-state"><p>Synced Lyrics are turned off in Settings.</p><button class="btn btn-secondary btn-sm" data-action="nav" data-route="settings">Open Settings</button></div>`
            : `
          <div class="lyric-scroll">
            ${track.lyrics
              .map(
                (line, idx) => `
              <button class="lyric-line ${idx === activeLyricIdx ? 'active' : ''}" data-lyric-idx="${idx}" data-action="seek-to" data-time="${line.time}">
                ${escapeHtml(line.text)}
              </button>
            `
              )
              .join('')}
          </div>
        `
        }
      </div>
    `
          : `
      <div class="np-queue-list">
        ${relatedTracks
          .map((t) => {
            const isCur = track && track.id === t.id;
            const isPlayingHere = isCur && store.isPlaying;
            return `
          <div class="np-queue-row ${isCur ? 'is-current' : ''}">
            <span class="np-grip" aria-hidden="true">${icon('drag_indicator', { size: 18 })}</span>
            <button class="list-row-main" style="gap:11px;" data-action="${isCur ? 'toggle-play' : 'play-track'}" data-track-id="${escapeHtml(t.id)}">
              ${renderArtwork({ src: t.artwork, alt: t.title, seed: t.artworkSeed, size: '44px', round: 'round-sm', playing: isPlayingHere })}
              <div style="min-width:0;flex:1;">
                <div class="list-row-title truncate">${escapeHtml(t.title)}</div>
                <div class="list-row-sub truncate">${escapeHtml(t.artistName)} · ${escapeHtml(t.genre)}</div>
              </div>
            </button>
            <span class="section-meta" style="margin-right:2px;">${formatTime(t.duration)}</span>
            <button class="icon-btn icon-btn-sm" data-action="add-to-queue" data-track-id="${escapeHtml(t.id)}" aria-label="Add to queue" title="Add to Up Next">
              ${icon('add', { size: 18 })}
            </button>
            <button class="np-queue-play" data-action="${isCur ? 'toggle-play' : 'play-track'}" data-track-id="${escapeHtml(t.id)}" aria-label="${isPlayingHere ? 'Pause' : 'Play'} ${escapeHtml(t.title)}">
              ${icon(isPlayingHere ? 'pause' : 'play_arrow', { filled: true, size: 18 })}
            </button>
          </div>
        `;
          })
          .join('')}
      </div>
    `
    }
  `;
}

function renderChatMessagesAndComposer(store, placeholder) {
  const quickEmojis = ['🔥', '🤍', '🎧', '✨', '🙌', 'Pure stillness', 'This drop is insane!'];
  const userInitials =
    (store.settings.displayName || 'YO')
      .trim()
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || 'YO';

  return `
    <div class="np-chat-feed">
      ${store.jam.messages
        .map((m) => {
          const seed = m.self ? userInitials : m.seed || m.sender.slice(0, 2).toUpperCase();
          return `
            <div class="np-chat-row ${m.self ? 'self' : ''}">
              <div class="np-avatar" aria-hidden="true">${escapeHtml(seed)}</div>
              <div class="np-chat-col">
                <div class="np-chat-meta">
                  <span class="np-chat-name">${escapeHtml(m.self ? 'You' : m.sender)}</span>
                  <span class="np-chat-time">${formatRelativeTime(m.time)}</span>
                </div>
                <div class="np-chat-bubble">${escapeHtml(m.text)}</div>
              </div>
            </div>
          `;
        })
        .join('')}
    </div>

    <div class="np-composer-wrap">
      ${
        store.ui.npEmojiOpen
          ? `
        <div class="chip-row no-scrollbar">
          ${quickEmojis
            .map(
              (item) => `
            <button type="button" class="chip" style="height:30px;padding:0 12px;font-size:12px;" data-action="append-emoji" data-emoji="${escapeHtml(item)}">${escapeHtml(item)}</button>
          `
            )
            .join('')}
        </div>
      `
          : ''
      }
      <form class="np-composer" data-submit="jam-chat">
        <div class="np-composer-pill">
          <input
            id="np-chat-input"
            type="text"
            placeholder="${escapeHtml(placeholder)}"
            value="${escapeHtml(store.ui.npChatDraft)}"
            data-input-ui="npChatDraft"
            autocomplete="off"
          />
          <button type="button" class="icon-btn icon-btn-sm" data-action="toggle-ui-bool" data-key="npEmojiOpen" aria-label="Quick reactions">
            ${icon('sentiment_satisfied', { size: 20 })}
          </button>
        </div>
        <button type="submit" class="np-send-circle" aria-label="Send message">
          ${icon('send', { filled: true, size: 19 })}
        </button>
      </form>
    </div>
  `;
}

function renderNowPlayingChatSheet(store) {
  return `
    <div class="np-sheet-top">
      <div class="np-sheet-title-group">
        <h2 class="np-sheet-heading">Chat</h2>
        <span class="np-sheet-status">
          <span class="dot-muted"></span>
          <span>${store.jam.roomListeners || 32} listeners</span>
        </span>
      </div>
      <div style="display:flex;align-items:center;gap:4px;">
        <button class="icon-btn icon-btn-sm" data-action="share-link" data-label="OpenMusic Listening Room" aria-label="Invite listeners">
          ${icon('person_add', { size: 20 })}
        </button>
        <button class="icon-btn icon-btn-sm" data-action="set-ui" data-key="npActiveTab" data-value="queue" aria-label="Close chat">
          ${icon('close', { size: 20 })}
        </button>
      </div>
    </div>

    ${renderChatMessagesAndComposer(store, 'Share your thoughts...')}
  `;
}

function renderNowPlayingJamSheet(store) {
  const sub = store.ui.npJamSubTab || 'chat';
  const listenerCount = store.jam.listeners.length || 8;

  return `
    <div class="np-sheet-top">
      <div class="np-sheet-title-group">
        <h2 class="np-sheet-heading">Jam</h2>
        <span class="np-sheet-status">
          <span class="dot-live-green"></span>
          <span data-bind-drift>${listenerCount} listening together${store.jam.active ? ` · ${escapeHtml(store.jam.code)}` : ''}</span>
        </span>
      </div>
      <button class="icon-btn icon-btn-sm" data-action="set-ui" data-key="npActiveTab" data-value="queue" aria-label="Collapse Jam">
        ${icon('keyboard_arrow_down', { size: 22 })}
      </button>
    </div>

    <!-- FULL-WIDTH SEGMENTED PILL BAR: CHAT | SESSION INFO | LISTENERS -->
    <div class="np-jam-seg" role="tablist">
      <button class="np-jam-seg-btn ${sub === 'chat' ? 'active' : ''}" data-action="set-ui" data-key="npJamSubTab" data-value="chat">
        ${icon('chat_bubble_outline', { size: 16 })}
        <span>Chat</span>
      </button>
      <button class="np-jam-seg-btn ${sub === 'info' ? 'active' : ''}" data-action="set-ui" data-key="npJamSubTab" data-value="info">
        ${icon('info', { size: 16 })}
        <span>Session Info</span>
      </button>
      <button class="np-jam-seg-btn ${sub === 'listeners' ? 'active' : ''}" data-action="set-ui" data-key="npJamSubTab" data-value="listeners">
        ${icon('group', { size: 16 })}
        <span>Listeners</span>
      </button>
    </div>

    ${
      sub === 'chat'
        ? renderChatMessagesAndComposer(store, 'Send a message to the jam...')
        : sub === 'info'
          ? `
      <div class="sheet-body" style="padding-top:4px;">
        ${
          !store.jam.active
            ? `
          <div class="empty-state" style="padding:18px 12px;">
            <div class="empty-icon">${icon('podcasts', { size: 24 })}</div>
            <h3 class="section-title">Host or Join a Synced Jam</h3>
            <p class="page-subtitle" style="max-width:320px;">
              Generate a scannable QR room code with live millisecond drift telemetry, or join an existing room.
            </p>
            <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:8px;">
              <button class="btn btn-primary btn-sm" data-action="create-jam">${icon('add_circle', { size: 17 })} Create Jam Room</button>
              <button class="btn btn-secondary btn-sm" data-action="toggle-ui-bool" data-key="npShowJoinInput">${icon('login', { size: 17 })} Join by Code</button>
            </div>
            ${
              store.ui.npShowJoinInput
                ? `
              <form class="row-flex" style="margin-top:12px;width:100%;max-width:300px;" data-submit="join-jam">
                <input
                  id="np-join-code"
                  class="input-field mono"
                  style="flex:1;text-transform:uppercase;"
                  type="text"
                  placeholder="OM-7K4Q"
                  value="${escapeHtml(store.ui.npJoinCode)}"
                  data-input-ui="npJoinCode"
                />
                <button type="submit" class="btn btn-primary btn-sm">Join</button>
              </form>
            `
                : ''
            }
          </div>
        `
            : `
          <div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap;justify-content:center;padding:4px 0;">
            <canvas id="jam-qr" class="qr-canvas" width="148" height="148" data-qr-code="${escapeHtml(store.jam.code)}" aria-label="Jam Room QR Code"></canvas>
            <div style="flex:1;min-width:190px;display:flex;flex-direction:column;gap:10px;">
              <div class="stat-card-subtle">
                <div class="section-meta">INVITE CODE</div>
                <div class="stat-value" style="font-size:20px;">${escapeHtml(store.jam.code)}</div>
              </div>
              <div class="stat-card-subtle">
                <div class="section-meta">CLOCK DRIFT TELEMETRY</div>
                <div class="stat-value" style="font-size:18px;" data-bind-drift-val>±${store.jam.driftMs} ms</div>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button class="btn btn-secondary btn-sm" data-action="share-link" data-label="Jam Room ${escapeHtml(store.jam.code)}">
                  ${icon('content_copy', { size: 15 })} Copy Invite
                </button>
                <button class="btn btn-danger btn-sm" data-action="leave-jam">${store.jam.isHost ? 'End Jam' : 'Leave'}</button>
              </div>
            </div>
          </div>
        `
        }
      </div>
    `
          : `
      <div class="np-queue-list" style="padding:0 14px 16px;">
        ${store.jam.listeners
          .map(
            (l) => `
          <div class="list-row" style="border-radius:12px;">
            <div class="list-row-main">
              <div class="np-avatar" aria-hidden="true">${escapeHtml(l.seed || l.name.slice(0, 2).toUpperCase())}</div>
              <div>
                <div class="list-row-title">${escapeHtml(l.name)}</div>
                <div class="list-row-sub">${escapeHtml(l.role)}</div>
              </div>
            </div>
            <span class="section-meta">${l.pingMs} ms</span>
          </div>
        `
          )
          .join('')}
      </div>
    `
    }
  `;
}

// 5. ALBUM DETAIL
function renderAlbumScreen(store, albumId) {
  const album = store.getAlbumById(albumId) || store.albums[0];
  const artist = store.getArtistById(album.artistId);
  const allTracks = album.trackIds.map((id) => store.getTrackById(id)).filter(Boolean);
  const totalSec = allTracks.reduce((s, t) => s + t.duration, 0);
  const hiResCount = allTracks.filter((t) => t.hiRes).length;
  const q = (store.ui.albumFilter || '').trim().toLowerCase();
  let tracks = q
    ? allTracks.filter((t) => t.title.toLowerCase().includes(q) || t.genre.toLowerCase().includes(q))
    : [...allTracks];
  if (store.ui.albumSort === 'alpha') tracks.sort((a, b) => a.title.localeCompare(b.title));
  if (store.ui.albumSort === 'duration') tracks.sort((a, b) => b.duration - a.duration);

  const currentTrack = store.getCurrentTrack();
  const isPlayingAlbum = store.isPlaying && currentTrack && album.trackIds.includes(currentTrack.id);
  const moreByArtist = store.albums.filter((a) => a.artistId === album.artistId && a.id !== album.id);
  const similarAlbums = store.albums.filter((a) => a.id !== album.id && a.artistId !== album.artistId).slice(0, 4);
  const allOffline = allTracks.length > 0 && allTracks.every((t) => store.isDownloaded(t.id));

  const rightHtml = `
    <button class="icon-btn icon-btn-sm" data-action="share-link" data-label="${escapeHtml(album.title)}" aria-label="Share album">
      ${icon('share', { size: 18 })}
    </button>
  `;

  return `
    ${renderTopBar({ title: album.title, rightHtml })}
    <section class="album-hero-bleed">
      <div class="album-ambient-bg" aria-hidden="true">
        ${album.artwork ? `<img src="${escapeHtml(album.artwork)}" alt="" referrerpolicy="no-referrer" />` : ''}
      </div>
      <div class="container album-hero-inner">
        <div class="detail-hero">
          <div class="album-cover-stage">
            ${renderArtwork({ src: album.artwork, alt: album.title, seed: album.artworkSeed, round: 'round-lg', extraClass: 'detail-hero-art' })}
          </div>
          <div class="detail-hero-meta">
            <span class="section-meta">${escapeHtml(album.releaseType.toUpperCase())} · ${escapeHtml(album.releaseDate)} · ${escapeHtml(album.label)}</span>
            <h1 class="page-title album-display-title">${escapeHtml(album.title)}</h1>
            <div class="album-artist-row">
              <button class="album-artist-link" data-action="nav" data-route="artist" data-id="${escapeHtml(album.artistId)}">
                ${
                  artist
                    ? renderArtwork({ src: artist.avatar, alt: artist.name, seed: artist.artworkSeed, size: '28px', round: 'round-full' })
                    : ''
                }
                <span>${escapeHtml(album.artistName)}</span>
                ${icon('chevron_right', { size: 16 })}
              </button>
              <span class="section-meta">${allTracks.length} tracks · ${formatDurationLong(totalSec)}</span>
            </div>
            <p class="page-subtitle album-liner-copy">${escapeHtml(album.description)}</p>
            <div class="detail-actions">
              <button class="btn btn-primary" data-action="${isPlayingAlbum ? 'toggle-play' : 'play-queue'}" data-queue="${escapeHtml(allTracks.map((t) => t.id).join(','))}">
                ${icon(isPlayingAlbum ? 'pause' : 'play_arrow', { filled: true, size: 19 })} ${isPlayingAlbum ? 'Pause' : 'Play Album'}
              </button>
              <button class="btn btn-secondary" data-action="shuffle-queue" data-queue="${escapeHtml(allTracks.map((t) => t.id).join(','))}">
                ${icon('shuffle', { size: 18 })} Shuffle
              </button>
              <button class="btn btn-secondary" data-action="download-bulk" data-queue="${escapeHtml(allTracks.map((t) => t.id).join(','))}" data-label="${escapeHtml(album.title)}">
                ${icon(allOffline ? 'download_done' : 'download', { size: 18 })} ${allOffline ? 'Offline' : 'Sync'}
              </button>
              <button class="icon-btn icon-btn-bordered" data-action="share-link" data-label="${escapeHtml(album.title)}" aria-label="Share album">
                ${icon('share', { size: 18 })}
              </button>
            </div>
          </div>
        </div>

        <div class="album-specs-strip" aria-label="Release technical specifications">
          <div class="album-spec-item">
            <span class="section-meta">MASTERING</span>
            <strong class="mono">${hiResCount > 0 ? '24-Bit / 192 kHz' : '320 kbps Opus'}</strong>
          </div>
          <div class="album-spec-item">
            <span class="section-meta">IMPRINT</span>
            <strong>${escapeHtml(album.label)}</strong>
          </div>
          <div class="album-spec-item">
            <span class="section-meta">RELEASED</span>
            <strong class="mono">${escapeHtml(album.releaseDate)}</strong>
          </div>
          <div class="album-spec-item">
            <span class="section-meta">RUNTIME</span>
            <strong class="mono">${formatDurationLong(totalSec)}</strong>
          </div>
        </div>
      </div>
    </section>

    <main class="container section-stack album-body-stack">
      <section class="block-stack">
        <div class="tracklist-toolbar">
          <div class="search-box search-box-pill" style="flex:1;min-width:190px;max-width:340px;">
            ${icon('search', { size: 17 })}
            <input
              id="album-filter-input"
              type="text"
              placeholder="Filter tracks in album..."
              value="${escapeHtml(store.ui.albumFilter)}"
              data-input-ui="albumFilter"
            />
          </div>
          <button class="btn btn-secondary btn-sm" data-action="cycle-album-sort">
            ${icon('sort', { size: 16 })} Sort: ${store.ui.albumSort === 'track' ? 'Track Order' : store.ui.albumSort === 'alpha' ? 'A–Z' : 'Duration'}
          </button>
        </div>

        <div class="list-card list-sheet">
          ${tracks.map((t, i) => renderTrackRow(store, t, { index: i, showRank: true, contextQueue: tracks.map((x) => x.id) })).join('')}
        </div>
      </section>

      <footer class="album-credits-foot">
        <span class="section-meta">© ${album.year} ${escapeHtml(album.label)} · ${escapeHtml(album.artistName)}</span>
        <span class="section-meta">${hiResCount}/${allTracks.length} HI-RES VERIFIED MASTERS</span>
      </footer>

      ${
        moreByArtist.length > 0
          ? `
        <section class="block-stack">
          <div class="section-header">
            <h2 class="section-title">More by ${escapeHtml(album.artistName)}</h2>
            <button class="text-link-btn" data-action="nav" data-route="artist" data-id="${escapeHtml(album.artistId)}">
              Artist Profile ${icon('chevron_right', { size: 16 })}
            </button>
          </div>
          <div class="card-grid-4">
            ${moreByArtist
              .map(
                (al, idx) => `
              <button class="media-card stagger-item" style="--stagger-i:${idx};" data-action="nav" data-route="album" data-id="${escapeHtml(al.id)}">
                ${renderArtwork({ src: al.artwork, alt: al.title, seed: al.artworkSeed, square: true, round: 'round-md' })}
                <div class="list-row-title truncate" style="margin-top:10px;">${escapeHtml(al.title)}</div>
                <div class="list-row-sub truncate">${escapeHtml(al.releaseType)} · ${al.year}</div>
              </button>
            `
              )
              .join('')}
          </div>
        </section>
      `
          : ''
      }

      ${
        similarAlbums.length > 0
          ? `
        <section class="block-stack">
          <div class="section-header">
            <h2 class="section-title">Explore Catalog Releases</h2>
            <button class="text-link-btn" data-action="nav" data-route="albums">All Albums ${icon('chevron_right', { size: 16 })}</button>
          </div>
          <div class="card-grid-4">
            ${similarAlbums
              .map(
                (al, idx) => `
              <button class="media-card stagger-item" style="--stagger-i:${idx};" data-action="nav" data-route="album" data-id="${escapeHtml(al.id)}">
                ${renderArtwork({ src: al.artwork, alt: al.title, seed: al.artworkSeed, square: true, round: 'round-md' })}
                <div class="list-row-title truncate" style="margin-top:10px;">${escapeHtml(al.title)}</div>
                <div class="list-row-sub truncate">${escapeHtml(al.artistName)} · ${al.year}</div>
              </button>
            `
              )
              .join('')}
          </div>
        </section>
      `
          : ''
      }
    </main>
  `;
}

// 6. PLAYLIST DETAIL
function renderPlaylistScreen(store, playlistId) {
  const pl = store.getPlaylistById(playlistId) || store.playlists[0];
  const allTracks = pl.trackIds.map((id) => store.getTrackById(id)).filter(Boolean);
  const totalSec = allTracks.reduce((s, t) => s + t.duration, 0);
  const q = (store.ui.playlistFilter || '').trim().toLowerCase();
  const tracks = q
    ? allTracks.filter((t) => t.title.toLowerCase().includes(q) || t.artistName.toLowerCase().includes(q))
    : allTracks;
  const allOffline = allTracks.length > 0 && allTracks.every((t) => store.isDownloaded(t.id));

  return `
    ${renderTopBar({ title: pl.title })}
    <main class="container section-stack">
      <section class="detail-hero">
        ${renderArtwork({ src: pl.artwork, alt: pl.title, seed: pl.artworkSeed, round: 'round-lg', extraClass: 'detail-hero-art' })}
        <div class="detail-hero-meta">
          <span class="section-meta">${pl.isPrivate ? 'PRIVATE PLAYLIST' : 'CURATED PLAYLIST'} · ${escapeHtml(pl.curator.toUpperCase())}</span>
          <h1 class="page-title">${escapeHtml(pl.title)}</h1>
          <p class="page-subtitle">${escapeHtml(pl.description)}</p>
          <div class="section-meta">${allTracks.length} tracks · ${allTracks.length ? formatDurationLong(totalSec) : '0 min'}</div>
          <div class="detail-actions">
            <button class="btn btn-primary" ${allTracks.length === 0 ? 'disabled' : ''} data-action="play-playlist" data-id="${escapeHtml(pl.id)}">
              ${icon('play_arrow', { filled: true, size: 19 })} Play
            </button>
            <button class="btn btn-secondary" ${allTracks.length === 0 ? 'disabled' : ''} data-action="shuffle-playlist" data-id="${escapeHtml(pl.id)}">
              ${icon('shuffle', { size: 18 })} Shuffle
            </button>
            <button class="btn btn-secondary" ${allTracks.length === 0 ? 'disabled' : ''} data-action="download-bulk" data-queue="${escapeHtml(allTracks.map((t) => t.id).join(','))}" data-label="${escapeHtml(pl.title)}">
              ${icon(allOffline ? 'download_done' : 'download', { size: 18 })} ${allOffline ? 'Offline' : 'Sync'}
            </button>
            <button class="icon-btn icon-btn-bordered" data-action="share-link" data-label="${escapeHtml(pl.title)}" aria-label="Share playlist">
              ${icon('share', { size: 18 })}
            </button>
            ${
              pl.isUserCreated
                ? `<button class="icon-btn icon-btn-bordered" data-action="delete-playlist" data-id="${escapeHtml(pl.id)}" aria-label="Delete playlist">${icon('delete_outline', { size: 18 })}</button>`
                : ''
            }
          </div>
        </div>
      </section>

      <section class="block-stack">
        <div class="search-box search-box-pill" style="max-width:340px;">
          ${icon('search', { size: 17 })}
          <input
            id="playlist-filter-input"
            type="text"
            placeholder="Find in playlist..."
            value="${escapeHtml(store.ui.playlistFilter)}"
            data-input-ui="playlistFilter"
          />
        </div>

        ${
          tracks.length === 0
            ? `
          <div class="empty-state surface-card">
            <div class="empty-icon">${icon('queue_music', { size: 24 })}</div>
            <h3 class="section-title">${allTracks.length === 0 ? 'This playlist is empty' : 'No matching tracks'}</h3>
            <p class="page-subtitle">Open any track's menu (•••) and choose "Add to Playlist" to populate this collection.</p>
          </div>
        `
            : `
          <div class="list-card">
            ${tracks
              .map((t, i) =>
                renderTrackRow(store, t, {
                  index: i,
                  contextQueue: tracks.map((x) => x.id),
                  playlistId: pl.isUserCreated ? pl.id : null,
                  showAlbum: true,
                })
              )
              .join('')}
          </div>
        `
        }
      </section>
    </main>
  `;
}

// 7. ARTIST DETAIL
function renderArtistScreen(store, artistId) {
  const artist = store.getArtistById(artistId) || store.artists[0];
  const followed = store.isFollowed(artist.id);
  const artistTracks = store.tracks.filter((t) => t.artistId === artist.id);
  const artistAlbums = store.albums.filter((a) => a.artistId === artist.id);
  const latestRelease = [...artistAlbums].sort((a, b) => b.year - a.year)[0] || null;
  const discogTab = store.ui.artistDiscogTab;
  const currentTrack = store.getCurrentTrack();
  const isPlayingArtist = store.isPlaying && currentTrack && currentTrack.artistId === artist.id;

  const filteredAlbums =
    discogTab === 'albums'
      ? artistAlbums.filter((a) => a.releaseType === 'Album')
      : discogTab === 'singles'
        ? artistAlbums.filter((a) => a.releaseType !== 'Album')
        : artistAlbums;

  const featuringPlaylists = store.playlists.filter((pl) =>
    pl.trackIds.some((tid) => artistTracks.some((t) => t.id === tid))
  );
  const relatedArtists = store.artists.filter((a) => a.id !== artist.id);

  const rightHtml = `
    <button class="icon-btn icon-btn-sm" data-action="share-link" data-label="${escapeHtml(artist.name)}" aria-label="Share artist">
      ${icon('share', { size: 18 })}
    </button>
  `;

  return `
    ${renderTopBar({ title: artist.name, rightHtml })}

    <!-- FULL-BLEED PANORAMIC ARTIST HERO -->
    <section class="artist-hero-bleed">
      ${renderArtwork({ src: artist.banner, alt: artist.name, seed: artist.artworkSeed, extraClass: 'fill-abs artist-hero-img' })}
      <div class="artist-hero-scrim" aria-hidden="true"></div>
      <div class="container artist-hero-inner">
        <div class="artist-banner-head">
          <div class="artist-banner-avatar">
            ${renderArtwork({ src: artist.avatar, alt: artist.name, seed: artist.artworkSeed, size: '104px', round: 'round-full' })}
          </div>
          <div style="min-width:0;flex:1;">
            <div class="artist-verified-line">
              ${artist.verified ? `${icon('verified', { filled: true, size: 16 })} <span>Verified Artist</span>` : '<span>Independent Studio Artist</span>'}
              <span aria-hidden="true">·</span>
              <span>${escapeHtml(artist.origin)}</span>
            </div>
            <h1 class="artist-hero-name">${escapeHtml(artist.name)}</h1>
            <div class="artist-hero-meta mono">
              <span>${escapeHtml(artist.monthlyListeners)} monthly listeners</span>
              <span aria-hidden="true">·</span>
              <span>${escapeHtml(artist.globalRank)}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <main class="container section-stack artist-body-stack">
      <!-- UNIFIED ACTIONS + INLINE STATS BAR -->
      <section class="artist-command-strip">
        <div class="artist-action-row">
          <button class="btn btn-primary" data-action="${isPlayingArtist ? 'toggle-play' : 'play-queue'}" data-queue="${escapeHtml(artistTracks.map((t) => t.id).join(','))}">
            ${icon(isPlayingArtist ? 'pause' : 'play_arrow', { filled: true, size: 20 })} ${isPlayingArtist ? 'Pause' : 'Play'}
          </button>
          <button class="btn btn-secondary" data-action="shuffle-queue" data-queue="${escapeHtml(artistTracks.map((t) => t.id).join(','))}">
            ${icon('shuffle', { size: 18 })} Shuffle
          </button>
          <button class="btn btn-secondary" data-action="play-artist-radio" data-id="${escapeHtml(artist.id)}">
            ${icon('radio', { size: 18 })} Radio
          </button>
          <button class="btn ${followed ? 'btn-primary' : 'btn-secondary'}" data-action="toggle-follow" data-id="${escapeHtml(artist.id)}">
            ${icon(followed ? 'check' : 'person_add', { size: 18 })} ${followed ? 'Following' : 'Follow'}
          </button>
        </div>

        <div class="artist-stats-bar">
          <div class="artist-stat-cell">
            <span class="section-meta">LISTENERS</span>
            <strong class="mono">${escapeHtml(artist.monthlyListeners)}</strong>
          </div>
          <div class="artist-stat-cell">
            <span class="section-meta">IMPRINT</span>
            <strong>${escapeHtml(artist.primaryLabel)}</strong>
          </div>
          <div class="artist-stat-cell">
            <span class="section-meta">CATALOG</span>
            <strong class="mono">${artistAlbums.length} releases · ${artistTracks.length} tracks</strong>
          </div>
        </div>
      </section>

      <!-- POPULAR TRACKS (EDGE-ATTACHED) -->
      <section class="block-stack">
        <div class="section-header">
          <h2 class="section-title">Popular</h2>
          <span class="section-meta">${artistTracks.length} STUDIO MASTERS</span>
        </div>
        <div class="list-card list-sheet">
          ${artistTracks
            .map((t, i) =>
              renderTrackRow(store, t, {
                index: i,
                showRank: true,
                contextQueue: artistTracks.map((x) => x.id),
                showAlbum: true,
              })
            )
            .join('')}
        </div>
      </section>

      <!-- LATEST RELEASE SPOTLIGHT -->
      ${
        latestRelease
          ? `
        <section class="block-stack">
          <div class="section-header">
            <h2 class="section-title">Latest Release</h2>
            <span class="section-meta">${escapeHtml(latestRelease.releaseDate)}</span>
          </div>
          <div class="artist-latest-card surface-card">
            <button class="artist-latest-art" data-action="nav" data-route="album" data-id="${escapeHtml(latestRelease.id)}">
              ${renderArtwork({ src: latestRelease.artwork, alt: latestRelease.title, seed: latestRelease.artworkSeed, square: true, round: 'round-md' })}
            </button>
            <div class="artist-latest-info">
              <span class="section-meta">${escapeHtml(latestRelease.releaseType.toUpperCase())} · ${latestRelease.trackIds.length} TRACKS · ${escapeHtml(latestRelease.label)}</span>
              <h3 class="artist-latest-title">${escapeHtml(latestRelease.title)}</h3>
              <p class="page-subtitle">${escapeHtml(latestRelease.description)}</p>
              <div class="artist-latest-actions">
                <button class="btn btn-primary btn-sm" data-action="play-queue" data-queue="${escapeHtml(latestRelease.trackIds.join(','))}">
                  ${icon('play_arrow', { filled: true, size: 17 })} Play Release
                </button>
                <button class="btn btn-secondary btn-sm" data-action="nav" data-route="album" data-id="${escapeHtml(latestRelease.id)}">
                  Open Album ${icon('chevron_right', { size: 16 })}
                </button>
              </div>
            </div>
          </div>
        </section>
      `
          : ''
      }

      <!-- DISCOGRAPHY WITH SEGMENTED TABS -->
      <section class="block-stack">
        <div class="section-header" style="flex-wrap:wrap;">
          <h2 class="section-title">Discography</h2>
          <div class="segmented">
            <button class="segmented-btn ${discogTab === 'popular' ? 'active' : ''}" data-action="set-ui" data-key="artistDiscogTab" data-value="popular">All</button>
            <button class="segmented-btn ${discogTab === 'albums' ? 'active' : ''}" data-action="set-ui" data-key="artistDiscogTab" data-value="albums">Albums</button>
            <button class="segmented-btn ${discogTab === 'singles' ? 'active' : ''}" data-action="set-ui" data-key="artistDiscogTab" data-value="singles">Singles &amp; EPs</button>
          </div>
        </div>
        <div class="tab-panel" data-tab-panel="artist-discog">
          ${
            filteredAlbums.length === 0
              ? `<div class="surface-card" style="padding:20px;color:var(--secondary);font-size:13px;">No releases in this category yet.</div>`
              : `
            <div class="card-grid-4">
              ${filteredAlbums
                .map(
                  (al, idx) => `
                <button class="media-card stagger-item" style="--stagger-i:${idx};" data-action="nav" data-route="album" data-id="${escapeHtml(al.id)}">
                  ${renderArtwork({ src: al.artwork, alt: al.title, seed: al.artworkSeed, square: true, round: 'round-md' })}
                  <div class="list-row-title truncate" style="margin-top:10px;">${escapeHtml(al.title)}</div>
                  <div class="list-row-sub truncate">${escapeHtml(al.releaseType)} · ${al.year}</div>
                </button>
              `
                )
                .join('')}
            </div>
          `
          }
        </div>
      </section>

      ${
        featuringPlaylists.length > 0
          ? `
        <section class="block-stack">
          <h2 class="section-title">Featuring ${escapeHtml(artist.name)}</h2>
          <div class="card-grid-4">
            ${featuringPlaylists
              .map(
                (pl, idx) => `
              <button class="media-card stagger-item" style="--stagger-i:${idx};" data-action="nav" data-route="playlist" data-id="${escapeHtml(pl.id)}">
                ${renderArtwork({ src: pl.artwork, alt: pl.title, seed: pl.artworkSeed, square: true, round: 'round-md' })}
                <div class="list-row-title truncate" style="margin-top:10px;">${escapeHtml(pl.title)}</div>
                <div class="list-row-sub truncate">${escapeHtml(pl.subtitle)}</div>
              </button>
            `
              )
              .join('')}
          </div>
        </section>
      `
          : ''
      }

      <!-- EDITORIAL ABOUT & STUDIO PROFILE -->
      <section class="surface-card artist-about-grid">
        <div class="artist-about-media">
          ${renderArtwork({ src: artist.banner, alt: artist.name, seed: artist.artworkSeed, extraClass: 'fill-abs' })}
          <div class="media-scrim"></div>
          <div class="artist-about-caption">
            <span class="mono" style="font-size:11px;opacity:0.82;">${escapeHtml(artist.origin.toUpperCase())}</span>
            <strong style="font-size:18px;font-weight:800;">${escapeHtml(artist.monthlyListeners)}</strong>
            <span style="font-size:12px;opacity:0.84;">Monthly Listeners</span>
          </div>
        </div>
        <div class="artist-about-copy">
          <div class="section-header">
            <h2 class="section-title">About</h2>
            <span class="section-meta">${escapeHtml(artist.primaryLabel.toUpperCase())}</span>
          </div>
          <p style="font-size:14px;color:var(--on-surface-variant);line-height:1.68;">${escapeHtml(artist.bio)}</p>
          <div class="artist-about-foot mono">
            <span>RANKING: ${escapeHtml(artist.globalRank)}</span>
            <span>·</span>
            <span>${artist.verified ? 'VERIFIED STUDIO ARCHIVE' : 'INDEPENDENT ARCHIVE'}</span>
          </div>
        </div>
      </section>

      <!-- RELATED ARTISTS -->
      <section class="block-stack">
        <div class="section-header">
          <h2 class="section-title">Listeners Also Explore</h2>
          <button class="text-link-btn" data-action="nav" data-route="artists">All Artists ${icon('chevron_right', { size: 16 })}</button>
        </div>
        <div class="h-scroll no-scrollbar">
          ${relatedArtists
            .map(
              (a, idx) => `
            <button class="artist-bubble stagger-item" style="--stagger-i:${idx};" data-action="nav" data-route="artist" data-id="${escapeHtml(a.id)}">
              ${renderArtwork({ src: a.avatar, alt: a.name, seed: a.artworkSeed, size: '116px', round: 'round-full' })}
              <div class="list-row-title truncate" style="width:100%;margin-top:10px;">${escapeHtml(a.name)}</div>
              <div class="list-row-sub truncate" style="width:100%;">${escapeHtml(a.origin)}</div>
            </button>
          `
            )
            .join('')}
        </div>
      </section>
    </main>
  `;
}

// 8. ALBUMS BROWSER
function renderAlbumsBrowser(store) {
  const tab = store.ui.albumsTab;
  const tabs = ['Top', 'Most time', 'Most played', 'Liked', 'Downloaded'];
  let albums = [...store.albums];

  if (tab === 'Liked') {
    albums = albums.filter((al) => al.trackIds.some((id) => store.isLiked(id)));
  } else if (tab === 'Downloaded') {
    albums = albums.filter((al) => al.trackIds.some((id) => store.isDownloaded(id)));
  } else if (tab === 'Most played') {
    const counts = {};
    store.history.forEach((h) => {
      const t = store.getTrackById(h.trackId);
      if (t) counts[t.albumId] = (counts[t.albumId] || 0) + 1;
    });
    albums.sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0));
  } else if (tab === 'Most time') {
    const secs = {};
    store.history.forEach((h) => {
      const t = store.getTrackById(h.trackId);
      if (t) secs[t.albumId] = (secs[t.albumId] || 0) + h.listenedSec;
    });
    albums.sort((a, b) => (secs[b.id] || 0) - (secs[a.id] || 0));
  }

  return `
    ${renderTopBar({ title: 'Albums' })}
    <main class="container section-stack">
      <div class="chip-row no-scrollbar">
        ${tabs
          .map(
            (t) => `
          <button class="chip ${tab === t ? 'active' : ''}" data-action="set-ui" data-key="albumsTab" data-value="${escapeHtml(t)}">${escapeHtml(t)}</button>
        `
          )
          .join('')}
      </div>
      ${
        albums.length === 0
          ? `<div class="empty-state surface-card"><div class="empty-icon">${icon('album', { size: 24 })}</div><p>No albums in "${escapeHtml(tab)}" yet.</p></div>`
          : `
        <div class="card-grid-4">
          ${albums
            .map(
              (al) => `
            <button class="media-card" data-action="nav" data-route="album" data-id="${escapeHtml(al.id)}">
              ${renderArtwork({ src: al.artwork, alt: al.title, seed: al.artworkSeed, square: true, round: 'round-md' })}
              <div class="list-row-title truncate" style="margin-top:10px;">${escapeHtml(al.title)}</div>
              <div class="list-row-sub truncate">${escapeHtml(al.artistName)} · ${al.year}</div>
            </button>
          `
            )
            .join('')}
        </div>
      `
      }
    </main>
  `;
}

// 9. ARTISTS BROWSER
function renderArtistsBrowser(store) {
  const tab = store.ui.artistsTab;
  const tabs = ['All', 'Liked', 'Downloaded', 'Following'];
  let artists = [...store.artists];

  if (tab === 'Following') {
    artists = artists.filter((a) => store.isFollowed(a.id));
  } else if (tab === 'Liked') {
    artists = artists.filter((a) => store.tracks.some((t) => t.artistId === a.id && store.isLiked(t.id)));
  } else if (tab === 'Downloaded') {
    artists = artists.filter((a) => store.tracks.some((t) => t.artistId === a.id && store.isDownloaded(t.id)));
  }

  return `
    ${renderTopBar({ title: 'Artists' })}
    <main class="container section-stack">
      <div class="chip-row no-scrollbar">
        ${tabs
          .map(
            (t) => `
          <button class="chip ${tab === t ? 'active' : ''}" data-action="set-ui" data-key="artistsTab" data-value="${escapeHtml(t)}">${escapeHtml(t)}</button>
        `
          )
          .join('')}
      </div>
      ${
        artists.length === 0
          ? `<div class="empty-state surface-card"><div class="empty-icon">${icon('person', { size: 24 })}</div><p>No artists matched "${escapeHtml(tab)}".</p></div>`
          : `
        <div class="artist-grid">
          ${artists
            .map(
              (a) => `
            <button class="artist-card" data-action="nav" data-route="artist" data-id="${escapeHtml(a.id)}">
              <div class="artist-card-thumb">
                ${renderArtwork({ src: a.avatar, alt: a.name, seed: a.artworkSeed, square: true, round: 'round-full' })}
              </div>
              <div class="list-row-title truncate" style="width:100%;margin-top:12px;">${escapeHtml(a.name)}</div>
              <div class="list-row-sub truncate" style="width:100%;">${escapeHtml(a.origin)}</div>
            </button>
          `
            )
            .join('')}
        </div>
      `
      }
    </main>
  `;
}

// 10. PLAYLISTS BROWSER
function renderPlaylistsBrowser(store) {
  const tab = store.ui.playlistsTab;
  const tabs = ['Yours', 'Featured', 'Downloaded'];
  let playlists = [...store.playlists];

  if (tab === 'Yours') {
    playlists = playlists.filter((p) => p.isUserCreated || p.curator === 'You' || p.curator === store.settings.displayName);
    if (playlists.length === 0) playlists = store.playlists;
  } else if (tab === 'Featured') {
    playlists = playlists.filter((p) => p.featured);
  } else if (tab === 'Downloaded') {
    playlists = playlists.filter((p) => p.trackIds.some((id) => store.isDownloaded(id)));
  }

  const rightHtml = `<button class="btn btn-primary btn-sm" data-action="open-create-playlist">${icon('add', { size: 17 })} New Playlist</button>`;

  return `
    ${renderTopBar({ title: 'Playlists', rightHtml })}
    <main class="container section-stack">
      <div class="chip-row no-scrollbar">
        ${tabs
          .map(
            (t) => `
          <button class="chip ${tab === t ? 'active' : ''}" data-action="set-ui" data-key="playlistsTab" data-value="${escapeHtml(t)}">${escapeHtml(t)}</button>
        `
          )
          .join('')}
      </div>
      <div class="card-grid-4">
        ${playlists
          .map(
            (pl) => `
          <button class="media-card" data-action="nav" data-route="playlist" data-id="${escapeHtml(pl.id)}">
            ${renderArtwork({ src: pl.artwork, alt: pl.title, seed: pl.artworkSeed, square: true, round: 'round-md' })}
            <div class="list-row-title truncate" style="margin-top:10px;">${escapeHtml(pl.title)}</div>
            <div class="list-row-sub truncate">${pl.trackIds.length} tracks · ${escapeHtml(pl.curator)}</div>
          </button>
        `
          )
          .join('')}
      </div>
    </main>
  `;
}

// 11. CHARTS
function renderChartsScreen(store) {
  const activeTab = store.ui.chartsTab || 'Global Top 10';
  const chartTabs = ['Global Top 10', 'Hi-Res 24-Bit', 'Trending Now', 'Ambient & Trance'];

  const baseRanked = store.tracks
    .filter((t) => typeof t.chartRank === 'number')
    .sort((a, b) => a.chartRank - b.chartRank);

  let ranked = [...baseRanked];
  if (activeTab === 'Hi-Res 24-Bit') {
    ranked = store.tracks.filter((t) => t.hiRes);
  } else if (activeTab === 'Trending Now') {
    ranked = [...store.tracks].sort((a, b) => (b.year - a.year) || ((a.chartRank || 99) - (b.chartRank || 99))).slice(0, 10);
  } else if (activeTab === 'Ambient & Trance') {
    ranked = store.tracks.filter((t) => /ambient|trance|progressive|downtempo/i.test(t.genre));
  }
  if (ranked.length === 0) ranked = baseRanked;

  const deltas = ['—', '▲ 2', '▲ 1', 'NEW', '▼ 1', '▲ 3', '—', '▲ 1', 'NEW', '▼ 2'];
  const topTrack = ranked[0];
  const podium = ranked.slice(0, 3);
  const totalSec = ranked.reduce((s, t) => s + t.duration, 0);
  const currentTrack = store.getCurrentTrack();
  const isPlayingChart = store.isPlaying && currentTrack && ranked.some((t) => t.id === currentTrack.id);
  const allOffline = ranked.every((t) => store.isDownloaded(t.id));

  const subtitles = {
    'Global Top 10': `Daily lossless index across Stockholm, Berlin, and Reykjavik · ${store.settings.country}`,
    'Hi-Res 24-Bit': 'Highest-played 24-bit / 192 kHz master recordings ranked by audiophile listening hours.',
    'Trending Now': 'Fastest-rising studio cuts and late-night sessions surging across listening rooms.',
    'Ambient & Trance': 'Deep spatial synthesis, modular pads, and hypnotic progressive trance leaders.',
  };

  return `
    ${renderTopBar({ title: 'Global Charts' })}

    <!-- FULL-BLEED EDITORIAL CHART HERO -->
    <section class="charts-hero-bleed">
      <div class="album-ambient-bg" aria-hidden="true">
        ${topTrack?.artwork ? `<img src="${escapeHtml(topTrack.artwork)}" alt="" referrerpolicy="no-referrer" />` : ''}
      </div>
      <div class="container charts-hero-inner">
        <div class="chip-row no-scrollbar" role="tablist" aria-label="Chart categories">
          ${chartTabs
            .map(
              (c) => `
            <button class="chip ${activeTab === c ? 'active' : ''}" data-action="set-ui" data-key="chartsTab" data-value="${escapeHtml(c)}">${escapeHtml(c)}</button>
          `
            )
            .join('')}
        </div>

        <div class="detail-hero" style="margin-top:8px;">
          ${
            topTrack
              ? renderArtwork({
                  src: topTrack.artwork,
                  alt: topTrack.title,
                  seed: topTrack.artworkSeed,
                  round: 'round-lg',
                  badge: '#1 LEADER',
                  extraClass: 'detail-hero-art',
                })
              : renderVaultHeroArt(ranked, { iconName: 'leaderboard', code: 'TOP 10', label: 'Charts' })
          }
          <div class="detail-hero-meta">
            <span class="section-meta">WEEKLY EDITORIAL INDEX · ${escapeHtml(activeTab.toUpperCase())}</span>
            <h1 class="page-title">${escapeHtml(activeTab)}</h1>
            <p class="page-subtitle">${escapeHtml(subtitles[activeTab] || subtitles['Global Top 10'])}</p>
            ${
              topTrack
                ? `<div class="section-meta">LEADING: <strong style="color:var(--on-surface);">${escapeHtml(topTrack.title)}</strong> · ${escapeHtml(topTrack.artistName)} · ${ranked.length} tracks · ${formatDurationLong(totalSec)}</div>`
                : ''
            }
            <div class="detail-actions">
              <button class="btn btn-primary" data-action="${isPlayingChart ? 'toggle-play' : 'play-queue'}" data-queue="${escapeHtml(ranked.map((t) => t.id).join(','))}">
                ${icon(isPlayingChart ? 'pause' : 'play_arrow', { filled: true, size: 19 })} ${isPlayingChart ? 'Pause' : 'Play Chart'}
              </button>
              <button class="btn btn-secondary" data-action="shuffle-queue" data-queue="${escapeHtml(ranked.map((t) => t.id).join(','))}">
                ${icon('shuffle', { size: 18 })} Shuffle
              </button>
              <button class="btn btn-secondary" data-action="download-bulk" data-queue="${escapeHtml(ranked.map((t) => t.id).join(','))}" data-label="${escapeHtml(activeTab)}">
                ${icon(allOffline ? 'download_done' : 'download', { size: 18 })} ${allOffline ? 'Synced' : 'Sync All'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <main class="container section-stack charts-body-stack" data-tab-panel="charts-view">
      <!-- TOP 3 PODIUM SHOWCASE -->
      ${
        podium.length >= 3
          ? `
        <section class="block-stack">
          <div class="section-header">
            <h2 class="section-title">Top 3 Podium</h2>
            <span class="section-meta">UPDATED DAILY</span>
          </div>
          <div class="charts-podium">
            ${podium
              .map((t, idx) => {
                const isCur = currentTrack && currentTrack.id === t.id;
                const isPlayingHere = isCur && store.isPlaying;
                const delta = deltas[idx] || '—';
                const deltaCls = delta.startsWith('▲') ? 'is-up' : delta === 'NEW' ? 'is-new' : 'is-flat';
                return `
                  <div class="podium-card stagger-item ${isCur ? 'is-current' : ''}" style="--stagger-i:${idx};">
                    <div class="podium-top">
                      <span class="podium-rank mono">${String(idx + 1).padStart(2, '0')}</span>
                      <span class="chart-delta ${deltaCls}">${escapeHtml(delta)}</span>
                    </div>
                    <button class="podium-art-btn" data-action="${isCur ? 'toggle-play' : 'play-track'}" data-track-id="${escapeHtml(t.id)}" data-queue="${escapeHtml(ranked.map((x) => x.id).join(','))}">
                      ${renderArtwork({
                        src: t.artwork,
                        alt: t.title,
                        seed: t.artworkSeed,
                        square: true,
                        round: 'round-md',
                        playing: isPlayingHere,
                      })}
                      <span class="podium-play-fab" aria-hidden="true">
                        ${icon(isPlayingHere ? 'pause' : 'play_arrow', { filled: true, size: 20 })}
                      </span>
                    </button>
                    <div class="podium-info">
                      <button class="list-row-title truncate" style="display:block;width:100%;text-align:left;" data-action="play-track" data-track-id="${escapeHtml(t.id)}" data-queue="${escapeHtml(ranked.map((x) => x.id).join(','))}">
                        ${escapeHtml(t.title)}
                      </button>
                      <button class="list-row-sub truncate" style="display:block;width:100%;text-align:left;" data-action="nav" data-route="artist" data-id="${escapeHtml(t.artistId)}">
                        ${escapeHtml(t.artistName)}
                      </button>
                    </div>
                  </div>
                `;
              })
              .join('')}
          </div>
        </section>
      `
          : ''
      }

      <!-- COMPLETE RANKED CHART LIST (EDGE-ATTACHED) -->
      <section class="block-stack">
        <div class="section-header">
          <h2 class="section-title">Full Ranking</h2>
          <span class="section-meta">${ranked.length} RANKED TRACKS</span>
        </div>
        <div class="list-card list-sheet">
          ${ranked
            .map((t, i) =>
              renderTrackRow(store, t, {
                index: i,
                showRank: true,
                rankDelta: deltas[i] || '—',
                contextQueue: ranked.map((x) => x.id),
                showAlbum: true,
              })
            )
            .join('')}
        </div>
      </section>
    </main>
  `;
}

// 12. LIKED SONGS
function renderLikedSongsScreen(store) {
  const allLiked = store.likedTrackIds.map((id) => store.getTrackById(id)).filter(Boolean);
  const q = (store.ui.likedFilter || '').trim().toLowerCase();
  const tracks = q
    ? allLiked.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.artistName.toLowerCase().includes(q) ||
          t.albumTitle.toLowerCase().includes(q)
      )
    : allLiked;
  const totalSec = allLiked.reduce((s, t) => s + t.duration, 0);

  return `
    ${renderTopBar({ title: 'Liked Songs' })}
    <main class="container container-narrow section-stack">
      <section class="detail-hero">
        ${renderVaultHeroArt(allLiked, { iconName: 'favorite', code: 'V-01', label: 'Liked Songs' })}
        <div class="detail-hero-meta">
          <span class="section-meta">VAULT 01 · PERSONAL ARCHIVE</span>
          <h1 class="page-title">Liked Songs</h1>
          <div class="section-meta">${allLiked.length} tracks · ${allLiked.length ? formatDurationLong(totalSec) : '0 min'}</div>
          <div class="detail-actions">
            <button class="btn btn-primary" ${allLiked.length === 0 ? 'disabled' : ''} data-action="play-queue" data-queue="${escapeHtml(allLiked.map((t) => t.id).join(','))}">
              ${icon('play_arrow', { filled: true, size: 19 })} Play All
            </button>
            <button class="btn btn-secondary" ${allLiked.length === 0 ? 'disabled' : ''} data-action="shuffle-queue" data-queue="${escapeHtml(allLiked.map((t) => t.id).join(','))}">
              ${icon('shuffle', { size: 18 })} Shuffle
            </button>
            <button class="btn btn-secondary" ${allLiked.length === 0 ? 'disabled' : ''} data-action="download-bulk" data-queue="${escapeHtml(allLiked.map((t) => t.id).join(','))}" data-label="Liked Songs">
              ${icon('download', { size: 18 })} Sync
            </button>
          </div>
        </div>
      </section>

      <div class="search-box search-box-pill" style="max-width:360px;">
        ${icon('search', { size: 17 })}
        <input
          id="liked-filter-input"
          type="text"
          placeholder="Search inside Liked Songs..."
          value="${escapeHtml(store.ui.likedFilter)}"
          data-input-ui="likedFilter"
        />
      </div>

      ${
        tracks.length === 0
          ? `<div class="empty-state surface-card"><div class="empty-icon">${icon('favorite_border', { size: 24 })}</div><p>${allLiked.length === 0 ? 'Tap the heart on any track to save it here.' : 'No liked tracks match your filter.'}</p></div>`
          : `
        <div class="list-card">
          ${tracks.map((t, i) => renderTrackRow(store, t, { index: i, contextQueue: tracks.map((x) => x.id), showAlbum: true })).join('')}
        </div>
      `
      }
    </main>
  `;
}

// 13. OFFLINE DOWNLOADS VAULT
function renderDownloadsScreen(store) {
  const downloadedTracks = store.downloadedTrackIds.map((id) => store.getTrackById(id)).filter(Boolean);
  const totalMb = downloadedTracks.reduce((s, t) => s + t.sizeMb, 0);
  const filter = store.ui.downloadsFilter;
  const sort = store.ui.downloadsSort;

  let filtered = downloadedTracks.filter((t) => {
    if (filter === 'Hi-Res') return t.hiRes;
    if (filter === 'Standard') return !t.hiRes;
    return true;
  });
  if (sort === 'alpha') filtered.sort((a, b) => a.title.localeCompare(b.title));
  if (sort === 'size') filtered.sort((a, b) => b.sizeMb - a.sizeMb);

  const anyRunning = store.activeDownloads.some((d) => !d.paused);
  const top8Ids = store.tracks.slice(0, 8).map((t) => t.id);

  const rightHtml = `
    <button class="icon-btn" data-action="refresh-downloads" aria-label="Verify Offline Vault">
      ${icon('sync', { size: 20, cls: store.downloadsRefreshing ? 'spin' : '' })}
    </button>
    <button class="btn btn-primary btn-sm" data-action="download-bulk" data-queue="${escapeHtml(top8Ids.join(','))}" data-label="Top 8">
      ${icon('download', { size: 16 })} Sync Top 8
    </button>
  `;

  return `
    ${renderTopBar({ title: 'Offline Vault', rightHtml })}
    <main class="container container-narrow section-stack">
      <section class="detail-hero">
        ${renderVaultHeroArt(downloadedTracks, { iconName: 'download_done', code: 'V-02', label: 'Offline Vault' })}
        <div class="detail-hero-meta">
          <span class="section-meta">VAULT 02 · LOCAL LOSSLESS STORAGE</span>
          <h1 class="page-title">Downloaded Songs</h1>
          <p class="page-subtitle">Cached locally for uninterrupted offline playback at ${escapeHtml(store.settings.downloadQuality)}.</p>
          <div class="section-meta">${downloadedTracks.length} masters · ${totalMb.toFixed(1)} MB stored</div>
          <div class="detail-actions">
            <button class="btn btn-primary" ${downloadedTracks.length === 0 ? 'disabled' : ''} data-action="play-queue" data-queue="${escapeHtml(downloadedTracks.map((t) => t.id).join(','))}">
              ${icon('play_arrow', { filled: true, size: 19 })} Play All
            </button>
            <button class="btn btn-secondary" ${downloadedTracks.length === 0 ? 'disabled' : ''} data-action="shuffle-queue" data-queue="${escapeHtml(downloadedTracks.map((t) => t.id).join(','))}">
              ${icon('shuffle', { size: 18 })} Shuffle
            </button>
          </div>
        </div>
      </section>

      <div class="stat-grid stat-grid-3">
        <div class="stat-card">
          <span class="section-meta">LOCAL STORAGE USED</span>
          <span class="stat-value">${totalMb.toFixed(1)} MB</span>
        </div>
        <div class="stat-card">
          <span class="section-meta">VERIFIED TRACKS</span>
          <span class="stat-value">${downloadedTracks.length}</span>
        </div>
        <div class="stat-card">
          <span class="section-meta">TARGET CODEC</span>
          <span class="stat-value" style="font-size:15px;margin-top:8px;">${escapeHtml(store.settings.downloadQuality)}</span>
        </div>
      </div>

      ${
        store.activeDownloads.length > 0
          ? `
        <section class="block-stack">
          <div class="section-header">
            <h2 class="section-title">In Transit (${store.activeDownloads.length})</h2>
            <button class="btn btn-secondary btn-sm" data-action="toggle-pause-all-downloads">
              ${icon(anyRunning ? 'pause' : 'play_arrow', { size: 16 })} ${anyRunning ? 'Pause All' : 'Resume All'}
            </button>
          </div>
          <div class="list-card">
            ${store.activeDownloads
              .map((d) => {
                const t = store.getTrackById(d.trackId);
                if (!t) return '';
                return `
                  <div class="list-row" style="flex-direction:column;align-items:stretch;gap:8px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
                      <div class="list-row-main">
                        ${renderArtwork({ src: t.artwork, alt: t.title, seed: t.artworkSeed, size: '40px', round: 'round-sm' })}
                        <div style="min-width:0;">
                          <div class="list-row-title truncate">${escapeHtml(t.title)}</div>
                          <div class="list-row-sub truncate">${escapeHtml(t.artistName)} · ${d.paused ? 'Paused' : `${d.progress}%`}</div>
                        </div>
                      </div>
                      <div class="list-row-right">
                        <button class="icon-btn icon-btn-sm" data-action="toggle-download-pause" data-track-id="${escapeHtml(t.id)}" aria-label="${d.paused ? 'Resume' : 'Pause'}">
                          ${icon(d.paused ? 'play_arrow' : 'pause', { size: 18 })}
                        </button>
                        <button class="icon-btn icon-btn-sm" data-action="remove-download" data-track-id="${escapeHtml(t.id)}" aria-label="Cancel download">
                          ${icon('close', { size: 18 })}
                        </button>
                      </div>
                    </div>
                    <div class="progress-bar"><div class="progress-fill" style="width:${d.progress}%;"></div></div>
                  </div>
                `;
              })
              .join('')}
          </div>
        </section>
      `
          : ''
      }

      <section class="block-stack">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
          <div class="chip-row">
            ${['All', 'Hi-Res', 'Standard']
              .map(
                (f) => `
              <button class="chip ${filter === f ? 'active' : ''}" data-action="set-ui" data-key="downloadsFilter" data-value="${f}">${f}</button>
            `
              )
              .join('')}
          </div>
          <button class="btn btn-secondary btn-sm" data-action="cycle-downloads-sort">
            ${icon('swap_vert', { size: 16 })} Sort: ${sort === 'recent' ? 'Recent' : sort === 'alpha' ? 'A–Z' : 'File Size'}
          </button>
        </div>

        ${
          filtered.length === 0
            ? `<div class="empty-state surface-card"><div class="empty-icon">${icon('cloud_download', { size: 24 })}</div><p>No offline tracks in this filter. Tap "Sync Top 8" to cache high-resolution masters.</p></div>`
            : `
          <div class="list-card">
            ${filtered
              .map((t) =>
                renderTrackRow(store, t, {
                  contextQueue: filtered.map((x) => x.id),
                  showRemoveDownload: true,
                  subtitleOverride: `${t.artistName} · ${t.bitrate} · ${t.sizeMb.toFixed(1)} MB`,
                })
              )
              .join('')}
          </div>
        `
        }
      </section>
    </main>
  `;
}

// 14. LISTENING HISTORY
function renderHistoryScreen(store) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();

  const today = store.history.filter((h) => h.playedAt >= todayMs);
  const earlier = store.history.filter((h) => h.playedAt < todayMs);

  const renderGroup = (label, entries) => {
    if (entries.length === 0) return '';
    return `
      <section class="block-stack">
        <div class="section-header">
          <h2 class="section-title">${label}</h2>
          <span class="section-meta">${entries.length} PLAYS</span>
        </div>
        <div class="list-card">
          ${entries
            .map((e) => {
              const t = store.getTrackById(e.trackId);
              if (!t) return '';
              return renderTrackRow(store, t, {
                trailingMeta: formatRelativeTime(e.playedAt),
                showAlbum: true,
              });
            })
            .join('')}
        </div>
      </section>
    `;
  };

  const rightHtml =
    store.history.length > 0
      ? `<button class="btn btn-secondary btn-sm" data-action="clear-history">${icon('delete_sweep', { size: 17 })} Clear History</button>`
      : '';

  return `
    ${renderTopBar({ title: 'Listening History', rightHtml })}
    <main class="container container-narrow section-stack">
      ${
        store.history.length === 0
          ? `<div class="empty-state surface-card"><div class="empty-icon">${icon('history', { size: 26 })}</div><h3 class="section-title">Timeline empty</h3><p class="page-subtitle">Play any track to begin logging local acoustic telemetry.</p></div>`
          : `${renderGroup('Today', today)}${renderGroup('Earlier', earlier)}`
      }
    </main>
  `;
}

// 15. ANALYTICS / TELEMETRY BAY
function renderAnalyticsScreen(store) {
  const period = store.ui.analyticsPeriod;
  const multiplier = period === 'Week' ? 1 : period === 'Month' ? 4.2 : 18.5;
  const baseSec = store.history.reduce((s, h) => s + h.listenedSec, 0) || 1800;
  const exposureHours = ((baseSec * multiplier) / 3600).toFixed(1);
  const totalPlays = Math.round(store.history.length * multiplier);
  const uniqueTracks = new Set(store.history.map((h) => h.trackId)).size;

  const rhythmBars =
    period === 'Week'
      ? [
          { label: 'Mon', val: 44 },
          { label: 'Tue', val: 62 },
          { label: 'Wed', val: 51 },
          { label: 'Thu', val: 78 },
          { label: 'Fri', val: 94, peak: true },
          { label: 'Sat', val: 85 },
          { label: 'Sun', val: 68 },
        ]
      : period === 'Month'
        ? [
            { label: 'W1', val: 58 },
            { label: 'W2', val: 74 },
            { label: 'W3', val: 92, peak: true },
            { label: 'W4', val: 81 },
          ]
        : [
            { label: 'Q1', val: 64 },
            { label: 'Q2', val: 76 },
            { label: 'Q3', val: 88 },
            { label: 'Q4', val: 96, peak: true },
          ];

  // Top artists residency
  const artistScores = new Map();
  store.history.forEach((h) => {
    const t = store.getTrackById(h.trackId);
    if (!t) return;
    artistScores.set(t.artistId, (artistScores.get(t.artistId) || 0) + h.listenedSec);
  });
  const topArtists = store.artists
    .map((a) => ({ artist: a, sec: Math.round((artistScores.get(a.id) || 240) * multiplier) }))
    .sort((a, b) => b.sec - a.sec)
    .slice(0, 4);
  const maxArtistSec = topArtists[0]?.sec || 1;

  const rightHtml = `
    <button class="btn btn-secondary btn-sm" data-action="export-telemetry">
      ${icon('download', { size: 16 })} Export JSON
    </button>
  `;

  return `
    ${renderTopBar({ title: 'Listening Insights', rightHtml })}
    <main class="container container-narrow section-stack">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
        <div>
          <span class="section-meta">LOCAL TELEMETRY BAY</span>
          <h1 class="page-title" style="margin-top:2px;">Acoustic Exposure</h1>
        </div>
        <div class="segmented">
          ${['Week', 'Month', 'Year']
            .map(
              (p) => `
            <button class="segmented-btn ${period === p ? 'active' : ''}" data-action="set-ui" data-key="analyticsPeriod" data-value="${p}">${p}</button>
          `
            )
            .join('')}
        </div>
      </div>

      <div class="stat-grid stat-grid-4">
        <div class="stat-card">
          <span class="section-meta">ACOUSTIC EXPOSURE</span>
          <span class="stat-value">${exposureHours} hr</span>
        </div>
        <div class="stat-card">
          <span class="section-meta">SESSIONS LOGGED</span>
          <span class="stat-value">${totalPlays}</span>
        </div>
        <div class="stat-card">
          <span class="section-meta">UNIQUE MASTERS</span>
          <span class="stat-value">${uniqueTracks}</span>
        </div>
        <div class="stat-card">
          <span class="section-meta">HI-RES RATIO</span>
          <span class="stat-value">84%</span>
        </div>
      </div>

      ${
        period === 'Year'
          ? `
        <section class="surface-card" style="padding:20px;background:var(--primary);color:var(--on-primary);">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
            <div>
              <span class="section-meta" style="color:inherit;opacity:0.75;">YEAR IN REVIEW · ${store.ui.analyticsYear}</span>
              <h2 style="font-size:22px;font-weight:800;margin-top:4px;">Your Signature Genre: Progressive Trance</h2>
              <p style="font-size:13.5px;opacity:0.85;margin-top:4px;">
                Peak listening window between 22:00 and 01:30 · Top artist ${escapeHtml(topArtists[0]?.artist.name || 'Solaris & Kaelen')}.
              </p>
            </div>
            <button class="btn btn-secondary btn-sm" data-action="play-queue" data-queue="${escapeHtml(store.tracks.slice(0, 6).map((t) => t.id).join(','))}">
              ${icon('play_arrow', { filled: true, size: 17 })} Replay Top Mix
            </button>
          </div>
        </section>
      `
          : ''
      }

      <section class="surface-card" style="padding:20px;">
        <div class="section-header">
          <h2 class="section-title">Daily Rhythm</h2>
          <span class="section-meta">${period.toUpperCase()} DISTRIBUTION</span>
        </div>
        <div class="bar-chart">
          ${rhythmBars
            .map(
              (b) => `
            <div class="bar-col">
              <span class="section-meta">${b.val}m</span>
              <div class="bar-track">
                <div class="bar-fill ${b.peak ? 'peak' : ''}" style="height:${b.val}%;"></div>
              </div>
              <span class="section-meta">${b.label}</span>
            </div>
          `
            )
            .join('')}
        </div>
      </section>

      <section class="block-stack">
        <div class="section-header">
          <h2 class="section-title">Top Artists Residency</h2>
          <span class="section-meta">BY LISTENING TIME</span>
        </div>
        <div class="list-card">
          ${topArtists
            .map(
              ({ artist, sec }) => `
            <div class="list-row" style="flex-direction:column;align-items:stretch;gap:8px;">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
                <button class="list-row-main" data-action="nav" data-route="artist" data-id="${escapeHtml(artist.id)}">
                  ${renderArtwork({ src: artist.avatar, alt: artist.name, seed: artist.artworkSeed, size: '42px', round: 'round-full' })}
                  <div>
                    <div class="list-row-title">${escapeHtml(artist.name)}</div>
                    <div class="list-row-sub">${escapeHtml(artist.origin)}</div>
                  </div>
                </button>
                <span class="section-meta">${formatDurationLong(sec)}</span>
              </div>
              <div class="progress-bar"><div class="progress-fill" style="width:${Math.max(12, Math.round((sec / maxArtistSec) * 100))}%;"></div></div>
            </div>
          `
            )
            .join('')}
        </div>
      </section>
    </main>
  `;
}

// 16. NOTIFICATIONS
function renderNotificationsScreen(store) {
  const cat = store.ui.notificationsCategory;
  const tabs = [
    { key: 'All', label: 'All' },
    { key: 'update', label: 'Updates' },
    { key: 'downloads', label: 'Downloads' },
    { key: 'system', label: 'System' },
  ];
  const list =
    cat === 'All'
      ? store.notifications
      : store.notifications.filter((n) => n.category === cat);

  const rightHtml = `
    <button class="btn btn-secondary btn-sm" data-action="mark-all-read">Mark All Read</button>
    <button class="icon-btn" data-action="clear-notifications" aria-label="Clear all notifications">${icon('delete_sweep', { size: 20 })}</button>
  `;

  return `
    ${renderTopBar({ title: 'Notifications', rightHtml })}
    <main class="container container-narrow section-stack">
      <div class="chip-row no-scrollbar">
        ${tabs
          .map(
            (t) => `
          <button class="chip ${cat === t.key ? 'active' : ''}" data-action="set-ui" data-key="notificationsCategory" data-value="${t.key}">${t.label}</button>
        `
          )
          .join('')}
      </div>

      ${
        list.length === 0
          ? `<div class="empty-state surface-card"><div class="empty-icon">${icon('notifications_none', { size: 26 })}</div><p>No notifications in this category.</p></div>`
          : `
        <div class="list-card">
          ${list
            .map(
              (n) => `
            <button class="list-row" style="width:100%;text-align:left;" data-action="mark-notification-read" data-id="${escapeHtml(n.id)}">
              <div class="list-row-main">
                <span class="settings-icon">
                  ${icon(n.category === 'downloads' ? 'download_done' : n.category === 'update' ? 'system_update' : 'info', { size: 19 })}
                </span>
                <div style="min-width:0;flex:1;">
                  <div style="display:flex;align-items:center;gap:8px;">
                    <span class="list-row-title">${escapeHtml(n.title)}</span>
                    ${!n.read ? `<span class="tag-mono" style="background:var(--accent);color:#fff;">NEW</span>` : ''}
                  </div>
                  <div class="list-row-sub">${escapeHtml(n.body)}</div>
                </div>
              </div>
              <span class="section-meta">${formatRelativeTime(n.timestamp)}</span>
            </button>
          `
            )
            .join('')}
        </div>
      `
      }
    </main>
  `;
}

// 17. SETTINGS
function renderSettingsScreen(store) {
  const s = store.settings;
  const tab = store.ui.settingsTab || 'All';
  const q = (store.ui.settingsSearch || '').trim().toLowerCase();

  const allLangs = ['English', 'Swedish', 'German', 'Japanese', 'Instrumental'];
  const countries = ['Sweden (SE)', 'Germany (DE)', 'United States (US)', 'United Kingdom (UK)', 'Japan (JP)', 'Iceland (IS)'];
  const qualityOptions = [
    { value: '128 kbps Opus', label: '128k Opus', tag: 'COMPACT', note: '~3.2 MB / track' },
    { value: '256 kbps Opus', label: '256k Opus', tag: 'BALANCED', note: '~6.4 MB / track' },
    { value: '320 kbps Opus', label: '320k Opus', tag: 'STUDIO', note: '~9.6 MB / track' },
    { value: '24-bit Lossless FLAC', label: '24-bit FLAC', tag: 'HI-RES', note: '~28 MB / track' },
  ];

  const initials =
    (s.displayName || 'OM')
      .trim()
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || 'OM';

  const offlineTracks = store.downloadedTrackIds.map((id) => store.getTrackById(id)).filter(Boolean);
  const offlineMb = offlineTracks.reduce((acc, t) => acc + t.sizeMb, 0);
  const telemetryMb = Math.max(0.2, +(store.history.length * 0.04).toFixed(1));
  const metaMb = Math.max(0.4, +(store.playlists.length * 0.15 + 0.4).toFixed(1));
  const totalStorageMb = offlineMb + telemetryMb + metaMb;
  const quotaMb = 250;
  const pctAudio = Math.min(88, Math.max(4, (offlineMb / quotaMb) * 100));
  const pctTelemetry = Math.min(8, Math.max(2, (telemetryMb / quotaMb) * 100));
  const pctMeta = Math.min(8, Math.max(2, (metaMb / quotaMb) * 100));

  const tabs = [
    { key: 'All', label: 'All Settings' },
    { key: 'Appearance', label: 'Appearance' },
    { key: 'Audio', label: 'Audio & DSP' },
    { key: 'Offline', label: 'Offline & Vault' },
    { key: 'System', label: 'Backup & System' },
  ];

  const matchesSection = (sectionKey, keywords) => {
    if (q) return keywords.includes(q);
    return tab === 'All' || tab === sectionKey;
  };

  const showAppearance = matchesSection(
    'Appearance',
    'appearance theme dark light nordic obsidian display name profile avatar language languages english swedish german japanese instrumental country region charts'
  );
  const showAudio = matchesSection(
    'Audio',
    'audio dsp equalizer eq biquad preset flat audiophile bass boost vocal late night quality opus flac lossless bitrate crossfade transition gapless normalization replaygain lufs volume gain lyrics synced'
  );
  const showOffline = matchesSection(
    'Offline',
    'offline vault storage quota local cache downloads downloaded masters history telemetry'
  );
  const showSystem = matchesSection(
    'System',
    'backup json export restore updates version engine dsp reset defaults about licenses terms privacy system'
  );

  const anyVisible = showAppearance || showAudio || showOffline || showSystem;
  const volPct = Math.round(store.volume * 100);

  const settingsRightHtml = `
    <button class="back-btn" data-action="toggle-setting" data-key="darkMode" aria-label="Toggle Light or Dark Theme" title="Toggle Light / Dark Theme">
      ${icon(s.darkMode ? 'light_mode' : 'dark_mode', { size: 18 })}
    </button>
  `;

  return `
    ${renderTopBar({ title: 'Settings', showBack: true, narrow: true, rightHtml: settingsRightHtml })}
    <main class="container container-narrow section-stack">
      <!-- PROFILE & STUDIO OVERVIEW BANNER -->
      <section class="settings-profile-card">
        <div class="settings-profile-head">
          <div class="settings-avatar" aria-hidden="true">${escapeHtml(initials)}</div>
          <div class="settings-identity">
            <div class="settings-identity-name truncate">${escapeHtml(s.displayName || 'Studio Listener')}</div>
            <span class="settings-identity-tag">STUDIO PROFILE · LOCAL FIRST</span>
          </div>
          <button class="btn btn-secondary btn-sm settings-eq-pill" data-action="open-eq">
            ${icon('equalizer', { size: 16 })}
            <span>${store.eq.enabled ? escapeHtml(store.eq.preset) : 'EQ Off'}</span>
          </button>
        </div>

        <form class="settings-name-form" data-submit="save-display-name">
          <input
            id="settings-display-name"
            class="input-field settings-name-input"
            type="text"
            maxlength="32"
            placeholder="Your display name"
            value="${escapeHtml(s.displayName)}"
            data-setting-input="displayName"
            aria-label="Display Name"
          />
          <button type="submit" class="btn btn-primary btn-sm">Save</button>
        </form>

        <div class="settings-metric-strip">
          <button class="settings-metric-box" data-action="nav" data-route="liked-songs">
            <span class="settings-metric-val">${store.likedTrackIds.length}</span>
            <span class="settings-metric-lbl">LIKED</span>
          </button>
          <button class="settings-metric-box" data-action="nav" data-route="downloads">
            <span class="settings-metric-val">${offlineMb.toFixed(1)} MB</span>
            <span class="settings-metric-lbl">OFFLINE</span>
          </button>
          <button class="settings-metric-box" data-action="nav" data-route="analytics">
            <span class="settings-metric-val">${store.history.length}</span>
            <span class="settings-metric-lbl">PLAYS</span>
          </button>
        </div>
      </section>

      <!-- CATEGORY TABS + INSTANT SETTINGS FILTER -->
      <div class="settings-controls-bar">
        <div class="search-box search-box-pill settings-search-box">
          ${icon('search', { size: 17 })}
          <input
            id="settings-filter-input"
            type="text"
            placeholder="Filter settings..."
            value="${escapeHtml(store.ui.settingsSearch || '')}"
            data-input-ui="settingsSearch"
            autocomplete="off"
          />
          ${
            store.ui.settingsSearch
              ? `<button class="icon-btn icon-btn-sm" style="width:26px;height:26px;" data-action="set-ui" data-key="settingsSearch" data-value="" aria-label="Clear filter">${icon('close', { size: 15 })}</button>`
              : ''
          }
        </div>

        <div class="chip-row no-scrollbar" role="tablist" aria-label="Settings categories">
          ${tabs
            .map(
              (t) => `
            <button class="chip ${!q && tab === t.key ? 'active' : ''}" data-action="set-ui" data-key="settingsTab" data-value="${t.key}">${t.label}</button>
          `
            )
            .join('')}
        </div>
      </div>

      ${
        !anyVisible
          ? `
        <div class="empty-state surface-card">
          <div class="empty-icon">${icon('tune', { size: 26 })}</div>
          <h3 class="section-title">No settings match "${escapeHtml(store.ui.settingsSearch)}"</h3>
          <p class="page-subtitle">Try searching for theme, EQ, crossfade, quality, or backup.</p>
          <button class="btn btn-secondary btn-sm" style="margin-top:6px;" data-action="set-ui" data-key="settingsSearch" data-value="">Reset Filter</button>
        </div>
      `
          : ''
      }

      <!-- 1. APPEARANCE & REGIONAL -->
      ${
        showAppearance
          ? `
        <section class="block-stack">
          <div class="section-header">
            <h2 class="section-title">Appearance &amp; Regional</h2>
            <span class="section-meta">${s.darkMode ? 'OBSIDIAN DARK' : 'NORDIC LIGHT'}</span>
          </div>
          <div class="list-card">
            <div class="settings-row settings-row-col">
              <div style="display:flex;align-items:center;gap:12px;">
                <span class="settings-icon">${icon('palette', { size: 19 })}</span>
                <div>
                  <div class="list-row-title">Studio Surface Theme</div>
                  <div class="list-row-sub">Choose your preferred monochrome acoustic workspace</div>
                </div>
              </div>

              <div class="theme-picker-grid">
                <button class="theme-option ${!s.darkMode ? 'active' : ''}" data-action="set-theme" data-mode="light" aria-pressed="${!s.darkMode}">
                  <div class="theme-preview theme-preview-light" aria-hidden="true">
                    <div class="theme-preview-bars">
                      <span class="theme-preview-pill" style="background:#181a1c;"></span>
                      <span class="theme-preview-dot" style="background:#e04d2e;"></span>
                    </div>
                    <div class="theme-preview-lines">
                      <span class="theme-preview-card" style="background:#ffffff;border:1px solid rgba(24,26,28,0.1);"></span>
                      <span class="theme-preview-card" style="background:#eeeeef;"></span>
                    </div>
                  </div>
                  <div class="theme-option-foot">
                    <div>
                      <div class="list-row-title">Nordic Paper</div>
                      <div class="section-meta">High-key light</div>
                    </div>
                    ${!s.darkMode ? icon('check_circle', { filled: true, size: 19 }) : icon('radio_button_unchecked', { size: 19 })}
                  </div>
                </button>

                <button class="theme-option ${s.darkMode ? 'active' : ''}" data-action="set-theme" data-mode="dark" aria-pressed="${s.darkMode}">
                  <div class="theme-preview theme-preview-dark" aria-hidden="true">
                    <div class="theme-preview-bars">
                      <span class="theme-preview-pill" style="background:#f3f4f6;"></span>
                      <span class="theme-preview-dot" style="background:#f26344;"></span>
                    </div>
                    <div class="theme-preview-lines">
                      <span class="theme-preview-card" style="background:#1b1d21;border:1px solid rgba(255,255,255,0.1);"></span>
                      <span class="theme-preview-card" style="background:#2b2f36;"></span>
                    </div>
                  </div>
                  <div class="theme-option-foot">
                    <div>
                      <div class="list-row-title">Obsidian Studio</div>
                      <div class="section-meta">Low-glare dark</div>
                    </div>
                    ${s.darkMode ? icon('check_circle', { filled: true, size: 19 }) : icon('radio_button_unchecked', { size: 19 })}
                  </div>
                </button>
              </div>
            </div>

            <div class="settings-row settings-row-col">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
                <div style="display:flex;align-items:center;gap:12px;">
                  <span class="settings-icon">${icon('translate', { size: 19 })}</span>
                  <div>
                    <div class="list-row-title">Music Languages</div>
                    <div class="list-row-sub">Select one or more preferred catalog languages</div>
                  </div>
                </div>
                <span class="section-meta">${s.languages.length} SELECTED</span>
              </div>
              <div class="chip-row" style="flex-wrap:wrap;overflow:visible;">
                ${allLangs
                  .map((lang) => {
                    const selected = s.languages.includes(lang);
                    return `
                      <button class="chip ${selected ? 'active' : ''}" data-action="toggle-language" data-lang="${escapeHtml(lang)}">
                        ${selected ? icon('check', { size: 15 }) : ''}
                        <span>${escapeHtml(lang)}</span>
                      </button>
                    `;
                  })
                  .join('')}
              </div>
            </div>

            <div class="settings-row">
              <div style="display:flex;align-items:center;gap:12px;">
                <span class="settings-icon">${icon('public', { size: 19 })}</span>
                <div>
                  <div class="list-row-title">Country &amp; Charts Region</div>
                  <div class="list-row-sub">Regional editorial chart alignment</div>
                </div>
              </div>
              <select class="select-field" data-setting-select="country" aria-label="Country">
                ${countries.map((c) => `<option value="${escapeHtml(c)}" ${s.country === c ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}
              </select>
            </div>
          </div>
        </section>
      `
          : ''
      }

      <!-- 2. AUDIO ENGINE & DSP -->
      ${
        showAudio
          ? `
        <section class="block-stack">
          <div class="section-header">
            <h2 class="section-title">Audio Engine &amp; DSP</h2>
            <span class="section-meta">WEB AUDIO BIQUAD · 48 KHZ</span>
          </div>
          <div class="list-card">
            <!-- INLINE 5-BAND EQ STUDIO CARD -->
            <div class="settings-row settings-row-col">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
                <div style="display:flex;align-items:center;gap:12px;">
                  <span class="settings-icon">${icon('equalizer', { size: 19 })}</span>
                  <div>
                    <div class="list-row-title">5-Band Biquad Equalizer</div>
                    <div class="list-row-sub">${store.eq.enabled ? `Active profile: ${escapeHtml(store.eq.preset)}` : 'Bypassed — flat hardware output'}</div>
                  </div>
                </div>
                <div style="display:flex;align-items:center;gap:10px;">
                  <button class="btn btn-secondary btn-sm" data-action="open-eq">Fine-Tune Bands</button>
                  <button class="switch" role="switch" aria-checked="${store.eq.enabled ? 'true' : 'false'}" data-action="toggle-eq" aria-label="Enable Equalizer">
                    <span class="switch-thumb"></span>
                  </button>
                </div>
              </div>

              <div class="eq-mini-stage ${store.eq.enabled ? '' : 'bypassed'}">
                <div class="eq-mini-bars" aria-label="Current 5-band equalizer response">
                  ${EQ_LABELS.map((freq, idx) => {
                    const gain = store.eq.bands[idx] || 0;
                    const normPct = Math.round(((gain + 12) / 24) * 100);
                    return `
                      <div class="eq-mini-col">
                        <div class="eq-mini-rail">
                          <div class="eq-mini-fill" style="height:${Math.max(10, normPct)}%;"></div>
                        </div>
                        <span class="section-meta" style="font-size:10px;">${freq}</span>
                      </div>
                    `;
                  }).join('')}
                </div>
                <div class="chip-row no-scrollbar">
                  ${Object.keys(EQ_PRESETS)
                    .map(
                      (p) => `
                    <button class="chip ${store.eq.enabled && store.eq.preset === p ? 'active' : ''}" style="height:31px;font-size:12px;" data-action="set-eq-preset" data-preset="${escapeHtml(p)}">${escapeHtml(p)}</button>
                  `
                    )
                    .join('')}
                </div>
              </div>
            </div>

            <!-- TACTILE CODEC QUALITY CARDS -->
            <div class="settings-row settings-row-col">
              <div style="display:flex;align-items:center;gap:12px;">
                <span class="settings-icon">${icon('high_quality', { size: 19 })}</span>
                <div>
                  <div class="list-row-title">Streaming &amp; Download Codec</div>
                  <div class="list-row-sub">Select acoustic resolution and Offline Vault footprint</div>
                </div>
              </div>
              <div class="quality-grid">
                ${qualityOptions
                  .map(
                    (opt) => `
                  <button class="quality-card ${s.downloadQuality === opt.value ? 'active' : ''}" data-action="set-quality" data-quality="${escapeHtml(opt.value)}">
                    <span class="section-meta" style="font-size:9.5px;letter-spacing:0.08em;">${opt.tag}</span>
                    <span style="font-size:13.5px;font-weight:700;">${opt.label}</span>
                    <span class="list-row-sub" style="font-size:11px;margin-top:0;">${opt.note}</span>
                  </button>
                `
                  )
                  .join('')}
              </div>
            </div>

            <!-- CROSSFADE SLIDER -->
            <div class="settings-row" style="flex-wrap:wrap;">
              <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:200px;">
                <span class="settings-icon">${icon('tune', { size: 19 })}</span>
                <div>
                  <div class="list-row-title">Crossfade Transition</div>
                  <div class="list-row-sub">Smooth overlap duration between queued tracks</div>
                </div>
              </div>
              <div class="settings-slider-group">
                <input
                  type="range"
                  class="settings-range"
                  min="0"
                  max="8"
                  step="0.5"
                  value="${s.crossfadeSec ?? 2}"
                  data-action="settings-crossfade"
                  aria-label="Crossfade seconds"
                />
                <span class="tag-mono" style="margin:0;min-width:52px;text-align:center;" data-bind-crossfade>${(s.crossfadeSec ?? 2) === 0 ? 'OFF' : `${Number(s.crossfadeSec ?? 2).toFixed(1)}s`}</span>
              </div>
            </div>

            <!-- MASTER OUTPUT VOLUME SLIDER -->
            <div class="settings-row" style="flex-wrap:wrap;">
              <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:200px;">
                <span class="settings-icon">${icon(store.volume === 0 ? 'volume_off' : 'volume_up', { size: 19 })}</span>
                <div>
                  <div class="list-row-title">Master Output Gain</div>
                  <div class="list-row-sub">Direct gain stage feeding the Web Audio output bus</div>
                </div>
              </div>
              <div class="settings-slider-group">
                <input
                  type="range"
                  class="settings-range"
                  min="0"
                  max="1"
                  step="0.02"
                  value="${store.volume}"
                  data-action="volume"
                  aria-label="Master output gain"
                />
                <span class="tag-mono" style="margin:0;min-width:52px;text-align:center;" data-bind-volume-pct>${volPct}%</span>
              </div>
            </div>

            <!-- PLAYBACK TOGGLES -->
            <div class="settings-row">
              <div style="display:flex;align-items:center;gap:12px;">
                <span class="settings-icon">${icon('graphic_eq', { size: 19 })}</span>
                <div>
                  <div class="list-row-title">Loudness Normalization (-14 LUFS)</div>
                  <div class="list-row-sub">Maintain consistent perceived loudness across albums</div>
                </div>
              </div>
              <button class="switch" role="switch" aria-checked="${s.normalizeAudio ? 'true' : 'false'}" data-action="toggle-setting" data-key="normalizeAudio" aria-label="Toggle Loudness Normalization">
                <span class="switch-thumb"></span>
              </button>
            </div>

            <div class="settings-row">
              <div style="display:flex;align-items:center;gap:12px;">
                <span class="settings-icon">${icon('all_inclusive', { size: 19 })}</span>
                <div>
                  <div class="list-row-title">Gapless Album Playback</div>
                  <div class="list-row-sub">Eliminate micro-pauses on continuous studio sessions</div>
                </div>
              </div>
              <button class="switch" role="switch" aria-checked="${s.gaplessPlayback ? 'true' : 'false'}" data-action="toggle-setting" data-key="gaplessPlayback" aria-label="Toggle Gapless Playback">
                <span class="switch-thumb"></span>
              </button>
            </div>

            <div class="settings-row">
              <div style="display:flex;align-items:center;gap:12px;">
                <span class="settings-icon">${icon('lyrics', { size: 19 })}</span>
                <div>
                  <div class="list-row-title">Synced Lyrics Engine</div>
                  <div class="list-row-sub">Real-time timestamped highlighting with ±100ms offset calibration</div>
                </div>
              </div>
              <button class="switch" role="switch" aria-checked="${s.syncedLyrics ? 'true' : 'false'}" data-action="toggle-setting" data-key="syncedLyrics" aria-label="Toggle Synced Lyrics">
                <span class="switch-thumb"></span>
              </button>
            </div>
          </div>
        </section>
      `
          : ''
      }

      <!-- 3. OFFLINE VAULT & STORAGE -->
      ${
        showOffline
          ? `
        <section class="block-stack">
          <div class="section-header">
            <h2 class="section-title">Offline Vault &amp; Storage</h2>
            <span class="section-meta">${totalStorageMb.toFixed(1)} MB / ${quotaMb} MB</span>
          </div>
          <div class="list-card">
            <div class="settings-row settings-row-col">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
                <div style="display:flex;align-items:center;gap:12px;">
                  <span class="settings-icon">${icon('hard_drive', { size: 19 })}</span>
                  <div>
                    <div class="list-row-title">Device Storage Allocation</div>
                    <div class="list-row-sub">${offlineTracks.length} offline masters · ${store.playlists.length} playlists · ${store.history.length} telemetry events</div>
                  </div>
                </div>
                <button class="btn btn-secondary btn-sm" data-action="nav" data-route="downloads">Manage Vault</button>
              </div>

              <div class="storage-meter" role="img" aria-label="Storage allocation breakdown">
                <div class="storage-seg-audio" style="width:${pctAudio.toFixed(1)}%;"></div>
                <div class="storage-seg-telemetry" style="width:${pctTelemetry.toFixed(1)}%;"></div>
                <div class="storage-seg-meta" style="width:${pctMeta.toFixed(1)}%;"></div>
              </div>

              <div class="storage-legend">
                <span class="legend-item"><span class="legend-dot" style="background:var(--primary);"></span>Audio Masters (${offlineMb.toFixed(1)} MB)</span>
                <span class="legend-item"><span class="legend-dot" style="background:var(--accent);"></span>Telemetry (${telemetryMb.toFixed(1)} MB)</span>
                <span class="legend-item"><span class="legend-dot" style="background:var(--secondary);"></span>Playlists &amp; Index (${metaMb.toFixed(1)} MB)</span>
              </div>
            </div>

            <div class="settings-row">
              <div style="display:flex;align-items:center;gap:12px;">
                <span class="settings-icon">${icon('history', { size: 19 })}</span>
                <div>
                  <div class="list-row-title">Listening Telemetry Cache</div>
                  <div class="list-row-sub">Stored locally on this device (capped at 3,000 events)</div>
                </div>
              </div>
              <button class="btn btn-secondary btn-sm" ${store.history.length === 0 ? 'disabled' : ''} data-action="clear-history">Clear History</button>
            </div>
          </div>
        </section>
      `
          : ''
      }

      <!-- 4. BACKUP, SYSTEM & SAFE RESET -->
      ${
        showSystem
          ? `
        <section class="block-stack">
          <div class="section-header">
            <h2 class="section-title">Backup &amp; System</h2>
            <span class="section-meta">ENGINE v0.5.1</span>
          </div>
          <div class="list-card">
            <div class="settings-row" style="flex-wrap:wrap;">
              <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:210px;">
                <span class="settings-icon">${icon('backup', { size: 19 })}</span>
                <div>
                  <div class="list-row-title">Library JSON Snapshot</div>
                  <div class="list-row-sub">
                    ${s.lastBackupAt ? `Last exported ${formatRelativeTime(s.lastBackupAt)} · ` : ''}Export or restore playlists, likes, EQ &amp; history
                  </div>
                </div>
              </div>
              <div style="display:flex;gap:8px;flex-wrap:wrap;">
                <button class="btn btn-primary btn-sm" data-action="export-backup">${icon('download', { size: 16 })} Export JSON</button>
                <label class="btn btn-secondary btn-sm" style="cursor:pointer;">
                  ${icon('upload', { size: 16 })} Restore
                  <input type="file" accept="application/json" data-action="import-backup" class="sr-only" />
                </label>
              </div>
            </div>

            <div class="settings-row">
              <div style="display:flex;align-items:center;gap:12px;">
                <span class="settings-icon">${icon('system_update', { size: 19 })}</span>
                <div>
                  <div class="list-row-title">Automatic DSP Updates</div>
                  <div class="list-row-sub">Keep OpenMusic playback &amp; lyric modules current</div>
                </div>
              </div>
              <button class="switch" role="switch" aria-checked="${s.autoUpdates ? 'true' : 'false'}" data-action="toggle-setting" data-key="autoUpdates" aria-label="Toggle Automatic Updates">
                <span class="switch-thumb"></span>
              </button>
            </div>

            <div class="settings-row">
              <div style="display:flex;align-items:center;gap:12px;">
                <span class="settings-icon">${icon('verified', { size: 19 })}</span>
                <div>
                  <div class="list-row-title">OpenMusic Studio v0.5.1</div>
                  <div class="list-row-sub">Pure HTML5 · Vanilla CSS · Web Audio API</div>
                </div>
              </div>
              <button class="btn btn-secondary btn-sm" data-action="check-updates">Check Updates</button>
            </div>

            <div class="settings-row danger-zone-row" style="flex-wrap:wrap;">
              <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:200px;">
                <span class="settings-icon" style="color:var(--error);">${icon('restart_alt', { size: 19 })}</span>
                <div>
                  <div class="list-row-title">Reset Studio Preferences</div>
                  <div class="list-row-sub">Restores theme, EQ, crossfade, and audio settings to factory defaults (keeps playlists)</div>
                </div>
              </div>
              ${
                store.ui.confirmResetSettings
                  ? `
                <div style="display:flex;align-items:center;gap:8px;">
                  <button class="btn btn-secondary btn-sm" data-action="cancel-reset-settings">Cancel</button>
                  <button class="btn btn-danger btn-sm" data-action="reset-settings">Confirm Reset</button>
                </div>
              `
                  : `<button class="btn btn-secondary btn-sm" style="color:var(--error);" data-action="confirm-reset-settings">Reset Defaults</button>`
              }
            </div>
          </div>

          <div class="settings-info-grid">
            <button class="settings-info-tile" data-action="open-info" data-type="about">
              <div>
                <div class="list-row-title">About OpenMusic</div>
                <div class="list-row-sub">Architecture &amp; build</div>
              </div>
              ${icon('chevron_right', { size: 18 })}
            </button>
            <button class="settings-info-tile" data-action="open-info" data-type="licenses">
              <div>
                <div class="list-row-title">Open Licenses</div>
                <div class="list-row-sub">Fonts &amp; icons</div>
              </div>
              ${icon('chevron_right', { size: 18 })}
            </button>
            <button class="settings-info-tile" data-action="open-info" data-type="terms">
              <div>
                <div class="list-row-title">Privacy &amp; Terms</div>
                <div class="list-row-sub">Local-first pledge</div>
              </div>
              ${icon('chevron_right', { size: 18 })}
            </button>
          </div>
        </section>
      `
          : ''
      }
    </main>
  `;
}

/* ============================================================================
 * ROUTER SWITCH
 * ========================================================================== */

export function renderScreen(store) {
  const route = store.getRoute();
  switch (route.name) {
    case 'home':
      return renderHomeScreen(store);
    case 'search':
      return renderSearchScreen(store);
    case 'library':
      return renderLibraryScreen(store);
    case 'nowplaying':
      return renderNowPlayingScreen(store);
    case 'album':
      return renderAlbumScreen(store, route.id);
    case 'playlist':
      return renderPlaylistScreen(store, route.id);
    case 'artist':
      return renderArtistScreen(store, route.id);
    case 'albums':
      return renderAlbumsBrowser(store);
    case 'artists':
      return renderArtistsBrowser(store);
    case 'playlists':
      return renderPlaylistsBrowser(store);
    case 'charts':
      return renderChartsScreen(store);
    case 'liked-songs':
      return renderLikedSongsScreen(store);
    case 'downloads':
      return renderDownloadsScreen(store);
    case 'history':
      return renderHistoryScreen(store);
    case 'analytics':
      return renderAnalyticsScreen(store);
    case 'notifications':
      return renderNotificationsScreen(store);
    case 'settings':
      return renderSettingsScreen(store);
    default:
      return renderHomeScreen(store);
  }
}

/* ============================================================================
 * MODALS, SHEETS, FULLSCREEN LYRICS & TOAST
 * ========================================================================== */

export function renderModal(store) {
  // 1. Fullscreen Lyrics Overlay
  if (store.ui.npLyricsFullView) {
    const track = store.getCurrentTrack();
    const activeIdx = store.getActiveLyricIndex(track);
    return `
      <div class="lyrics-fullscreen" role="dialog" aria-label="Full Screen Synced Lyrics">
        <div class="topbar" style="background:transparent;">
          <div class="topbar-inner">
            <div class="topbar-left">
              ${renderArtwork({ src: track.artwork, alt: track.title, seed: track.artworkSeed, size: '38px', round: 'round-sm' })}
              <div style="min-width:0;">
                <div class="list-row-title truncate">${escapeHtml(track.title)}</div>
                <div class="list-row-sub truncate">${escapeHtml(track.artistName)}</div>
              </div>
            </div>
            <div class="topbar-right">
              <button class="btn btn-secondary btn-sm" data-action="lyric-offset" data-delta="-100">-100ms</button>
              <span class="section-meta">${store.ui.npLyricOffsetMs >= 0 ? '+' : ''}${store.ui.npLyricOffsetMs}ms</span>
              <button class="btn btn-secondary btn-sm" data-action="lyric-offset" data-delta="100">+100ms</button>
              <button class="icon-btn icon-btn-bordered" data-action="close-modals" aria-label="Close full screen lyrics">
                ${icon('close', { size: 20 })}
              </button>
            </div>
          </div>
        </div>
        <div class="lyrics-fullscreen-body" data-lyrics-scroller="fullscreen" data-track-id="${escapeHtml(track.id)}">
          <div class="lyrics-fullscreen-list">
            ${renderWordSyncedLyrics(track, activeIdx, 'lyrics-fullscreen-line')}
          </div>
        </div>
      </div>
    `;
  }

  // 2. Track Context Sheet (Studio Options UI)
  if (store && store.ui && store.ui.modalTrackId) {
    const track = store.getTrackById ? store.getTrackById(store.ui.modalTrackId) : null;
    if (!track) return '';
    const liked = store.isLiked(track.id);
    const downloaded = store.isDownloaded(track.id);
    const codecLabel = track.hiRes ? 'FLAC 24/192' : track.bitrate;

    return `
      <div class="modal-backdrop" data-action="backdrop-close">
        <div class="modal-sheet options-sheet" role="dialog" aria-label="Track options">
          <div class="sheet-handle"></div>
          <div class="options-track-head">
            ${renderArtwork({ src: track.artwork, alt: track.title, seed: track.artworkSeed, size: '52px', round: 'round-md' })}
            <div style="min-width:0;flex:1;">
              <div class="options-track-title truncate">${escapeHtml(track.title)}</div>
              <div class="list-row-sub truncate">${escapeHtml(track.artistName)} · ${escapeHtml(track.albumTitle)}</div>
              <div class="options-track-meta">
                <span class="tag-mono">${escapeHtml(codecLabel)}</span>
                <span class="section-meta">${formatTime(track.duration)}</span>
              </div>
            </div>
            <button class="icon-btn icon-btn-sm" style="background:var(--surface-container);" data-action="close-modals" aria-label="Close">
              ${icon('close', { size: 18 })}
            </button>
          </div>

          ${
            store?.modal?.trackMenuPickPlaylist
              ? `
            <div class="block-stack" style="gap:10px;">
              <div class="section-header">
                <span class="section-meta">ADD TO PLAYLIST</span>
                <button class="text-link-btn" data-action="track-menu-back">${icon('arrow_back', { size: 15 })} Back</button>
              </div>
              <div class="options-group">
                ${store.playlists
                  .map(
                    (pl) => `
                  <button class="options-row" data-action="add-track-to-playlist" data-playlist-id="${escapeHtml(pl.id)}" data-track-id="${escapeHtml(track.id)}">
                    ${renderArtwork({ src: pl.artwork, alt: pl.title, seed: pl.artworkSeed, size: '38px', round: 'round-sm' })}
                    <div class="options-row-text">
                      <div class="options-row-label truncate">${escapeHtml(pl.title)}</div>
                      <div class="options-row-sub truncate">${pl.trackIds.length} tracks · ${escapeHtml(pl.curator)}</div>
                    </div>
                    ${icon('add_circle_outline', { size: 19 })}
                  </button>
                `
                  )
                  .join('')}
              </div>
            </div>
          `
              : `
            <div class="options-quick-grid">
              <button class="options-quick-btn ${liked ? 'is-active' : ''}" data-action="toggle-like" data-track-id="${escapeHtml(track.id)}">
                <span class="options-quick-icon">${icon('favorite', { filled: liked, size: 20 })}</span>
                <span>${liked ? 'Liked' : 'Like'}</span>
              </button>
              <button class="options-quick-btn" data-action="play-next" data-track-id="${escapeHtml(track.id)}">
                <span class="options-quick-icon">${icon('queue_play_next', { size: 20 })}</span>
                <span>Play Next</span>
              </button>
              <button class="options-quick-btn ${downloaded ? 'is-active' : ''}" data-action="${downloaded ? 'remove-download' : 'queue-download'}" data-track-id="${escapeHtml(track.id)}">
                <span class="options-quick-icon">${icon(downloaded ? 'download_done' : 'download', { size: 20 })}</span>
                <span>${downloaded ? 'Offline' : 'Sync'}</span>
              </button>
              <button class="options-quick-btn" data-action="share-link" data-label="${escapeHtml(track.title)}">
                <span class="options-quick-icon">${icon('share', { size: 20 })}</span>
                <span>Share</span>
              </button>
            </div>

            <div class="options-section">
              <div class="options-section-label">PLAYBACK &amp; STUDIO</div>
              <div class="options-group">
                <button class="options-row" data-action="add-to-queue" data-track-id="${escapeHtml(track.id)}">
                  <span class="options-row-icon">${icon('add_to_queue', { size: 19 })}</span>
                  <div class="options-row-text">
                    <div class="options-row-label">Add to Queue</div>
                    <div class="options-row-sub">Append to the end of Up Next</div>
                  </div>
                  <span class="options-row-chevron">${icon('chevron_right', { size: 18 })}</span>
                </button>
                <button class="options-row" data-action="open-eq">
                  <span class="options-row-icon">${icon('equalizer', { size: 19 })}</span>
                  <div class="options-row-text">
                    <div class="options-row-label">5-Band Equalizer</div>
                    <div class="options-row-sub">${store.eq.enabled ? `${escapeHtml(store.eq.preset)} profile active` : 'Bypassed — flat response'}</div>
                  </div>
                  <span class="options-row-chevron">${icon('chevron_right', { size: 18 })}</span>
                </button>
                <button class="options-row" data-action="track-menu-pick-playlist">
                  <span class="options-row-icon">${icon('playlist_add', { size: 19 })}</span>
                  <div class="options-row-text">
                    <div class="options-row-label">Add to Playlist</div>
                    <div class="options-row-sub">Save to one of ${store.playlists.length} collections</div>
                  </div>
                  <span class="options-row-chevron">${icon('chevron_right', { size: 18 })}</span>
                </button>
              </div>
            </div>

            <div class="options-section">
              <div class="options-section-label">CATALOG</div>
              <div class="options-group">
                <button class="options-row" data-action="nav-from-modal" data-route="album" data-id="${escapeHtml(track.albumId)}">
                  <span class="options-row-icon">${icon('album', { size: 19 })}</span>
                  <div class="options-row-text">
                    <div class="options-row-label">Go to Album</div>
                    <div class="options-row-sub truncate">${escapeHtml(track.albumTitle)}</div>
                  </div>
                  <span class="options-row-chevron">${icon('chevron_right', { size: 18 })}</span>
                </button>
                <button class="options-row" data-action="nav-from-modal" data-route="artist" data-id="${escapeHtml(track.artistId)}">
                  <span class="options-row-icon">${icon('person', { size: 19 })}</span>
                  <div class="options-row-text">
                    <div class="options-row-label">Go to Artist</div>
                    <div class="options-row-sub truncate">${escapeHtml(track.artistName)}</div>
                  </div>
                  <span class="options-row-chevron">${icon('chevron_right', { size: 18 })}</span>
                </button>
              </div>
            </div>
          `
          }
        </div>
      </div>
    `;
  }

  // 3. Create Playlist Dialog
  if (store?.modal?.createPlaylistOpen) {
    return `
      <div class="modal-backdrop" data-action="backdrop-close">
        <div class="modal-sheet" role="dialog" aria-label="Create Playlist">
          <div class="sheet-handle"></div>
          <div class="section-header">
            <h2 class="section-title">Create Playlist</h2>
            <button class="icon-btn icon-btn-sm" data-action="close-modals" aria-label="Close">${icon('close', { size: 19 })}</button>
          </div>
          <form class="block-stack" data-submit="create-playlist">
            <div class="block-stack" style="gap:6px;">
              <label for="create-pl-name" class="section-meta">PLAYLIST TITLE</label>
              <input
                id="create-pl-name"
                class="input-field"
                type="text"
                placeholder="e.g. Midnight Concrete Drive"
                value="${escapeHtml(store.ui.createPlaylistName)}"
                data-input-ui="createPlaylistName"
                required
              />
            </div>
            <div class="block-stack" style="gap:6px;">
              <label for="create-pl-desc" class="section-meta">DESCRIPTION (OPTIONAL)</label>
              <input
                id="create-pl-desc"
                class="input-field"
                type="text"
                placeholder="Deep progressive & studio ambient cuts"
                value="${escapeHtml(store.ui.createPlaylistDesc)}"
                data-input-ui="createPlaylistDesc"
              />
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;">
              <div>
                <div class="list-row-title">Private Playlist</div>
                <div class="list-row-sub">Keep visible only in your local vault</div>
              </div>
              <button type="button" class="switch" role="switch" aria-checked="${store.ui.createPlaylistPrivate ? 'true' : 'false'}" data-action="toggle-ui-bool" data-key="createPlaylistPrivate" aria-label="Private playlist">
                <span class="switch-thumb"></span>
              </button>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px;">
              <button type="button" class="btn btn-secondary" data-action="close-modals">Cancel</button>
              <button type="submit" class="btn btn-primary">Create</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  // 4. 5-Band Biquad EQ Modal
  if (store?.modal?.eqOpen) {
    return `
      <div class="modal-backdrop" data-action="backdrop-close">
        <div class="modal-sheet" role="dialog" aria-label="5-Band Equalizer">
          <div class="sheet-handle"></div>
          <div class="section-header">
            <div>
              <h2 class="section-title">5-Band Biquad EQ</h2>
              <div class="section-meta">LIVE WEB AUDIO DSP · ${escapeHtml(store.eq.preset.toUpperCase())}</div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;">
              <button class="switch" role="switch" aria-checked="${store.eq.enabled ? 'true' : 'false'}" data-action="toggle-eq" aria-label="Enable Equalizer">
                <span class="switch-thumb"></span>
              </button>
              <button class="icon-btn icon-btn-sm" data-action="close-modals" aria-label="Close">${icon('close', { size: 19 })}</button>
            </div>
          </div>

          <div class="chip-row no-scrollbar">
            ${Object.keys(EQ_PRESETS)
              .map(
                (p) => `
              <button class="chip ${store.eq.preset === p && store.eq.enabled ? 'active' : ''}" data-action="set-eq-preset" data-preset="${escapeHtml(p)}">${escapeHtml(p)}</button>
            `
              )
              .join('')}
          </div>

          <div class="eq-grid ${store.eq.enabled ? '' : 'disabled'}">
            ${EQ_LABELS.map(
              (label, idx) => `
              <div class="eq-band">
                <span class="section-meta" data-bind-eq-val="${idx}">${store.eq.bands[idx] >= 0 ? '+' : ''}${store.eq.bands[idx].toFixed(1)}dB</span>
                <div class="eq-slider-slot">
                  <input
                    type="range"
                    class="eq-slider"
                    min="-12"
                    max="12"
                    step="0.5"
                    value="${store.eq.bands[idx]}"
                    data-action="eq-band"
                    data-band="${idx}"
                    aria-label="${label} band gain"
                  />
                </div>
                <span class="section-meta">${label}</span>
              </div>
            `
            ).join('')}
          </div>
        </div>
      </div>
    `;
  }

  // 5. Settings Info Modal
  if (store?.modal?.infoType) {
    const copy = {
      about: {
        title: 'About OpenMusic',
        body: 'OpenMusic v0.5.1 is a Scandinavian-inspired audiophile studio player built with pure HTML5, handcrafted vanilla CSS, and a real-time Web Audio API synthesis & 5-band Biquad equalizer engine. All playlists, listening telemetry, and offline vault records live locally in your browser.',
      },
      licenses: {
        title: 'Open Source Licenses',
        body: 'Typography uses Plus Jakarta Sans and JetBrains Mono (SIL Open Font License 1.1) with Material Symbols Outlined (Apache License 2.0). Application logic and DSP audio routing are implemented natively using standard browser Web APIs.',
      },
      terms: {
        title: 'Privacy & Local-First Terms',
        body: 'OpenMusic operates with zero external tracking telemetry. Your listening history (capped at 3,000 events), equalizer profiles, playlists, and settings remain exclusively on your device and can be exported or restored anytime as JSON.',
      },
    }[store.modal.infoType];

    return `
      <div class="modal-backdrop" data-action="backdrop-close">
        <div class="modal-sheet" role="dialog" aria-label="${escapeHtml(copy.title)}">
          <div class="sheet-handle"></div>
          <div class="section-header">
            <h2 class="section-title">${escapeHtml(copy.title)}</h2>
            <button class="icon-btn icon-btn-sm" data-action="close-modals" aria-label="Close">${icon('close', { size: 19 })}</button>
          </div>
          <p style="font-size:13.5px;color:var(--on-surface-variant);line-height:1.6;">${escapeHtml(copy.body)}</p>
          <div style="display:flex;justify-content:flex-end;">
            <button class="btn btn-primary btn-sm" data-action="close-modals">Done</button>
          </div>
        </div>
      </div>
    `;
  }

  return '';
}

export function renderToast(store) {
  if (!store.toastMessage) return '';
  return `
    <div class="toast-pill">
      ${icon('check_circle', { filled: true, size: 16 })}
      <span>${escapeHtml(store.toastMessage)}</span>
    </div>
  `;
}

/* ============================================================================
 * LAYOUT-MATCHED SHIMMER SKELETON LOADERS
 * ========================================================================== */

function renderSkeletonRows(count = 6) {
  return Array.from({ length: count })
    .map(
      (_, i) => `
    <div class="skel-row" style="--stagger-i:${i};">
      <div class="skel skel-tiny"></div>
      <div class="skel skel-thumb"></div>
      <div class="skel-row-lines">
        <div class="skel skel-line" style="width:${62 - (i % 3) * 10}%;"></div>
        <div class="skel skel-line skel-line-sm" style="width:${42 + (i % 3) * 8}%;"></div>
      </div>
      <div class="skel skel-circle-sm"></div>
    </div>
  `
    )
    .join('');
}

export function renderRouteSkeleton(store) {
  const route = store.getRoute();

  if (route.name === 'artist') {
    return `
      ${renderTopBar({ title: 'Loading Artist...' })}
      <div class="skel-artist-banner skel"></div>
      <main class="container section-stack" aria-busy="true" aria-label="Loading artist">
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <div class="skel skel-pill" style="width:112px;"></div>
          <div class="skel skel-pill" style="width:104px;"></div>
          <div class="skel skel-pill" style="width:98px;"></div>
          <div class="skel skel-pill" style="width:108px;"></div>
        </div>
        <div class="list-card list-sheet">${renderSkeletonRows(5)}</div>
        <div class="card-grid-4">
          ${Array.from({ length: 4 })
            .map(
              () => `
            <div class="media-card">
              <div class="skel skel-square"></div>
              <div class="skel skel-line" style="width:74%;margin-top:12px;"></div>
              <div class="skel skel-line skel-line-sm" style="width:46%;margin-top:6px;"></div>
            </div>
          `
            )
            .join('')}
        </div>
      </main>
    `;
  }

  if (route.name === 'charts') {
    return `
      ${renderTopBar({ title: 'Global Charts' })}
      <main class="container section-stack" aria-busy="true" aria-label="Loading charts">
        <div style="display:flex;gap:8px;overflow:hidden;">
          <div class="skel skel-pill" style="width:118px;height:34px;"></div>
          <div class="skel skel-pill" style="width:104px;height:34px;"></div>
          <div class="skel skel-pill" style="width:114px;height:34px;"></div>
        </div>
        <div class="detail-hero">
          <div class="skel detail-hero-art"></div>
          <div class="detail-hero-meta" style="width:100%;">
            <div class="skel skel-line skel-line-sm" style="width:36%;"></div>
            <div class="skel skel-line skel-line-lg" style="width:68%;"></div>
            <div class="skel skel-line" style="width:84%;"></div>
            <div style="display:flex;gap:10px;margin-top:10px;">
              <div class="skel skel-pill" style="width:130px;"></div>
              <div class="skel skel-pill" style="width:104px;"></div>
            </div>
          </div>
        </div>
        <div class="charts-podium">
          ${Array.from({ length: 3 })
            .map(
              () => `
            <div class="podium-card">
              <div class="skel skel-square"></div>
              <div class="skel skel-line" style="width:72%;margin-top:10px;"></div>
              <div class="skel skel-line skel-line-sm" style="width:48%;margin-top:6px;"></div>
            </div>
          `
            )
            .join('')}
        </div>
        <div class="list-card list-sheet">${renderSkeletonRows(6)}</div>
      </main>
    `;
  }

  if (route.name === 'album' || route.name === 'playlist') {
    return `
      ${renderTopBar({ title: route.name === 'album' ? 'Loading Album...' : 'Loading Playlist...' })}
      <main class="container section-stack" aria-busy="true" aria-label="Loading release">
        <div class="detail-hero">
          <div class="skel detail-hero-art"></div>
          <div class="detail-hero-meta" style="width:100%;">
            <div class="skel skel-line skel-line-sm" style="width:44%;"></div>
            <div class="skel skel-line skel-line-lg" style="width:72%;"></div>
            <div class="skel skel-line" style="width:86%;"></div>
            <div style="display:flex;gap:10px;margin-top:10px;">
              <div class="skel skel-pill" style="width:132px;"></div>
              <div class="skel skel-pill" style="width:106px;"></div>
              <div class="skel skel-pill" style="width:94px;"></div>
            </div>
          </div>
        </div>
        <div class="list-card list-sheet">${renderSkeletonRows(6)}</div>
      </main>
    `;
  }

  if (route.name === 'albums' || route.name === 'artists' || route.name === 'playlists') {
    const isCircle = route.name === 'artists';
    return `
      ${renderTopBar({ title: route.name.charAt(0).toUpperCase() + route.name.slice(1) })}
      <main class="container section-stack" aria-busy="true" aria-label="Loading catalog">
        <div style="display:flex;gap:8px;">
          <div class="skel skel-pill" style="width:82px;height:34px;"></div>
          <div class="skel skel-pill" style="width:96px;height:34px;"></div>
          <div class="skel skel-pill" style="width:110px;height:34px;"></div>
        </div>
        <div class="${isCircle ? 'artist-grid' : 'card-grid-4'}">
          ${Array.from({ length: 8 })
            .map(
              () => `
            <div class="${isCircle ? 'artist-card' : 'media-card'}">
              <div class="skel ${isCircle ? 'skel-avatar-lg' : 'skel-square'}"></div>
              <div class="skel skel-line" style="width:70%;margin-top:12px;"></div>
              <div class="skel skel-line skel-line-sm" style="width:46%;margin-top:6px;"></div>
            </div>
          `
            )
            .join('')}
        </div>
      </main>
    `;
  }

  return `
    ${renderTopBar({ title: 'Loading...' })}
    <main class="container container-narrow section-stack" aria-busy="true" aria-label="Loading view">
      <div class="stat-grid stat-grid-4">
        ${Array.from({ length: 4 })
          .map(() => `<div class="stat-card"><div class="skel skel-line skel-line-sm" style="width:54%;"></div><div class="skel skel-line skel-line-lg" style="width:70%;margin-top:10px;"></div></div>`)
          .join('')}
      </div>
      <div class="list-card list-sheet">${renderSkeletonRows(5)}</div>
    </main>
  `;
}
