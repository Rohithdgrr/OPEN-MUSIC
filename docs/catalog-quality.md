# Catalog quality: dedupe, language-grouped albums, junk filter, offline runbook

Spec of record for the 2026-10-07 catalog-quality change. Approved plan: one
merged card per movie album with a language badge; language chips inside the
detail; conservative junk filter; offline crash explained.

## 1. Why albums look duplicated

JioSaavn stores each language of a movie as a **separate album with a
separate id** (verified live 2026-10-07: `search.getAlbumResults q=Baahubali`
returns `hindi`, `telugu`, `(Tamil)`, `malayalam` variants of
"Baahubali - The Beginning"). `uniqById` / `dedup_feed` collapse same ids
only, so the same movie renders 3-7 cards. Track-level dedup
(`dedup_tracks` backend, `dedupeTracks` frontend) already works — tracks are
not the problem.

Upstream album rows carry a `language` field, and it already reaches the UI:
`official::FeedItem.language` (`official.rs`, `#[serde(default)]`) is set by
both `entity_item` and `feed_item`. No backend shape change was needed.

## 2. Grouping spec (`app/src/albumgroup.js`, DOM-free, unit-tested)

- `baseAlbumTitle(title)`: lowercase, strip a trailing ` (X)` / ` - X` /
  ` [X]` single-word suffix, collapse whitespace. Pure string op.
- `groupLangAlbums(list)`: group album cards by base title **only when the
  group holds >= 2 distinct non-empty `language` values**. Otherwise cards
  pass through untouched (same-language editions, language-less rows,
  non-album kinds never merge).
- Merged card = first-seen card + `langCount` + `languages[]` (badge shows
  e.g. `3 languages`); variant tokens recorded in the module registry via
  `registerAlbumVariants()` and read back with `variantsFor(token)`.
- Applied at every album-grid origin: desktop search cards, home shelves,
  home-jump, library saved albums, artist discography (no-op there until
  upstream adds language), mobile home shelf, mobile search shelf, mobile
  discography, mobile library.
- Opening a grouped album fetches each variant token's `album_tracks` in
  parallel (cap 7, `Promise.allSettled`), merges, runs the existing
  `dedupeTracks`. The existing `renderLangChips` then sees 2+ language
  buckets and renders — selecting a language filters via the existing
  `ddLang`/`setDdLang` path (desktop) or the new compact chip row (mobile
  detail). Non-grouped albums keep the single-fetch path.

## 3. Junk filter (conservative)

Drop a track row only when **both** hold:

- title contains a whole word `sample`, `trailer`, `testing` or `demo`
  (case-insensitive), **and**
- artist is empty or a placeholder (`""`, `null`, `none`, `undefined`,
  `n/a`, `na`, `-` — the existing `is_placeholder` / `isPlaceholder` rule).

This removes the observed `This is a sample trailer - testing / NULL` row
with zero risk to real songs (a legit `Trailer Music` with a real artist is
kept). Enforced in backend `dedup_tracks` (`jiosaavn.rs` — covers albums,
playlists, search, home, artist pages, both adapters' callers) and frontend
`dedupeTracks` (`search.js` — covers locally stored/restored lists).

## 4. Offline runbook (root-caused, not a code bug)

The `127.0.0.1 refused to connect` full-window error (screenshot 28-09) is a
**debug build with a baked devUrl**: `target/debug/trance-music.exe`
contains the literal string `http://127.0.0.1:1430` (verified by binary
string scan). Launched without `tauri dev`'s asset server, its main frame
has nothing to load. The installed release
(`%LocalAppData%\TRANCE MUSIC\trance-music.exe`) contains `tauri.localhost`
and no devUrl string — assets are embedded and the window boots offline.

Rules:

1. Daily use = the installed release (desktop shortcut already points
   there). Never double-click `target\debug\trance-music.exe`.
2. `npm run tauri dev` is for development only; its window dies with the
   `:1430` asset server.
3. Offline playback = vault downloads (`netMode() === "offline"` gate
   already routes there); catalog/search need network by nature.

## 5. Verification

- `cargo test` gains `junk_rows_dropped_only_when_title_and_artist_agree`
  (plus keeps: legit junk-titled song with a real artist survives).
- `app/tests/albumgroup.test.mjs` gains grouping unit tests (same
  title + same language = untouched; differing languages = one card +
  registry; non-albums / language-less rows = untouched).
- Gates: `npm test`, `npm run lint`, `OP_OFFLINE=1 cargo test`,
  `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`.
