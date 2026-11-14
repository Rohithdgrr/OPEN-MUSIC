package com.openmusic.trancemusic

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException

class ShareCardProvider : ContentProvider() {
  override fun onCreate(): Boolean = true

  private fun cachedPng(uri: Uri): File {
    val ctx = context ?: throw FileNotFoundException("App context unavailable")
    val directory = File(ctx.cacheDir, "share-cards").canonicalFile
    val name = uri.lastPathSegment?.takeIf { it.isNotBlank() }
      ?: throw FileNotFoundException("Missing share-card name")
    val file = File(directory, name).canonicalFile
    if (uri.authority != "${ctx.packageName}.sharecards" ||
      uri.pathSegments.size != 1 ||
      file.parentFile != directory ||
      !file.name.endsWith(".png", ignoreCase = true) ||
      !file.isFile
    ) {
      throw FileNotFoundException("Share card not found")
    }
    return file
  }

  override fun getType(uri: Uri): String? {
    cachedPng(uri)
    return "image/png"
  }

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?,
  ): Cursor {
    val file = cachedPng(uri)
    val columns = projection?.toList()
      ?: listOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
    return MatrixCursor(columns.toTypedArray(), 1).apply {
      addRow(
        columns.map { column ->
          when (column) {
            OpenableColumns.DISPLAY_NAME -> file.name
            OpenableColumns.SIZE -> file.length()
            else -> null
          }
        }.toTypedArray(),
      )
    }
  }

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    if (mode != "r") throw FileNotFoundException("Share cards are read-only")
    return ParcelFileDescriptor.open(cachedPng(uri), ParcelFileDescriptor.MODE_READ_ONLY)
  }

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<out String>?,
  ): Int = 0
}
