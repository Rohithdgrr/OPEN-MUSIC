package com.openmusic.trancemusic

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import android.widget.RemoteViews
import java.net.HttpURLConnection
import java.net.URL

/// Owns the Android media surfaces: MediaSession (lockscreen, BT/car,
/// headset), the MediaStyle notification (notification panel + lockscreen
/// render the same notification), and the homescreen AppWidget.
///
/// Framework APIs only (minSdk 24) — no media3/androidx.media, so offline
/// gradle stays green. All JS entry runs on a WebView background thread;
/// session/notification/widget writes go through `main`.
object MediaHub {
  const val ACTION_SYNC = "com.openmusic.trancemusic.TM_SYNC"
  const val ACTION_TOGGLE = "com.openmusic.trancemusic.TM_TOGGLE"
  const val ACTION_NEXT = "com.openmusic.trancemusic.TM_NEXT"
  const val ACTION_PREV = "com.openmusic.trancemusic.TM_PREV"
  const val ACTION_PLAY = "com.openmusic.trancemusic.TM_PLAY"
  const val ACTION_PAUSE = "com.openmusic.trancemusic.TM_PAUSE"
  const val ACTION_STOP = "com.openmusic.trancemusic.TM_STOP"
  const val ACTION_DISMISS = "com.openmusic.trancemusic.TM_DISMISS"
  const val ACTION_SEEK_TO = "com.openmusic.trancemusic.TM_SEEK_TO"
  const val EXTRA_SEEK = "tm_arg"
  const val EXTRA_ROUTE = "tm_route"

  private const val NOTIF_ID = 4201
  private const val CHANNEL = "tm_media"

  private lateinit var app: Context
  private val main = Handler(Looper.getMainLooper())
  private var ready = false

  private var session: MediaSession? = null
  private var web: WebView? = null

  private var metaTitle = ""
  private var metaArtist = ""
  private var metaAlbum = ""
  private var metaArtUrl = ""
  private var art: Bitmap? = null
  private var playing = false
  private var posMs = 0L
  private var durMs = 0L
  private var everMeta = false

  private val lock = Any()
  private var pendingAction = ""
  private var pendingRoute = ""

  fun init(ctx: Context) {
    if (ready) return
    ready = true
    app = ctx.applicationContext
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val nm = app.getSystemService(NotificationManager::class.java)
      if (nm != null && nm.getNotificationChannel(CHANNEL) == null) {
        nm.createNotificationChannel(
          NotificationChannel(CHANNEL, "Now playing", NotificationManager.IMPORTANCE_LOW),
        )
      }
    }
    main.post {
      try {
        val s = MediaSession(app, "OpenMusic")
        s.setFlags(
          MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or
            MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS,
        )
        s.setCallback(
          object : MediaSession.Callback() {
            override fun onPlay() = deliver("PLAY")
            override fun onPause() = deliver("PAUSE")
            override fun onSkipToNext() = deliver("NEXT")
            override fun onSkipToPrevious() = deliver("PREV")
            override fun onStop() = deliver("STOP")
            override fun onSeekTo(pos: Long) = deliver("SEEK_TO", pos)
          },
        )
        session = s
      } catch (_: Exception) {
      }
    }
  }

  fun setWebView(w: WebView?) {
    web = w
  }

  fun setRoute(route: String) {
    synchronized(lock) { pendingRoute = route }
  }

  // ------------------------------------------------------------ JS pushes -

  fun onMeta(title: String, artist: String, album: String, artUrl: String) {
    main.post {
      var artChanged = false
      if (title != metaTitle || artist != metaArtist || album != metaAlbum) {
        metaTitle = title
        metaArtist = artist
        metaAlbum = album
      }
      if (artUrl != metaArtUrl) {
        metaArtUrl = artUrl
        art = null
        artChanged = artUrl.isNotEmpty()
      }
      everMeta = true
      publishSession()
      ensureService()
      postNotif()
      refreshWidgets()
      if (artChanged) fetchArt(artUrl)
    }
  }

  fun onState(isPlaying: Boolean, pos: Long, dur: Long, @Suppress("UNUSED_PARAMETER") rate: Float) {
    main.post {
      playing = isPlaying
      posMs = pos
      durMs = dur
      publishSession()
      ensureService()
      postNotif()
      refreshWidgets()
    }
  }

  fun dismiss() {
    main.post {
      try {
        val nm = app.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        nm?.cancel(NOTIF_ID)
      } catch (_: Exception) {
      }
      try {
        session?.isActive = false
      } catch (_: Exception) {
      }
      metaTitle = ""
      metaArtist = ""
      metaAlbum = ""
      metaArtUrl = ""
      art = null
      playing = false
      try {
        app.stopService(Intent(app, MediaService::class.java))
      } catch (_: Exception) {
      }
    }
  }

  // ---------------------------------------------------------- JS onwards -

  /// Remote action from notification/widget/headset/BT. Live page: eval the
  /// one shared `window.__tmRemote` and stash only if it did not act (atomic
  /// check-and-call in JS). Dead page: stash for consumeAction().
  fun deliver(action: String, argMs: Long = 0L) {
    val call =
      when {
        action.endsWith("TOGGLE") -> "toggle()"
        action.endsWith("NEXT") -> "next()"
        action.endsWith("PREV") -> "prev()"
        action.endsWith("PAUSE") -> "pause()"
        action.endsWith("PLAY") -> "play()"
        action.endsWith("STOP") || action.endsWith("DISMISS") -> "stop()"
        action.endsWith("SEEK_TO") -> "seekTo($argMs)"
        else -> return
      }
    val w = web
    if (w == null) {
      stash(action, argMs)
      return
    }
    val method = call.substringBefore("(")
    val js =
      "(() => { const R = window.__tmRemote; " +
        "if (!R || typeof R.$method !== 'function') return 0; " +
        "R.$call; return 1; })()"
    try {
      w.post {
        try {
          w.evaluateJavascript(js) { v -> if (v != "1") stash(action, argMs) }
        } catch (_: Exception) {
          stash(action, argMs)
        }
      }
    } catch (_: Exception) {
      stash(action, argMs)
    }
  }

  private fun stash(action: String, argMs: Long) {
    // native.js drainPending splits on "|" then suffix-matches the action.
    synchronized(lock) { pendingAction = "$action|$argMs" }
  }

  fun takeAction(): String = synchronized(lock) {
    val a = pendingAction
    pendingAction = ""
    a
  }

  fun takeRoute(): String = synchronized(lock) {
    val r = pendingRoute
    pendingRoute = ""
    r
  }

  // --------------------------------------------------------------- session -

  private fun publishSession() {
    val s = session ?: return
    try {
      val mb = MediaMetadata.Builder()
        .putString(MediaMetadata.METADATA_KEY_TITLE, metaTitle.ifEmpty { "OpenMusic" })
        .putString(MediaMetadata.METADATA_KEY_ARTIST, metaArtist)
        .putString(MediaMetadata.METADATA_KEY_ALBUM, metaAlbum)
      val bmp = art
      if (bmp != null) mb.putBitmap(MediaMetadata.METADATA_KEY_ART, bmp)
      s.setMetadata(mb.build())
      val state = if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED
      s.setPlaybackState(
        PlaybackState.Builder()
          .setState(state, posMs, 1.0f)
          .setActions(
            PlaybackState.ACTION_PLAY or
              PlaybackState.ACTION_PAUSE or
              PlaybackState.ACTION_SKIP_TO_NEXT or
              PlaybackState.ACTION_SKIP_TO_PREVIOUS or
              PlaybackState.ACTION_SEEK_TO or
              PlaybackState.ACTION_STOP,
          ).build(),
      )
      s.isActive = everMeta
    } catch (_: Exception) {
    }
  }

  // ---------------------------------------------------------- notification -

  private fun notifManager(): NotificationManager? =
    try {
      app.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
    } catch (_: Exception) {
      null
    }

  private fun flags(): Int =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    } else {
      PendingIntent.FLAG_UPDATE_CURRENT
    }

  fun openApp(ctx: Context, route: String, code: Int): PendingIntent {
    val i = Intent(ctx, MainActivity::class.java)
    i.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    i.putExtra(EXTRA_ROUTE, route)
    return PendingIntent.getActivity(ctx, code, i, flags())
  }

  fun action(ctx: Context, action: String, code: Int, argMs: Long): PendingIntent {
    val i = Intent(ctx, MediaService::class.java).setAction(action)
    if (argMs != 0L) i.putExtra(EXTRA_SEEK, argMs)
    // getForegroundService: the tap may arrive while the app is dead, and
    // only a foreground-service launch lets the service post then.
    return PendingIntent.getForegroundService(ctx, code, i, flags())
  }

  /// Notification.Action wrapper (the Builder form is the only overload that
  /// takes an explicit PendingIntent on this SDK).
  private fun notifAction(title: String, icon: Int, act: String, code: Int): Notification.Action =
    Notification.Action.Builder(icon, title, action(app, act, code, 0L)).build()

  fun buildNotif(): Notification {
    val token = session?.sessionToken
    val toggleIcon =
      if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
    val b =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(app, CHANNEL)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(app)
      }
    b.setSmallIcon(android.R.drawable.ic_media_play)
      .setContentTitle(metaTitle.ifEmpty { "OpenMusic" })
      .setContentText(metaArtist)
      .setSubText(metaAlbum.ifEmpty { null })
      .setContentIntent(openApp(app, "nowplaying", 1001))
      .setDeleteIntent(action(app, ACTION_DISMISS, 1005, 0L))
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setOngoing(playing)
      .setShowWhen(false)
      .addAction(notifAction("Previous", android.R.drawable.ic_media_previous, ACTION_PREV, 1002))
      .addAction(notifAction(if (playing) "Pause" else "Play", toggleIcon, ACTION_TOGGLE, 1003))
      .addAction(notifAction("Next", android.R.drawable.ic_media_next, ACTION_NEXT, 1004))
    val bmp = art
    if (bmp != null) b.setLargeIcon(bmp)
    if (token != null) {
      b.setStyle(
        Notification.MediaStyle().setMediaSession(token).setShowActionsInCompactView(0, 1, 2),
      )
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      b.setColorized(true).setColor(0xFF18181B.toInt())
    }
    return b.build()
  }

  private fun postNotif() {
    try {
      notifManager()?.notify(NOTIF_ID, buildNotif())
    } catch (_: Exception) {
    }
  }

  fun ensureForeground(svc: MediaService) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      svc.startForeground(
        NOTIF_ID,
        buildNotif(),
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
      )
    } else {
      @Suppress("DEPRECATION")
      svc.startForeground(NOTIF_ID, buildNotif())
    }
  }

  private fun ensureService() {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        app.startForegroundService(Intent(app, MediaService::class.java).setAction(ACTION_SYNC))
      } else {
        app.startService(Intent(app, MediaService::class.java).setAction(ACTION_SYNC))
      }
    } catch (_: Exception) {
    }
  }

  /// A remote tap that arrived with no page and no track yet: the stash is
  /// kept for the next boot, but the placeholder must not linger.
  fun maybeRetire(svc: MediaService) {
    if (web != null || everMeta) return
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        svc.stopForeground(android.app.Service.STOP_FOREGROUND_REMOVE)
      } else {
        @Suppress("DEPRECATION")
        svc.stopForeground(true)
      }
    } catch (_: Exception) {
    }
    try {
      svc.stopSelf()
    } catch (_: Exception) {
    }
  }

  // ------------------------------------------------------------------ art -

  private fun fetchArt(url: String) {
    Thread {
      try {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 8000
        conn.readTimeout = 8000
        conn.instanceFollowRedirects = true
        conn.connect()
        if (conn.responseCode in 200..299) {
          conn.inputStream.use { ins ->
            val raw = BitmapFactory.decodeStream(ins)
            if (raw != null) {
              val bmp = Bitmap.createScaledBitmap(raw, 256, 256, true)
              if (bmp !== raw) {
                try {
                  raw.recycle()
                } catch (_: Exception) {
                }
              }
              main.post {
                // A newer track may have cleared art while we fetched.
                if (url == metaArtUrl) {
                  art = bmp
                  publishSession()
                  postNotif()
                  refreshWidgets()
                }
              }
              return@Thread
            }
          }
        }
      } catch (_: Exception) {
      }
    }.start()
  }

  // ---------------------------------------------------------------- widget -

  fun bindWidget(ctx: Context, views: RemoteViews) {
    try {
      views.setTextViewText(R.id.tm_w_title, metaTitle.ifEmpty { "OpenMusic" })
      views.setTextViewText(R.id.tm_w_artist, metaArtist.ifEmpty { "Nothing playing" })
      val bmp = art
      if (bmp != null) {
        views.setImageViewBitmap(R.id.tm_w_art, bmp)
      } else {
        views.setImageViewResource(R.id.tm_w_art, R.mipmap.ic_launcher)
      }
      views.setImageViewResource(
        R.id.tm_w_toggle,
        if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
      )
    } catch (_: Exception) {
    }
  }

  fun refreshWidgets() {
    try {
      val mgr = AppWidgetManager.getInstance(app) ?: return
      val ids = mgr.getAppWidgetIds(ComponentName(app, TmWidget::class.java))
      if (ids.isEmpty()) return
      for (id in ids) {
        val views = RemoteViews(app.packageName, R.layout.tm_widget)
        bindWidget(app, views)
        views.setOnClickPendingIntent(R.id.tm_w_root, openApp(app, "nowplaying", 1001))
        views.setOnClickPendingIntent(R.id.tm_w_prev, action(app, ACTION_PREV, 1002, 0L))
        views.setOnClickPendingIntent(R.id.tm_w_toggle, action(app, ACTION_TOGGLE, 1003, 0L))
        views.setOnClickPendingIntent(R.id.tm_w_next, action(app, ACTION_NEXT, 1004, 0L))
        try {
          mgr.updateAppWidget(id, views)
        } catch (_: Exception) {
        }
      }
    } catch (_: Exception) {
    }
  }
}
