# Android media surfaces: notification + lockscreen + homescreen widget

Status: spec first (2026-10-15). Mobile-only. Desktop untouched.

## What the user asked

"Homescreen (notification panel widget), lockscreen widget — make it work."
The parenthetical defines it: the **media notification** (notification panel
and lockscreen render the same notification) plus the **homescreen AppWidget**.
Both were designed but never built: `mobile/native.js` (imported by
`mobile/app.js`) pushes track/state through `window.TMNative` and exposes
`window.__tmRemote` for remote control, but `MediaHub.kt` never existed —
the bridge was a silent no-op and no notification/widget ever appeared.
(WebView `navigator.mediaSession` in `mobile/player.js` is a second,
independent path; it stays as-is.)

## Architecture

```
JS (native.js) --JSON--> window.TMNative (Kotlin @JavascriptInterface)
  pushMeta   {title, artist, album, art}   (art = absolute http(s) URL)
  pushState  {playing, pos ms, dur ms, rate}
  dismissNotification()
  consumeAction() -> "TOGGLE|" | "NEXT|" | "PREV|" | "SEEK_TO|<ms>" | "STOP|" | ""
  consumeRoute()  -> "nowplaying" | ""            (widget body tap)

Remote taps (notification buttons, widget, headset) --PendingIntent-->
  MediaService action -> JS alive ? eval window.__tmRemote.*
                                : stash -> consumeAction()/consumeRoute()
```

### `saveLocal` — the sixth bridge method (2026-10-24)

`saveLocal(json) -> String` is **not** a media-surface method — it serves the
"Save to local" menu item (`mobile/savelocal.js` → menus.js): copies one
vaulted song file (absolute path in the JSON) into
`MediaStore.Audio` under `Music/OpenMusic/` with TITLE/ARTIST/ALBUM set and
a size dedupe. Returns the line protocol `ok <name>` / `same <name>` /
`err: …` (parsed by `savelocal.js bridgeResult()`). Media-surface
methods stay in `native.js`; this one's JS caller lives in
`savelocal.js` — both consume the bridge, so the "names are a contract"
note spans two consumers. API ≥ 29 only (scoped storage, no permission).

## Native layer (all framework APIs, zero new Gradle deps)

`app/src-tauri/android-overlay/` is the tracked source of truth; `gen/` is
gitignored and `tauri android init` wipes it, so `build.sh
inject_android_mediahub` copies the overlay in and patches the manifest +
`MainActivity.kt` idempotently (same pattern as
`inject_android_permissions`).

| File | Job |
|---|---|
| `kotlin/MediaHub.kt` | `object`: MediaSession, notification channel + MediaStyle post (public visibility → lockscreen), art fetch on bg thread, FGS start/stop, pending action/route stash |
| `kotlin/TmBridge.kt` | `@JavascriptInterface` with exactly the five methods above — names are a contract with `native.js`, do not rename |
| `kotlin/MediaService.kt` | foreground service (`mediaPlayback` type, API 29+/34 guarded): owns the ongoing notification, dispatches action intents |
| `kotlin/TmWidget.kt` | AppWidgetProvider: art/title/artist + prev/toggle/next, body tap opens `#/nowplaying`; cold-start actions stash for `consumeAction` |
| `kotlin/MainActivity.kt` | overlay replacement: `onWebViewCreate` attaches `TMNative`, `onCreate`/`onNewIntent` forward launch actions + route, requests POST_NOTIFICATIONS (API 33+) |
| `res/xml/tm_widget_info.xml`, `res/layout/tm_widget.xml` | widget size/update config + RemoteViews layout (no collection views — static art/text/buttons) |
| manifest patch | `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `POST_NOTIFICATIONS` (all install-time except POST_NOTIFICATIONS, asked at runtime); service + widget receiver entries |

Constraints: minSdk 24 (framework MediaSession/MediaStyle/AppWidget all
API-21+); targetSdk 37; Kotlin 2.2.10; PendingIntents immutable (API 31+);
no `androidx.media` / media3 — framework only, so offline gradle stays green.

## Verification runbook (emulator-5554, debug APK)

1. `inject_android_mediahub`, `tauri android build --debug`, `adb install -r`.
2. CDP: play a track → `dumpsys notification` shows the media notification
   with title/artist + prev/toggle/next actions.
3. Simulate taps without touching glass: `am start-foreground-service` with
   the toggle/prev/next actions → CDP audio element pauses/advances.
4. `dumpsys media_session` shows metadata + playback state; `dumpsys
   appwidget` lists the provider; an `APPWIDGET_UPDATE` broadcast runs
   `onUpdate` crash-free (logcat).
5. Lockscreen shares the notification (public visibility + media template) —
   visual confirm on the emulator; no separate lockscreen code exists.

### Run record 2026-10-15 (BUILD with notifAction fix, 31.1 MiB debug APK)

- Bridge: `window.TMNative === "object"` on first CDP contact; `pm grant
  POST_NOTIFICATIONS` pre-launch so no dialog blocks the run.
- Play (Quick Picks row tap) → audio `paused:false`, relay stream.
- `dumpsys notification`: id 4201, channel `tm_media`, ONGOING +
  FOREGROUND_SERVICE, `vis=PUBLIC`, MediaStyle + session token, actions
  Previous/Pause/Next via startForegroundService. `dumpsys media_session`:
  `OpenMusic` is the media-button session, PLAYING, real metadata
  (Hellallallo / A.R. Rahman / Peddi).
- Remote in: `KEYCODE_MEDIA_PAUSE` → session callback → `deliver` →
  `__tmRemote.pause()` → audio `paused:true`; `cmd media_session dispatch
  play` → playing again. (Direct `am start-foreground-service` is correctly
  refused: service is `exported=false`; the PendingIntents carry the same
  actions and are present in dumpsys.)
- Widget: `dumpsys appwidget` lists `TmWidget` provider;
  `APPWIDGET_UPDATE` broadcast → `onUpdate` ran, no logcat exceptions
  (no widget pinned on the emulator, so RemoteViews inflation is
  code-reviewed only).
- Browsers on the aged profile: artists 110 tiles with evidence, albums 106
  with listening-time evidence, charts 9 ranked rows, playlists Featured 34
  rows (Yours/Downloaded honestly empty — no library playlists).
- Fix shipped from a failing first build: framework `Notification.Builder`
  has no `(PendingIntent, CharSequence)` addAction — `Notification.Action`
  (API 23+, minSdk 24) via a `notifAction` helper.

## Seek bar ticks while playing (2026-10-24)

Report: the seek bar in the notification center, on the widget and on the
Android 16 status chip did not move.

Root cause chain: the JS side pushes state only every 2-5 s (throttled
onPaint + a 5 s heartbeat) and the WebView throttles page timers hard once
backgrounded, so posMs anchors went stale; the AppWidget renders RemoteViews
only when re-set (no extrapolation) and had **no progress bar at all**; the
notification/chip surfaces extrapolate from the session's PlaybackState, which
froze between rare anchors.

Fix (Kotlin only, MediaHub.kt + tm_widget.xml):
1. publishPlayback() — a cheap per-tick publish (position + transport
   only; paused speed is 0.0 so nothing drifts). publishSession() (metadata
   churn) is unchanged and calls it.
2. A forever ticker started by init() (startTick()): while playing &&
   durMs > 0 it advances posMs by 1 s locally each second, publishes
   PlaybackState and refreshes the widget; idle cadence 5 s. The next JS push
   remains authoritative and re-anchors (posMs = pos).
3. The widget layout gained a horizontal ProgressBar (tm_w_progress,
   max 1000); bindWidget() sets progress/visibility (visible only once a
   track with a duration is known). The Android 16 status chip reads the same
   PlaybackState, so one fix feeds all three surfaces.
