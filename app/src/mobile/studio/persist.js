// persist.js — normalise stored/imported Studio state.
//
// Why this exists: everything the shell paints comes from `localStorage` or a
// user-chosen backup file. Both are untrusted input: a value written by an
// older build, a half-finished write, or a hand-edited `openmusic-backup.json`
// can put a string where the code expects an array. That used to reach
// `pl.trackIds.map(...)` inside a render and take the whole UI down — and,
// because `persist()` writes it straight back, stay broken across restarts.
//
// Pure and dependency-free on purpose: the store passes its own defaults in,
// and the rules are unit-tested without a DOM or a Web Audio context.
//
// Contract: every function returns a value of the stated shape, never throws,
// and drops anything it cannot represent. Brute-forcing a shape is not a goal.

/** C0 controls and DEL never belong in a title, a name or an id. */
function stripControlChars(text) {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 32 || code === 127) continue;
    out += char;
  }
  return out;
}

export const LIMITS = {
  playlists: 500,
  playlistTracks: 5000,
  history: 3000,
  notifications: 200,
  recentSearches: 12,
  liked: 5000,
  followed: 1000,
  downloads: 5000,
  title: 120,
  description: 500,
  label: 80,
  id: 160,
  displayName: 40,
  languages: 12,
  eqBands: 5,
};

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A trimmed, control-character-free string, capped to `max` characters. */
export function asText(value, max = LIMITS.label) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = stripControlChars(String(value)).trim();
  return max > 0 ? text.slice(0, max) : text;
}

/** Array of unique, non-empty ids (strings), capped to `max` entries. */
export function asIdList(value, max = LIMITS.liked) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string' && typeof entry !== 'number') continue;
    const id = asText(entry, LIMITS.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

export function asBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  return fallback;
}

export function asNumber(value, { min = -Infinity, max = Infinity, fallback = 0 } = {}) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Settings are a fixed known key set; unknown keys are dropped, not merged. */
export function sanitizeSettings(raw, defaults) {
  const base = isObject(defaults) ? defaults : {};
  const out = { ...base };
  if (!isObject(raw)) return out;

  if ('displayName' in raw) out.displayName = asText(raw.displayName, LIMITS.displayName) || base.displayName || 'Listener';
  for (const key of ['darkMode', 'syncedLyrics', 'autoUpdates', 'gaplessPlayback', 'normalizeAudio']) {
    if (key in raw) out[key] = asBool(raw[key], Boolean(base[key]));
  }
  for (const key of ['country', 'downloadQuality']) {
    if (key in raw) out[key] = asText(raw[key], LIMITS.label) || base[key] || '';
  }
  if ('languages' in raw) {
    const list = Array.isArray(raw.languages) ? raw.languages : [];
    const languages = [];
    for (const entry of list) {
      const lang = asText(entry, LIMITS.label);
      if (lang && !languages.includes(lang)) languages.push(lang);
      if (languages.length >= LIMITS.languages) break;
    }
    // At least one language must stay selected: `toggleLanguage` relies on it.
    out.languages = languages.length ? languages : [...(base.languages || [])];
  }
  if ('crossfadeSec' in raw) out.crossfadeSec = asNumber(raw.crossfadeSec, { min: 0, max: 12, fallback: Number(base.crossfadeSec) || 0 });
  if ('lastBackupAt' in raw) {
    out.lastBackupAt = Number.isFinite(Number(raw.lastBackupAt)) && Number(raw.lastBackupAt) > 0 ? Number(raw.lastBackupAt) : null;
  }
  return out;
}

/** Five numeric bands in dB, clamped to the equalizer's usable range. */
export function sanitizeEq(raw, defaults) {
  const base = isObject(defaults) ? defaults : {};
  const fallbackBands = Array.isArray(base.bands) ? base.bands.slice(0, LIMITS.eqBands) : [];
  const bands = Array.isArray(raw?.bands)
    ? raw.bands.slice(0, LIMITS.eqBands).map((value, i) => asNumber(value, { min: -12, max: 12, fallback: Number(fallbackBands[i]) || 0 }))
    : [];
  return {
    enabled: isObject(raw) ? asBool(raw.enabled, Boolean(base.enabled)) : Boolean(base.enabled),
    preset: isObject(raw) ? asText(raw.preset, LIMITS.label) || base.preset || '' : base.preset || '',
    bands: bands.length === LIMITS.eqBands ? bands : [...fallbackBands],
  };
}

const PLAYLIST_TEXT_FIELDS = ['subtitle', 'description', 'curator', 'author', 'artworkSeed'];
const PLAYLIST_BOOL_FIELDS = ['isPrivate', 'isUserCreated', 'isPublic', 'isCollaborative', 'featured', 'curated', 'isChart'];
const PLAYLIST_NUM_FIELDS = ['likes'];

export function sanitizePlaylist(raw) {
  if (!isObject(raw)) return null;
  const id = asText(raw.id, LIMITS.id);
  const title = asText(raw.title, LIMITS.title);
  // A playlist without an id or a title cannot be opened or shown.
  if (!id || !title) return null;
  const out = { id, title, trackIds: asIdList(raw.trackIds, LIMITS.playlistTracks) };
  for (const key of PLAYLIST_TEXT_FIELDS) out[key] = asText(raw[key], key === 'description' ? LIMITS.description : LIMITS.label);
  for (const key of PLAYLIST_BOOL_FIELDS) out[key] = asBool(raw[key]);
  for (const key of PLAYLIST_NUM_FIELDS) out[key] = asNumber(raw[key], { min: 0, max: 1e9, fallback: 0 });
  // `artwork` is a URL; an unusable value must not become a broken <img>.
  out.artwork = typeof raw.artwork === 'string' ? raw.artwork.trim() : '';
  out.trackCount = out.trackIds.length;
  return out;
}

export function sanitizePlaylists(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const row of raw) {
    const playlist = sanitizePlaylist(row);
    if (!playlist || seen.has(playlist.id)) continue;
    seen.add(playlist.id);
    out.push(playlist);
    if (out.length >= LIMITS.playlists) break;
  }
  return out;
}

export function sanitizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw) {
    if (!isObject(row)) continue;
    const trackId = asText(row.trackId, LIMITS.id);
    if (!trackId) continue;
    const id = asText(row.id, LIMITS.id) || `h-${trackId}-${out.length}`;
    out.push({
      id,
      trackId,
      playedAt: asNumber(row.playedAt, { min: 0, max: Date.now() + 86400000, fallback: 0 }),
      listenedSec: asNumber(row.listenedSec ?? row.secondsListened, { min: 0, max: 86400, fallback: 0 }),
    });
    if (out.length >= LIMITS.history) break;
  }
  return out;
}

export function sanitizeNotifications(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw) {
    if (!isObject(row)) continue;
    const title = asText(row.title, LIMITS.title);
    if (!title) continue;
    out.push({
      id: asText(row.id, LIMITS.id) || `n-${out.length}`,
      category: asText(row.category, LIMITS.label) || 'system',
      title,
      body: asText(row.body, LIMITS.description),
      timestamp: asNumber(row.timestamp, { min: 0, max: Date.now() + 86400000, fallback: 0 }),
      read: asBool(row.read),
    });
    if (out.length >= LIMITS.notifications) break;
  }
  return out;
}

export function sanitizeRecentSearches(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    const query = asText(entry, LIMITS.title);
    if (!query || out.includes(query)) continue;
    out.push(query);
    if (out.length >= LIMITS.recentSearches) break;
  }
  return out;
}

/**
 * Normalise a stored snapshot. Fields that fail to parse are simply absent, so
 * the caller's `?? default` path applies instead of a poisoned value.
 */
export function sanitizePersisted(raw) {
  if (!isObject(raw)) return null;
  const out = {};
  if (Array.isArray(raw.playlists)) out.playlists = sanitizePlaylists(raw.playlists);
  if (Array.isArray(raw.likedTrackIds)) out.likedTrackIds = asIdList(raw.likedTrackIds, LIMITS.liked);
  if (Array.isArray(raw.followedArtistIds)) out.followedArtistIds = asIdList(raw.followedArtistIds, LIMITS.followed);
  if (Array.isArray(raw.downloadedTrackIds)) out.downloadedTrackIds = asIdList(raw.downloadedTrackIds, LIMITS.downloads);
  if (Array.isArray(raw.history)) out.history = sanitizeHistory(raw.history);
  if (Array.isArray(raw.notifications)) out.notifications = sanitizeNotifications(raw.notifications);
  if (Array.isArray(raw.recentSearches)) out.recentSearches = sanitizeRecentSearches(raw.recentSearches);
  if (isObject(raw.settings)) out.settings = raw.settings;
  if (isObject(raw.eq)) out.eq = raw.eq;
  if ('volume' in raw) out.volume = asNumber(raw.volume, { min: 0, max: 1, fallback: 0.76 });
  return out;
}

/**
 * Validate an imported backup. Unlike storage, a bad file is *rejected* rather
 * than partially applied: the user picked it, so silence would be a lie.
 * Returns `{ ok: true, value }` or `{ ok: false, reason }`.
 */
export function sanitizeBackup(raw) {
  if (!isObject(raw)) return { ok: false, reason: 'Not an OpenMusic backup file' };
  const playlists = sanitizePlaylists(raw.playlists);
  const likedTrackIds = asIdList(raw.likedTrackIds, LIMITS.liked);
  const followedArtistIds = asIdList(raw.followedArtistIds, LIMITS.followed);
  const eq = isObject(raw.eq) && Array.isArray(raw.eq.bands) ? sanitizeEq(raw.eq, null) : null;
  const settings = isObject(raw.settings) ? raw.settings : null;
  const anything = playlists.length || likedTrackIds.length || followedArtistIds.length || eq || settings;
  if (!anything) return { ok: false, reason: 'Backup has no library, settings or equalizer data' };
  return {
    ok: true,
    value: {
      playlists,
      likedTrackIds,
      followedArtistIds,
      settings: settings ? { ...settings } : null,
      eq: eq && eq.bands.length ? eq : null,
    },
  };
}
