// studio-features.test.mjs — tests for share drawer, downloads status, clean detail headers, and native media bridge
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('screens.js: album and playlist headers have no clutter description paragraphs', () => {
  const screens = read('src', 'mobile', 'studio', 'screens.js');
  assert.ok(!screens.includes('album-liner-copy'), 'album-liner-copy description paragraph was removed from Album screen');
  assert.ok(!screens.includes('artist-hero-meta mono'), 'artist-hero-meta mono clutter was removed from Artist hero');
  assert.ok(!screens.includes('Monthly Listeners</span>'), 'Monthly Listeners caption was removed from Artist about');
});

test('screens.js: downloads screen shows download status summary and status tags', () => {
  const screens = read('src', 'mobile', 'studio', 'screens.js');
  assert.ok(screens.includes('downloads-status-summary'), 'downloads-status-summary element is present in downloads screen');
  assert.ok(screens.includes('Songs Downloaded'), 'shows count of songs downloaded');
  assert.ok(screens.includes('OFFLINE READY'), 'shows offline ready status');
  assert.ok(screens.includes("trailingMeta: 'Saved offline'"), 'tracks in downloads show "Saved offline" trailing meta');
});

test('screens.js: share drawer modal renders with application targets', () => {
  const screens = read('src', 'mobile', 'studio', 'screens.js');
  assert.ok(screens.includes('share-drawer'), 'share-drawer modal is rendered');
  assert.ok(screens.includes('SHARE WITH APPLICATION'), 'share header specifies application selection');
  assert.ok(screens.includes('WhatsApp'), 'includes WhatsApp option');
  assert.ok(screens.includes('Telegram'), 'includes Telegram option');
  assert.ok(screens.includes('X (Twitter)'), 'includes Twitter / X option');
  assert.ok(screens.includes('More Apps (System Share)'), 'includes System application chooser option');
  assert.ok(screens.includes('Copy Link'), 'includes Copy Link option');
});

test('native.js: defines remote control contract and pushes for Android widget and lockscreen', () => {
  const code = read('src', 'mobile', 'studio', 'native.js');
  assert.ok(code.includes('window.__tmRemote'), 'defines window.__tmRemote');
  assert.ok(code.includes('play()'), 'handles remote play');
  assert.ok(code.includes('pause()'), 'handles remote pause');
  assert.ok(code.includes('toggle()'), 'handles remote toggle');
  assert.ok(code.includes('next()'), 'handles remote next');
  assert.ok(code.includes('prev()'), 'handles remote prev');
  assert.ok(code.includes('seekTo('), 'handles remote seekTo');
  assert.ok(code.includes('pushMeta('), 'exports pushMeta');
  assert.ok(code.includes('pushState('), 'exports pushState');
});

test('MediaHub.kt: includes duration in MediaMetadata for lockscreen seekbar and checks widget progress', () => {
  const kt = read('src-tauri', 'android-overlay', 'kotlin', 'MediaHub.kt');
  assert.ok(kt.includes('MediaMetadata.METADATA_KEY_DURATION'), 'MediaMetadata includes duration for seekbar');
  assert.ok(kt.includes('R.drawable.tm_notif_icon'), 'Notification uses tm_notif_icon');
  assert.ok(kt.includes('R.layout.tm_widget'), 'Widget uses tm_widget layout');
});

test('screens.js: renders new home sections (Most Played, Favorite Playlists, Top 10, Top 100, Daily Mix)', () => {
  const screens = read('src', 'mobile', 'studio', 'screens.js');
  assert.ok(screens.includes('Most Played'), 'renders Most Played section');
  assert.ok(screens.includes('Favorite Playlists'), 'renders Favorite Playlists section');
  assert.ok(screens.includes('Top 10 Chart'), 'renders Top 10 Chart countdown section');
  assert.ok(screens.includes('Top 100 Anthems'), 'renders Top 100 Anthems section');
  assert.ok(screens.includes('Daily Mix &amp; Fresh Drops'), 'renders Daily Mix & Fresh Drops section');
});

test('screens.js: all lyrics controls are removed from lyrics displays', () => {
  const screens = read('src', 'mobile', 'studio', 'screens.js');
  assert.ok(!screens.includes('np-lyrics-head-controls'), 'no offset or icon control bar in np lyrics stage');
  assert.ok(!screens.includes('data-action="lyric-offset"'), 'all lyric-offset buttons (-100ms, +100ms) are removed');
  assert.ok(screens.includes('SYNCED LYRICS'), 'clean synced lyrics header is present');
});

test('styles.css: #FFFFFF background and contrast styling for Home and Now Playing screens', () => {
  const css = read('src', 'mobile', 'studio', 'styles.css');
  assert.ok(css.includes('body[data-screen="home"]') && css.includes('#FFFFFF'), 'Home screen has #FFFFFF background');
  assert.ok(css.includes('body[data-screen="nowplaying"]') && css.includes('#FFFFFF'), 'Now Playing screen has #FFFFFF background');
  assert.ok(css.includes('.home-top100-card'), 'styles for home top 100 section exist');
  assert.ok(css.includes('.np-lyrics-badge'), 'styles for clean lyrics badge exist');
});
