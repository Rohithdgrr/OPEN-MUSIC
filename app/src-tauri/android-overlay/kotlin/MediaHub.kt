package com.openmusic.trancemusic

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.webkit.WebView
import android.widget.RemoteViews
import java.io.File
import org.json.JSONObject
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

  // 1-second playback ticker: while playing it advances posMs locally and
  // re-publishes PlaybackState + widget progress. The JS-side pushes throttle
  // at 2-5 s and stall entirely once the WebView is backgrounded (Android
  // throttles its timers), which froze the notification bar, the Android 16
  // status chip and the widget at the last pushed anchor.
  private var ticker: Runnable? = null

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
    startTick()
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

  /// Cheap per-tick publish: position + transport state only — no metadata
  /// churn, cheap enough to run every second. Speed is 1.0 while playing so
  /// the system extrapolates between ticks, and 0.0 while paused so nothing
  /// drifts forward.
  private fun publishPlayback() {
    val s = session ?: return
    try {
      val state = if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED
      s.setPlaybackState(
        PlaybackState.Builder()
          .setState(state, posMs, if (playing) 1.0f else 0.0f)
          .setActions(
            PlaybackState.ACTION_PLAY or
              PlaybackState.ACTION_PAUSE or
              PlaybackState.ACTION_SKIP_TO_NEXT or
              PlaybackState.ACTION_SKIP_TO_PREVIOUS or
              PlaybackState.ACTION_SEEK_TO or
              PlaybackState.ACTION_STOP,
          ).build(),
      )
    } catch (_: Exception) {
    }
  }

  private fun startTick() {
    if (ticker != null) return
    val r =
      object : Runnable {
        override fun run() {
          if (playing && durMs > 0L && posMs < durMs) {
            posMs = (posMs + 1000L).coerceAtMost(durMs)
            publishPlayback()
            refreshWidgets()
          }
          // Keeps polling (slowly) while paused so a resumed push is picked
          // up seamlessly; the JS push remains authoritative on every change.
          main.postDelayed(this, if (playing) 1000L else 5000L)
        }
      }
    ticker = r
    main.postDelayed(r, 1000L)
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
      publishPlayback()
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
      // Seek bar: visible only once a track with a duration is known; the
      // ticker refreshes it every second while playing.
      val hasProgress = everMeta && durMs > 0L
      views.setViewVisibility(
        R.id.tm_w_progress,
        if (hasProgress) android.view.View.VISIBLE else android.view.View.GONE,
      )
      if (hasProgress) {
        val pct = ((posMs * 1000L) / durMs).coerceIn(0L, 1000L).toInt()
        views.setProgressBar(R.id.tm_w_progress, 1000, pct, false)
      }
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

  // ------------------------------------------------------------ save local -

  /// Copy one vaulted song file into MediaStore (Music/OpenMusic/) — the
  /// "Save to local" menu item (savelocal.js). Scoped storage makes this a
  /// plain insert, no storage permission on API 29+; older versions answer
  /// honestly instead of failing oddly. Runs on the caller's (WebView)
  /// thread; a few MB copy is milliseconds-to-seconds of work.
  fun saveLocal(json: String): String {
    if (!this::app.isInitialized) return "err: app not ready"
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      return "err: save to local needs Android 10 or newer"
    }
    try {
      val o = JSONObject(json)
      val src = File(o.optString("path", ""))
      if (!src.isFile) return "err: saved file not found — download it again"
      val bytes = src.length()
      if (bytes <= 0L) return "err: saved file is empty"

      // The display name from savelocal.js localFileName(), re-sanitized here
      // as defense in depth: same strip rule, so dedupe compares the same
      // final string the JS side computed.
      val display = sanitizeName(o.optString("display", "")) ?: "song.m4a"
      val ext = display.substringAfterLast('.', "m4a")
      val mime = if (ext.equals("opus", ignoreCase = true)) "audio/ogg" else "audio/mp4"
      val sanitized = sanitizeName(o.optString("title", "")) ?: display.substringBeforeLast('.')
      val artistName = sanitizeName(o.optString("artist", "")) ?: "Unknown artist"
      val albumName = sanitizeName(o.optString("album", "")) ?: "Unknown album"

      val cr = app.contentResolver
      // Idempotent subject = the name, not the bytes: a re-downloaded vault
      // copy can differ byte-for-byte (CDN encode drift) while being the same
      // song; treating that as new made MediaStore auto-rename the second
      // insert to " <n>.m4a" and the device filled with duplicates.
      val media = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
      cr.query(
        media,
        arrayOf(MediaStore.MediaColumns._ID),
        "${MediaStore.MediaColumns.DISPLAY_NAME} = ?",
        arrayOf(display),
        null,
      )?.use { c ->
        if (c.moveToFirst()) {
          return "same $display"
        }
      }

      val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, display)
        put(MediaStore.MediaColumns.MIME_TYPE, mime)
        put(MediaStore.MediaColumns.RELATIVE_PATH, "Music/OpenMusic/")
        put(MediaStore.Audio.AudioColumns.TITLE, sanitized)
        put(MediaStore.Audio.AudioColumns.ARTIST, artistName.ifEmpty { "Unknown artist" })
        put(MediaStore.Audio.AudioColumns.ALBUM, albumName.ifEmpty { "Unknown album" })
        put(MediaStore.Audio.AudioColumns.IS_MUSIC, 1)
        put(MediaStore.Audio.AudioColumns.IS_RINGTONE, 0)
        put(MediaStore.Audio.AudioColumns.IS_NOTIFICATION, 0)
        put(MediaStore.Audio.AudioColumns.IS_ALARM, 0)
        put(MediaStore.Audio.AudioColumns.IS_PODCAST, 0)
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }
      val uri = cr.insert(media, values) ?: return "err: media library rejected the insert"
      try {
        cr.openOutputStream(uri)?.use { outs ->
          src.inputStream().use { ins ->
            ins.copyTo(outs, 64 * 1024)
          }
          outs.flush()
        } ?: run {
          fail(uri, cr, display)
          return "err: could not open storage stream"
        }
        val done = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
        cr.update(uri, done, null, null)
        // MediaProvider can rename on a display-name race ("song (1).m4a") —
        // the honest result is the name the row actually carries now.
        var actual = display
        try {
          cr.query(
            uri,
            arrayOf(MediaStore.MediaColumns.DISPLAY_NAME),
            null,
            null,
            null,
          )?.use { c ->
            if (c.moveToFirst()) actual = c.getString(0) ?: display
          }
        } catch (_: Exception) {
        }
        return "ok $actual"
      } catch (e: Exception) {
        fail(uri, cr, display)
        return "err: save failed — ${e.message ?: "copy error"}"
      }
    } catch (e: Exception) {
      return "err: ${e.message ?: "save error"}"
    }
  }

  private fun fail(uri: Uri, cr: ContentResolver, name: String) {
    try {
      cr.delete(uri, null, null)
    } catch (_: Exception) {
      logW("[TM] saveLocal: could not discard pending row ($name)")
    }
  }

  private fun logW(msg: String) {
    try {
      android.util.Log.w("OpenMusic", msg)
    } catch (_: Exception) {
    }
  }

  /// Same strip rule as savelocal.js localFileName: Android-hostile
  /// separators + control chars → space, spacing collapsed, trimmed.
  private fun sanitizeName(raw: String): String? {
    val s = raw
      .replace(Regex("[/:*?\"<>|\\\\]"), " ")
      .replace(Regex("[\\x00-\\x1f]"), " ")
      .replace(Regex("\\s+"), " ")
      .trim()
      .trimEnd('-', '.', ' ')
      .take(96)
    return if (s.isEmpty()) null else s
  }
}
