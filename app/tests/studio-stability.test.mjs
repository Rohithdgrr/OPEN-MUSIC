// Static gates for the Studio shell's stability work. Source-level because the
// shell needs a DOM + Web Audio + Tauri IPC to execute; these assert that the
// guards are still wired rather than that they are reachable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../src/mobile/studio/${rel}`, import.meta.url), 'utf8');
const storeSrc = read('store.js');
const appSrc = read('app.js');
const screensSrc = read('screens.js');

test('every untrusted state boundary routes through the sanitizer', () => {
  const loadPersisted = storeSrc.slice(storeSrc.indexOf('function loadPersisted()'), storeSrc.indexOf('class OpenMusicStore'));
  assert.match(loadPersisted, /sanitizePersisted\(/, 'stored state is sanitised on read');

  const importBackup = storeSrc.slice(storeSrc.indexOf('importBackupJson(text)'), storeSrc.indexOf('shareLink(label)'));
  assert.match(importBackup, /sanitizeBackup\(/, 'an imported backup is validated');
  assert.match(importBackup, /return false/, 'a rejected backup reports failure to the caller');

  const updateSettings = storeSrc.slice(storeSrc.indexOf('updateSettings(patch)'), storeSrc.indexOf('toggleLanguage(lang)'));
  assert.match(updateSettings, /sanitizeSettings\(/, 'settings patches cannot write a wrong-typed value');

  const createPlaylist = storeSrc.slice(storeSrc.indexOf('createPlaylist(title'), storeSrc.indexOf('deletePlaylist('));
  assert.match(createPlaylist, /asText\(title, LIMITS\.title\)/, 'playlist titles are length-bounded');
});

test('the store never assigns a raw persisted field directly', () => {
  // The old bug shape: `this.likedTrackIds = Array.isArray(saved?.linked) ? saved.x : default`.
  // A wrong-typed element inside that array still reached the renderer.
  for (const field of ['likedTrackIds', 'followedArtistIds', 'recentSearches']) {
    const direct = new RegExp(`this\\.${field}\\s*=\\s*saved\\?\\.\\.${field}`);
    assert.equal(direct.test(storeSrc), false, `${field} must come from the sanitizer, not raw storage`);
  }
});

test('a failing render is contained instead of freezing the shell', () => {
  assert.match(appSrc, /function renderAllUnsafe\(/, 'the raw render is separated from its guard');
  assert.match(appSrc, /function paintRenderFailure\(/, 'a recoverable screen exists');
  assert.match(appSrc, /catch \(error\) \{\r?\n\s*console\.error\('\[studio\] render failed'/, 'the failure is logged, not swallowed');
  assert.match(appSrc, /data-action="reload-app"/, 'the error card offers a way out');
  assert.match(appSrc, /case 'reload-app'/, 'and the action is handled');
  assert.match(appSrc, /\[studio\] playback dom update failed/, 'the tick path is guarded too');
});

test('the shared media card replaced the copy-pasted grid cards', () => {
  assert.equal((screensSrc.match(/function mediaCard\(/g) || []).length, 1, 'one definition');
  const callSites = (screensSrc.match(/\$\{mediaCard\(\{/g) || []).length;
  assert.ok(callSites >= 8, `expected at least 8 call sites, found ${callSites}`);
  // The only kinds left are the two home cards (an <article> with a play fab),
  // the mixed search results card, and the shimmer skeleton.
  const rawButtons = (screensSrc.match(/<button class="media-card/g) || []).length;
  assert.ok(rawButtons <= 2, `raw media-card buttons regressed: ${rawButtons}`);
});

test('the shared card escapes everything it prints', () => {
  const start = screensSrc.indexOf('function mediaCard(');
  const body = screensSrc.slice(start, screensSrc.indexOf('function renderTopBar(', start));
  assert.match(body, /escapeHtml\(route\)/);
  assert.match(body, /escapeHtml\(id\)/);
  assert.match(body, /escapeHtml\(title\)/);
  // renderArtwork normalises its own src (a non-URL renders the sleeve).
  assert.match(body, /renderArtwork\(\{ src: artwork/);
});
