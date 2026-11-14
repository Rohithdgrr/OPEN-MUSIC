package com.openmusic.trancemusic

import android.webkit.JavascriptInterface
import org.json.JSONObject

/// JS bridge for `mobile/native.js` (`window.TMNative`). Method names are a
/// contract with native.js — do not rename. Runs on a WebView background
/// thread; MediaHub re-posts to the main thread where the platform requires
/// it. Cold-start actions are stashed by MediaHub and replayed through
/// consumeAction()/consumeRoute() by native.js drainPending().
class TmBridge(private val hub: MediaHub) {
  @JavascriptInterface
  fun pushMeta(json: String) {
    try {
      val o = JSONObject(json)
      hub.onMeta(
        o.optString("title", ""),
        o.optString("artist", ""),
        o.optString("album", ""),
        o.optString("art", ""),
      )
    } catch (_: Exception) {
    }
  }

  @JavascriptInterface
  fun pushState(json: String) {
    try {
      val o = JSONObject(json)
      hub.onState(
        o.optBoolean("playing", false),
        o.optLong("pos", 0L),
        o.optLong("dur", 0L),
        o.optDouble("rate", 1.0).toFloat(),
      )
    } catch (_: Exception) {
    }
  }

  @JavascriptInterface
  fun dismissNotification() {
    hub.dismiss()
  }

  /// Native share sheet. The Android WebView does not implement
  /// `navigator.share`, so the JS side falls back to this: an ACTION_SEND
  /// chooser — the real Android share sheet (2026-11-13).
  @JavascriptInterface
  fun share(text: String) {
    hub.share(text)
  }

  @JavascriptInterface
  fun shareImage(dataUrl: String, title: String, text: String): String =
    hub.shareImage(dataUrl, title, text)

  /// "Save to local" (menus.js trackMenu): copy one vaulted song file into the
  /// device's MediaStore (Music/OpenMusic/) so other players see it. Distinct
  /// from "Download", which vaults into the app-private folder only OpenMusic
  /// can read. Returns a line protocol consumed by savelocal.js bridgeResult():
  /// `ok <name>` / `same <name>` / `err: …` — `same` makes the menu item
  /// idempotent (docs/mobile/06-features.md, 2026-10-24).
  /// ONE declaration only: a second identical overload fails the Kotlin build
  /// (docs/mobile/09-problems-solutions.md P59).
  @JavascriptInterface
  fun saveLocal(json: String): String = hub.saveLocal(json)

  @JavascriptInterface
  fun consumeAction(): String = hub.takeAction()

  @JavascriptInterface
  fun consumeRoute(): String = hub.takeRoute()

}
