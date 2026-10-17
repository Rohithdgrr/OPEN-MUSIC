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

  @JavascriptInterface
  fun consumeAction(): String = hub.takeAction()

  @JavascriptInterface
  fun consumeRoute(): String = hub.takeRoute()
}
