// OpenMusic catalog data & pure HTML helpers (vanilla JavaScript)

export function parseLrc(lrcText) {
  if (!lrcText || typeof lrcText !== 'string') return [];
  const lines = lrcText.split('\n');
  const result = [];
  const timeRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let match;
    timeRegex.lastIndex = 0;
    const timestamps = [];
    while ((match = timeRegex.exec(trimmed)) !== null) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const ms = match[3] ? parseInt(match[3].padEnd(3, '0').slice(0, 3), 10) : 0;
      timestamps.push(min * 60 + sec + ms / 1000);
    }
    const text = trimmed.replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, '').trim();
    if (text) {
      for (const t of timestamps) {
        result.push({ time: t, text });
      }
    }
  }
  return result.sort((a, b) => a.time - b.time);
}

// "5:15" / "1:02:03" → seconds; anything else → 0.
function clockToSecs(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v !== 'string') return 0;
  const parts = v.trim().split(':').map((x) => Number(x));
  if (!parts.length || parts.some((x) => !Number.isFinite(x))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** Lowercase, punctuation-free form for name matching (never for display). */
export function foldName(v) {
  return String(v ?? '')
    .toLowerCase()
    .replace(/\(from[^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** `"320 kbps Opus"` → `"320kbps"` — the backend's tier label. */
export function qualityTier(label) {
  const m = String(label ?? '').match(/(\d{2,3})\s*kbps/i);
  return m ? `${m[1]}kbps` : '320kbps';
}

/** Flat SongRow payload for `store_song` / `store_play` / `store_fav`. */
export function toStoreTrack(t) {
  if (!t || !t.id) return null;
  return {
    id: String(t.id),
    title: t.title || '',
    artist: t.artistName || t.artist || '',
    album: t.albumTitle || t.album || '',
    image: t.artwork || t.image || '',
    duration_secs: Math.max(0, Math.round(Number(t.duration) || 0)),
    language: t.language || '',
    year: t.year ? String(t.year) : '',
  };
}

export function mapUpstreamSongToTrack(s) {
  if (!s) return null;
  const id = String(s.id || s.token || '');
  if (!id) return null;
  const title = s.title || s.name || s.song || 'Unknown Title';
  const artist = s.artist || s.subtitle || s.primary_artists || s.singers || 'Unknown Artist';
  const album = s.album || s.album_name || title;
  const image = s.image || s.artwork || s.cover || '/logo.png';
  const dur = Number(s.duration_secs) || clockToSecs(s.duration) || 210;
  const artistIds = Array.isArray(s.artist_ids) ? s.artist_ids.filter(Boolean) : [];
  const slug = String(artist).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
  return {
    id,
    title,
    artistName: artist,
    artistId: s.artist_id || artistIds[0] || `artist-${slug}`,
    albumTitle: album,
    albumId: s.album_id || s.album_token || `album-${foldName(album).replace(/ /g, '-')}`,
    duration: dur,
    artwork: image,
    artworkSeed: title.slice(0, 2).toUpperCase(),
    qualityBadge: s.quality || '320 kbps MP3',
    sampleRate: '44.1 kHz',
    bitDepth: '16-bit',
    bitrate: '320 kbps',
    bpm: 128,
    scale: 'minor',
    rootMidi: 60,
    lossless: false,
    hiRes: Boolean(s.hq),
    genre: s.genre || 'Music',
    language: s.language || '',
    label: s.label || '',
    year: Number(s.year) || 0,
    sizeMb: Number(s.size_mb) || 0,
    streamUrl: s.streamUrl || s.url || '',
    lyrics: Array.isArray(s.lyrics) ? s.lyrics : typeof s.lyrics === 'string' ? parseLrc(s.lyrics) : [],
  };
}

export function mapUpstreamAlbumToAlbum(a) {
  if (!a) return null;
  const id = String(a.id || a.token || Math.random());
  const title = a.title || a.name || 'Unknown Album';
  const artist = a.artist || a.subtitle || a.primary_artists || 'Unknown Artist';
  const image = a.image || a.artwork || a.cover || '/logo.png';
  const year = a.year || (new Date().getFullYear());
  const trackIds = Array.isArray(a.tracks) ? a.tracks.map((t) => String(t.id || t)) : [];
  return {
    id,
    title,
    artistName: artist,
    artistId: a.artist_id || `artist-${id}`,
    artwork: image,
    artworkSeed: title.slice(0, 2).toUpperCase(),
    year: Number(year) || 0,
    description: a.description || '',
    releaseType: a.release_type || a.type || 'Album',
    releaseDate: a.release_date || (Number(year) ? String(year) : ''),
    genre: a.genre || 'Music',
    trackCount: trackIds.length || Number(a.song_count) || 0,
    durationText: a.duration ? `${Math.round(Number(a.duration) / 60)} min` : '',
    label: a.label || '',
    catalogueCode: `OM-${id.slice(0, 4).toUpperCase()}`,
    quality: a.quality || '320 kbps MP3',
    token: a.token || a.perma_url?.split('/').pop() || '',
    trackIds
  };
}

export function mapUpstreamArtistToArtist(ar) {
  if (!ar) return null;
  const id = String(ar.id || ar.token || Math.random());
  const name = ar.name || ar.title || 'Unknown Artist';
  const image = ar.image || ar.artwork || ar.avatar || '/logo.png';
  return {
    id,
    name,
    verified: Boolean(ar.verified ?? true),
    monthlyListeners: ar.follower_count ? Number(ar.follower_count).toLocaleString() : '500,000+',
    origin: ar.origin || 'International',
    banner: image,
    avatar: image,
    artworkSeed: name.slice(0, 2).toUpperCase(),
    bio: ar.bio || `${name} — Featured artist on OpenMusic streaming catalog.`,
    primaryLabel: ar.label || 'OpenMusic Artist Roster',
    globalRank: ar.rank ? `#${ar.rank}` : '#100 Global'
  };
}

/* ---------------------------------------------------------------------------
 * Real backend shapes (home_feed FeedItems, SQLite SongRows, vault entries).
 * These keep the token so album/artist/playlist detail can fetch their tracks
 * lazily, and carry `curated: true` so hydration can tell them apart from
 * playlists the user created.
 * ------------------------------------------------------------------------- */

export function mapFeedPlaylist(f, extra = {}) {
  if (!f || !f.id) return null;
  const title = f.title || 'Untitled playlist';
  const count = Number(f.count) || 0;
  return {
    id: String(f.id),
    title,
    subtitle: f.subtitle || (count ? `${count} tracks` : 'Playlist'),
    description: f.subtitle || title,
    curator: extra.isChart ? 'Charts' : 'OpenMusic Curation',
    featured: true,
    isPrivate: false,
    artwork: f.image || '/logo.png',
    artworkSeed: title.slice(0, 2).toUpperCase(),
    trackIds: [],
    trackCount: count,
    token: f.token || '',
    language: f.language || '',
    curated: true,
    isChart: Boolean(extra.isChart),
  };
}

export function mapFeedAlbum(f) {
  if (!f || !f.id) return null;
  const title = f.title || 'Untitled album';
  return {
    id: String(f.id),
    title,
    artistName: f.subtitle || 'Various Artists',
    artistId: `artist-${String(f.subtitle || 'various-artists').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`,
    artwork: f.image || '/logo.png',
    artworkSeed: title.slice(0, 2).toUpperCase(),
    year: Number(f.year) || 0,
    description: f.subtitle || '',
    releaseType: 'Album',
    releaseDate: String(f.year || ''),
    genre: 'Music',
    trackCount: Number(f.count) || 0,
    durationText: '',
    label: '',
    catalogueCode: '',
    quality: '320 kbps',
    trackIds: [],
    token: f.token || '',
    language: f.language || '',
    curated: true,
  };
}

export function mapFeedArtist(f) {
  if (!f || !f.id) return null;
  const name = f.title || f.name || 'Unknown Artist';
  return {
    id: String(f.id),
    name,
    verified: true,
    monthlyListeners: f.subtitle || '',
    origin: f.language || '',
    banner: f.image || '/logo.png',
    avatar: f.image || '/logo.png',
    artworkSeed: name.slice(0, 2).toUpperCase(),
    bio: '',
    primaryLabel: '',
    globalRank: '',
    token: f.token || '',
    curated: true,
  };
}

/** SQLite SongRow (store_recent / store_favs) → catalog track. */
export function mapSongRow(row) {
  if (!row) return null;
  const base = row.data && typeof row.data === 'object' ? { ...row.data, ...row } : row;
  return mapUpstreamSongToTrack(base);
}

/** Vault entry (list_downloads.entries[]) → catalog track. */
export function mapVaultEntry(e) {
  if (!e) return null;
  const t = mapUpstreamSongToTrack({ ...e, duration_secs: e.duration_secs });
  if (t) {
    t.qualityBadge = e.quality || t.qualityBadge;
    t.path = e.path || '';
  }
  return t;
}

export const IMG = {
  lateNightHero:
    'https://lh3.googleusercontent.com/aida-public/AB6AXuCpJUTSoe6Peo-vDfskdbBgVmjR-h_h3dby0SnrUl0lQqv_43a6msDzqkWzOOIy76FKq96dQSMY8T3z3C_amDxQZiidkhBY1EUcl7YGOabZX7QTCLXoLxOCGiaawE7JjkPxSoLeWUzMXuGTSHFBYyxqlq7qpGSHsN2ojnAfQZRzHiJjqWt-fuutjfGqBpoQw6rIsWvUkl8Jj1slwfpvvcYUtOkmKv_H6kc2c9mOAtV7mOne8ao_zcs4Jw',
  midnightLights:
    'https://lh3.googleusercontent.com/aida-public/AB6AXuAcKZJzER7JL8dMNY-fpx_CmgYAaSfDmjDdwYZg0vAcI5AQutKmFUvr3CxaTFcu0YvghYOmn6k4TGRAO0n5_SwvHF8qjffHzpw9F6pq3FzpPVEwUtqGYPJZlvVAbGbPpZWOLz3axrut8ThgLLP0RrYvqjD9K0YACcWSYWMOnB9TSNGCPdVPn38naV5bNf3Tz6fmoSmjYzDs6yDmd3rb_wY3LTVvHjl3hY5t7F1zPX9mYIw7bb3XpAKmGg',
  neonHorizons:
    'https://lh3.googleusercontent.com/aida-public/AB6AXuARKd03zp3_4CEBcmi2dccvygZI2HDm6eDo86_Wc7CSzXrXINh131w2UEBiwf5At-5eqLX6jsUzFtFbEG_HbmAAfkiyFIUXvlD-WQwBUHoRX7CsWf7CbHw4UWyR-yW_l3oUK8CiKrHRak-HHHR64hGM5V4df87rxbAO4J6i6f1xWfKVmG6-ltcKLcsZQg4PzWfSx64Q0mLGRifsFBXnHMYkwaGGXTs695YsJ02icWwlKK3O4QKczs8zzA',
  subtleEchoes:
    'https://lh3.googleusercontent.com/aida-public/AB6AXuBEAiOmU0iQcUB27VSDd3CYkb8mi0n3eA2hDU9bOTlKuXq9O84XBs2Bnn7Boost7RMKOxHe3qY7i3d8JPeHIBqculF0OdIJWsCdel7QhojYqHKSDodajiUCQiM5UcnHQqy2NyLyfdvh--pFo5t0FWvnz-xYpCk0lY3NsvPGBuFXy7hlx03uGw42QGzeXOmgUAY6TRTIgwdczSe3-FJjR2nrQQL0aeFlgxERzTdIXbNO3er9FdRbTVGfRg',
  crystalline:
    'https://lh3.googleusercontent.com/aida-public/AB6AXuDrcm4vDpksP6oaa5L3TCl4nA2y9BrGUCdtgRW-wVWih6In7PAaCaMdC7iVNeXFnfIMPDWNBmiduDMYTYUZp-vvqdBmXWHwuVh9vSVkn4OgLB1lPRm5zRKQtG16iaLMS8hP-o1l1BKgCfqwhppFG-CVpmqHQ8sXonKqhgbrIARxqeC0ctocP1XO94jsY1qh8yZHwrT-Df19xFbkdX8HnvVTukwWFxPet2VdFMUI0_zEKJAkirV3i-Gjfg',
  solarisBanner:
    'https://lh3.googleusercontent.com/aida-public/AB6AXuCok4LxRdB_3hYGFFbxPus1a34F-Orw4olgUBm7v7PtJFzfSh3NZBaGTlqXM82i9ntlgezqVwbtVXHjiAPxqjNScK5FHUoRC848rSRJsUOUytKy1nysrcNOHEkr7kVfxcf2EVbncclyQjkw8FJRKnbbt7yr34F-3giogx8aaAgR_v39W1UfQxP4qTsanXH8yk5HBZIseYElO8rfwdpZEu5qr7FSuVqV8RR97HuSQWyNe7voHPI4M8mEgQ',
  monolithCover:
    'https://lh3.googleusercontent.com/aida-public/AB6AXuA_TUIxDvjmv4s9E209tXPbml8Q5nYC7vV9PgItmrNz3Ct2Hy_xwndE3_yqyh5NPQ6G3VP54SDka8hKitdMteEQpTe64BnZX-3TCRVGwDjxFY5kjxU6q0ATIaTAb2LQY8g_IZTnjRLX6YNWm-n292lpM_OZCyGuiGvrHgkxzDrcqqEVGEw52A8EWXDHMJHeCDNkrmwpisWUzwxboIhAS8AX9e2nb-vVlgJ4aa3XKLF9HvHNLdMI3Aa-vg',
  solarisAvatar:
    'https://lh3.googleusercontent.com/aida-public/AB6AXuCirOvzA1FGSSsdVOAwqUZ40DGMcOW6nh2ioG-ejIyLa2nyOXvubfE397GJ0RAsJ-SLIi74V-ifb9qad_-b9Mh56-jRYOyKB_NSx6w_lcnH46iP8y_wV6nC5BJCbyiC4yFRKusQaV9KJ-wt6MfYDAS8t7YZKuNb2yco8Y7fgXH7SOJSZfmO7kQHq0HOAYLcJglZHfM4sqIeoQtKa3LC1JTqxDfK_gGkHvk6lKl0ZpJyURpVY5PtkycYVQ',
  nocturneSingle:
    'https://lh3.googleusercontent.com/aida-public/AB6AXuB2Idy6ziBdh61ZrOYMTcXrT9-GMxpdS6R9Wu1429njzOmjxIAgmtGNMXbve8L8FgN2SvklSBhYw4lmdKKt2kdao8UjJU5TxisujC9vB6OAPODIdpcc_-Z3_kJkqOu4Zeif3uZas_hAIpDvIaJ7QravWSSg5EsB0esfyBhOK00Rc0bPj-F6CdH0EN6fpK9G4JrPABF69o8HYJKnkRC4XFj480bRZBqQkO64vfMvQdNcs9PwzJJeu1xswg',
  resonanceEp:
    'https://lh3.googleusercontent.com/aida-public/AB6AXuAC5u6cud8gd_ogbk-Gy8hgEwRyeaAd2EUh-pDRszMrrLD-GXJyZ-rdFDo9ZUu5Qp6qmj-DYqCk8HRjsNKVVzHPC6czsjBwWuoQmJlmluyx6HTisOSF31XpelQz6tq3cd37XQ7-xjcOqTCeN-77_PaX5Lg1SOfYAgyqVnzTSKeb6zw23S17qTJy7CDQstaIzERCxaZGhlEApCtZs0mHGDvewYduclO1CnkgCn4R7T5z_0f3fKrNW4ifmw',
  curatedLateNight:
    'https://lh3.googleusercontent.com/aida-public/AB6AXuAWKMdtLdI5a7_xS9ltbANR9fNuDU-gMoXhJch5UqRRZd8-V8iEi5eZA1Qyx9pBIn23IBxDWhu8T2yxxVJ3e0xvV_EJ9bmG6MnoWBWIPj9bfM4XR50kWge1Mcw1wkxmlW3kTacupj6x4WbHseHIt0i6zgAm0wERX7A2vFHQAR-P1oo5BPILSMwiAAz4G99BcKsEZKXg33GygrFSxwIyc5ImBbSHOgXnUhHRxGkkhViYwEuAvXeMP5GB4g',
  nocturneSpiral:
    'https://lh3.googleusercontent.com/aida-public/AB6AXuD_k8npZTFOX7zsNxXjGHYq9POtr5Ms4GEffYZ0lBdldgGk00-9moTPSUJjb0kXljgsJXQFjBGEhF1DnXIEwnOtOGMLwYoLfq4SSQHvz9J495aQB5xJEVsypxFJM5Se-XFp26mRP2TgWhyJkQG1Dp2--c1U7lLUqnWcmvAmCx3drJ_bDBZjPndWrh8WqC6TPzb0OScM9VVzN501p8lf1tyAlYs5S1SJ6ZygbTKyWGyUGrfpKMm1cmjYeQ',
  waveformEp:
    'https://lh3.googleusercontent.com/aida-public/AB6AXuBj9WglYOSkg9OvKT549wPE9vgdff_5IncOqaC8p2H65M4ItHZKd1UpCySQuWwWBKDMVugVfXUimkbASs9-yLwIXmBXedh21LrJ3jVFHN_Yj3AB3jEWM7cDPOUUuGbJjB4huBfPhvssEP7_WIQMi0qAwpygCEe0bd3Hn6zpKSJ3JzZYo2EIygCq2hD_Z7JSmaJcb6PveSnNsftH4eQJUBxUvWJ-VXdmD-kDfNzmcMnb5aU8IpmWpO2Myg',
  topResultArt:
    'https://lh3.googleusercontent.com/aida-public/AB6AXuBoiWE1dvW8E4E2EA3Qd2-2txO5VQ8TEhdtyvqwGoySiHaRT2MU-Qv5lAD7P6DW1oeSrHDrmwh6ojej_n8dD9OAL6POh7hsUYg8RIYbFezSrF39WTyxmePOnDGlzVu5aSpXP2qMfWfkhPXnkBy1kqsFpcFVLz5Wfe8Yhy5ZibRXXgOqFuwjg4BgAFnODRNwfywwqMjOX7NW-EarnZcbtRnxhcoKdaHMf3CITxQjgasQk2hCFn-z2i0nkQ',
};

export const ARTISTS = [
  {
    id: 'artist-solaris',
    name: 'Solaris & Kaelen',
    verified: true,
    monthlyListeners: '1,248,920',
    origin: 'Berlin / Stockholm',
    banner: IMG.solarisBanner,
    avatar: IMG.solarisAvatar,
    artworkSeed: 'SK',
    bio: 'Duo exploring atmospheric progressive electronic, brutalist sound design, and acoustic minimalism since 2018. Based between Berlin and Stockholm, Solaris & Kaelen merge hardware analog modulations with clinical digital acoustics.',
    primaryLabel: 'Hyperion Sound',
    globalRank: '#34 Ambient & Modular',
  },
  {
    id: 'artist-aura',
    name: 'Aura Sound',
    verified: true,
    monthlyListeners: '842,110',
    origin: 'Copenhagen',
    banner: IMG.neonHorizons,
    avatar: IMG.neonHorizons,
    artworkSeed: 'AS',
    bio: 'Copenhagen-based producer crafting deep nocturnal chords, analog tape loops, and slow-burning progressive trance landscapes engineered for late-night headphone listening.',
    primaryLabel: 'Nordic Pulse Recordings',
    globalRank: '#61 Progressive Electronic',
  },
  {
    id: 'artist-mirage',
    name: 'Mirage Architecture',
    verified: true,
    monthlyListeners: '615,400',
    origin: 'Zurich',
    banner: IMG.subtleEchoes,
    avatar: IMG.subtleEchoes,
    artworkSeed: 'MA',
    bio: 'Spatial sound collective building minimalist dub-techno and resonant architectural ambient works recorded directly to quarter-inch master tape.',
    primaryLabel: 'Monolith Press',
    globalRank: '#88 Spatial & Ambient',
  },
  {
    id: 'artist-kaelen',
    name: 'Kaelen Solo Archive',
    verified: true,
    monthlyListeners: '509,380',
    origin: 'Stockholm',
    banner: IMG.crystalline,
    avatar: IMG.crystalline,
    artworkSeed: 'KS',
    bio: 'Solo modular synthesizer sketches, quartz percussion studies, and crystalline granular soundscapes from the Stockholm archive.',
    primaryLabel: 'Hyperion Sound',
    globalRank: '#112 Modular Synthesis',
  },
  {
    id: 'artist-vesper',
    name: 'Vesper & Lin',
    verified: true,
    monthlyListeners: '734,800',
    origin: 'Reykjavik / Amsterdam',
    banner: IMG.nocturneSpiral,
    avatar: IMG.waveformEp,
    artworkSeed: 'VL',
    bio: 'Vocal trance and cinematic ambient duo pairing ethereal Nordic vocal textures with hypnotic 128 BPM rolling sub-bass architecture.',
    primaryLabel: 'Aether Acoustics',
    globalRank: '#49 Vocal & Uplifting',
  },
  {
    id: 'artist-nord',
    name: 'Nordkapp Signal',
    verified: false,
    monthlyListeners: '284,150',
    origin: 'Oslo',
    banner: IMG.lateNightHero,
    avatar: IMG.lateNightHero,
    artworkSeed: 'NS',
    bio: 'High-precision tech trance and psy-minimal field recordings captured along the Arctic coastline and processed through vintage studio filters.',
    primaryLabel: 'Fjord Audio',
    globalRank: '#147 Tech Trance',
  },
];

export const ALBUMS = [
  {
    id: 'album-monolith',
    title: 'Monolith Sessions',
    artistId: 'artist-solaris',
    artistName: 'Solaris & Kaelen',
    year: 2024,
    releaseDate: 'OCT 2024',
    releaseType: 'Album',
    label: 'HYPERION SOUND',
    artwork: IMG.monolithCover,
    artworkSeed: 'MS',
    description:
      'Recorded across concrete chambers in Berlin and studio halls in Stockholm, Monolith Sessions blends crystalline harmonic pads with taut progressive momentum.',
    trackIds: ['trk-1', 'trk-5', 'trk-6', 'trk-7'],
  },
  {
    id: 'album-resonance',
    title: 'Resonance EP',
    artistId: 'artist-solaris',
    artistName: 'Solaris & Kaelen',
    year: 2023,
    releaseDate: 'NOV 2023',
    releaseType: 'EP',
    label: 'HYPERION SOUND',
    artwork: IMG.resonanceEp,
    artworkSeed: 'RE',
    description: 'Six-part study in harmonic overtones, restrained percussion, and deep low-end acoustics.',
    trackIds: ['trk-8', 'trk-9'],
  },
  {
    id: 'album-nocturne',
    title: 'Nocturne Trance Vol. IV',
    artistId: 'artist-solaris',
    artistName: 'Solaris & Kaelen',
    year: 2024,
    releaseDate: 'AUG 2024',
    releaseType: 'Single',
    label: 'HYPERION SOUND',
    artwork: IMG.nocturneSingle,
    artworkSeed: 'NT',
    description: 'Late-hour collaborative single featuring Aura Sound on analog arpeggiators and tape delay.',
    trackIds: ['trk-10'],
  },
  {
    id: 'album-horizons',
    title: 'Afterglow Architecture',
    artistId: 'artist-aura',
    artistName: 'Aura Sound',
    year: 2024,
    releaseDate: 'SEP 2024',
    releaseType: 'Album',
    label: 'NORDIC PULSE',
    artwork: IMG.neonHorizons,
    artworkSeed: 'AA',
    description: 'Wide-screen nocturnal electronics designed around slow-evolving sawtooth waves and crisp percussion.',
    trackIds: ['trk-2', 'trk-11'],
  },
  {
    id: 'album-echoes',
    title: 'Tactile Surfaces',
    artistId: 'artist-mirage',
    artistName: 'Mirage Architecture',
    year: 2024,
    releaseDate: 'JUN 2024',
    releaseType: 'Album',
    label: 'MONOLITH PRESS',
    artwork: IMG.subtleEchoes,
    artworkSeed: 'TS',
    description: 'Minimalist spatial textures and matte ambient drones mastered at 24-bit / 96kHz.',
    trackIds: ['trk-3', 'trk-12'],
  },
  {
    id: 'album-quartz',
    title: 'Quartz Dispersion',
    artistId: 'artist-kaelen',
    artistName: 'Kaelen Solo Archive',
    year: 2024,
    releaseDate: 'MAY 2024',
    releaseType: 'EP',
    label: 'HYPERION SOUND',
    artwork: IMG.crystalline,
    artworkSeed: 'QD',
    description: 'High-key granular synthesis works built from acoustic piano harmonics and modular filters.',
    trackIds: ['trk-4'],
  },
  {
    id: 'album-aether',
    title: 'Glass Horizon',
    artistId: 'artist-vesper',
    artistName: 'Vesper & Lin',
    year: 2024,
    releaseDate: 'OCT 2024',
    releaseType: 'Album',
    label: 'AETHER ACOUSTICS',
    artwork: IMG.waveformEp,
    artworkSeed: 'GH',
    description: 'Uplifting vocal trance and atmospheric breaks recorded in Reykjavik.',
    trackIds: ['trk-13', 'trk-14'],
  },
  {
    id: 'album-arctic',
    title: 'Polar Telemetry',
    artistId: 'artist-nord',
    artistName: 'Nordkapp Signal',
    year: 2023,
    releaseDate: 'DEC 2023',
    releaseType: 'Album',
    label: 'FJORD AUDIO',
    artwork: IMG.nocturneSpiral,
    artworkSeed: 'PT',
    description: 'Relentless tech trance and psy-progressive rhythmic precision.',
    trackIds: ['trk-15', 'trk-16'],
  },
];

export const TRACKS = [
  {
    id: 'trk-1',
    title: 'Midnight City Lights',
    artistId: 'artist-solaris',
    artistName: 'Solaris & Kaelen',
    albumId: 'album-monolith',
    albumTitle: 'Monolith Sessions',
    duration: 258,
    artwork: IMG.midnightLights,
    artworkSeed: 'MC',
    genre: 'Progressive Trance',
    year: 2024,
    hiRes: true,
    bitrate: '320 KBPS',
    bpm: 124,
    rootMidi: 57,
    scale: 'minor',
    chartRank: 1,
    sizeMb: 11.8,
    lyrics: [
      { time: 0, text: 'Static hum beneath the sodium glow' },
      { time: 12, text: 'Concrete towers breathing slow and low' },
      { time: 24, text: 'Midnight city lights dissolve the rain' },
      { time: 38, text: 'Signals crossing on an open plane' },
      { time: 52, text: 'Hold the frequency until the morning clears' },
      { time: 68, text: 'Every echo calibrates the atmosphere' },
      { time: 86, text: 'Glass reflections tracing avenues of chrome' },
      { time: 104, text: 'Low-end pulse is guiding every traveler home' },
      { time: 126, text: 'Midnight city lights, stay luminous and still' },
      { time: 148, text: 'Weightless cadence rising past the harbor hill' },
      { time: 174, text: 'Let the silence settle between every frame' },
      { time: 200, text: 'Only silver horizon and the quiet flame' },
    ],
  },
  {
    id: 'trk-2',
    title: 'Neon Horizons',
    artistId: 'artist-aura',
    artistName: 'Aura Sound',
    albumId: 'album-horizons',
    albumTitle: 'Afterglow Architecture',
    duration: 314,
    artwork: IMG.neonHorizons,
    artworkSeed: 'NH',
    genre: 'Progressive Trance',
    year: 2024,
    hiRes: true,
    bitrate: '320 KBPS',
    bpm: 122,
    rootMidi: 53,
    scale: 'dorian',
    chartRank: 2,
    sizeMb: 14.2,
    lyrics: [
      { time: 0, text: 'Distant skyline fading into slate' },
      { time: 16, text: 'Open highways after half past eight' },
      { time: 34, text: 'Neon horizons shimmer on the bay' },
      { time: 54, text: 'Pulling all the static miles away' },
      { time: 78, text: 'Warm analog currents drifting through the glass' },
      { time: 102, text: 'Watch the midnight silhouettes go past' },
      { time: 132, text: 'Stay in motion till the northern lights align' },
      { time: 168, text: 'Every wavelength balanced on the line' },
    ],
  },
  {
    id: 'trk-3',
    title: 'Subtle Echoes',
    artistId: 'artist-mirage',
    artistName: 'Mirage Architecture',
    albumId: 'album-echoes',
    albumTitle: 'Tactile Surfaces',
    duration: 232,
    artwork: IMG.subtleEchoes,
    artworkSeed: 'SE',
    genre: 'Ambient',
    year: 2024,
    hiRes: true,
    bitrate: '24-BIT',
    bpm: 92,
    rootMidi: 55,
    scale: 'dorian',
    chartRank: 4,
    sizeMb: 18.4,
    lyrics: [
      { time: 0, text: 'Paper grain and winter air' },
      { time: 20, text: 'Subtle echoes lingering everywhere' },
      { time: 44, text: 'Soft reverberation on the plaster wall' },
      { time: 72, text: 'Barely a whisper in the silent hall' },
      { time: 104, text: 'Listen closely as the harmonics bend' },
      { time: 140, text: 'Where the stillness meets the quiet end' },
    ],
  },
  {
    id: 'trk-4',
    title: 'Crystalline Dispersion',
    artistId: 'artist-kaelen',
    artistName: 'Kaelen Solo Archive',
    albumId: 'album-quartz',
    albumTitle: 'Quartz Dispersion',
    duration: 287,
    artwork: IMG.crystalline,
    artworkSeed: 'CD',
    genre: 'Ambient',
    year: 2024,
    hiRes: true,
    bitrate: '24-BIT',
    bpm: 98,
    rootMidi: 60,
    scale: 'major',
    chartRank: 6,
    sizeMb: 21.6,
    lyrics: [
      { time: 0, text: 'Instrumental modular study — Part I' },
      { time: 28, text: 'Refracted quartz harmonics in stereo field' },
      { time: 64, text: 'Granular piano resonance opening wide' },
      { time: 110, text: 'Sub-octave shimmer slowly decaying' },
      { time: 164, text: 'Return to pure sine equilibrium' },
    ],
  },
  {
    id: 'trk-5',
    title: 'Concrete Horizons',
    artistId: 'artist-solaris',
    artistName: 'Solaris & Kaelen',
    albumId: 'album-monolith',
    albumTitle: 'Monolith Sessions',
    duration: 232,
    artwork: IMG.monolithCover,
    artworkSeed: 'CH',
    genre: 'Tech Trance',
    year: 2024,
    hiRes: true,
    bitrate: '320 KBPS',
    bpm: 130,
    rootMidi: 52,
    scale: 'phrygian',
    chartRank: 3,
    sizeMb: 10.7,
    lyrics: [
      { time: 0, text: 'Monolith shadow across the courtyard stone' },
      { time: 18, text: 'Precision rhythm carved in monochrome' },
      { time: 40, text: 'Concrete horizons rising sharp and clean' },
      { time: 66, text: 'Pulse of the architecture in between' },
      { time: 96, text: 'Lock into the cadence, let the filters climb' },
      { time: 132, text: 'Every transient suspended out of time' },
    ],
  },
  {
    id: 'trk-6',
    title: 'Obsidian Echoes',
    artistId: 'artist-solaris',
    artistName: 'Solaris & Kaelen',
    albumId: 'album-monolith',
    albumTitle: 'Monolith Sessions',
    duration: 220,
    artwork: IMG.monolithCover,
    artworkSeed: 'OE',
    genre: 'Progressive Trance',
    year: 2024,
    hiRes: false,
    bitrate: '256 KBPS',
    bpm: 126,
    rootMidi: 50,
    scale: 'minor',
    sizeMb: 8.9,
    lyrics: [
      { time: 0, text: 'Obsidian surface catching twilight rain' },
      { time: 22, text: 'Low frequency waves roll across the plain' },
      { time: 48, text: 'Shadows stretching past the concrete pier' },
      { time: 80, text: 'Obsidian echoes crystal clear' },
    ],
  },
  {
    id: 'trk-7',
    title: 'Nordic Telemetry',
    artistId: 'artist-solaris',
    artistName: 'Solaris & Kaelen',
    albumId: 'album-monolith',
    albumTitle: 'Monolith Sessions',
    duration: 274,
    artwork: IMG.topResultArt,
    artworkSeed: 'NL',
    genre: 'Ambient',
    year: 2024,
    hiRes: true,
    bitrate: '24-BIT',
    bpm: 108,
    rootMidi: 57,
    scale: 'dorian',
    sizeMb: 19.2,
    lyrics: [
      { time: 0, text: 'Northern relay beacon at 02:00' },
      { time: 30, text: 'Clear skies over Stockholm harbor' },
      { time: 72, text: 'Analog tape hiss warming the room' },
      { time: 124, text: 'Quiet calibration until first light' },
    ],
  },
  {
    id: 'trk-8',
    title: 'Harmonic Drift',
    artistId: 'artist-solaris',
    artistName: 'Solaris & Kaelen',
    albumId: 'album-resonance',
    albumTitle: 'Resonance EP',
    duration: 245,
    artwork: IMG.resonanceEp,
    artworkSeed: 'HD',
    genre: 'Uplifting Trance',
    year: 2023,
    hiRes: true,
    bitrate: '320 KBPS',
    bpm: 134,
    rootMidi: 59,
    scale: 'major',
    chartRank: 7,
    sizeMb: 11.4,
    lyrics: [
      { time: 0, text: 'Opening chords breaking through the overcast' },
      { time: 24, text: 'Harmonic drift carrying us forward fast' },
      { time: 52, text: 'Sunlight shimmering on silver glass' },
      { time: 88, text: 'Hold the horizon as the clouds move past' },
    ],
  },
  {
    id: 'trk-9',
    title: 'Acoustic Grid 04',
    artistId: 'artist-solaris',
    artistName: 'Solaris & Kaelen',
    albumId: 'album-resonance',
    albumTitle: 'Resonance EP',
    duration: 212,
    artwork: IMG.resonanceEp,
    artworkSeed: 'AG',
    genre: 'Tech Trance',
    year: 2023,
    hiRes: false,
    bitrate: '256 KBPS',
    bpm: 132,
    rootMidi: 52,
    scale: 'minor',
    sizeMb: 8.6,
    lyrics: [
      { time: 0, text: 'Modular clock synced to 132 BPM' },
      { time: 34, text: 'Grid alignment across four stereo buses' },
      { time: 80, text: 'Resonant filter sweep into breakdown' },
    ],
  },
  {
    id: 'trk-10',
    title: 'Nocturne Trance Vol. IV',
    artistId: 'artist-solaris',
    artistName: 'Solaris & Kaelen feat. Aura',
    albumId: 'album-nocturne',
    albumTitle: 'Nocturne Trance Vol. IV',
    duration: 372,
    artwork: IMG.nocturneSingle,
    artworkSeed: 'NV',
    genre: 'Uplifting Trance',
    year: 2024,
    hiRes: true,
    bitrate: '320 KBPS',
    bpm: 136,
    rootMidi: 55,
    scale: 'minor',
    chartRank: 5,
    sizeMb: 16.9,
    lyrics: [
      { time: 0, text: 'Light trails bending through the tunnel arch' },
      { time: 22, text: 'Feel the tempo gather in the dark' },
      { time: 48, text: 'Nocturne trance unfolding in the midnight air' },
      { time: 82, text: 'Every frequency suspended everywhere' },
      { time: 120, text: 'Rise through the mist until the skyline glows' },
      { time: 162, text: 'Where the endless signal flows' },
    ],
  },
  {
    id: 'trk-11',
    title: 'Velvet Pulse',
    artistId: 'artist-aura',
    artistName: 'Aura Sound',
    albumId: 'album-horizons',
    albumTitle: 'Afterglow Architecture',
    duration: 266,
    artwork: IMG.curatedLateNight,
    artworkSeed: 'VP',
    genre: 'Progressive Trance',
    year: 2024,
    hiRes: true,
    bitrate: '320 KBPS',
    bpm: 121,
    rootMidi: 50,
    scale: 'dorian',
    sizeMb: 12.1,
    lyrics: [
      { time: 0, text: 'Soft velvet pulse across the harbor bridge' },
      { time: 28, text: 'Cold mist drifting past the northern ridge' },
      { time: 64, text: 'Turn the dial down to the warmest tone' },
      { time: 102, text: 'Listening together though we walk alone' },
    ],
  },
  {
    id: 'trk-12',
    title: 'Matte Horizon',
    artistId: 'artist-mirage',
    artistName: 'Mirage Architecture',
    albumId: 'album-echoes',
    albumTitle: 'Tactile Surfaces',
    duration: 248,
    artwork: IMG.subtleEchoes,
    artworkSeed: 'MH',
    genre: 'Ambient',
    year: 2024,
    hiRes: true,
    bitrate: '24-BIT',
    bpm: 86,
    rootMidi: 53,
    scale: 'major',
    sizeMb: 19.8,
    lyrics: [
      { time: 0, text: 'Still water beneath an overcast sky' },
      { time: 36, text: 'Uncolored light along the shore' },
      { time: 84, text: 'Breathe in the quiet room' },
    ],
  },
  {
    id: 'trk-13',
    title: 'Silver Voice in Mist',
    artistId: 'artist-vesper',
    artistName: 'Vesper & Lin',
    albumId: 'album-aether',
    albumTitle: 'Glass Horizon',
    duration: 294,
    artwork: IMG.waveformEp,
    artworkSeed: 'SV',
    genre: 'Vocal Trance',
    year: 2024,
    hiRes: true,
    bitrate: '320 KBPS',
    bpm: 128,
    rootMidi: 60,
    scale: 'minor',
    chartRank: 8,
    sizeMb: 13.5,
    lyrics: [
      { time: 0, text: 'Calling out across the silver mist' },
      { time: 18, text: 'Every word becomes a melody' },
      { time: 38, text: 'Hold on to the warmth before it fades' },
      { time: 62, text: 'We are moving weightless in the sound' },
      { time: 92, text: 'Carry me beyond the glass horizon' },
      { time: 128, text: 'Where the night turns into clear blue day' },
    ],
  },
  {
    id: 'trk-14',
    title: 'Aurora Cadence',
    artistId: 'artist-vesper',
    artistName: 'Vesper & Lin',
    albumId: 'album-aether',
    albumTitle: 'Glass Horizon',
    duration: 261,
    artwork: IMG.waveformEp,
    artworkSeed: 'AC',
    genre: 'Uplifting Trance',
    year: 2024,
    hiRes: true,
    bitrate: '320 KBPS',
    bpm: 136,
    rootMidi: 57,
    scale: 'major',
    chartRank: 9,
    sizeMb: 12.0,
    lyrics: [
      { time: 0, text: 'Curtains of emerald folding overhead' },
      { time: 26, text: 'Every heartbeat keeping perfect time' },
      { time: 58, text: 'Aurora cadence lighting up the frost' },
      { time: 96, text: 'Nothing left behind and nothing lost' },
    ],
  },
  {
    id: 'trk-15',
    title: 'Spiral Vector',
    artistId: 'artist-nord',
    artistName: 'Nordkapp Signal',
    albumId: 'album-arctic',
    albumTitle: 'Polar Telemetry',
    duration: 304,
    artwork: IMG.nocturneSpiral,
    artworkSeed: 'SP',
    genre: 'Psy Trance',
    year: 2023,
    hiRes: true,
    bitrate: '320 KBPS',
    bpm: 140,
    rootMidi: 50,
    scale: 'phrygian',
    chartRank: 10,
    sizeMb: 14.0,
    lyrics: [
      { time: 0, text: 'Spiral staircase turning into zero point' },
      { time: 32, text: 'Rolling bassline locked to phase' },
      { time: 74, text: 'High-latitude signal resonance' },
      { time: 126, text: 'Full spectrum acceleration' },
    ],
  },
  {
    id: 'trk-16',
    title: 'Subzero Transit',
    artistId: 'artist-nord',
    artistName: 'Nordkapp Signal',
    albumId: 'album-arctic',
    albumTitle: 'Polar Telemetry',
    duration: 254,
    artwork: IMG.lateNightHero,
    artworkSeed: 'ST',
    genre: 'Tech Trance',
    year: 2023,
    hiRes: false,
    bitrate: '256 KBPS',
    bpm: 134,
    rootMidi: 52,
    scale: 'phrygian',
    sizeMb: 10.2,
    lyrics: [
      { time: 0, text: 'Midnight rails across the frozen bay' },
      { time: 28, text: 'Steel percussion echoing the dark' },
      { time: 68, text: 'Subzero transit to the northern edge' },
    ],
  },
];

export const INITIAL_PLAYLISTS = [];

export const GENRE_CARDS = [
  { label: 'Telugu Songs', query: 'telugu songs', icon: 'music_note', bg: 'linear-gradient(135deg, #1565c0, #0d47a1)' },
  { label: 'Hindi Songs', query: 'hindi songs', icon: 'music_note', bg: 'linear-gradient(135deg, #d84315, #ef6c00)' },
  { label: 'Tamil Songs', query: 'tamil songs', icon: 'music_note', bg: 'linear-gradient(135deg, #00695c, #00897b)' },
  { label: 'English Songs', query: 'english songs', icon: 'music_note', bg: 'linear-gradient(135deg, #4a148c, #7b1fa2)' },
  { label: 'Malayalam Songs', query: 'malayalam songs', icon: 'music_note', bg: 'linear-gradient(135deg, #004d40, #00796b)' },
  { label: 'Bhojpuri Songs', query: 'bhojpuri songs', icon: 'music_note', bg: 'linear-gradient(135deg, #880e4f, #ad1457)' },
];

export const INITIAL_HISTORY = [
  { id: 'h-1', trackId: 'trk-1', playedAt: Date.now() - 1000 * 60 * 14, listenedSec: 258 },
  { id: 'h-2', trackId: 'trk-2', playedAt: Date.now() - 1000 * 60 * 48, listenedSec: 314 },
  { id: 'h-3', trackId: 'trk-5', playedAt: Date.now() - 1000 * 60 * 110, listenedSec: 232 },
  { id: 'h-4', trackId: 'trk-10', playedAt: Date.now() - 1000 * 60 * 60 * 5, listenedSec: 340 },
  { id: 'h-5', trackId: 'trk-3', playedAt: Date.now() - 1000 * 60 * 60 * 26, listenedSec: 232 },
  { id: 'h-6', trackId: 'trk-13', playedAt: Date.now() - 1000 * 60 * 60 * 30, listenedSec: 294 },
  { id: 'h-7', trackId: 'trk-4', playedAt: Date.now() - 1000 * 60 * 60 * 52, listenedSec: 287 },
  { id: 'h-8', trackId: 'trk-15', playedAt: Date.now() - 1000 * 60 * 60 * 78, listenedSec: 304 },
];

export const INITIAL_NOTIFICATIONS = [
  {
    id: 'n-1',
    category: 'downloads',
    title: 'Offline Vault synced',
    body: 'Monolith Sessions (4 tracks · 320 kbps Opus) verified in local storage.',
    timestamp: Date.now() - 1000 * 60 * 24,
    read: false,
  },
  {
    id: 'n-2',
    category: 'update',
    title: 'OpenMusic v0.5.1 ready',
    body: 'Improved 5-band Biquad equalizer headroom and smoother synced lyric timing.',
    timestamp: Date.now() - 1000 * 60 * 60 * 4,
    read: false,
  },
  {
    id: 'n-3',
    category: 'system',
    title: 'Acoustic telemetry active',
    body: 'Listening history is stored locally on this device (capped at 3,000 events).',
    timestamp: Date.now() - 1000 * 60 * 60 * 22,
    read: true,
  },
];

export const EQ_PRESETS = {
  Flat: [0, 0, 0, 0, 0],
  Audiophile: [1.5, 0.5, 0, 1.5, 2.5],
  'Bass Boost': [5.5, 3.5, 0, 0.5, 1],
  Vocal: [-1, 1, 3.5, 3, 1],
  'Late Night': [2.5, 1, -1.5, -1, 1.5],
};

export const EQ_LABELS = ['60Hz', '230Hz', '910Hz', '3.6kHz', '14kHz'];

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

export function formatDurationLong(totalSec) {
  const mins = Math.max(1, Math.round(totalSec / 60));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h} hr ${m} min` : `${h} hr`;
}

export function formatRelativeTime(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const diffSec = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

const ART_PALETTES = [
  ['#16181c', '#2e323a', '#7c828f'],
  ['#1b1d20', '#383a40', '#a3a5ad'],
  ['#13151a', '#262b36', '#6b758a'],
  ['#1d1c1b', '#3b3936', '#9a958d'],
  ['#141918', '#273532', '#6d8a83'],
  ['#1a171c', '#342c38', '#8c7a96'],
];

function hashSeed(input) {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * JioSaavn serves a stock grey avatar for artists it has no photo of. It is not
 * artwork and the Android CSP does not allow that host, so paint our own sleeve
 * instead of a request that can only fail.
 */
/**
 * JioSaavn publishes the same artwork at several renditions (`-50x50`,
 * `-150x150`, `-500x500`). A 52 px row does not need 35 KB of image, so map a
 * target pixel size onto the nearest rendition. Never upscales, and leaves
 * URLs without a size suffix (editorial art) untouched.
 */
export function artVariant(src, targetPx) {
  const url = normalizeArtworkSrc(src);
  if (!url || !targetPx) return url;
  const m = url.match(/^(.*)-(\d+)x(\d+)(\.(?:jpe?g|png|webp))(\?.*)?$/i);
  if (!m) return url;
  const current = Number(m[2]) || 0;
  const pick = targetPx <= 75 ? 50 : targetPx <= 250 ? 150 : 500;
  if (current && current <= pick) return url;
  return `${m[1]}-${pick}x${pick}${m[4]}${m[5] || ''}`;
}

function normalizeArtworkSrc(src) {
  const url = String(src || '').trim();
  if (!url) return '';
  if (/jiosaavn\.com\/_i\/3\.0\/artist-default/i.test(url)) return '';
  if (!isUsableImageSrc(url)) return '';
  return url;
}

/**
 * A value is artwork only when a browser can actually fetch it: an absolute
 * URL, a same-origin path, or an inline data/blob URI. Seed records and a few
 * upstream rows carry opaque ids in their image fields; rendering those as
 * `<img src>` paints the browser's broken-image icon over the sleeve.
 */
export function isUsableImageSrc(src) {
  const v = String(src || '').trim();
  if (!v) return false;
  return /^(https?:)?\/\//i.test(v) || /^data:image\//i.test(v) || /^blob:/i.test(v) || (v.startsWith('/') && v.length > 1);
}

/** Pure HTML artwork block with automatic geometric SVG sleeve fallback on image error */
export function renderArtwork({
  src = '',
  alt = '',
  seed = 'OM',
  size = '',
  round = 'round-md',
  square = false,
  playing = false,
  extraClass = '',
  badge = '',
}) {
  const idx = hashSeed(seed + alt) % ART_PALETTES.length;
  const [c1, c2, c3] = ART_PALETTES[idx];
  const label = escapeHtml((seed || alt.slice(0, 2)).toUpperCase().slice(0, 2));
  const styleSize = size ? `width:${size};height:${size};` : '';
  src = normalizeArtworkSrc(src);

  // Small tiles get a small rendition; the browser picks by layout × DPR.
  const px = parseInt(size, 10) || 0;
  let imgSrc = src;
  let imgSrcSet = '';
  if (src && px > 0) {
    const small = artVariant(src, 150);
    const large = artVariant(src, 500);
    if (small !== large) {
      imgSrc = small;
      imgSrcSet = `${small} 150w, ${large} 500w`;
    }
  }

  return `
    <div class="artwork ${src ? 'has-img' : 'img-ready'} ${round} ${square ? 'square' : ''} ${extraClass}"
      style="${styleSize}background-image:linear-gradient(135deg,${c1} 0%,${c2} 58%,${c3} 100%);">
      <div class="artwork-fallback" aria-hidden="true">
        <svg viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="36" fill="none" stroke="white" stroke-width="1"></circle>
          <circle cx="50" cy="50" r="22" fill="none" stroke="white" stroke-width="0.75"></circle>
          <line x1="14" y1="50" x2="86" y2="50" stroke="white" stroke-width="0.6"></line>
          <rect x="44" y="14" width="12" height="72" fill="white" fill-opacity="0.14"></rect>
        </svg>
        <span class="artwork-fallback-label">${label}</span>
      </div>
      ${
        src
          ? `<img src="${escapeHtml(imgSrc)}"${imgSrcSet ? ` srcset="${escapeHtml(imgSrcSet)}" sizes="${px}px"` : ''} alt="${escapeHtml(alt)}" referrerpolicy="no-referrer" loading="lazy" decoding="async" style="position:relative;z-index:1;" />`
          : ''
      }
      ${
        playing
          ? `<div class="artwork-playing-overlay" style="z-index:2;"><div class="eq-bars" aria-label="Playing"><span></span><span></span><span></span></div></div>`
          : ''
      }
      ${badge ? `<span class="rank-badge" style="z-index:3;">${escapeHtml(badge)}</span>` : ''}
    </div>
  `;
}
