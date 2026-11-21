import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS,
  asIdList,
  asNumber,
  asText,
  sanitizeBackup,
  sanitizeEq,
  sanitizeHistory,
  sanitizeNotifications,
  sanitizePersisted,
  sanitizePlaylist,
  sanitizePlaylists,
  sanitizeSettings,
} from '../src/mobile/studio/persist.js';

const SETTINGS = {
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
const EQ = { enabled: true, preset: 'Audiophile', bands: [4, 2, 0, 1, 3] };

test('asText strips control characters, trims and caps length', () => {
  assert.equal(asText('  hey\u0000 there \n', 40), 'hey there');
  assert.equal(asText('x'.repeat(400), 10), 'x'.repeat(10));
  assert.equal(asText(42, 10), '42');
  assert.equal(asText(null), '');
  assert.equal(asText({ toString: () => 'nope' }), '');
});

test('asIdList keeps only usable ids, dedupes and caps', () => {
  assert.deepEqual(asIdList(['a', 'a', '', ' b ', 7, null, {}]), ['a', 'b', '7']);
  assert.deepEqual(asIdList('not-an-array'), []);
  assert.equal(asIdList(Array.from({ length: 10 }, (_, i) => `id-${i}`), 3).length, 3);
});

test('asNumber clamps and rejects non-finite values', () => {
  assert.equal(asNumber('0.5', { min: 0, max: 1, fallback: 0.7 }), 0.5);
  assert.equal(asNumber(4, { min: 0, max: 1, fallback: 0.7 }), 1);
  assert.equal(asNumber(-4, { min: 0, max: 1, fallback: 0.7 }), 0);
  assert.equal(asNumber('loud', { fallback: 0.7 }), 0.7);
  assert.equal(asNumber(NaN, { fallback: 0.7 }), 0.7);
});

test('sanitizeSettings repairs wrong types instead of merging them', () => {
  const out = sanitizeSettings(
    { darkMode: 'yes', languages: 'English', crossfadeSec: 99, displayName: '   ', unknownKey: 'x', country: 12 },
    SETTINGS,
  );
  assert.equal(out.darkMode, false, 'a string is not a boolean');
  assert.deepEqual(out.languages, SETTINGS.languages, 'a string is not a language list');
  assert.equal(out.crossfadeSec, 12, 'crossfade is clamped, not trusted');
  assert.equal(out.displayName, 'Alex Mercer', 'blank display names fall back');
  assert.equal(out.country, '12', 'scalars are coerced to text');
  assert.equal('unknownKey' in out, false, 'unknown keys never reach settings');
});

test('sanitizeSettings always leaves at least one language selected', () => {
  const out = sanitizeSettings({ languages: [] }, SETTINGS);
  assert.deepEqual(out.languages, SETTINGS.languages);
  const cleaned = sanitizeSettings({ languages: ['Tamil', 'Tamil', '', 3] }, SETTINGS);
  assert.deepEqual(cleaned.languages, ['Tamil', '3']);
});

test('sanitizeSettings keeps lastBackupAt numeric or null', () => {
  assert.equal(sanitizeSettings({ lastBackupAt: 'sometime' }, SETTINGS).lastBackupAt, null);
  assert.equal(sanitizeSettings({ lastBackupAt: 1700000000000 }, SETTINGS).lastBackupAt, 1700000000000);
});

test('sanitizeEq rejects wrong-length or non-numeric bands', () => {
  assert.deepEqual(sanitizeEq({ enabled: 'no', bands: [1, 2] }, EQ), { enabled: true, preset: 'Audiophile', bands: EQ.bands });
  assert.deepEqual(sanitizeEq({ bands: ['6', 2, 0, 1, 3], preset: 'Bass' }, EQ).bands, [6, 2, 0, 1, 3]);
  assert.deepEqual(sanitizeEq({ bands: [99, -99, 0, 0, 0] }, EQ).bands, [12, -12, 0, 0, 0], 'bands are clamped to ±12 dB');
  assert.deepEqual(sanitizeEq(null, EQ).bands, EQ.bands);
});

test('sanitizePlaylist drops rows a screen could not render', () => {
  assert.equal(sanitizePlaylist(null), null);
  assert.equal(sanitizePlaylist({ id: 'p1' }), null, 'no title');
  assert.equal(sanitizePlaylist({ title: 'No id' }), null, 'no id');
  assert.equal(sanitizePlaylist('p1'), null);
});

test('sanitizePlaylist rebuilds the shape screens expect', () => {
  const out = sanitizePlaylist({
    id: 'pl-user-1',
    title: '  Road Trip  ',
    trackIds: ['a', '', 'a', null, 'b'],
    isPrivate: 'yes',
    trackCount: 99,
    description: 'x'.repeat(2000),
  });
  assert.equal(out.title, 'Road Trip');
  assert.deepEqual(out.trackIds, ['a', 'b']);
  assert.equal(out.trackCount, 2, 'count is derived from the ids that survived');
  assert.equal(out.isPrivate, false, 'a string is not a boolean');
  assert.equal(out.description.length, LIMITS.description);
  assert.equal(out.artwork, '');
});

test('sanitizePlaylists dedupes ids and caps the library', () => {
  const rows = [{ id: 'a', title: 'A' }, { id: 'a', title: 'A again' }, { id: 'b', title: 'B' }];
  assert.deepEqual(sanitizePlaylists(rows).map((p) => p.id), ['a', 'b']);
  const many = Array.from({ length: LIMITS.playlists + 25 }, (_, i) => ({ id: `p${i}`, title: `P${i}` }));
  assert.equal(sanitizePlaylists(many).length, LIMITS.playlists);
});

test('sanitizeHistory keeps only rows with a track and bounded numbers', () => {
  const out = sanitizeHistory([
    { id: 'h1', trackId: 'trk-1', playedAt: 1, listenedSec: 30 },
    { trackId: '' },
    { trackId: 'trk-2', listenedSec: -5, secondsListened: null },
    'junk',
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].trackId, 'trk-1');
  assert.equal(out[1].listenedSec, 0, 'negative dwell is clamped to zero');
});

test('sanitizeNotifications drops untitled rows and defaults the category', () => {
  const out = sanitizeNotifications([{ id: 'n1', title: 'Hi' }, { body: 'no title' }, null]);
  assert.equal(out.length, 1);
  assert.equal(out[0].category, 'system');
  assert.equal(out[0].read, false);
});

test('sanitizePersisted returns null for unusable storage and repairs the rest', () => {
  assert.equal(sanitizePersisted(null), null);
  assert.equal(sanitizePersisted('[]'), null);
  const out = sanitizePersisted({
    playlists: [{ id: 'p', title: 'P' }],
    likedTrackIds: ['x', 2],
    followedArtistIds: 'artist-1',
    history: [{ trackId: 'trk-1' }],
    notifications: [{ title: 'N' }],
    recentSearches: ['  ', 'kerala', 'kerala', { q: 1 }],
    volume: 'loud',
    settings: { darkMode: true },
    eq: { bands: [1, 2, 3, 4, 5] },
  });
  assert.deepEqual(out.likedTrackIds, ['x', '2']);
  assert.equal('followedArtistIds' in out, false, 'a string is dropped, so the default applies');
  assert.deepEqual(out.recentSearches, ['kerala']);
  assert.equal(out.volume, 0.76);
  assert.deepEqual(out.settings, { darkMode: true });
});

test('sanitizeBackup rejects a file with nothing usable', () => {
  assert.equal(sanitizeBackup(null).ok, false);
  assert.equal(sanitizeBackup({ playlists: [], settings: 'x' }).ok, false);
  assert.match(sanitizeBackup({}).reason, /no library/i);
});

test('sanitizeBackup accepts a real export and normalises it', () => {
  const result = sanitizeBackup({
    version: '1.0',
    playlists: [{ id: 'p1', title: 'Mine', trackIds: ['a'], isUserCreated: true }],
    likedTrackIds: ['a', 'a'],
    followedArtistIds: ['artist-1'],
    settings: { darkMode: true },
    eq: { bands: [1, 1, 1, 1, 1] },
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.playlists[0].title, 'Mine');
  assert.deepEqual(result.value.likedTrackIds, ['a']);
  assert.deepEqual(result.value.eq.bands, [1, 1, 1, 1, 1]);
  assert.deepEqual(result.value.settings, { darkMode: true });
});

test('sanitizeBackup keeps a settings-only backup (a valid, if sparse, file)', () => {
  const result = sanitizeBackup({ settings: { darkMode: true } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.playlists, []);
  assert.equal(result.value.eq, null);
});

test('the module stays pure — no DOM, storage or network access', async () => {
  const raw = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/mobile/studio/persist.js', import.meta.url), 'utf8'));
  // Comments explain the threat model; only executable code has to be pure.
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  for (const forbidden of ['localStorage', 'document.', 'window.', 'fetch(', 'invoke(']) {
    assert.equal(source.includes(forbidden), false, `persist.js must not reference ${forbidden}`);
  }
});
