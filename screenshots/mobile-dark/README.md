# Mobile screenshots — DARK theme

Captured **2026-11-13** from the debug APK installed on the `Pixel6_API36`
emulator (`com.openmusic.trancemusic`, v0.5.1), driven over CDP against the
real WebView. Device 1080×2400, PNG.

**Theme was switched through the app's own control** — the onboarding's
"Dark" button (step 3), which writes the same `localStorage.tm-theme` the
Settings select does. Every capture below was verified dark at capture time
(`document.documentElement.classList.contains("dark") === true`,
body `background-color: rgb(9, 9, 11)`).

## What this build fixes (see `docs/mobile/06-features.md`)

- **Translucent theme colours render in the dark palette.** Tailwind bakes the
  *light* value into every `/NN` utility (`bg-surface-container-lowest/95` →
  `hsla(0,0%,100%,.95)`), and the plain dark rules never matched the `/NN`
  suffix — so the options sheet was a white panel and the section headers
  carried a light grey band. All 39 variants the shell uses now have a dark
  rule.
- **Artist tiles show the artist.** The mined profile only knows the track's
  album cover, so artist tiles wore somebody else's picture; they now carry
  the artist's own photo from the catalogue.
- **Action discs are glass**, not solid white holes.
- **No band behind the home shelf titles.**
- **Grid layout**: the Artists/Albums/Playlists/Charts/Liked/Downloads screens
  are two columns of square artwork (Settings → Appearance & Theme → Layout
  switches to the vertical list).

## The 20 screens

| File | Screen | Notes |
|---|---|---|
| `home.png` | Home | greeting, Featured Spotlight, Top Charts, Featured Playlists, mini player |
| `search.png` | Search | empty state, filter chips (All/Tracks/Albums/Artists/Playlists) |
| `library.png` | Library | Your Library, tabs, rows |
| `settings.png` | Settings | v0.5.1, preferences, theme picker (Dark selected) |
| `analytics.png` | Analytics | Listening Insights, Week/Month/Year |
| `artists.png` | Artists | artist grid with monthly-listener counts |
| `albums.png` | Albums | Top / Most time / Most played tabs |
| `playlists.png` | Playlists | **Featured** tab (the default "Yours" tab is empty on a fresh install) |
| `charts.png` | Charts | editorial rank, untouched |
| `liked-songs.png` | Liked songs | favorites + vault |
| `download.png` | Downloads | offline vault, storage |
| `history.png` | History | listening history, acoustic timeline |
| `notification.png` | Notifications | event feed |
| `nowplaying.png` | Now Playing | full player, playing |
| `album-detail.png` | Album | "Awarapan 2" — 8 tracks, Play/Shuffle, filter, custom order |
| `artist-detail.png` | Artist | "Krish Mondal" — verified badge, top tracks |
| `playlist-detail.png` | Playlist | "Hindi: India Superhits Top 50" — synced, track list |
| `queue-sheet.png` | Queue sheet | up-next list + "Search tracks to append" |
| `jam-sheet.png` | Jam sheet | create/join a room, session metrics |
| `chat-sheet.png` | Chat panel | room chat, reaction chips, message input |

`_manifest.json` / `_details.json` / `_fixups.json` hold the machine-readable
record: file size, route hash, dark flag and the first 70 characters of the
screen's text at capture time.

## How the capture worked

CDP over `adb forward tcp:9223 localabstract:webview_devtools_remote_<pid>`,
Node 24's global `WebSocket` (no `ws` dependency). Per screen:
set `location.hash` → wait for the DOM to settle → `adb shell screencap` →
`adb pull`.

Two things that will bite anyone repeating this:

- **`data-nav` values start with the token, not the id**:
  `album?token=…&id=…`, `playlist?token=…&id=…`. Matching on `album?id=`
  finds nothing and silently times out.
- **A leftover bottom sheet swallows navigation.** The chat/jam sheets persist
  across a route change; remove `#tm-options-sheet` (and friends) before
  navigating, and force a re-render by passing through a different hash
  (setting the *same* hash fires no `hashchange`, so the router never
  re-renders).

Detail screens are reached by clicking a real tile — the app resolves
name → id through `resolveEntity()`, so there is no id to type. Album tiles
carry both the album name and the artist line inside the
`[data-entity-name]` wrapper, which is why the album grid's tiles do not
navigate; the home screen's rows do (`data-nav="album?token=…"`).
