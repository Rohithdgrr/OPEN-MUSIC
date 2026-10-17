package com.openmusic.trancemusic

import android.app.Service
import android.content.Intent
import android.os.IBinder

/// Foreground service that owns the ongoing media notification. Remote taps
/// (notification buttons, widget, headset) arrive here as action intents —
/// launched via getForegroundService, so they work even while the app is
/// dead. MediaHub.dispatch either drives the live page or stashes for the
/// next boot (native.js drainPending replays it).
class MediaService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    MediaHub.init(this)
    // A foreground service must post within seconds of startForegroundService.
    MediaHub.ensureForeground(this)
    val action = intent?.action
    if (action != null && action != MediaHub.ACTION_SYNC) {
      val arg = intent.getLongExtra(MediaHub.EXTRA_SEEK, 0L)
      MediaHub.deliver(action, arg)
    }
    MediaHub.maybeRetire(this)
    return START_NOT_STICKY
  }
}
