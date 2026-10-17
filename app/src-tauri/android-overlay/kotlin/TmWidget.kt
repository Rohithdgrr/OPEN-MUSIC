package com.openmusic.trancemusic

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.widget.RemoteViews

/// Homescreen player widget: artwork + title/artist + prev/toggle/next. The
/// body opens Now Playing; buttons go to MediaService (foreground-service
/// launch, works while the app is dead) and MediaHub drives or stashes.
class TmWidget : AppWidgetProvider() {
  override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
    MediaHub.init(ctx)
    for (id in ids) {
      try {
        val views = RemoteViews(ctx.packageName, R.layout.tm_widget)
        MediaHub.bindWidget(ctx, views)
        views.setOnClickPendingIntent(R.id.tm_w_root, MediaHub.openApp(ctx, "nowplaying", 1001))
        views.setOnClickPendingIntent(R.id.tm_w_prev, MediaHub.action(ctx, MediaHub.ACTION_PREV, 1002, 0L))
        views.setOnClickPendingIntent(R.id.tm_w_toggle, MediaHub.action(ctx, MediaHub.ACTION_TOGGLE, 1003, 0L))
        views.setOnClickPendingIntent(R.id.tm_w_next, MediaHub.action(ctx, MediaHub.ACTION_NEXT, 1004, 0L))
        mgr.updateAppWidget(id, views)
      } catch (_: Exception) {
      }
    }
  }
}
