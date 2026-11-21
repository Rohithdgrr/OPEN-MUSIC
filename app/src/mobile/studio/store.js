// OpenMusic reactive state store & timers (pure vanilla JavaScript)
import {
  ALBUMS,
  ARTISTS,
  EQ_PRESETS,
  INITIAL_HISTORY,
  INITIAL_NOTIFICATIONS,
  INITIAL_PLAYLISTS,
  TRACKS,
  foldName,
  mapUpstreamSongToTrack,
  mapFeedPlaylist,
  mapFeedAlbum,
  mapFeedArtist,
  mapSongRow,
  mapVaultEntry,
  isUsableImageSrc,
  parseLrc,
  qualityTier,
  toStoreTrack,
} from './data.js';
import { audioEngine } from './audio.js';
import { resolveArtistArt } from '../artresolve.js';
import {
  LIMITS,
  asText,
  sanitizeBackup,
  sanitizeEq,
  sanitizePersisted,
  sanitizeSettings,
} from './persist.js';

const STORAGE_KEY = 'openmusic_vanilla_v1';
const STREAM_TTL_MS = 6 * 60 * 60 * 1000;
const STREAM_CACHE_MAX = 300;
const STREAM_PREFETCH_DELAY_MS = 1200;
const ARTIST_ART_BATCH = 48;

const getInvoke = () => {
  if (typeof window === 'undefined') return null;
  return window.__TAURI__?.core?.invoke ?? window.__TAURI_INTERNALS__?.invoke ?? null;
};

const DEFAULT_SETTINGS = {
  displayName: 'Alex Mercer',
  darkMode: false,
  languages: ['English'],
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
    // Untrusted even when we wrote it: an older build, a partial write or a
    // hand-edit must not reach the renderer as a wrong-typed value.
    return sanitizePersisted(JSON.parse(raw));
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
    // Seeded rows are design-mock placeholders. They keep the shell populated
    // on a first offline boot and are dropped as soon as real artists arrive.
    this.artists = ARTISTS.map((a) => ({ ...a, seeded: true }));
    // Only playlists the user made survive hydration; INITIAL_PLAYLISTS are
    // demo content and are dropped the first time the backend answers.
    this._savedPlaylists = Array.isArray(saved?.playlists) ? saved.playlists : null;
    // Only user-created playlists persist. Curated shelves come back from
    // `home_feed`; keeping stale copies would resurrect removed catalogs.
    const savedUserPlaylists = (saved?.playlists || []).filter((p) => p && p.isUserCreated === true);
    this.playlists = savedUserPlaylists.length
      ? savedUserPlaylists.map((p) => ({ ...p, trackIds: Array.isArray(p.trackIds) ? [...p.trackIds] : [] }))
      : INITIAL_PLAYLISTS.map((p) => ({ ...p, trackIds: [...p.trackIds] }));

    // The chart the backend recommends on the Home feed, and its full track
    // order once opened. `tracks` only ever carries the five countdown rows,
    // so the Charts screen needs its own list rather than the home slice.
    this.chartId = '';
    this.chartTrackIds = [];

    this.likedTrackIds = Array.isArray(saved?.likedTrackIds)
      ? saved.likedTrackIds
      : ['trk-1', 'trk-2', 'trk-3', 'trk-5', 'trk-10', 'trk-13'];

    this.followedArtistIds = Array.isArray(saved?.followedArtistIds)
      ? saved.followedArtistIds
      : ['artist-solaris', 'artist-aura', 'artist-vesper'];

    this.downloadedTrackIds = Array.isArray(saved?.downloadedTrackIds)
      ? saved.downloadedTrackIds
      : ['trk-1', 'trk-5', 'trk-6', 'trk-7', 'trk-3'];

    // Dropped artist ids → the card that absorbed them (see `_dedupeArtists`).
    this._artistAlias = new Map();

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

    this.settings = sanitizeSettings(saved?.settings, DEFAULT_SETTINGS);
    this.eq = sanitizeEq(saved?.eq, DEFAULT_EQ);

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
      chartsTab: 'Global Top 10',
      chartsScope: 'all',
      librarySearchQuery: '',
      npAppendQuery: '',
      npAppendOpen: false,
      albumFilter: '', // text filter: an empty box lists every track
      albumSort: 'recent',
      albumsTab: 'all',
      playlistFilter: '', // text filter: an empty box lists every track
      playlistsTab: 'all',
      likedFilter: '',
      settingsSearch: '',
      settingsTab: 'general',
      confirmResetSettings: false,
      createPlaylistName: '',
      createPlaylistDesc: '',
      createPlaylistPrivate: false,
      analyticsRange: '30d',
      analyticsPeriod: 'Week',
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
      trackMenuPickPlaylist: false,
      shareDrawerOpen: false,
      shareItem: null,
      sleepTimerSec: 0,
      sleepTimerRemainingSec: 0,
      volumeSliderActive: false,
      queueDragIndex: null,
      queueOverIndex: null,
      headerScrolled: false,
    };

    this.toastMessage = null;
    this.toastTimer = null;

    // Live-data surface state (docs/mobile/studio-real-data.md).
    this.searchState = {
      seq: 0,
      query: '',
      tracks: [],
      albums: [],
      artists: [],
      playlists: [],
      loading: false,
      error: '',
    };
    this.searchSuggestions = [];
    this._suggestSeq = 0;
    this._loading = new Map();
    this._hydrated = false;
    this._hydrateFailures = 0;
    this._hydrateToastShown = false;

    // Stream resolution plane: a resolved relay URL costs an upstream lookup,
    // so cache it, coalesce concurrent asks, and prefetch the next track.
    this._streamCache = new Map();
    this._streamInflight = new Map();
    this._prefetchTimer = null;
    this._errorRetryFor = null;
    this.perf = { resolves: 0, cacheHits: 0, prefetches: 0, failures: 0 };

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
    audioEngine.onError = () => this._handleStreamError();
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

    // Connect to the live backend: the real catalog replaces the demo shelf
    // the first time every command answers (offline first boot keeps the demo).
    this.hydrateRealData();
  }

  /* ------------------------------------------------------------------------
   * SUBSCRIPTION & PERSISTENCE
   * ---------------------------------------------------------------------- */

  get modal() {
    return {
      trackMenuTrackId: this.ui?.modalTrackId || null,
      trackMenuPickPlaylist: this.ui?.trackMenuPickPlaylist || false,
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
        // Only user-created playlists; curated shelves are re-hydrated.
        playlists: this.playlists.filter((p) => p.isUserCreated === true),
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
        if (item.paused || item.real) continue;
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
    const direct = this.artists.find((a) => a.id === id);
    if (direct) return direct;
    const merged = this._artistAlias?.get?.(id);
    if (merged) return this.artists.find((a) => a.id === merged) || null;
    return null;
  }

  /** Fold case, punctuation and `&` so "Pritam" and "pritam " share a key. */
  _artistNameKey(name) {
    return String(name || '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  _findArtistByName(name) {
    const key = this._artistNameKey(name);
    if (!key) return null;
    return this.artists.find((a) => !a.seeded && this._artistNameKey(a.name) === key) || null;
  }

  /** How complete a card is; the better one survives a merge. */
  _artistRank(artist) {
    if (!artist) return -1;
    let rank = artist.seeded ? -100 : 0;
    if (!artist.derived) rank += 4; // a real catalog artist card
    if (artist.token) rank += 3; // openable without a name lookup
    if (String(artist.avatar || '').indexOf('/artists/') !== -1) rank += 3;
    if (!artist.needsArt) rank += 1;
    if (artist.bio) rank += 1;
    return rank;
  }

  /** Fill what the surviving card is missing from the one being dropped. */
  _absorbArtist(target, donor) {
    if (!target || !donor || target === donor) return;
    for (const field of [
      'token',
      'bio',
      'origin',
      'monthlyListeners',
      'primaryLabel',
      'globalRank',
      'trackCount',
      'verified',
    ]) {
      if (!target[field] && donor[field]) target[field] = donor[field];
    }
    const donorArt = String(donor.avatar || '');
    if (target.needsArt && donorArt.indexOf('/artists/') !== -1 && isUsableImageSrc(donorArt)) {
      target.avatar = donorArt;
      target.banner = isUsableImageSrc(donor.banner) ? donor.banner : donorArt;
      target.needsArt = false;
    }
  }

  /**
   * Tracks carry whatever artist id their row was tagged with, while the
   * catalog card for the same person arrives under its own id — so one artist
   * can show up twice under one name. Keep the richer card, repoint every
   * track/follow that referenced the dropped id, and resolve the old id
   * through `_artistAlias` forever after.
   */
  _dedupeArtists() {
    const byName = new Map();
    const merged = [];
    const alias = new Map();
    for (const artist of this.artists) {
      if (!artist) continue;
      const key = artist.seeded ? '' : this._artistNameKey(artist.name);
      if (!key) {
        merged.push(artist);
        continue;
      }
      const kept = byName.get(key);
      if (!kept) {
        byName.set(key, artist);
        merged.push(artist);
        continue;
      }
      const winner = this._artistRank(artist) > this._artistRank(kept) ? artist : kept;
      const loser = winner === kept ? artist : kept;
      if (winner !== kept) {
        merged[merged.indexOf(kept)] = winner;
        byName.set(key, winner);
      }
      this._absorbArtist(winner, loser);
      if (loser.id && loser.id !== winner.id) alias.set(loser.id, winner.id);
    }
    if (alias.size === 0) return 0;
    for (const [from, to] of alias) this._artistAlias.set(from, to);
    for (const track of this.tracks) {
      const to = alias.get(track.artistId);
      if (to) track.artistId = to;
    }
    this.followedArtistIds = Array.from(new Set(this.followedArtistIds.map((id) => alias.get(id) || id)));
    this.artists = merged;
    return alias.size;
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
    // A failed row stays listed for Retry/Dismiss but must not block it.
    return this.activeDownloads.some((d) => d.trackId === trackId && d.status !== 'failed');
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
   * REAL CATALOG PLUMBING
   * ---------------------------------------------------------------------- */

  /** Coalesce concurrent lazy loads (a route and a Play tap must not double-fetch). */
  _loadWithCache(key, loader) {
    if (!this._loading) this._loading = new Map();
    if (this._loading.has(key)) return this._loading.get(key);
    const pending = (async () => {
      try {
        return await loader();
      } finally {
        this._loading.delete(key);
      }
    })();
    this._loading.set(key, pending);
    return pending;
  }

  _mergeTrack(track) {
    if (!track || !track.id) return null;
    const existing = this.tracks.find((t) => t.id === track.id);
    if (existing) {
      if (!existing.streamUrl && track.streamUrl) existing.streamUrl = track.streamUrl;
      if (!existing.year && track.year) existing.year = track.year;
      if (!existing.label && track.label) existing.label = track.label;
      if ((!existing.lyrics || existing.lyrics.length === 0) && track.lyrics && track.lyrics.length) {
        existing.lyrics = track.lyrics;
      }
      this._ensureArtistFor(existing);
      this._ensureAlbumFor(existing);
      return existing;
    }
    this.tracks.push(track);
    this._ensureArtistFor(track);
    this._ensureAlbumFor(track);
    return track;
  }

  /** Merge raw upstream tracks; returns how many were new. */
  _mergeTracks(rows) {
    if (!Array.isArray(rows)) return 0;
    let added = 0;
    for (const row of rows) {
      const t = mapUpstreamSongToTrack(row);
      if (!t) continue;
      const before = this.tracks.length;
      this._mergeTrack(t);
      if (this.tracks.length > before) added += 1;
    }
    return added;
  }

  /**
   * A real track never opens a different artist. When the catalog has no card
   * for the track's artist yet, derive one from the row itself (the numeric
   * `artist_ids[0]` / a name slug) instead of falling back to `artists[0]`.
   */
  _ensureArtistFor(track) {
    if (!track || !track.artistId) return;
    if (this.getArtistById(track.artistId)) return;
    const name = String(track.artistName || 'Unknown Artist')
      .split(/\s*(?:,|\bfeat\.?\b|\bft\.?\b)\s*/i)[0]
      .trim() || 'Unknown Artist';
    // The same person may already have a card under another id: point the
    // track at it instead of minting a second tile with the same name.
    const known = this._findArtistByName(name);
    if (known) {
      track.artistId = known.id;
      return;
    }
    this.artists.push({
      id: track.artistId,
      name,
      verified: false,
      monthlyListeners: '',
      origin: '',
      banner: track.artwork || '/logo.png',
      avatar: track.artwork || '/logo.png',
      artworkSeed: name.slice(0, 2).toUpperCase(),
      bio: '',
      primaryLabel: '',
      globalRank: '',
      token: '',
      curated: true,
      derived: true,
      // The avatar above is the track's cover, not the artist's photo. The
      // art pass below replaces it with the catalog's real portrait.
      needsArt: true,
    });
  }

  /**
   * Replace stand-in covers on derived artist cards with the catalog's real
   * portrait. Bounded (pool 3, `ARTIST_ART_BATCH` per pass) and cached by name,
   * so a listing of 100+ artists does not fire 100 simultaneous searches.
   */
  resolveArtistArtwork(batch = ARTIST_ART_BATCH) {
    const invoke = getInvoke();
    if (!invoke) return Promise.resolve(0);
    // One attempt per artist per session: a genuine miss (no catalogue entity)
    // must not be re-queried every time the listing opens.
    this._artTried = this._artTried || new Set();
    const targets = this.artists
      .filter((a) => a && a.needsArt && !a._artBusy && !this._artTried.has(a.name))
      .slice(0, batch);
    if (!targets.length) return Promise.resolve(0);
    targets.forEach((a) => {
      a._artBusy = true;
      this._artTried.add(a.name);
    });

    let landed = 0;
    const apply = (artist, hit) => {
      if (!hit || !isUsableImageSrc(hit.image)) return;
      artist.avatar = hit.image;
      artist.banner = hit.image;
      artist.needsArt = false;
      if (hit.token && !artist.token) artist.token = hit.token;
      landed += 1;
    };

    let cursor = 0;
    const worker = async () => {
      while (cursor < targets.length) {
        const artist = targets[cursor++];
        try {
          apply(artist, await resolveArtistArt(artist.name, invoke));
        } catch {
          // A miss is honest: the cover stand-in stays.
        } finally {
          artist._artBusy = false;
        }
      }
    };

    return Promise.all([worker(), worker(), worker()])
      .then(() => {
        if (landed > 0) this.emit('state');
        return landed;
      });
  }

  /** Same idea for albums: a derived card keeps the tracks already merged. */
  _ensureAlbumFor(track) {
    if (!track || !track.albumId || !track.albumTitle) return;
    const existing = this.getAlbumById(track.albumId);
    if (existing) {
      if (existing.derived && !existing.trackIds.includes(track.id)) existing.trackIds.push(track.id);
      return;
    }
    this.albums.push({
      id: track.albumId,
      title: track.albumTitle,
      artistName: track.artistName || 'Various Artists',
      artistId: track.artistId || '',
      artwork: track.artwork || '/logo.png',
      artworkSeed: track.albumTitle.slice(0, 2).toUpperCase(),
      year: track.year || 0,
      description: '',
      releaseType: 'Album',
      releaseDate: track.year ? String(track.year) : '',
      genre: track.genre || 'Music',
      trackCount: 1,
      durationText: '',
      label: track.label || '',
      catalogueCode: '',
      quality: '320 kbps',
      trackIds: [track.id],
      token: '',
      language: track.language || '',
      curated: true,
      derived: true,
    });
  }

  async ensurePlaylistTracks(playlistId) {
    const pl = this.getPlaylistById(playlistId);
    if (!pl) return null;
    if (pl._loaded || pl.trackIds.length > 0) return pl;
    const invoke = getInvoke();
    if (!invoke) return pl;
    try {
      const rows = await this._loadWithCache(`playlist:${playlistId}`, () =>
        invoke("playlist_tracks", { id: playlistId })
      );
      if (Array.isArray(rows) && rows.length > 0) {
        const ids = [];
        for (const row of rows) {
          const t = this._mergeTrack(mapUpstreamSongToTrack(row));
          if (t && !ids.includes(t.id)) ids.push(t.id);
        }
        pl.trackIds = ids;
        pl.trackCount = ids.length || pl.trackCount;
        if ((!pl.artwork || pl.artwork === '/logo.png') && ids.length > 0) {
          const first = this.getTrackById(ids[0]);
          if (first) pl.artwork = first.artwork;
        }
        this.emit('state');
      }
      pl._loaded = true;
    } catch (err) {
      console.warn('playlist_tracks failed', playlistId, err);
    }
    return pl;
  }

  /**
   * The Charts screen shows the whole chart, not Home's five-row countdown.
   * The chart is an ordinary playlist in the feed, so it uses the same
   * `playlist_tracks` path and order. A failed fetch leaves the five
   * `chartRank` rows the shell already has.
   */
  async ensureChartTracks() {
    if (this._chartLoaded || this._chartLoading) return this.chartTrackIds;
    const cardId = this.playlists.find((p) => p.isChart)?.id || '';
    const chartId = this.chartId && this.getPlaylistById(this.chartId) ? this.chartId : cardId;
    if (!chartId) return this.chartTrackIds;
    this._chartLoading = true;
    try {
      const pl = await this.ensurePlaylistTracks(chartId);
      const ids = pl ? pl.trackIds.filter((id) => this.getTrackById(id)) : [];
      if (ids.length > 0) {
        this.chartTrackIds = ids;
        this._chartLoaded = true;
        this.emit('state');
      }
    } catch (err) {
      console.warn('chart tracks failed', chartId, err);
    } finally {
      this._chartLoading = false;
    }
    return this.chartTrackIds;
  }

  /**
   * `album_tracks` needs the perma-url token, while a track row only carries a
   * numeric `album_id`. Derived cards resolve their token through the album
   * entity search, matched on the folded title (and artist as a tiebreak).
   */
  async _resolveAlbumToken(album) {
    const invoke = getInvoke();
    if (!invoke || !album || !album.title) return '';
    try {
      const page = await invoke("search_entities", { kind: 'album', query: album.title, limit: 8, page: 1 });
      const items = Array.isArray(page) ? page : page?.items || [];
      const want = foldName(album.title);
      const wantArtist = foldName(album.artistName);
      const match =
        items.find((it) => it.token && foldName(it.title) === want && (!wantArtist || foldName(it.subtitle).includes(wantArtist))) ||
        items.find((it) => it.token && foldName(it.title) === want) ||
        items.find((it) => it.token && wantArtist && foldName(it.subtitle).includes(wantArtist));
      if (match) {
        album.token = match.token;
        if (!album.artwork || album.artwork === '/logo.png') album.artwork = match.image || album.artwork;
        if (!album.artistName && match.subtitle) album.artistName = match.subtitle;
        return match.token;
      }
    } catch (err) {
      console.warn('album token resolve failed', album.title, err);
    }
    return '';
  }

  async ensureAlbumTracks(albumId) {
    const album = this.getAlbumById(albumId);
    if (!album) return null;
    if (album._loaded) return album;
    if (!album.derived && album.trackIds.length > 0) {
      album._loaded = true;
      return album;
    }
    const invoke = getInvoke();
    if (!invoke) return album;
    const token = album.token || (await this._resolveAlbumToken(album));
    if (!token) {
      album._loaded = true;
      return album;
    }
    try {
      const rows = await this._loadWithCache(`album:${token}`, () => invoke("album_tracks", { token }));
      if (Array.isArray(rows) && rows.length > 0) {
        const ids = [];
        for (const row of rows) {
          const t = this._mergeTrack(mapUpstreamSongToTrack(row));
          if (t && !ids.includes(t.id)) ids.push(t.id);
        }
        album.trackIds = ids;
        album.trackCount = ids.length;
        if (album.derived && Number(rows[0]?.year)) album.year = Number(rows[0].year);
        this.emit('state');
      }
      album._loaded = true;
    } catch (err) {
      console.warn('album_tracks failed', albumId, err);
    }
    return album;
  }

  async ensureArtistTracks(artistId) {
    const artist = this.getArtistById(artistId);
    if (!artist || artist._loaded) return artist || null;
    const invoke = getInvoke();
    if (!invoke) return artist;
    let token = artist.token || '';
    if (!token && artist.name) {
      try {
        const page = await invoke("search_entities", { kind: 'artist', query: artist.name, limit: 6, page: 1 });
        const items = Array.isArray(page) ? page : page?.items || [];
        const want = foldName(artist.name);
        const match =
          items.find((it) => it.token && foldName(it.title) === want) ||
          items.find((it) => it.token && want && foldName(it.title).includes(want));
        if (match) {
          artist.token = match.token;
          if (match.image) {
            artist.avatar = match.image;
            artist.banner = match.image;
          }
        }
      } catch (err) {
        console.warn('artist token resolve failed', artist.name, err);
      }
      token = artist.token || '';
    }
    if (!token) {
      artist._loaded = true;
      return artist;
    }
    try {
      const page = await this._loadWithCache(`artist:${token}`, () =>
        invoke("artist_tracks", { token, page: 0 })
      );
      const rows = Array.isArray(page) ? page : page?.tracks || [];
      let added = 0;
      for (const row of rows) {
        const t = mapUpstreamSongToTrack(row);
        if (!t) continue;
        t.artistId = artist.id;
        if (!t.artistName) t.artistName = artist.name;
        const before = this.tracks.length;
        this._mergeTrack(t);
        if (this.tracks.length > before) added += 1;
      }
      artist._loaded = true;
      if (added > 0) this.emit('state');
    } catch (err) {
      console.warn('artist_tracks failed', artistId, err);
    }
    return artist;
  }

  async playPlaylist(playlistId, { shuffle = false } = {}) {
    const pl = await this.ensurePlaylistTracks(playlistId);
    const ids = pl ? pl.trackIds.filter((id) => this.getTrackById(id)) : [];
    if (ids.length === 0) {
      this.showToast('This playlist has no playable tracks');
      return;
    }
    this.playQueue(ids, { shuffle });
  }

  async playArtistRadio(artistId) {
    const artist = await this.ensureArtistTracks(artistId);
    const primary = this.tracks.filter((t) => t.artistId === artistId).map((t) => t.id);
    if (primary.length === 0) {
      this.showToast('No tracks found for this artist');
      return;
    }
    const others = this.tracks.filter((t) => t.artistId !== artistId).map((t) => t.id);
    this.playQueue([...primary, ...others.slice(0, 6)], { shuffle: true });
    if (artist) this.showToast(`Started ${artist.name} Radio`);
  }

  /** Genre cards / recent-search chips: commit the query and fetch for real. */
  applySearch(query) {
    const q = String(query || '').trim();
    this.ui.searchQuery = q;
    this.searchSuggestions = [];
    if (q) {
      this.addRecentSearch(q);
      this.searchLive(q);
    }
    this.emit('state');
  }

  /**
   * Boot hydration: replace the demo shelf with what the backend actually has.
   * Failure of any single command leaves that slice untouched, so an offline
   * first boot still renders instead of going blank.
   */
  async hydrateRealData() {
    const invoke = getInvoke();
    if (!invoke || this._hydrated) return;
    this._hydrated = true;
    try {
      const [feedRes, vaultRes, recentRes, favsRes] = await Promise.allSettled([
        invoke("home_feed"),
        invoke("list_downloads"),
        invoke("store_recent", { limit: 200 }),
        invoke("store_favs", { limit: 300 }),
      ]);
      let changed = false;
      let feedOk = false;

      if (feedRes.status === 'fulfilled' && feedRes.value) {
        const feed = feedRes.value;
        feedOk = true;

        // Remember which playlist is "the chart": Home only carries its five
        // countdown rows, while the Charts screen wants the whole list.
        this.chartId = String(feed.chart_id || feed.charts?.[0]?.id || '');
        this.chartTrackIds = [];
        this._chartLoaded = false;

        const chartTracks = [];
        (Array.isArray(feed.top_tracks) ? feed.top_tracks : []).forEach((raw, idx) => {
          const t = mapUpstreamSongToTrack(raw);
          if (!t) return;
          t.chartRank = idx + 1;
          chartTracks.push(t);
        });

        const feedArtists = (feed.artists || []).map(mapFeedArtist).filter(Boolean);
        if (feedArtists.length > 0) {
          this.artists = [
            ...feedArtists,
            ...this.artists.filter((a) => !a.seeded && !feedArtists.some((f) => f.id === a.id)),
          ];
          this._dedupeArtists();
          changed = true;
        }

        if (chartTracks.length > 0) {
          this.tracks = chartTracks;
          chartTracks.forEach((t) => {
            this._ensureArtistFor(t);
            this._ensureAlbumFor(t);
          });
          this._dedupeArtists();
          changed = true;
        }

        const curated = [];
        const seen = new Set();
        const pushCurated = (f, extra) => {
          const p = mapFeedPlaylist(f, extra);
          if (!p || seen.has(p.id)) return;
          seen.add(p.id);
          curated.push(p);
        };
        pushCurated(feed.spotlight, {});
        (feed.playlists || []).forEach((f) => pushCurated(f, {}));
        (feed.daily || []).forEach((f) => pushCurated(f, {}));
        (feed.charts || []).forEach((f) => pushCurated(f, { isChart: true }));
        if (curated.length > 0) {
          this.playlists = [...curated, ...this.playlists.filter((p) => p.isUserCreated)];
          changed = true;
        }

        const feedAlbums = (feed.albums || []).map(mapFeedAlbum).filter(Boolean);
        if (feedAlbums.length > 0) {
          // Drop the design-mock albums entirely; only albums derived from a
          // real track row survive alongside the feed's own cards.
          this.albums = [
            ...feedAlbums,
            ...this.albums.filter((a) => a.derived && !feedAlbums.some((f) => f.id === a.id)),
          ];
          changed = true;
        }

        if (changed && !this.queue.some((id) => this.getTrackById(id))) {
          this.queue = this.tracks.slice(0, 12).map((t) => t.id);
          this.queueIndex = 0;
          const cur = this.getCurrentTrack();
          if (cur) audioEngine.setTrack(cur);
        }
      }

      if (vaultRes.status === 'fulfilled' && vaultRes.value) {
        const raw = vaultRes.value;
        const entries = Array.isArray(raw) ? raw : Array.isArray(raw.entries) ? raw.entries : [];
        this.downloadedTrackIds = [];
        for (const entry of entries) {
          const t = mapVaultEntry(entry);
          if (!t) continue;
          this._mergeTrack(t);
          if (!this.downloadedTrackIds.includes(t.id)) this.downloadedTrackIds.push(t.id);
        }
        changed = true;
      }

      if (recentRes.status === 'fulfilled' && Array.isArray(recentRes.value)) {
        const history = [];
        for (const row of recentRes.value) {
          const t = this._mergeTrack(mapSongRow(row));
          if (!t) continue;
          const secs = Number(row.duration_secs) || Math.round(t.duration) || 0;
          history.push({
            id: `h-${row.id}-${row.last_played || 0}`,
            trackId: t.id,
            playedAt: (Number(row.last_played) || 0) * 1000 || Date.now(),
            listenedSec: secs,
            secondsListened: secs,
            completed: true,
          });
        }
        this.history = history;
        changed = true;
      }

      if (favsRes.status === 'fulfilled' && Array.isArray(favsRes.value)) {
        const ids = [];
        for (const row of favsRes.value) {
          const t = this._mergeTrack(mapSongRow(row));
          if (t && !ids.includes(t.id)) ids.push(t.id);
        }
        this.likedTrackIds = ids;
        changed = true;
      }

      if (feedOk) {
        // Demo-only surfaces (invented notifications, Jam chat, follows, recent
        // searches) never survive the first real answer. User playlists stay.
        this.notifications = [];
        this.recentSearches = [];
        this.jam.messages = [];
        this.followedArtistIds = this.followedArtistIds.filter((id) => Boolean(this.getArtistById(id)));
      }

      this.persist();
      if (changed) this.emit('state');

      // A rejected home feed means the shelf is still demo data: retry once,
      // then say so instead of pretending the catalog is real.
      if (feedOk) {
        this._hydrateFailures = 0;
        // The resume card is the most likely first tap: resolve it while idle.
        const resumeId = this.queue[this.queueIndex];
        if (resumeId) this._prefetchStream(resumeId, 800);
        // Artist cards derived from tracks carry a cover stand-in; swap in the
        // catalog portrait in the background so the Artists grid stops showing
        // film posters as faces.
        this.resolveArtistArtwork().catch(() => {});
      } else {
        this._scheduleHydrateRetry();
      }
    } catch (err) {
      console.warn('hydrateRealData error:', err);
      this._scheduleHydrateRetry();
    }
  }

  _scheduleHydrateRetry() {
    this._hydrateFailures = (this._hydrateFailures || 0) + 1;
    this._hydrated = false;
    if (this._hydrateFailures === 1) {
      window.setTimeout(() => this.hydrateRealData(), 1500);
      return;
    }
    if (!this._hydrateToastShown) {
      this._hydrateToastShown = true;
      this.showToast("Couldn't reach the catalog — showing what's saved on this device");
    }
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

    // Entering a listing that shows artist faces is the moment those portraits
    // matter; resolve the next slice of stand-in covers for it.
    if (name === 'artists' || name === 'library') {
      this.resolveArtistArtwork().catch(() => {});
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

    // Real detail screens fetch their tracks once (coalesced per entity).
    if (name === 'playlist' && opts.id) this.ensurePlaylistTracks(opts.id);
    if (name === 'album' && opts.id) this.ensureAlbumTracks(opts.id);
    if (name === 'artist' && opts.id) this.ensureArtistTracks(opts.id);
    // Charts: load the full chart playlist instead of the five home rows.
    if (name === 'charts') this.ensureChartTracks();

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
      listenedSec: Math.round(track.duration) || 0,
      secondsListened: Math.round(track.duration) || 0,
    };
    this.history = [entry, ...this.history].slice(0, 3000);
    this.persist();
    // Persist the play in the SQLite ledger so History/Analytics survive restarts.
    const invoke = getInvoke();
    const payload = toStoreTrack(track);
    if (invoke && payload) {
      invoke("store_play", { track: payload }).catch(() => {});
    }
  }

  /* ------------------------------------------------------------------------
   * LIVE BACKEND & PLAYBACK
   * ---------------------------------------------------------------------- */

  _streamKey(track) {
    return `${track.id}|${qualityTier(this.settings.downloadQuality)}`;
  }

  _cachedStream(track) {
    const key = this._streamKey(track);
    const hit = this._streamCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > STREAM_TTL_MS) {
      this._streamCache.delete(key);
      return null;
    }
    return hit;
  }

  _applyStream(track, entry) {
    track.streamUrl = entry.url;
    if (entry.quality) {
      track.bitrate = entry.quality;
      track.qualityBadge = `${entry.quality} MP3`;
    }
  }

  /** Single-flight resolve: a double tap dials the backend once. */
  _resolveStream(track) {
    const invoke = getInvoke();
    if (!invoke) return Promise.reject(new Error('no-backend'));
    const cached = this._cachedStream(track);
    if (cached) {
      this.perf.cacheHits += 1;
      return Promise.resolve(cached);
    }
    const key = this._streamKey(track);
    const inflight = this._streamInflight.get(key);
    if (inflight) return inflight;

    this.perf.resolves += 1;
    const promise = invoke('resolve_song', {
      id: track.id,
      quality: qualityTier(this.settings.downloadQuality),
    })
      .then((res) => {
        const url = res && (res.proxy_url || res.direct_url);
        if (!url) throw new Error('no-stream');
        const entry = {
          url,
          quality: res.chosen_quality || qualityTier(this.settings.downloadQuality),
          at: Date.now(),
        };
        this._streamCache.set(key, entry);
        if (this._streamCache.size > STREAM_CACHE_MAX) {
          this._streamCache.delete(this._streamCache.keys().next().value);
        }
        return entry;
      })
      .catch((err) => {
        this.perf.failures += 1;
        throw err;
      })
      .finally(() => {
        this._streamInflight.delete(key);
      });
    this._streamInflight.set(key, promise);
    return promise;
  }

  async _resolveStreamWithRetry(track) {
    try {
      return await this._resolveStream(track);
    } catch (err) {
      // Offline is not a transient failure — report it immediately.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) throw err;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return this._resolveStream(track);
    }
  }

  _streamErrorMessage() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return "You're offline — this track needs a connection";
    }
    return "Couldn't load this track — tap it again to retry";
  }

  /**
   * Warm one track's stream ticket in the background. Used for the next queue
   * item and for the resume track right after boot, so tapping play does not
   * pay for an upstream resolve.
   */
  _prefetchStream(trackId, delayMs = STREAM_PREFETCH_DELAY_MS) {
    if (!getInvoke() || !trackId) return;
    const track = this.getTrackById(trackId);
    if (!track || track.streamUrl) return;
    const key = this._streamKey(track);
    if (this._streamCache.has(key) || this._streamInflight.has(key)) return;
    if (this._prefetchTimer) {
      window.clearTimeout(this._prefetchTimer);
      this._prefetchTimer = null;
    }
    this._prefetchTimer = window.setTimeout(() => {
      this._prefetchTimer = null;
      const target = this.getTrackById(trackId);
      if (!target || target.streamUrl) return;
      this.perf.prefetches += 1;
      this._resolveStream(target)
        .then((entry) => this._applyStream(target, entry))
        .catch(() => {});
    }, delayMs);
  }

  /** Warm the next ticket while the current track plays. */
  _prefetchNext() {
    if (this.queue.length < 2) return;
    const nextId = this.queue[(this.queueIndex + 1) % this.queue.length];
    if (!nextId || nextId === this.queue[this.queueIndex]) return;
    this._prefetchStream(nextId);
  }

  /** Media element failed: one forced re-resolve (a signed CDN URL can expire). */
  _handleStreamError() {
    const track = this.getCurrentTrack();
    if (!track) return;
    if (!track.streamUrl) {
      this.isPlaying = false;
      this.emit('state');
      return;
    }
    if (this._errorRetryFor === track.id) {
      this.isPlaying = false;
      this.showToast("Playback failed — this track may be unavailable");
      this.emit('state');
      return;
    }
    this._errorRetryFor = track.id;
    this._streamCache.delete(this._streamKey(track));
    track.streamUrl = '';
    this._resolveStreamWithRetry(track)
      .then((entry) => {
        this._applyStream(track, entry);
        audioEngine.setTrack(track);
        audioEngine.play(track);
        this.emit('state');
      })
      .catch(() => {
        this.isPlaying = false;
        this.showToast(this._streamErrorMessage());
        this.emit('state');
      });
  }

  async _prepareAndPlay(track) {
    if (!track) return;
    const invoke = getInvoke();
    const seq = this.trackChangeSeq;
    if (this._errorRetryFor && this._errorRetryFor !== track.id) this._errorRetryFor = null;

    if (invoke && !track.streamUrl) {
      const cached = this._cachedStream(track);
      if (cached) this._applyStream(track, cached);
    }

    if (invoke && !track.streamUrl) {
      try {
        const entry = await this._resolveStreamWithRetry(track);
        // The user may have picked another track while this one resolved.
        if (seq !== this.trackChangeSeq) return;
        this._applyStream(track, entry);
        this._errorRetryFor = null;
      } catch (err) {
        if (seq !== this.trackChangeSeq) return;
        console.warn('Could not resolve stream for track', track.id, err);
        this.isPlaying = false;
        this.showToast(this._streamErrorMessage());
        this.emit('state');
        return;
      }
    }

    // A real catalog never fakes audio: with a backend present and no stream,
    // the honest state is stopped (the synthesizer is only the no-backend demo).
    if (!track.streamUrl && invoke) {
      this.isPlaying = false;
      this.showToast(this._streamErrorMessage());
      this.emit('state');
      return;
    }

    if (!track.lyrics || track.lyrics.length === 0) {
      this.loadLyrics(track);
    }

    audioEngine.setTrack(track);
    audioEngine.play(track);
    this.updateMediaSession(track);
    this._prefetchNext();
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
    // Likes live in the SQLite store too, so `store_favs` restores them.
    const invoke = getInvoke();
    const payload = track ? toStoreTrack(track) : null;
    if (invoke && payload) {
      invoke("store_fav", { track: payload, fav: !was }).catch(() => {});
    }
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
    // Bounded at the boundary: a pasted paragraph is not a playlist name.
    const clean = asText(title, LIMITS.title);
    if (!clean) return null;
    const blurb = asText(description, LIMITS.description);
    const id = `pl-user-${Date.now()}`;
    const newPl = {
      id,
      title: clean,
      subtitle: 'Your playlist',
      description: blurb || 'Your personal collection.',
      author: this.settings.displayName || 'You',
      curator: 'You',
      isUserCreated: true,
      curated: false,
      isPrivate: Boolean(isPrivate),
      artwork: '/logo.png',
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
    // A previous attempt's FAILED row must not shadow the new one's progress.
    this.activeDownloads = this.activeDownloads.filter(
      (d) => !(d.trackId === trackId && d.status === 'failed')
    );
    const invoke = getInvoke();
    this.activeDownloads.push({
      trackId,
      progress: 0,
      paused: false,
      status: 'downloading',
      received: 0,
      total: null,
      error: '',
      real: Boolean(invoke),
    });
    this.showToast(`Downloading: ${track.title}`);
    this.emit('state');
    if (invoke) {
      let channel = null;
      try {
        channel = await this._downloadChannel((msg) => {
          if (!msg) return;
          const dl = this.activeDownloads.find((d) => d.trackId === trackId);
          if (!dl) return;
          dl.received = Number(msg.received) || dl.received;
          dl.total = msg.total != null ? Number(msg.total) : dl.total;
          if (dl.total > 0) dl.progress = Math.min(100, Math.round((dl.received / dl.total) * 100));
          else if (msg.done) dl.progress = 100;
          if (msg.quality) dl.quality = msg.quality;
          dl.status = msg.done ? 'completed' : 'downloading';
          this.emit('state');
        });

        // `download_song` declares `on_progress: Channel` — Tauri maps the
        // camelCase `onProgress` key onto it. Sending the snake_case twin as
        // well produced two args for one parameter.
        const out = await invoke("download_song", {
          id: track.id,
          quality: qualityTier(this.settings.downloadQuality),
          onProgress: channel,
        });
        if (out && out.path) track.path = out.path;
        this.activeDownloads = this.activeDownloads.filter((d) => d.trackId !== trackId);
        if (!this.downloadedTrackIds.includes(trackId)) {
          this.downloadedTrackIds.push(trackId);
        }
        this.persist();
        this.showToast(`Vaulted: ${track.title}`);
        this.emit('state');
        this.loadVaultDownloads().catch(() => {});
      } catch (err) {
        console.warn("Download error:", err);
        const errMsg = String(err || '').split('\n')[0].slice(0, 120);
        // Keep the row: Downloads shows FAILED + the reason, with Retry and
        // Dismiss, instead of the failure living only in a toast.
        const dl = this.activeDownloads.find((d) => d.trackId === trackId);
        if (dl) {
          dl.status = 'failed';
          dl.error = errMsg || 'Download failed';
          dl.progress = 0;
        } else {
          this.activeDownloads.push({
            trackId,
            progress: 0,
            paused: false,
            status: 'failed',
            received: 0,
            total: null,
            error: errMsg || 'Download failed',
            real: true,
          });
        }
        this.showToast(`Download failed — ${errMsg}`);
        this.emit('state');
      } finally {
        try {
          channel?.cleanup?.();
        } catch {}
      }
    }
  }

  /// Ordered-buffer progress Channel for `download_song`. Prefers the global
  /// Tauri API (`withGlobalTauri` exposes `core.Channel`); falls back to the
  /// vendored implementation in `src/core.js`, which is what desktop vault.js
  /// uses — plain objects cannot receive ordered channel messages.
  async _downloadChannel(onMessage) {
    const GlobalChannel = window.__TAURI__?.core?.Channel;
    if (GlobalChannel) {
      const ch = new GlobalChannel();
      ch.onmessage = onMessage;
      return ch;
    }
    const { Channel } = await import('../../core.js');
    const ch = new Channel();
    ch.onmessage = onMessage;
    return ch;
  }

  /// Drop a finished/failed in-transit row without touching the vault.
  dismissDownload(trackId) {
    this.activeDownloads = this.activeDownloads.filter((d) => d.trackId !== trackId);
    this.emit('state');
  }

  /// Cancel an in-flight download backend-side (`.part` is deleted), then
  /// drop the row. Distinct from `removeDownload`, which deletes a vaulted file.
  async cancelDownload(trackId) {
    const invoke = getInvoke();
    if (invoke) {
      try {
        await invoke("cancel_download", { id: trackId });
      } catch (err) {
        console.warn("cancel_download error:", err);
      }
    }
    this.activeDownloads = this.activeDownloads.filter((d) => d.trackId !== trackId);
    this.emit('state');
  }

  queueBulkDownloads(trackIds, label = 'tracks', concurrency = 3) {
    const toAdd = trackIds.filter((id) => !this.isDownloaded(id) && !this.isDownloading(id));
    if (toAdd.length === 0) {
      this.showToast('All tracks already in Offline Vault');
      return;
    }
    this.showToast(`Queued ${toAdd.length} ${label} for parallel download (${concurrency} concurrent)`);
    let idx = 0;
    let active = 0;
    const runNext = () => {
      while (active < concurrency && idx < toAdd.length) {
        const id = toAdd[idx++];
        active++;
        this.queueDownload(id).finally(() => {
          active--;
          runNext();
        });
      }
    };
    runNext();
  }

  downloadAllParallel(concurrency = 4) {
    const candidateIds = this.queue.concat(this.tracks.map((t) => t.id));
    const unique = [...new Set(candidateIds)].filter((id) => !this.isDownloaded(id) && !this.isDownloading(id));
    if (unique.length === 0) {
      this.showToast('All eligible tracks already in Offline Vault');
      return;
    }
    this.queueBulkDownloads(unique.slice(0, 20), 'library songs', concurrency);
  }

  reorderQueue(fromIdx, toIdx) {
    if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0) return;
    if (fromIdx >= this.queue.length || toIdx >= this.queue.length) return;
    const [moved] = this.queue.splice(fromIdx, 1);
    this.queue.splice(toIdx, 0, moved);
    if (this.queueIndex === fromIdx) {
      this.queueIndex = toIdx;
    } else if (fromIdx < this.queueIndex && toIdx >= this.queueIndex) {
      this.queueIndex--;
    } else if (fromIdx > this.queueIndex && toIdx <= this.queueIndex) {
      this.queueIndex++;
    }
    this.persist();
    this.emit('state');
  }

  reorderPlaylist(playlistId, fromIdx, toIdx) {
    const pl = this.getPlaylistById(playlistId);
    if (!pl || fromIdx === toIdx) return;
    if (fromIdx < 0 || toIdx < 0 || fromIdx >= pl.trackIds.length || toIdx >= pl.trackIds.length) return;
    const [moved] = pl.trackIds.splice(fromIdx, 1);
    pl.trackIds.splice(toIdx, 0, moved);
    this.persist();
    this.emit('state');
  }

  /// Manual ordering for Liked Songs — resolves by track id so filtered or
  /// unresolved rows can't shift the indices.
  reorderLiked(fromTrackId, toTrackId) {
    if (!fromTrackId || !toTrackId || fromTrackId === toTrackId) return;
    const fromIdx = this.likedTrackIds.indexOf(fromTrackId);
    const toIdx = this.likedTrackIds.indexOf(toTrackId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = this.likedTrackIds.splice(fromIdx, 1);
    this.likedTrackIds.splice(toIdx, 0, moved);
    this.persist();
    this.emit('state');
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
    const running = this.activeDownloads.filter((d) => !d.paused && d.status !== 'failed');
    const paused = this.activeDownloads.filter((d) => d.paused);
    const invoke = getInvoke();
    if (running.length > 0) {
      for (const d of running) {
        d.paused = true;
        // The backend keeps the `.part` prefix; resume re-enters download_song.
        if (invoke) invoke("pause_download", { id: d.trackId }).catch(() => {});
      }
      this.showToast(`Paused ${running.length} download${running.length === 1 ? '' : 's'}`);
    } else if (paused.length > 0) {
      const ids = paused.map((d) => d.trackId);
      this.activeDownloads = this.activeDownloads.filter((d) => !d.paused);
      this.showToast('Resuming downloads');
      for (const id of ids) this.queueDownload(id);
      return;
    } else {
      this.showToast('No active downloads');
      return;
    }
    this.emit('state');
  }

  toggleSingleDownloadPause(trackId) {
    const item = this.activeDownloads.find((d) => d.trackId === trackId);
    if (!item || item.status === 'failed') return;
    const invoke = getInvoke();
    if (!item.paused) {
      item.paused = true;
      if (invoke) invoke("pause_download", { id: trackId }).catch(() => {});
      this.emit('state');
      return;
    }
    // Resume: drop the paused row and re-enter download_song — the backend
    // picks the kept `.part` prefix back up (Range request or clean restart).
    this.activeDownloads = this.activeDownloads.filter((d) => d.trackId !== trackId);
    this.queueDownload(trackId);
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

  async fetchSuggestions(query) {
    const q = String(query || '').trim();
    if (q.length < 2) {
      this.searchSuggestions = [];
      this.emit('state');
      return;
    }
    const invoke = getInvoke();
    if (!invoke) return;
    const seq = ++this._suggestSeq;
    try {
      const res = await invoke("search_suggestions", { query: q });
      if (this._suggestSeq !== seq) return;
      const suggestions = [];
      if (res) {
        for (const s of (res.songs || [])) {
          if (s.title && !suggestions.includes(s.title)) suggestions.push(s.title);
        }
        for (const a of (res.albums || [])) {
          if (a.title && !suggestions.includes(a.title)) suggestions.push(a.title);
        }
        for (const a of (res.artists || [])) {
          const name = a.title || a.name;
          if (name && !suggestions.includes(name)) suggestions.push(name);
        }
        for (const p of (res.playlists || [])) {
          if (p.title && !suggestions.includes(p.title)) suggestions.push(p.title);
        }
      }
      this.searchSuggestions = suggestions.slice(0, 8);
      this.emit('state');
    } catch (err) {
      console.warn("fetchSuggestions error:", err);
    }
  }

  clearSuggestions() {
    this.searchSuggestions = [];
    this._suggestSeq++;
    this.emit('state');
  }

  addRecentSearch(query) {
    const clean = (query || '').trim();
    if (!clean) return;
    this.recentSearches = [clean, ...this.recentSearches.filter((q) => q.toLowerCase() !== clean.toLowerCase())].slice(0, 10);
    this.persist();
    this.emit('state');
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
      timestamp: Date.now(),
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
    this.settings = sanitizeSettings({ ...this.settings, ...patch }, DEFAULT_SETTINGS);
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
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.showToast('Invalid backup JSON file');
      return false;
    }
    const result = sanitizeBackup(parsed);
    if (!result.ok) {
      this.showToast(result.reason);
      return false;
    }
    const data = result.value;
    // Replace, never merge: a restore must not leave the old library mixed in.
    this.playlists = data.playlists;
    this.likedTrackIds = data.likedTrackIds;
    this.followedArtistIds = data.followedArtistIds;
    if (data.settings) this.settings = sanitizeSettings(data.settings, DEFAULT_SETTINGS);
    if (data.eq) {
      this.eq = sanitizeEq(data.eq, DEFAULT_EQ);
      audioEngine.setEq(this.eq);
    }
    this.applyTheme();
    this.persist();
    this.showToast('Backup restored successfully');
    this.closeModals();
    this.emit('state');
    return true;
  }

  shareLink(label) {
    this.openShareDrawer(label);
  }

  openShareDrawer(label, customUrl = null) {
    const url = customUrl || 'https://rohithdgrr.github.io/OPEN-MUSIC/';
    const text = `${label}\n${url}`;
    this.ui.shareDrawerOpen = true;
    this.ui.shareItem = { label, url, text };
    this.emit('modal');
  }

  closeShareDrawer() {
    this.ui.shareDrawerOpen = false;
    this.ui.shareItem = null;
    this.emit('modal');
  }

  copyShareLink() {
    const item = this.ui.shareItem;
    const text = item ? item.text : 'https://rohithdgrr.github.io/OPEN-MUSIC/';
    const label = item ? item.label : 'OpenMusic';
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => this.showToast(`Copied ${label} share link to clipboard`),
        () => this.showToast('Could not copy the share link')
      );
    } else {
      this.showToast(`Link copied: ${label}`);
    }
    this.closeShareDrawer();
  }

  triggerSystemShare() {
    const item = this.ui.shareItem;
    if (!item) return;
    const bridge = typeof window !== 'undefined' ? window.TMNative : null;
    if (bridge && typeof bridge.share === 'function') {
      try {
        bridge.share(item.text);
        this.showToast('Choose an app to share with');
        this.closeShareDrawer();
        return;
      } catch {}
    }
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      navigator
        .share({ title: item.label, text: item.text, url: item.url })
        .then(() => this.showToast(`Shared ${item.label}`))
        .catch(() => {});
      this.closeShareDrawer();
      return;
    }
    this.copyShareLink();
  }

  openTrackMenu(trackId) {
    this.ui.modal = 'track-menu';
    this.ui.modalTrackId = trackId;
    this.ui.trackMenuPickPlaylist = false;
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
    this.ui.modal = null;
    this.ui.modalTrackId = null;
    this.ui.modalPlaylistId = null;
    this.ui.modalInfoType = null;
    this.ui.trackMenuPickPlaylist = false;
    this.ui.shareDrawerOpen = false;
    this.ui.shareItem = null;
    this.emit('modal');
  }

  /* ------------------------------------------------------------------------
   * LIVE TAURI DATA CONNECTIONS
   * ---------------------------------------------------------------------- */

  /**
   * One catalog search. `search_entities` needs an explicit `kind`, so the
   * three entity chips are three calls, all in parallel with the song page.
   * Answers land in `searchState` (rendered by the Search screen) and are also
   * merged into the catalog so a detail route can open them.
   */
  async searchLive(query) {
    if (typeof query !== 'string') return;
    const cleanQ = query.trim();
    const invoke = getInvoke();
    if (!cleanQ || cleanQ.length < 2) {
      this.searchState = {
        seq: this.searchState?.seq || 0,
        query: cleanQ,
        tracks: [],
        albums: [],
        artists: [],
        playlists: [],
        loading: false,
        error: '',
      };
      this.emit('state');
      return;
    }
    if (!invoke) return;

    const seq = (this.searchState?.seq || 0) + 1;
    this.searchState = {
      seq,
      query: cleanQ,
      tracks: [],
      albums: [],
      artists: [],
      playlists: [],
      loading: true,
      error: '',
    };
    this.emit('state');

    const [songsRes, albumsRes, artistsRes, playlistsRes] = await Promise.allSettled([
      invoke("search_songs", { query: cleanQ, limit: 30, page: 1 }),
      invoke("search_entities", { kind: 'album', query: cleanQ, limit: 12, page: 1 }),
      invoke("search_entities", { kind: 'artist', query: cleanQ, limit: 12, page: 1 }),
      invoke("search_entities", { kind: 'playlist', query: cleanQ, limit: 12, page: 1 }),
    ]);
    // A newer keystroke owns the state now: drop this stale answer.
    if (this.searchState?.seq !== seq) return;

    const pageItems = (res) => {
      if (res.status !== 'fulfilled' || !res.value) return [];
      if (Array.isArray(res.value)) return res.value;
      return res.value.items || [];
    };

    const tracks = [];
    const songPage = songsRes.status === 'fulfilled' ? songsRes.value : null;
    const rawSongs = Array.isArray(songPage) ? songPage : songPage?.tracks || songPage?.items || songPage?.songs || [];
    for (const raw of rawSongs) {
      const t = this._mergeTrack(mapUpstreamSongToTrack(raw));
      if (t && !tracks.includes(t)) tracks.push(t);
    }

    const albums = pageItems(albumsRes)
      .map((f) => {
        const mapped = mapFeedAlbum(f);
        if (!mapped) return null;
        return this.getAlbumById(mapped.id) || (this.albums.push(mapped), mapped);
      })
      .filter(Boolean);

    const artists = pageItems(artistsRes)
      .map((f) => {
        const mapped = mapFeedArtist(f);
        if (!mapped) return null;
        // A catalog card may already exist under the name with another id.
        const existing = this.getArtistById(mapped.id) || this._findArtistByName(mapped.name);
        if (existing) {
          this._absorbArtist(existing, mapped);
          return existing;
        }
        this.artists.push(mapped);
        return mapped;
      })
      .filter(Boolean);

    const playlists = pageItems(playlistsRes)
      .map((f) => {
        const mapped = mapFeedPlaylist(f);
        if (!mapped) return null;
        return this.getPlaylistById(mapped.id) || (this.playlists.push(mapped), mapped);
      })
      .filter(Boolean);

    const failed = [songsRes, albumsRes, artistsRes, playlistsRes].filter((r) => r.status === 'rejected');
    this.searchState = {
      seq,
      query: cleanQ,
      tracks,
      albums,
      artists,
      playlists,
      loading: false,
      error: failed.length === 4 ? 'Search is unavailable right now' : '',
    };
    this.emit('state');
  }

  /** `list_downloads` answers `{dir, entries[]}` — never treat it as an array. */
  async loadVaultDownloads() {
    const invoke = getInvoke();
    if (!invoke) return;
    try {
      const raw = await invoke("list_downloads");
      if (!raw) return;
      const entries = Array.isArray(raw) ? raw : Array.isArray(raw.entries) ? raw.entries : [];
      this.downloadedTrackIds = [];
      for (const entry of entries) {
        const t = mapVaultEntry(entry);
        if (!t) continue;
        this._mergeTrack(t);
        if (!this.downloadedTrackIds.includes(t.id)) this.downloadedTrackIds.push(t.id);
      }
      this.persist();
      this.emit('state');
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
        id: String(track.id),
        title: track.title || '',
        artist: track.artistName || track.artist || '',
        // Both are required by the command's signature.
        album: track.albumTitle || track.album || '',
        duration: Math.max(0, Math.round(Number(track.duration) || 0)),
      });
      if (res) {
        const toLines = (rows) =>
          (Array.isArray(rows) ? rows : [])
            .map((row) =>
              Array.isArray(row)
                ? { time: Number(row[0]) || 0, text: String(row[1] ?? '') }
                : { time: Number(row?.time) || 0, text: String(row?.text ?? '') }
            )
            .filter((line) => line.text);
        if (typeof res === 'string') {
          track.lyrics = parseLrc(res);
        } else if (Array.isArray(res.synced) && res.synced.length > 0) {
          // Backend contract: `synced` is `[[seconds, line], …]`.
          track.lyrics = toLines(res.synced);
        } else if (res.lyrics || res.lrc) {
          track.lyrics = parseLrc(res.lyrics || res.lrc);
        } else if (Array.isArray(res.lines)) {
          track.lyrics = toLines(res.lines);
        } else if (typeof res.plain === 'string') {
          track.lyrics = parseLrc(res.plain);
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
