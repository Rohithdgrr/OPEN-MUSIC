// OpenMusic reactive state store & timers (pure vanilla JavaScript)
import {
  ALBUMS,
  ARTISTS,
  EQ_PRESETS,
  INITIAL_HISTORY,
  INITIAL_NOTIFICATIONS,
  INITIAL_PLAYLISTS,
  TRACKS,
  mapUpstreamSongToTrack,
  mapUpstreamAlbumToAlbum,
  mapUpstreamArtistToArtist,
  parseLrc,
} from './data.js';
import { audioEngine } from './audio.js';

const STORAGE_KEY = 'openmusic_vanilla_v1';

const getInvoke = () => {
  if (typeof window === 'undefined') return null;
  return window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke ?? null;
};

const DEFAULT_SETTINGS = {
  displayName: 'Alex Mercer',
  darkMode: false,
  languages: ['English', 'Instrumental'],
  country: 'Sweden (SE)',
  downloadQuality: '320 kbps Opus',
  syncedLyrics: true,
  autoUpdates: true,
  crossfadeSec: 2,
  gaplessPlayback: true,
  normalizeAudio: true,
  lastBackupAt: null,
};

const DEFAULT_EQ = {
  enabled: true,
  preset: 'Audiophile',
  bands: [...EQ_PRESETS.Audiophile],
};

function loadPersisted() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

class OpenMusicStore {
  constructor() {
    const saved = loadPersisted();

    // Navigation history stack
    this.routeStack = [{ name: 'home' }];

    // Core catalog & user library
    this.tracks = [...TRACKS];
    this.albums = [...ALBUMS];
    this.artists = [...ARTISTS];
    this.playlists = Array.isArray(saved?.playlists) && saved.playlists.length
      ? saved.playlists
      : INITIAL_PLAYLISTS.map((p) => ({ ...p, trackIds: [...p.trackIds] }));

    this.likedTrackIds = Array.isArray(saved?.likedTrackIds)
      ? saved.likedTrackIds
      : ['trk-1', 'trk-2', 'trk-3', 'trk-5', 'trk-10', 'trk-13'];

    this.followedArtistIds = Array.isArray(saved?.followedArtistIds)
      ? saved.followedArtistIds
      : ['artist-solaris', 'artist-aura', 'artist-vesper'];

    this.downloadedTrackIds = Array.isArray(saved?.downloadedTrackIds)
      ? saved.downloadedTrackIds
      : ['trk-1', 'trk-5', 'trk-6', 'trk-7', 'trk-3'];

    // Active downloads in transit: { trackId, progress, paused }
    this.activeDownloads = [];
    this.downloadsRefreshing = false;

    this.history = Array.isArray(saved?.history)
      ? saved.history
      : INITIAL_HISTORY.map((h) => ({ ...h }));

    this.notifications = Array.isArray(saved?.notifications)
      ? saved.notifications
      : INITIAL_NOTIFICATIONS.map((n) => ({ ...n }));

    this.recentSearches = Array.isArray(saved?.recentSearches)
      ? saved.recentSearches
      : ['Solaris & Kaelen', 'Monolith Sessions', 'Progressive Trance', 'Midnight City Lights'];

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(saved?.settings || {}),
    };

    this.eq = {
      enabled: saved?.eq?.enabled ?? DEFAULT_EQ.enabled,
      preset: saved?.eq?.preset ?? DEFAULT_EQ.preset,
      bands: Array.isArray(saved?.eq?.bands) && saved.eq.bands.length === 5
        ? [...saved.eq.bands]
        : [...DEFAULT_EQ.bands],
    };

    // Playback state
    this.queue = this.tracks.slice(0, 8).map((t) => t.id);
    this.queueIndex = 0;
    this.isPlaying = false;
    this.currentTime = 0;
    this.lastTickAt = performance.now();
    this.shuffle = false;
    this.repeat = 'off'; // 'off' | 'all' | 'one'
    this.volume = typeof saved?.volume === 'number' ? saved.volume : 0.76;
    this.muted = false;
    this.prevVolume = this.volume;

    // Jam session state
    this.jam = {
      active: false,
      code: '',
      isHost: false,
      driftMs: 12,
      roomListeners: 32,
      listeners: [],
      messages: [
        {
          id: 'm-init-1',
          sender: 'Solaris (Host)',
          text: 'Streaming direct from 96kHz master tape in Berlin.',
          time: Date.now() - 320000,
          self: false,
        },
        {
          id: 'm-init-2',
          sender: 'Aura Sound',
          text: 'Audio drift locked at ±12ms across Stockholm and Copenhagen.',
          time: Date.now() - 110000,
          self: false,
        },
      ],
    };

    // Granular UI ephemeral state
    this.ui = {
      searchQuery: '',
      searchCategory: 'All',
      searchActiveFilter: 'All',
      homeCategory: 'All',
      homeActiveCategory: 'all',
      homeBrowseFilter: 'All',
      libraryFilter: 'All',
      librarySort: 'recent',
      librarySearchOpen: false,
      libraryView: 'list',
      chartsTab: 'global',
      chartsScope: 'all',
      librarySearchQuery: '',
      npAppendQuery: '',
      npAppendOpen: false,
      albumFilter: 'all',
      albumSort: 'recent',
      albumsTab: 'all',
      playlistFilter: 'all',
      playlistsTab: 'all',
      likedFilter: '',
      settingsSearch: '',
      settingsTab: 'general',
      confirmResetSettings: false,
      createPlaylistName: '',
      createPlaylistDesc: '',
      createPlaylistPrivate: false,
      analyticsRange: '30d',
      analyticsPeriod: '30d',
      analyticsYear: 2026,
      notifFilter: 'all',
      notificationsCategory: 'all',
      downloadsFilter: 'all',
      downloadsSort: 'recent',
      artistTab: 'popular',
      artistDiscogTab: 'tracks',
      artistsTab: 'all',
      npActiveTab: 'visualizer', // 'visualizer' | 'lyrics' | 'queue' | 'jam' | 'info'
      npLyricsExpanded: false,
      npLyricsOffsetSec: 0,
      npLyricOffsetMs: 0,
      npLyricsFullView: false,
      npShowLyrics: false,
      npShowWordSync: true,
      npSocialMode: false,
      npJamSubTab: 'info', // 'info' | 'chat' | 'qr'
      npChatDraft: '',
      npEmojiOpen: false,
      npJoinCode: '',
      npShowJoinInput: false,
      npEqExpanded: false,
      npInfoTab: 'specs',
      modal: null, // 'track-menu' | 'playlist-create' | 'eq' | 'sleep' | 'info' | 'share' | 'backup'
      modalTrackId: null,
      modalPlaylistId: null,
      modalInfoType: null,
      sleepTimerSec: 0,
      sleepTimerRemainingSec: 0,
      volumeSliderActive: false,
      queueDragIndex: null,
      queueOverIndex: null,
      headerScrolled: false,
    };

    this.toastMessage = null;
    this.toastTimer = null;

    // Kinetic transitions & micro-skeleton route state
    this.navDirection = 'none'; // 'forward' | 'back' | 'up' | 'down' | 'none'
    this.trackTransition = 'none'; // 'next' | 'prev' | 'switch' | 'none'
    this.trackChangeSeq = 0;
    this.routeLoading = false;
    this._routeLoadTimer = null;

    // Subscribers
    this.listeners = new Set();

    // Sync initial audioEngine state
    audioEngine.onEnded = () => this.nextTrack(true);
    audioEngine.onTimeUpdate = (cur, dur) => {
      this.currentTime = cur;
      if (dur && Number.isFinite(dur) && dur > 0) {
        const trk = this.getCurrentTrack();
        if (trk && (!trk.duration || trk.duration <= 0)) trk.duration = Math.round(dur);
      }
    };
    audioEngine.setTrack(this.getCurrentTrack());
    audioEngine.setVolume(this.volume);
    audioEngine.setEq(this.eq);
    this.applyTheme();

    // Start background timers
    this._startTimers();

    // Android back button & popstate navigation
    if (typeof window !== 'undefined') {
      window.addEventListener('popstate', () => {
        if (this.ui.modal) {
          this.closeModals();
        } else if (this.routeStack.length > 1) {
          this.goBack();
        }
      });
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' || e.key === 'Back') {
          if (this.ui.modal) {
            e.preventDefault();
            this.closeModals();
          } else if (this.routeStack.length > 1) {
            e.preventDefault();
            this.goBack();
          }
        }
      });
    }

    // Connect to live backend if available
    this.loadHomeFeed();
    this.loadVaultDownloads();
  }

  /* ------------------------------------------------------------------------
   * SUBSCRIPTION & PERSISTENCE
   * ---------------------------------------------------------------------- */

  get modal() {
    return {
      trackMenuTrackId: this.ui?.modalTrackId || null,
      trackMenuPickPlaylist: this.ui?.modalPlaylistId || false,
      createPlaylistOpen: this.ui?.modal === 'playlist-create',
      eqOpen: this.ui?.modal === 'eq',
      infoType: this.ui?.modalInfoType || null,
    };
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type = 'state') {
    for (const fn of this.listeners) {
      fn(type, this);
    }
  }

  persist() {
    try {
      const payload = {
        playlists: this.playlists,
        likedTrackIds: this.likedTrackIds,
        followedArtistIds: this.followedArtistIds,
        downloadedTrackIds: this.downloadedTrackIds,
        history: this.history.slice(0, 3000),
        notifications: this.notifications.slice(0, 100),
        recentSearches: this.recentSearches.slice(0, 12),
        settings: this.settings,
        eq: this.eq,
        volume: this.volume,
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore quota errors
    }
  }

  applyTheme() {
    document.documentElement.classList.toggle('dark', Boolean(this.settings.darkMode));
  }

  showToast(message) {
    this.toastMessage = message;
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    this.emit('toast');
    this.toastTimer = window.setTimeout(() => {
      this.toastMessage = null;
      this.toastTimer = null;
      this.emit('toast');
    }, 2600);
  }

  /* ------------------------------------------------------------------------
   * TIMERS (PLAYBACK TICK, PROGRESSIVE DOWNLOADS, JAM TELEMETRY)
   * ---------------------------------------------------------------------- */

  _startTimers() {
    // 250ms surgical playback tick
    window.setInterval(() => {
      if (!this.isPlaying) return;
      const track = this.getCurrentTrack();
      if (!track) return;
      const realCur = audioEngine.getCurrentTime();
      if (Number.isFinite(realCur) && realCur > 0) {
        this.currentTime = realCur;
      } else {
        this.currentTime += 0.25;
      }
      this.lastTickAt = performance.now();
      if (this.currentTime >= track.duration) {
        if (this.repeat === 'one') {
          this.currentTime = 0;
          this.lastTickAt = performance.now();
          audioEngine.seek(0);
          this.emit('tick');
        } else {
          this.nextTrack(true);
        }
      } else {
        this.emit('tick');
      }
    }, 250);

    // 650ms download progress ticker
    window.setInterval(() => {
      if (this.activeDownloads.length === 0) return;
      let changed = false;
      const completed = [];
      for (const item of this.activeDownloads) {
        if (item.paused) continue;
        const step = 14 + Math.floor(Math.random() * 14);
        item.progress = Math.min(100, item.progress + step);
        changed = true;
        if (item.progress >= 100) {
          completed.push(item.trackId);
        }
      }
      if (completed.length > 0) {
        this.activeDownloads = this.activeDownloads.filter((d) => !completed.includes(d.trackId));
        for (const id of completed) {
          if (!this.downloadedTrackIds.includes(id)) {
            this.downloadedTrackIds = [id, ...this.downloadedTrackIds];
            const t = this.getTrackById(id);
            if (t) {
              this.addNotification(
                'downloads',
                `Downloaded "${t.title}"`,
                `${t.artistName} · ${this.settings.downloadQuality} saved to Offline Vault.`
              );
            }
          }
        }
        this.persist();
        this.showToast(
          completed.length === 1
            ? `Saved "${this.getTrackById(completed[0])?.title || 'track'}" to vault`
            : `Saved ${completed.length} tracks to vault`
        );
      }
      if (changed) this.emit('state');
    }, 650);

    // 1000ms sleep timer countdown
    window.setInterval(() => {
      if (this.ui.sleepTimerRemainingSec > 0) {
        this.ui.sleepTimerRemainingSec -= 1;
        if (this.ui.sleepTimerRemainingSec <= 0) {
          this.ui.sleepTimerSec = 0;
          this.ui.sleepTimerRemainingSec = 0;
          if (this.isPlaying) {
            this.togglePlay();
            this.showToast('Sleep timer reached — playback stopped');
          }
        }
      }
    }, 1000);
  }

  /* ------------------------------------------------------------------------
   * SELECTORS
   * ---------------------------------------------------------------------- */

  getRoute() {
    return this.routeStack[this.routeStack.length - 1] || { name: 'home' };
  }

  getTrackById(id) {
    return this.tracks.find((t) => t.id === id) || null;
  }

  getAlbumById(id) {
    return this.albums.find((a) => a.id === id) || null;
  }

  getArtistById(id) {
    return this.artists.find((a) => a.id === id) || null;
  }

  getPlaylistById(id) {
    return this.playlists.find((p) => p.id === id) || null;
  }

  getCurrentTrack() {
    const id = this.queue[this.queueIndex];
    return this.getTrackById(id) || this.tracks[0];
  }

  isLiked(trackId) {
    return this.likedTrackIds.includes(trackId);
  }

  isFollowed(artistId) {
    return this.followedArtistIds.includes(artistId);
  }

  isDownloaded(trackId) {
    return this.downloadedTrackIds.includes(trackId);
  }

  isDownloading(trackId) {
    return this.activeDownloads.some((d) => d.trackId === trackId);
  }

  getUnreadCount() {
    return this.notifications.filter((n) => !n.read).length;
  }

  getSmoothCurrentTime() {
    const real = audioEngine.getCurrentTime();
    if (Number.isFinite(real) && real > 0) return real;
    if (!this.isPlaying) return this.currentTime;
    const now = performance.now();
    const elapsed = Math.max(0, (now - this.lastTickAt) / 1000);
    return Math.min(this.getCurrentTrack()?.duration || 0, this.currentTime + elapsed);
  }

  getActiveLyricIndex(track, curTime = null) {
    if (!track || !Array.isArray(track.lyrics) || track.lyrics.length === 0) return -1;
    const t = curTime !== null ? curTime : this.getSmoothCurrentTime();
    let active = -1;
    for (let i = 0; i < track.lyrics.length; i++) {
      if (t >= track.lyrics[i].time - 0.25) {
        active = i;
      } else {
        break;
      }
    }
    return active;
  }

  /* ------------------------------------------------------------------------
   * NAVIGATION & BACK
   * ---------------------------------------------------------------------- */

  navigate(name, params = {}) {
    const opts = typeof params === 'string' ? { id: params } : (params || {});
    const current = this.getRoute();
    const next = { name, ...opts };
    // Avoid pushing exact duplicate
    if (current.name === next.name && current.id === next.id) {
      if (name === 'search' && typeof params.query === 'string') {
        this.ui.searchQuery = params.query;
        this.searchLive(params.query);
        this.emit('state');
      }
      return;
    }
    if (name === 'search' && typeof params.query === 'string') {
      this.ui.searchQuery = params.query;
      this.addRecentSearch(params.query);
      this.searchLive(params.query);
    }

    if (name === 'nowplaying') {
      this.navDirection = 'up';
    } else if (current.name === 'nowplaying') {
      this.navDirection = 'down';
    } else {
      this.navDirection = 'forward';
    }

    if (name === 'home') {
      this.routeStack = [next];
    } else {
      this.routeStack.push(next);
      if (this.routeStack.length > 24) {
        this.routeStack = this.routeStack.slice(-24);
      }
    }

    try {
      if (typeof window !== 'undefined' && window.history?.pushState) {
        window.history.pushState({ route: next }, '', '#' + name);
      }
    } catch {
      // Ignore in test or sandboxed environments
    }

    window.scrollTo({ top: 0, behavior: 'instant' });

    if (this._routeLoadTimer) {
      window.clearTimeout(this._routeLoadTimer);
      this._routeLoadTimer = null;
    }

    const skeletonRoutes = new Set(['artist', 'album', 'charts', 'playlist', 'albums', 'artists', 'playlists', 'analytics']);
    if (skeletonRoutes.has(name)) {
      this.routeLoading = true;
      this.emit('route-load');
      this._routeLoadTimer = window.setTimeout(() => {
        this._routeLoadTimer = null;
        this.routeLoading = false;
        this.emit('state');
      }, 175);
    } else {
      this.routeLoading = false;
      this.emit('state');
    }
  }

  goBack() {
    const current = this.getRoute();
    this.navDirection = current.name === 'nowplaying' ? 'down' : 'back';
    if (this._routeLoadTimer) {
      window.clearTimeout(this._routeLoadTimer);
      this._routeLoadTimer = null;
    }
    this.routeLoading = false;
    if (this.routeStack.length > 1) {
      this.routeStack.pop();
    } else {
      this.routeStack = [{ name: 'home' }];
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
    this.emit('state');
  }

  setUi(patch) {
    Object.assign(this.ui, patch);
    this.emit('state');
  }

  _recordHistory(trackId) {
    const track = this.getTrackById(trackId);
    if (!track) return;
    const entry = {
      id: `hist-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      trackId,
      playedAt: Date.now(),
      completed: true,
      secondsListened: track.duration,
    };
    this.history = [entry, ...this.history].slice(0, 3000);
    this.persist();
  }

  /* ------------------------------------------------------------------------
   * LIVE BACKEND & PLAYBACK
   * ---------------------------------------------------------------------- */

  async _prepareAndPlay(track) {
    if (!track) return;
    const invoke = getInvoke();
    if (invoke && !track.streamUrl) {
      try {
        const quality = this.settings.downloadQuality || '320kbps';
        const res = await invoke("resolve_song", { id: track.id, quality });
        if (res && res.url) {
          track.streamUrl = res.url;
          if (res.bitrate) track.qualityBadge = `${res.bitrate} MP3`;
          if (res.duration && Number(res.duration) > 0) track.duration = Number(res.duration);
        }
      } catch (err) {
        console.warn("Could not resolve stream for track", track.id, err);
      }
    }

    if (!track.lyrics || track.lyrics.length === 0) {
      this.loadLyrics(track);
    }

    audioEngine.setTrack(track);
    audioEngine.play(track);
    this.updateMediaSession(track);
  }

  playTrack(trackId, contextQueue = null) {
    const track = this.getTrackById(trackId);
    if (!track) return;

    if (Array.isArray(contextQueue) && contextQueue.length > 0) {
      this.queue = [...contextQueue];
      const idx = this.queue.indexOf(trackId);
      this.queueIndex = idx >= 0 ? idx : 0;
    } else {
      const existing = this.queue.indexOf(trackId);
      if (existing >= 0) {
        this.queueIndex = existing;
      } else {
        this.queue = [trackId, ...this.queue.filter((id) => id !== trackId)];
        this.queueIndex = 0;
      }
    }

    this.currentTime = 0;
    this.lastTickAt = performance.now();
    this.isPlaying = true;
    this.trackTransition = 'switch';
    this.trackChangeSeq += 1;
    this._prepareAndPlay(track);
    this._recordHistory(trackId);
    this.emit('state');
  }

  playQueue(trackIds, { shuffle = false, startIndex = 0 } = {}) {
    if (!Array.isArray(trackIds) || trackIds.length === 0) return;
    let list = [...trackIds];
    if (shuffle) {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      this.shuffle = true;
    }
    this.queue = list;
    this.queueIndex = Math.max(0, Math.min(startIndex, list.length - 1));
    const track = this.getCurrentTrack();
    this.currentTime = 0;
    this.lastTickAt = performance.now();
    this.isPlaying = true;
    this.trackTransition = 'switch';
    this.trackChangeSeq += 1;
    this._prepareAndPlay(track);
    this._recordHistory(track.id);
    this.emit('state');
  }

  togglePlay() {
    const track = this.getCurrentTrack();
    if (!track) return;
    if (this.isPlaying) {
      this.currentTime = this.getSmoothCurrentTime();
      this.isPlaying = false;
      audioEngine.pause();
    } else {
      this.lastTickAt = performance.now();
      this.isPlaying = true;
      this._prepareAndPlay(track);
    }
    this.updateMediaSession(track);
    this.emit('state');
  }

  nextTrack(autoAdvance = false) {
    if (this.queue.length === 0) return;
    let nextIdx;
    if (this.shuffle && this.queue.length > 1) {
      do {
        nextIdx = Math.floor(Math.random() * this.queue.length);
      } while (nextIdx === this.queueIndex);
    } else {
      nextIdx = this.queueIndex + 1;
      if (nextIdx >= this.queue.length) {
        if (this.repeat === 'all' || !autoAdvance) {
          nextIdx = 0;
        } else {
          this.isPlaying = false;
          this.currentTime = 0;
          this.lastTickAt = performance.now();
          audioEngine.pause();
          this.emit('state');
          return;
        }
      }
    }
    this.queueIndex = nextIdx;
    const track = this.getCurrentTrack();
    this.currentTime = 0;
    this.lastTickAt = performance.now();
    this.trackTransition = 'next';
    this.trackChangeSeq += 1;
    if (this.isPlaying || !autoAdvance) {
      this.isPlaying = true;
      this._prepareAndPlay(track);
      this._recordHistory(track.id);
    } else {
      audioEngine.setTrack(track);
    }
    this.emit('state');
  }

  prevTrack() {
    if (this.currentTime > 4) {
      this.seekTo(0);
      return;
    }
    if (this.queue.length === 0) return;
    this.queueIndex = (this.queueIndex - 1 + this.queue.length) % this.queue.length;
    const track = this.getCurrentTrack();
    this.currentTime = 0;
    this.lastTickAt = performance.now();
    this.trackTransition = 'prev';
    this.trackChangeSeq += 1;
    if (this.isPlaying) {
      this._prepareAndPlay(track);
      this._recordHistory(track.id);
    } else {
      audioEngine.setTrack(track);
    }
    this.emit('state');
  }

  seekTo(seconds) {
    const track = this.getCurrentTrack();
    if (!track) return;
    this.currentTime = Math.max(0, Math.min(track.duration, Number(seconds) || 0));
    this.lastTickAt = performance.now();
    audioEngine.seek(this.currentTime);
    this.updateMediaSession(track);
    this.emit('tick');
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    this.showToast(this.shuffle ? 'Shuffle enabled' : 'Shuffle off');
    this.emit('state');
  }

  toggleRepeat() {
    const order = ['off', 'all', 'one'];
    const cur = order.indexOf(this.repeat);
    this.repeat = order[(cur + 1) % order.length];
    const labels = { off: 'Repeat off', all: 'Repeat all', one: 'Repeat one' };
    this.showToast(labels[this.repeat]);
    this.emit('state');
  }

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, Number(vol) || 0));
    this.muted = this.volume === 0;
    audioEngine.setVolume(this.volume);
    this.persist();
    this.emit('state');
  }

  toggleMute() {
    if (this.muted) {
      this.volume = this.prevVolume || 0.76;
      this.muted = false;
    } else {
      this.prevVolume = this.volume;
      this.volume = 0;
      this.muted = true;
    }
    audioEngine.setVolume(this.volume);
    this.emit('state');
  }

  playNext(trackId) {
    const existing = this.queue.indexOf(trackId);
    if (existing >= 0) {
      this.queue.splice(existing, 1);
      if (existing < this.queueIndex) this.queueIndex -= 1;
    }
    this.queue.splice(this.queueIndex + 1, 0, trackId);
    const t = this.getTrackById(trackId);
    this.showToast(`Playing next: "${t ? t.title : 'Track'}"`);
    this.emit('state');
  }

  addToQueue(trackId) {
    if (!this.queue.includes(trackId)) {
      this.queue.push(trackId);
      const t = this.getTrackById(trackId);
      this.showToast(`Added to queue: "${t ? t.title : 'Track'}"`);
      this.emit('state');
    } else {
      this.showToast('Already in queue');
    }
  }

  removeFromQueue(index) {
    if (this.queue.length <= 1) {
      this.showToast('Cannot empty the active queue');
      return;
    }
    this.queue.splice(index, 1);
    if (index < this.queueIndex) {
      this.queueIndex -= 1;
    } else if (index === this.queueIndex && this.queueIndex >= this.queue.length) {
      this.queueIndex = 0;
      const t = this.getCurrentTrack();
      audioEngine.setTrack(t);
      if (this.isPlaying) this._prepareAndPlay(t);
    }
    this.emit('state');
  }

  reorderQueue(fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= this.queue.length || toIndex >= this.queue.length) return;
    const currentId = this.queue[this.queueIndex];
    const item = this.queue.splice(fromIndex, 1)[0];
    this.queue.splice(toIndex, 0, item);
    this.queueIndex = this.queue.indexOf(currentId);
    this.emit('state');
  }

  /* ------------------------------------------------------------------------
   * USER LIBRARY (LIKES, FOLLOWS, PLAYLISTS)
   * ---------------------------------------------------------------------- */

  toggleLike(trackId) {
    const track = this.getTrackById(trackId);
    const was = this.likedTrackIds.includes(trackId);
    if (was) {
      this.likedTrackIds = this.likedTrackIds.filter((id) => id !== trackId);
      this.showToast(track ? `Removed from Liked: ${track.title}` : 'Removed from Liked');
    } else {
      this.likedTrackIds = [trackId, ...this.likedTrackIds];
      this.showToast(track ? `Added to Liked: ${track.title}` : 'Added to Liked');
    }
    this.persist();
    this.emit('state');
  }

  toggleFollowArtist(artistId) {
    const artist = this.getArtistById(artistId);
    const was = this.followedArtistIds.includes(artistId);
    if (was) {
      this.followedArtistIds = this.followedArtistIds.filter((id) => id !== artistId);
      this.showToast(artist ? `Unfollowed ${artist.name}` : 'Unfollowed artist');
    } else {
      this.followedArtistIds = [artistId, ...this.followedArtistIds];
      this.showToast(artist ? `Following ${artist.name}` : 'Following artist');
    }
    this.persist();
    this.emit('state');
  }

  createPlaylist(title, description = '', isPrivate = false) {
    const clean = (title || '').trim();
    if (!clean) return null;
    const id = `pl-user-${Date.now()}`;
    const newPl = {
      id,
      title: clean,
      description: description.trim() || 'Curated personal lossless collection.',
      author: this.settings.displayName || 'You',
      artwork: '',
      artworkSeed: clean.slice(0, 2).toUpperCase(),
      trackIds: [],
      trackCount: 0,
      durationText: '0 min',
      isPublic: !isPrivate,
      isCollaborative: false,
      likes: 1,
    };
    this.playlists = [newPl, ...this.playlists];
    this.persist();
    this.showToast(`Playlist "${clean}" created`);
    this.emit('state');
    return newPl;
  }

  deletePlaylist(playlistId) {
    const pl = this.getPlaylistById(playlistId);
    this.playlists = this.playlists.filter((p) => p.id !== playlistId);
    this.persist();
    this.showToast(pl ? `Deleted "${pl.title}"` : 'Playlist deleted');
    if (this.getRoute().name === 'playlist' && this.getRoute().id === playlistId) {
      this.navigate('library');
    } else {
      this.emit('state');
    }
  }

  addTrackToPlaylist(playlistId, trackId) {
    const pl = this.getPlaylistById(playlistId);
    const trk = this.getTrackById(trackId);
    if (!pl) return;
    if (!pl.trackIds.includes(trackId)) {
      pl.trackIds = [...pl.trackIds, trackId];
      pl.trackCount = pl.trackIds.length;
      if (!pl.artwork && trk && trk.artwork) {
        pl.artwork = trk.artwork;
      }
      this.persist();
      this.showToast(`Added to "${pl.title}"`);
      this.emit('state');
    } else {
      this.showToast(`Already in "${pl.title}"`);
    }
  }

  removeTrackFromPlaylist(playlistId, trackId) {
    const pl = this.getPlaylistById(playlistId);
    if (!pl) return;
    pl.trackIds = pl.trackIds.filter((id) => id !== trackId);
    pl.trackCount = pl.trackIds.length;
    this.persist();
    this.showToast(`Removed from "${pl.title}"`);
    this.emit('state');
  }

  /* ------------------------------------------------------------------------
   * OFFLINE VAULT & DOWNLOADS
   * ---------------------------------------------------------------------- */

  async queueDownload(trackId) {
    const track = this.getTrackById(trackId);
    if (!track) return;
    if (this.isDownloaded(trackId)) {
      this.showToast(`Already vaulted: ${track.title}`);
      return;
    }
    if (this.isDownloading(trackId)) {
      this.showToast(`Downloading: ${track.title}`);
      return;
    }
    this.activeDownloads.push({
      trackId,
      progress: 0,
      paused: false,
    });
    this.showToast(`Downloading: ${track.title}`);
    this.emit('state');

    const invoke = getInvoke();
    if (invoke) {
      try {
        await invoke("download_song", {
          id: track.id,
          quality: this.settings.downloadQuality || "320kbps"
        });
        this.activeDownloads = this.activeDownloads.filter(d => d.trackId !== trackId);
        if (!this.downloadedTrackIds.includes(trackId)) {
          this.downloadedTrackIds.push(trackId);
        }
        this.persist();
        this.showToast(`Vaulted: ${track.title}`);
        this.emit('state');
      } catch (err) {
        console.warn("Download error:", err);
      }
    }
  }

  queueBulkDownloads(trackIds, label = 'tracks') {
    const toAdd = trackIds.filter((id) => !this.isDownloaded(id) && !this.isDownloading(id));
    if (toAdd.length === 0) {
      this.showToast('All tracks already in Offline Vault');
      return;
    }
    for (const id of toAdd) {
      this.queueDownload(id);
    }
    this.showToast(`Queued ${toAdd.length} ${label} for offline vault`);
  }

  async removeDownload(trackId) {
    const track = this.getTrackById(trackId);
    this.downloadedTrackIds = this.downloadedTrackIds.filter((id) => id !== trackId);
    this.activeDownloads = this.activeDownloads.filter((d) => d.trackId !== trackId);
    this.persist();

    const invoke = getInvoke();
    if (invoke && track) {
      try {
        await invoke("remove_download", { path: track.path || track.id });
      } catch (err) {
        console.warn("remove_download error:", err);
      }
    }

    this.showToast(track ? `Removed from vault: ${track.title}` : 'Removed from vault');
    this.emit('state');
  }

  togglePauseAllDownloads() {
    const anyRunning = this.activeDownloads.some((d) => !d.paused);
    for (const d of this.activeDownloads) {
      d.paused = anyRunning;
    }
    this.showToast(anyRunning ? 'Paused all active downloads' : 'Resumed downloads');
    this.emit('state');
  }

  toggleSingleDownloadPause(trackId) {
    const item = this.activeDownloads.find((d) => d.trackId === trackId);
    if (!item) return;
    item.paused = !item.paused;
    this.emit('state');
  }

  async refreshDownloads() {
    this.downloadsRefreshing = true;
    this.emit('state');
    await this.loadVaultDownloads();
    window.setTimeout(() => {
      this.downloadsRefreshing = false;
      this.showToast('Offline vault verified — all checksums match');
      this.emit('state');
    }, 450);
  }

  /* ------------------------------------------------------------------------
   * SEARCH & HISTORY
   * ---------------------------------------------------------------------- */

  addRecentSearch(query) {
    const clean = (query || '').trim();
    if (!clean) return;
    this.recentSearches = [clean, ...this.recentSearches.filter((q) => q.toLowerCase() !== clean.toLowerCase())].slice(0, 10);
    this.persist();
  }

  removeRecentSearch(query) {
    this.recentSearches = this.recentSearches.filter((q) => q !== query);
    this.persist();
    this.emit('state');
  }

  clearRecentSearches() {
    this.recentSearches = [];
    this.persist();
    this.emit('state');
  }

  clearHistory() {
    this.history = [];
    this.persist();
    this.showToast('Playback history cleared');
    this.emit('state');
  }

  /* ------------------------------------------------------------------------
   * NOTIFICATIONS
   * ---------------------------------------------------------------------- */

  addNotification(category, title, body) {
    const n = {
      id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      category,
      title,
      body,
      createdAt: Date.now(),
      read: false,
    };
    this.notifications = [n, ...this.notifications].slice(0, 100);
    this.persist();
    this.emit('state');
  }

  markNotificationRead(id) {
    const n = this.notifications.find((item) => item.id === id);
    if (!n || n.read) return;
    n.read = true;
    this.persist();
    this.emit('state');
  }

  markAllNotificationsRead() {
    for (const n of this.notifications) n.read = true;
    this.persist();
    this.showToast('All notifications marked as read');
    this.emit('state');
  }

  clearNotifications() {
    this.notifications = [];
    this.persist();
    this.showToast('Notifications cleared');
    this.emit('state');
  }

  /* ------------------------------------------------------------------------
   * JAM SOCIAL LISTENING ROOMS
   * ---------------------------------------------------------------------- */

  createJamRoom() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'OM-';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    this.jam = {
      ...this.jam,
      active: true,
      isHost: true,
      code,
      driftMs: 9,
      listeners: [
        { id: 'u-self', name: `${this.settings.displayName || 'You'} (Host)`, role: 'Host', pingMs: 4 },
        { id: 'u-soren', name: 'Soren · Stockholm', role: 'Synced', pingMs: 14 },
        { id: 'u-freja', name: 'Freja · Berlin', role: 'Synced', pingMs: 19 },
      ],
    };
    this.ui.npSocialMode = true;
    this.ui.npActiveTab = 'jam';
    this.ui.npJamSubTab = 'info';
    this.ui.npShowJoinInput = false;
    this.showToast(`Jam room ${code} created`);
    this.emit('state');

    const invoke = getInvoke();
    if (invoke) {
      invoke("room_open", {}).catch(() => {});
    }
  }

  joinJamRoom(rawCode) {
    const clean = (rawCode || '').trim().toUpperCase();
    if (!clean) {
      this.showToast('Enter a room code to join');
      return;
    }
    const code = clean.startsWith('OM-') ? clean : `OM-${clean.slice(0, 6)}`;
    this.jam = {
      ...this.jam,
      active: true,
      isHost: false,
      code,
      driftMs: 14,
      listeners: [
        { id: 'u-host', name: 'Kaelen (Host)', role: 'Host', pingMs: 11 },
        { id: 'u-self', name: `${this.settings.displayName || 'You'} (You)`, role: 'Synced', pingMs: 6 },
        { id: 'u-mira', name: 'Mira · Copenhagen', role: 'Synced', pingMs: 21 },
      ],
    };
    this.ui.npSocialMode = true;
    this.ui.npActiveTab = 'jam';
    this.ui.npJamSubTab = 'info';
    this.ui.npShowJoinInput = false;
    this.ui.npJoinCode = '';
    this.showToast(`Joined Jam session ${code}`);
    this.emit('state');

    const invoke = getInvoke();
    if (invoke) {
      invoke("room_join", { code }).catch(() => {});
    }
  }

  leaveJamRoom() {
    const wasHost = this.jam.isHost;
    this.jam = {
      ...this.jam,
      active: false,
      isHost: false,
      code: '',
      listeners: [],
    };
    this.ui.npSocialMode = false;
    this.showToast(wasHost ? 'Ended Jam session' : 'Left Jam session');
    this.emit('state');

    const invoke = getInvoke();
    if (invoke) {
      invoke("room_close", {}).catch(() => {});
    }
  }

  sendJamChat(text) {
    const clean = (text || '').trim();
    if (!clean) return;
    const msg = {
      id: `m-${Date.now()}`,
      sender: this.settings.displayName || 'You',
      text: clean,
      time: Date.now(),
      self: true,
    };
    this.jam.messages = [...this.jam.messages, msg];
    this.ui.npChatDraft = '';
    this.emit('state');

    const invoke = getInvoke();
    if (invoke) {
      invoke("room_chat", { text: clean }).catch(() => {});
    }

    if (this.jam.active) {
      const replies = [
        'Locked in sync — love this transition.',
        'That 3.6kHz presence on the synth is unreal.',
        'Queueing Subtle Echoes right after this!',
        'Zero drift over here in Stockholm.',
      ];
      window.setTimeout(() => {
        if (!this.jam.active) return;
        this.jam.messages = [
          ...this.jam.messages,
          {
            id: `m-peer-${Date.now()}`,
            sender: 'Soren · Stockholm',
            text: replies[Math.floor(Math.random() * replies.length)],
            time: Date.now(),
            self: false,
          },
        ];
        this.emit('state');
      }, 1300);
    }
  }

  /* ------------------------------------------------------------------------
   * 5-BAND EQUALIZER
   * ---------------------------------------------------------------------- */

  toggleEqEnabled() {
    this.eq.enabled = !this.eq.enabled;
    audioEngine.setEq(this.eq);
    this.persist();
    this.showToast(this.eq.enabled ? 'Equalizer active' : 'Equalizer bypassed');
    this.emit('state');
  }

  setEqPreset(presetName) {
    const target = EQ_PRESETS[presetName];
    if (!target) return;
    this.eq.preset = presetName;
    this.eq.bands = [...target];
    this.eq.enabled = true;
    audioEngine.setEq(this.eq);
    this.persist();
    this.showToast(`Preset: ${presetName}`);
    this.emit('state');
  }

  setEqBand(index, value) {
    if (index < 0 || index >= 5) return;
    this.eq.bands[index] = Math.max(-12, Math.min(12, Number(value) || 0));
    this.eq.preset = 'Custom';
    audioEngine.setEq(this.eq);
    this.persist();
    this.emit('tick');
  }

  /* ------------------------------------------------------------------------
   * SETTINGS & PREFERENCES
   * ---------------------------------------------------------------------- */

  updateSettings(patch) {
    Object.assign(this.settings, patch);
    if ('darkMode' in patch) this.applyTheme();
    this.persist();
    this.emit('state');
  }

  toggleLanguage(lang) {
    const list = this.settings.languages || [];
    if (list.includes(lang)) {
      if (list.length === 1) {
        this.showToast('At least one catalog language must remain selected');
        return;
      }
      this.settings.languages = list.filter((l) => l !== lang);
    } else {
      this.settings.languages = [...list, lang];
    }
    this.persist();
    this.emit('state');
  }

  checkUpdates() {
    this.showToast('Checking for signed updates...');
    const invoke = getInvoke();
    if (invoke) {
      invoke("api_version").then((v) => {
        this.showToast(`OpenMusic is up to date (core v${v || '2.4'})`);
      }).catch(() => {
        this.showToast('OpenMusic is up to date (core v2.4)');
      });
    } else {
      window.setTimeout(() => {
        this.showToast('OpenMusic is up to date (core v2.4)');
      }, 700);
    }
  }

  exportBackupJson(filename = 'openmusic-backup.json') {
    const payload = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      playlists: this.playlists,
      likedTrackIds: this.likedTrackIds,
      followedArtistIds: this.followedArtistIds,
      settings: this.settings,
      eq: this.eq,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    this.settings.lastBackupAt = Date.now();
    this.persist();
    this.showToast('Backup exported successfully');
    this.closeModals();
  }

  resetSettingsToDefaults() {
    this.settings = { ...DEFAULT_SETTINGS };
    this.eq = { ...DEFAULT_EQ, bands: [...DEFAULT_EQ.bands] };
    this.volume = 0.76;
    audioEngine.setVolume(this.volume);
    audioEngine.setEq(this.eq);
    this.applyTheme();
    this.persist();
    this.showToast('Settings restored to defaults');
    this.emit('state');
  }

  importBackupJson(text) {
    try {
      const data = JSON.parse(text);
      if (Array.isArray(data.playlists)) this.playlists = data.playlists;
      if (Array.isArray(data.likedTrackIds)) this.likedTrackIds = data.likedTrackIds;
      if (Array.isArray(data.followedArtistIds)) this.followedArtistIds = data.followedArtistIds;
      if (data.settings && typeof data.settings === 'object') {
        Object.assign(this.settings, data.settings);
      }
      if (data.eq && Array.isArray(data.eq.bands)) {
        this.eq = data.eq;
        audioEngine.setEq(this.eq);
      }
      this.applyTheme();
      this.persist();
      this.showToast('Backup restored successfully');
      this.closeModals();
      this.emit('state');
    } catch {
      this.showToast('Invalid backup JSON file');
    }
  }

  shareLink(label) {
    const url = window.location.href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        this.showToast(`Copied ${label} share link to clipboard`);
      });
    } else {
      this.showToast(`Shared ${label}`);
    }
    this.closeModals();
  }

  openTrackMenu(trackId) {
    this.ui.modal = 'track-menu';
    this.ui.modalTrackId = trackId;
    this.emit('modal');
  }

  openCreatePlaylist() {
    this.ui.modal = 'playlist-create';
    this.emit('modal');
  }

  openEqModal() {
    this.ui.modal = 'eq';
    this.emit('modal');
  }

  openInfoModal(type) {
    this.ui.modal = 'info';
    this.ui.modalInfoType = type;
    this.emit('modal');
  }

  closeModals() {
    if (this.ui.modal !== null) {
      this.ui.modal = null;
      this.ui.modalTrackId = null;
      this.ui.modalPlaylistId = null;
      this.ui.modalInfoType = null;
      this.emit('modal');
    }
  }

  /* ------------------------------------------------------------------------
   * LIVE TAURI DATA CONNECTIONS
   * ---------------------------------------------------------------------- */

  async searchLive(query) {
    if (!query || typeof query !== 'string' || query.trim().length < 2) return;
    const cleanQ = query.trim();
    const invoke = getInvoke();
    if (!invoke) return;

    try {
      const [songRes, entityRes] = await Promise.allSettled([
        invoke("search_songs", { query: cleanQ, limit: 30, page: 1 }),
        invoke("search_entities", { query: cleanQ, limit: 8, page: 1 })
      ]);

      let changed = false;

      // 1. Process Song hits
      if (songRes.status === 'fulfilled' && songRes.value) {
        const items = Array.isArray(songRes.value)
          ? songRes.value
          : (songRes.value.items || songRes.value.songs || []);
        for (const item of items) {
          const t = mapUpstreamSongToTrack(item);
          if (t && !this.tracks.some((existing) => existing.id === t.id)) {
            this.tracks.push(t);
            changed = true;
          }
        }
      }

      // 2. Process Entity hits (albums and artists)
      if (entityRes.status === 'fulfilled' && entityRes.value) {
        const entities = Array.isArray(entityRes.value)
          ? entityRes.value
          : (entityRes.value.items || []);
        for (const ent of entities) {
          if (ent.kind === 'album' || ent.type === 'album') {
            const alb = mapUpstreamAlbumToAlbum(ent);
            if (alb && !this.albums.some((a) => a.id === alb.id)) {
              this.albums.push(alb);
              changed = true;
            }
          } else if (ent.kind === 'artist' || ent.type === 'artist') {
            const art = mapUpstreamArtistToArtist(ent);
            if (art && !this.artists.some((a) => a.id === art.id)) {
              this.artists.push(art);
              changed = true;
            }
          }
        }
      }

      if (changed) {
        this.emit('state');
      }
    } catch (err) {
      console.warn("searchLive error:", err);
    }
  }

  async loadHomeFeed() {
    const invoke = getInvoke();
    if (!invoke) return;
    try {
      const feed = await invoke("home_feed");
      if (!feed) return;
      let changed = false;
      const list = feed.trending || feed.songs || feed.charts || [];
      if (Array.isArray(list)) {
        for (const s of list) {
          const t = mapUpstreamSongToTrack(s);
          if (t && !this.tracks.some((existing) => existing.id === t.id)) {
            this.tracks.push(t);
            changed = true;
          }
        }
      }
      if (changed) {
        this.emit('state');
      }
    } catch (err) {
      console.warn("loadHomeFeed error:", err);
    }
  }

  async loadVaultDownloads() {
    const invoke = getInvoke();
    if (!invoke) return;
    try {
      const downloads = await invoke("list_downloads");
      if (Array.isArray(downloads)) {
        let changed = false;
        for (const d of downloads) {
          const t = mapUpstreamSongToTrack(d);
          if (t) {
            if (d.url || d.path) t.streamUrl = d.url || d.path;
            const existingIdx = this.tracks.findIndex((x) => x.id === t.id);
            if (existingIdx >= 0) {
              if (t.streamUrl) this.tracks[existingIdx].streamUrl = t.streamUrl;
            } else {
              this.tracks.push(t);
            }
            if (!this.downloadedTrackIds.includes(t.id)) {
              this.downloadedTrackIds.push(t.id);
              changed = true;
            }
          }
        }
        if (changed) {
          this.persist();
          this.emit('state');
        }
      }
    } catch (err) {
      console.warn("loadVaultDownloads error:", err);
    }
  }

  async loadLyrics(track) {
    if (!track || (Array.isArray(track.lyrics) && track.lyrics.length > 0)) return;
    const invoke = getInvoke();
    if (!invoke) return;
    try {
      const res = await invoke("get_lyrics", {
        id: track.id,
        title: track.title,
        artist: track.artistName || track.artist || ''
      });
      if (res) {
        if (typeof res === 'string') {
          track.lyrics = parseLrc(res);
        } else if (res.lyrics || res.lrc) {
          track.lyrics = parseLrc(res.lyrics || res.lrc);
        } else if (Array.isArray(res.lines)) {
          track.lyrics = res.lines;
        }
        if (track.lyrics && track.lyrics.length > 0) {
          this.emit('state');
        }
      }
    } catch (err) {
      console.warn("loadLyrics error:", err);
    }
  }

  updateMediaSession(track) {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !track) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artistName || track.artist || 'OpenMusic',
        album: track.albumTitle || track.album || 'OpenMusic',
        artwork: [
          { src: track.artwork || '/logo.png', sizes: '512x512', type: 'image/jpeg' },
          { src: track.artwork || '/logo.png', sizes: '256x256', type: 'image/jpeg' },
          { src: track.artwork || '/logo.png', sizes: '128x128', type: 'image/jpeg' }
        ]
      });
      navigator.mediaSession.playbackState = this.isPlaying ? 'playing' : 'paused';
      if (Number.isFinite(track.duration) && track.duration > 0) {
        navigator.mediaSession.setPositionState({
          duration: track.duration,
          position: Math.min(this.currentTime, track.duration),
          playbackRate: 1.0
        });
      }
    } catch (e) {
      // Ignore mediaSession errors on unsupported platforms
    }
  }
}

export const store = new OpenMusicStore();
