# OPEN-MUSIC — Screen Wireframes

Extracted from the 12 Stitch zips (unzipped in `_zips/`). Sources:

| Screen | Zip |
|---|---|
| Playlists + Playlist Detail | `stitch_sona_minimal_music_downloader (4)` |
| Album / Artist page | `stitch_sona_minimal_music_downloader (5)` |
| Library | `stitch_sona_minimal_music_downloader (6)` |
| Listening History | `stitch_sona_minimal_music_downloader (8)` |
| (existing) Home / Search / Now Playing / Downloads / Settings | zips (7) / base / (1) / (2) / (3) — already in `index.html` |

Shared chrome on every screen (from the zips): fixed top nav (Home · Library · Search · Downloads · Now Playing · Settings) → content → persistent mini-player footer (prev / play / next / repeat / queue) → telemetry status strip.

---

## 1. Playlists — `data-view="playlists"` (zip 4)

```
┌──────────────────────────────────────────────────────────────────────┐
│ [← Back to Library ESC]                                             │
│ PLAYLISTS                              [⟳] [⬆ Import] [+ New]      │
├──────────────────────────────────────────────────────────────────────┤
│ ( All 24 │ Created by You 8 │ Artist Radios 6 │ Queue/Smart 5 │     │
│   Saved Albums 5 )                    [grid_view] [view_agenda]     │
├──────────────────────────────────────────────────────────────────────┤
│ ┌── FEATURED PLAYLIST (banner) ────────────────────────────────────┐ │
│ │ Nocturne Trance Sessions                                         │ │
│ │ [▶ Play] [⇄ Shuffle] [⭳ Download] [♡] [⋯]                      │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│ YOUR PLAYLISTS & MIXES        "View all 24 playlists →"             │
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐                                  │
│ │img │ │img │ │img │ │img │ │img │   ← 5-up grid, hover ▶ overlay   │
│ │name│ │name│ │name│ │name│ │name│                                  │
│ └────┘ └────┘ └────┘ └────┘ └────┘                                  │
│  Liked Songs · Current Queue & Session Stash · Artist Spotlight ·   │
│  Deep Progressive Trance (138 BPM) · Above & Beyond Radio · …       │
├──────────────────────────────────────────────────────────────────────┤
│ PLAYLIST TRACKS                            [⭳ Download Playlist]    │
│ [▶] #  Title / Artist              duration  [♡] [⋯]                │
│ [▶] 1  …                                                           │
│ …                              [Load all 28 tracks]                 │
└──────────────────────────────────────────────────────────────────────┘
```

- Filter chips = client-side filter over the playlist list.
- Click card → detail section below (or its own view): featured banner + track rows.
- Track row = existing `playQueueItem(track)` pipeline (already in `app/src/playback.js`).

## 2. Album / Artist page — `data-view="album"` (zip 5)

```
┌──────────────────────────────────────────────────────────────────────┐
│ [← Library / Artists ESC]                                           │
│ ┌────────┐  Solaris & Kaelen                                        │
│ │ cover  │  [▶ Play Artist] [⇄ Shuffle Radio] [✓ In Library]       │
│ │ 1:1    │  [↗ share] [⋯]                                           │
│ └────────┘  842k listeners · 15 releases                            │
├──────────────────────────────────────────────────────────────────────┤
│ POPULAR TRACKS                                                       │
│ [▶] 1  Title / Album            320kbps  plays  dur  [♡] [⋯]       │
│ …                                                                    │
├──────────────────────────────────────────────────────────────────────┤
│ DISCOGRAPHY                [All Releases│Albums 3│EPs 8│Live 4]     │
│ ┌────┐ ┌────┐ ┌────┐ ┌────┐                                         │
│ │year│ │year│ │year│ │year│  ← album cards, click → tracks          │
│ │tItl│ │tItl│ │tItl│ │tItl│                                         │
│ └────┘ └────┘ └────┘ └────┘                                         │
├──────────────────────────────────────────────────────────────────────┤
│ RELATED SOUND ARTISTS                      "View All Affinity →"    │
│ [chip] [chip] [chip] [chip]                                         │
└──────────────────────────────────────────────────────────────────────┘
```

- `Popular Tracks` and `Discography` are both track/album lists → same row renderer as search results.
- Album card click → `playlist_tracks`-style fetch of that album (`webapi.get&type=album`, verified live).

## 3. Library — `data-view="library"` (zip 6)

```
┌──────────────────────────────────────────────────────────────────────┐
│ AUDIO LIBRARY      [📂 Add Local] [⬇ Import M3U] [⟳ Sync Vault]    │
├──────────────────────────────────────────────────────────────────────┤
│ ( All Library │ Liked 142 │ Heavy Rotation │ History │              │
│   Downloaded Offline │ Artists & Releases )        [list] [grid]    │
├──────────────────────────────────────────────────────────────────────┤
│ HEAVY ROTATION                                                       │
│ [▶art] [▶art] [▶art] [▶art]   ← 4 now-playing tiles                │
├──────────────────────────────────────────────────────────────────────┤
│ LIKED TRACKS            [▶ Play All] [⇄ Shuffle] [View All 142]     │
│ [▶] Title / Artist                          [♡] [⋯]  ×5 rows        │
├──────────────────────────────────────────────────────────────────────┤
│ LISTENING HISTORY                          [⏹ Clear History]        │
│ [▶] recent 3 tracks                                               │
├──────────────────────────────────────────────────────────────────────┤
│ STORAGE & INTEGRITY                                                  │
│ [███████████░░] local cache · downloaded · M3U imports              │
└──────────────────────────────────────────────────────────────────────┘
```

- Liked Tracks = existing `tm-library` localStorage (hero-save already writes it) — promote to a real list here.
- History = a `tm-history` array appended in `playQueueItem` (the one place playback starts).

## 4. Listening History — `data-view="history"` (zip 8)

```
┌──────────────────────────────────────────────────────────────────────┐
│ [← Library]   Listening History                                     │
│               [📅 Last 30 Days ▾] [⬇ Export Audit] [🗑 sweep]      │
├──────────────────────────────────────────────────────────────────────┤
│ ( All Sessions 318 │ Fully Played │ Hi-Res ≥96kHz │ DSD │ Partial )  │
├──────────────────────────────────────────────────────────────────────┤
│ [▶] Title / Artist — Album        date   quality  [♡] [⋯]          │
│ …  grouped by day, "Expand Week (19) ▾" divider                     │
│ [▶] …                                                               │
│                                        [‹ Previous 50│ Next 50 ›]   │
└──────────────────────────────────────────────────────────────────────┘
```

---

## What the app already has vs. what's missing

| Piece | Status |
|---|---|
| Home / Search / Now Playing + mini-player | in `index.html`, wired |
| Playlist **detail** playback (`playlist_tracks`) | backend done — zip-4 screen just needs the view |
| Album tracks (`webapi.get&type=album`) | verified live, **command not written yet** |
| Liked / library storage | `tm-library` localStorage, no screen |
| History | **not tracked yet** — add in `playQueueItem` |
| Nav entries Library / Downloads / Settings | Downloads + Settings exist as zips; Library is the new view |

**Order:** nav links → library view (liked) → history tracking → playlists view → album view.
