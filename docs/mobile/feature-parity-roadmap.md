# Android feature parity audit

Scope: Android mobile only. This audit distinguishes absent features from
features that already exist or are only partial; the desktop Discord item is
out of scope unless Android support is explicitly intended.

## Verified baseline

| Capability | Status | Evidence / boundary |
|---|---|---|
| Automatic loudness matching | Implemented, not ReplayGain-tag based | `mobile/player.js` measures/caches loudness on eligible connections and applies a gain through `loudness.js`; see `docs/audio-quality.md`. |
| User-adjustable equalizer | Implemented | Now Playing exposes five persisted bands (−12 to +12 dB); the automatic chain remains active and the legacy Settings/per-track controls remain absent. |
| Playback speed / tempo | Partial | Settings and Now Playing expose 0.75x–1.5x through `HTMLMediaElement.playbackRate`; independent pitch control is absent. |
| Skip silence | Implemented; switch verified on device | `mobile/silence-skip.js` has a tested sustained-RMS gate; the switch defaults off and persists on-device. The actual audio-level silence seek still needs a controlled device test. |
| Sleep timer | Implemented | The mobile utility bar cycles Off / 15 / 30 / 60 / 90 minutes through `sleep.js`. |
| Music recognition | Gap / provider decision | No Android recognition integration is present; a recognition provider and microphone/privacy contract are required. |
| AI lyrics translation | Gap | Gemini is used for missing-lyrics generation, not translation. |
| Word-synced lyrics | Partial | Better Lyrics word timestamps are used when returned; ordinary line-synced lyrics use an even per-word animation estimate. |
| Music-video search/streaming | Gap / catalog decision | The current track catalog and stream resolver expose audio tracks, not a video endpoint. |
| Listen Together | Implemented with a different topology | Jam rooms, chat, queue sync and drift correction use the Rust LAN room server; this is not a metroserver deployment. |
| Last.fm scrobbling | Gap / credentials | No Last.fm client or account flow is present. |
| Discord Rich Presence | Not Android scope | No mobile implementation; Discord presence is a desktop integration. |
| First-party account/cloud sync | Gap / backend required | Settings supports local backup/restore and shared-playlist exchange, not a hosted account or sync service. |
| Playlist import/export | M3U/PLS implemented and device-verified | `playlist-file.js` parses M3U/M3U8/PLS metadata and catalog-matches up to 100 entries; source paths are never opened. CSV import/export remains. |
| Material 3 color palettes | Partial | System / light / dark are available; user-selectable palettes and wallpaper-derived colors are absent. |
| Android home-screen widget | Implemented | Native `TmWidget` provides artwork, metadata and previous/play-next controls. |
| Gapless and crossfade | Implemented | Mobile exposes gapless and configurable crossfade; this does not claim sample-accurate switching. |
| SmartQueue / radio refill | Implemented | Mobile radio refills the queue and applies its existing eligibility gate. |
| MediaSession / lock-screen controls | Implemented | Native MediaSession and notification actions are provided by `android-overlay`. |
| Android Auto | Gap / platform work | Requires an Android media-browser/service integration and validation in Android Auto. |
| Chromecast / Google Cast | Gap / provider SDK | Requires Cast SDK integration and a receiver/streaming contract. |
| True ReplayGain | Partial | Current loudness measurement is an approximation from decoded stream audio; embedded ReplayGain metadata is not available from the source catalog. |
| Per-track playback position | Implemented | Mobile saves and restores the queue and position without autoplay. |
| Multiple independent queues | Gap | Mobile currently persists one queue. |
| Voice control | Gap / platform decision | No speech-recognition engine is bundled or wired. |

## First implementation slice: mobile equalizer

Implemented in `app/src/mobile/eqstate.js`, `player.js`, and `audioplus.js`,
with the action in `screens/nowplaying.html` and dialog styling in
`shell.css`. It uses the existing DSP chain. Automatic normalization and
spatial processing remain enabled; there is no Settings toggle. The dialog
has an accessible reset-to-flat action, persists values locally, and applies
them to active and standby transport chains so crossfade does not change the
sound.

Acceptance:

- The five bands can be adjusted from -12 dB to +12 dB in 1 dB steps.
- Values persist across route changes and app restarts.
- Changes apply to the currently playing track and the crossfade standby.
- Reset returns all bands to 0 dB; audio-quality normalization remains active.
- The new control is reachable by touch and keyboard and does not change the
  desktop graph.
- Focused EQ and boot-graph tests pass; device interaction is not yet
  verified.

## Android bundle packaging defect (2026-11-14)

The Android build's nested `tauri android-studio-script` invocation runs
through the npm `tauri` script during Gradle packaging. The old script cleaned
`mobile/dist` before every command, removing `app.js` after the initial bundle
step; the APK then served the HTML fallback with a `text/html` response for
the module and never started the mobile app code. The nested invocation does
not receive `TAURI_ENV_PLATFORM`, so the wrapper must recognize the
`android android-studio-script` argument sequence and skip cleanup there while
preserving the existing cleanup behavior for other Tauri commands.

Acceptance: build and install the x86_64 debug APK, confirm the module loads
as JavaScript, and verify a routed screen mounts its interactive handlers.

Verification (2026-11-14): `npm.cmd --prefix app run tauri:android -- build
--debug --target x86_64 --apk --ci` completed successfully. On `Pixel6_API36`,
the WebView returned HTTP 200 with `text/javascript` for
`mobile/dist/app.js`, mounted Home and Search, and returned six results for
“believer.” Now Playing's EQ dialog opened with five bands; changing a band
persisted to `tm-eq-bands` and Reset returned all bands to flat. The prior
stored EQ value was restored after the probe. Full JavaScript tests passed
580/580 and lint was clean.

## Accepted scope and remaining phases (2026-11-14)

The user confirmed these substitutions and boundaries:

| Request | Accepted scope |
|---|---|
| First-party account and cloud sync | Replaced by device-local SQLite. No account or cross-device sync is claimed. |
| Last.fm scrobbling | Replaced by local listening analytics. No Last.fm writes are claimed. |
| Music video playback | Deferred. Do not scrape YouTube/Innertube or extract media streams; revisit only with an authorized provider/player contract. |
| Ambient-song recognition | Deferred until a documented recognition provider is selected. JioSaavn text search or Google Search alone cannot identify audio fingerprints. |
| Lyrics timing | Keep documented line-synced sources; defer word timestamps until a permitted provider contract exists. |
| Lyrics translation | Requires an authorized translation source for catalog lyrics; do not generate or distribute translations of copyrighted song lyrics without authorization. |
| Google Cast | Deferred. |
| Discord Rich Presence | Deferred; no desktop changes in the accepted scope. |
| Android Auto | Implement with AndroidX Media3 and verify in the user's available Android Auto test environment. |
| Voice control | Implement on-demand Android `SpeechRecognizer`; no always-on wake word. Request microphone permission only when invoked and disclose that recognition may use the system service. |

### In-scope implementation acceptance

- **Independent pitch and tempo:** separate controls, bounded values, persisted
  state, and playback tests proving pitch changes do not alter tempo and vice
  versa. This must not replace the existing audio-quality chain.
- **Skip silence:** opt-in playback control with a bounded silence threshold
  and hold duration; no skipping during pause, seek, or buffering; tests for
  state transitions and user-visible status.
- **M3U/PLS import:** parse local files safely, resolve entries against the
  supported catalog, report unresolved rows, and never play arbitrary URLs or
  local paths from imported files.
- **Named queues:** multiple persisted queues with explicit switching,
  isolated queue contents/playheads, and migration from the existing single
  queue without loss.
- **Material palettes:** 19 selectable presets including AMOLED black,
  persisted selection, readable text/focus states in light and dark modes.
  Wallpaper-derived colors are separate and must not be claimed unless the
  Android wallpaper-color path is implemented and tested.
- **AI lyrics translation:** only proceed with an authorized translation
  source/permission; otherwise keep this item explicitly blocked.
- **Android Auto:** expose browsable media and transport through Media3,
  maintain playback state/metadata, and verify on the provided Android Auto
  test environment.
- **Voice control:** invoke system speech recognition only from a user action,
  parse a bounded set of playback/search intents, handle denial/cancellation,
  and verify no microphone recording continues after the request ends.

Existing status remains as recorded in the verified baseline above. Do not
mark any item complete until its acceptance checks, full test suite, and
on-device verification have been recorded here.

### Verification update (2026-11-14)

- **M3U import:** on Pixel6_API36, imported a real `.m3u` fixture through the
  Settings file picker; the catalog matched and saved one track. The fixture's
  remote media URL was metadata only, consistent with the parser's safety
  tests.
- **Skip silence:** the Settings control appeared off when its preference was
  absent; real taps persisted `1` then `0` and updated its switch state. The
  threshold/state-machine tests pass, but a controlled silent audio stream was
  not used to verify an actual seek on-device.
- **Build and gates:** x86_64 debug APK built (22,169,561 bytes), installed,
  and launched on the emulator. `npm test` passed 587/587; ESLint, focused
  tests, JS syntax, and `git diff --check` passed.
