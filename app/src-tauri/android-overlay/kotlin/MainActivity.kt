package com.openmusic.trancemusic

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

/// Overlay replacement for the stock generated MainActivity (gen/ is wiped
/// by `tauri android init`; build.sh inject_android_mediahub copies this in).
/// Hooks:
/// - onWebViewCreate (WryActivity): attaches the TMNative JavascriptInterface
///   before page JS runs, so native.js always finds its bridge.
/// - onCreate/onNewIntent: forwards widget/notification launch actions +
///   routes into MediaHub (live page or cold-start stash).
/// - POST_NOTIFICATIONS runtime prompt (API 33+) on first launch.
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    MediaHub.init(applicationContext)
    handleTmIntent(intent)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
        PackageManager.PERMISSION_GRANTED
    ) {
      try {
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS)) {}
      } catch (_: Exception) {
      }
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    try {
      webView.addJavascriptInterface(TmBridge(MediaHub), "TMNative")
    } catch (_: Exception) {
    }
    MediaHub.setWebView(webView)
  }

  override fun onDestroy() {
    MediaHub.setWebView(null)
    super.onDestroy()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleTmIntent(intent)
  }

  private fun handleTmIntent(intent: Intent?) {
    if (intent == null) return
    try {
      val action = intent.getStringExtra("tm_action")
      if (action != null) MediaHub.deliver(action, intent.getLongExtra("tm_arg", 0L))
      val route = intent.getStringExtra(MediaHub.EXTRA_ROUTE)
      if (route != null) MediaHub.setRoute(route)
    } catch (_: Exception) {
    }
  }
}
