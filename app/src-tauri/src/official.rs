//! First-party JioSaavn adapter â€” `www.jiosaavn.com/api.php`.
//!
//! This is the API JioSaavn's own web player calls, so it is the primary
//! catalog source: no community-mirror rate limit, real pagination (`n`/`p`)
//! and a media url for every song. Mirrors (`jiosaavn.rs`) are the fallback.
//!
//! Media urls arrive as `encrypted_media_url`: base64 over DES-ECB with an
//! 8-byte key. Decrypting yields the CDN asset of the 96 kbps rendition, from
//! which the other four renditions are derived by suffix swap â€” so every song
//! resolves to the complete file, not a preview.
//!
//! Must NOT know anything about HTTP servers (that is `proxy.rs`'s job).

use std::sync::Mutex;

use base64::Engine;
use serde::Serialize;
use serde_json::Value;

use crate::jiosaavn::{
    check_id, dedup_tracks, flag, fmt_duration, html_unescape, image_url, num_any, text,
    QualityUrl, Song, Track,
};

/// JioSaavn's web API entry point.
const BASE: &str = "https://www.jiosaavn.com/api.php";

/// DES-ECB key used for `encrypted_media_url` (8 ASCII bytes).
const MEDIA_KEY: &[u8; 8] = b"38346591";

/// Renditions the CDN serves for every `*_96.mp4` asset, low to high.
const RENDITIONS: &[(&str, &str)] = &[
    ("12kbps", "_12"),
    ("48kbps", "_48"),
    ("96kbps", "_96"),
    ("160kbps", "_160"),
    ("320kbps", "_320"),
];

/// Upper bound the upstream honours for a single search page.
const MAX_PAGE_SIZE: u32 = 40;

/// Rows per page of an artist's catalogue — the artist page itself asks the
/// API for 50, and `p` walks the rest of the discography behind them.
const ARTIST_PAGE_SIZE: u32 = 50;

/// Releases pulled into an artist's discography in one round trip.
const ARTIST_RELEASES: u32 = 50;

// ---------------------------------------------------------------------------
// Content preferences (Settings -> General)
// ---------------------------------------------------------------------------

/// Language / region every `api.php` call is biased to. Empty means "source
/// default", "all" means "language filter off" and is never sent.
static PREF_LANG: Mutex<String> = Mutex::new(String::new());
static PREF_COUNTRY: Mutex<String> = Mutex::new(String::new());

/// Set once at boot and whenever the user changes the selects in Settings.
pub fn set_prefs(lang: &str, country: &str) {
    if let Ok(mut g) = PREF_LANG.lock() {
        *g = lang.to_string();
    }
    if let Ok(mut g) = PREF_COUNTRY.lock() {
        *g = country.to_string();
    }
}

fn pref(m: &Mutex<String>) -> String {
    // A poisoned guard still carries the value the panicking thread held, so
    // recover it instead of silently dropping the user's language choice.
    m.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// One `api.php` round-trip. Upstream reports failures in HTTP 200 bodies, so
/// both the status line and the JSON envelope are checked.
async fn call(client: &reqwest::Client, params: &[(&str, &str)]) -> Result<Value, String> {
    let query = {
        let mut ser = url::form_urlencoded::Serializer::new(String::new());
        for (k, v) in params {
            ser.append_pair(k, v);
        }
        let lang = pref(&PREF_LANG);
        if !lang.is_empty() && lang != "all" {
            ser.append_pair("lang", &lang);
        }
        let country = pref(&PREF_COUNTRY);
        if !country.is_empty() {
            ser.append_pair("country", &country);
        }
        ser.finish()
    };
    let url = format!("{BASE}?{query}");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("{url} -> HTTP {status}"));
    }
    let body = resp.text().await.map_err(|e| format!("read {url}: {e}"))?;
    let value: Value = serde_json::from_str(&body).map_err(|e| format!("decode {url}: {e}"))?;
    if let Some(err) = value.get("error") {
        // Usually `{"error":{"msg":...}}`; a few endpoints answer with a bare
        // string ("No new song found for current radio.").
        let msg = err
            .as_str()
            .or_else(|| err.get("msg").and_then(Value::as_str))
            .unwrap_or("upstream error");
        return Err(format!("{BASE}: {msg}"));
    }
    if value.get("status").and_then(Value::as_str) == Some("failure") {
        let msg = value
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or("upstream failure");
        return Err(format!("{BASE}: {msg}"));
    }
    Ok(value)
}

// ---------------------------------------------------------------------------
// Media url decryption
// ---------------------------------------------------------------------------

/// Base64 + DES-ECB decrypt JioSaavn's `encrypted_media_url` into a CDN url.
pub fn decrypt_media_url(encoded: &str) -> Result<String, String> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|e| format!("media url is not base64: {e}"))?;
    if raw.is_empty() || raw.len() % 8 != 0 {
        return Err(format!(
            "media url is {} bytes, not a whole number of DES blocks",
            raw.len()
        ));
    }

    use des::cipher::{BlockDecrypt, KeyInit};
    let cipher = des::Des::new_from_slice(MEDIA_KEY).map_err(|e| format!("des key: {e}"))?;

    let mut out = Vec::with_capacity(raw.len());
    for block in raw.chunks_exact(8) {
        let mut b = des::cipher::generic_array::GenericArray::clone_from_slice(block);
        cipher.decrypt_block(&mut b);
        out.extend_from_slice(&b);
    }

    // PKCS#7 unpad (DES block size is 8).
    let pad = *out.last().unwrap_or(&0) as usize;
    if pad == 0
        || pad > 8
        || out.len() < pad
        || !out[out.len() - pad..].iter().all(|&b| b == pad as u8)
    {
        return Err("media url padding is invalid".into());
    }
    out.truncate(out.len() - pad);

    String::from_utf8(out).map_err(|e| format!("media url is not utf-8: {e}"))
}

/// Derive every rendition url from a decrypted `â€¦_96.mp4` asset url.
fn renditions(base: &str) -> Vec<QualityUrl> {
    let stem = match base.strip_suffix("_96.mp4") {
        Some(stem) => stem,
        // Unexpected shape: expose what we have rather than nothing.
        None => {
            return vec![QualityUrl {
                quality: "96kbps".into(),
                url: base.to_string(),
            }]
        }
    };
    RENDITIONS
        .iter()
        .map(|(quality, suffix)| QualityUrl {
            quality: (*quality).to_string(),
            url: format!("{stem}{suffix}.mp4"),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

fn hq_available(v: &Value) -> bool {
    match v.get("320kbps") {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

/// Official payloads use different field names than the mirrors and HTML
/// entities inside titles (`&quot;`), so this parses its own shape.
fn parse_song(v: &Value) -> Track {
    // `webapi.get` (album/artist pages) nests duration, album and the 320
    // flag one level down; search results keep them at the top.
    let info = &v["more_info"];
    let duration_secs = num_any(v, "duration")
        .or_else(|| num_any(info, "duration"))
        .unwrap_or(0.0)
        .max(0.0) as u64;
    let title = text(v, "song")
        .or_else(|| text(v, "title"))
        .unwrap_or_default();
    let artist = text(v, "primary_artists")
        .or_else(|| text(v, "singers"))
        .or_else(|| text(v, "music"))
        // Radio batches carry the credit only under `more_info`.
        .or_else(|| text(info, "primary_artists"))
        .or_else(|| text(info, "singers"))
        .or_else(|| text(info, "music"))
        .or_else(|| text(v, "subtitle"))
        .unwrap_or_default();
    let album = text(v, "album")
        .or_else(|| text(info, "album"))
        .unwrap_or_default();
    // Prefer the 500x500 artwork when the payload only carries the 150px thumb.
    let image = image_url(match v.get("image") {
        Some(v) => v,
        None => &info["image"],
    });

    // Artist ids sit in `artistMap`, either at the top (search) or under
    // `more_info` (getDetails / webapi.get).
    let map = if v["artistMap"].is_object() {
        &v["artistMap"]
    } else {
        &info["artistMap"]
    };
    let artist_ids = map["primary_artists"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| text(a, "id"))
        .collect();

    Track {
        id: text(v, "id").unwrap_or_default(),
        title: html_unescape(&title),
        artist: html_unescape(&artist),
        album: html_unescape(&album),
        duration_secs,
        duration: fmt_duration(duration_secs),
        image,
        page_url: text(v, "perma_url")
            .or_else(|| text(v, "url"))
            .unwrap_or_default(),
        hq: hq_available(v) || hq_available(info),
        plays: num_any(v, "play_count")
            .or_else(|| num_any(v, "playCount"))
            .unwrap_or(0.0)
            .max(0.0) as u64,
        has_lyrics: flag(info, "has_lyrics").or_else(|| flag(v, "has_lyrics")),
        artist_ids,
        album_id: text(info, "album_id")
            .or_else(|| text(&v["album"], "id"))
            .unwrap_or_default(),
        year: text(v, "year").unwrap_or_default(),
        label: text(info, "label").unwrap_or_default(),
        language: text(v, "language").unwrap_or_default(),
        explicit: flag(v, "explicit_content").unwrap_or(false),
    }
}

// ---------------------------------------------------------------------------
// Catalog operations
// ---------------------------------------------------------------------------

/// Search page `page` (1-based) with `limit` results per page.
pub async fn search(
    client: &reqwest::Client,
    query: &str,
    limit: u32,
    page: u32,
) -> Result<Vec<Track>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("empty query".into());
    }
    let limit = limit.clamp(1, MAX_PAGE_SIZE).to_string();
    let page = page.max(1).to_string();
    let value = call(
        client,
        &[
            ("__call", "search.getResults"),
            ("q", query),
            ("n", &limit),
            ("p", &page),
            ("_format", "json"),
            ("_marker", "0"),
        ],
    )
    .await?;

    let results = value
        .get("results")
        .and_then(Value::as_array)
        .ok_or_else(|| "search response missing results".to_string())?;
    // Raw parse â€” `jiosaavn::search_songs` collapses repeats and keeps the
    // un-deduped page length for its `page_full` signal.
    Ok(results.iter().map(parse_song).collect())
}

/// One page of non-track search results (album / artist / playlist cards).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct EntityPage {
    pub items: Vec<FeedItem>,
    /// Whether upstream still had rows *after* this page â€” read from
    /// `total`/`start`, never from `items.len()` (dedup shrinks it).
    pub page_full: bool,
}

/// Entity searches the first-party API exposes alongside `search.getResults`.
/// Each has its own operation name and its own row shape.
const ENTITY_OPS: &[(&str, &str)] = &[
    ("album", "search.getAlbumResults"),
    ("artist", "search.getArtistResults"),
    ("playlist", "search.getPlaylistResults"),
];

/// Normalise one row of an entity search into the card shape the grids render.
/// Field names differ per kind (`albumid`/`listid`/`id`, `text`/`name`/
/// `listname`), so each is picked explicitly â€” never guessed from leftovers.
fn entity_item(kind: &str, v: &Value) -> Option<FeedItem> {
    let (id, title) = match kind {
        "album" => (text(v, "albumid")?, text(v, "text")?),
        "playlist" => (text(v, "listid")?, text(v, "listname")?),
        _ => (text(v, "id")?, text(v, "name")?),
    };
    let subtitle = match kind {
        "album" => text(v, "primary_artists")
            .or_else(|| text(v, "music"))
            .unwrap_or_default(),
        "playlist" => {
            // Curator is firstname + lastname; `username` is the fallback.
            let who = [text(v, "firstname"), text(v, "lastname")]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" ");
            if who.trim().is_empty() {
                text(v, "username").unwrap_or_default()
            } else {
                who
            }
        }
        // Artists carry no useful sub-line; `ddCard` falls back to "Artist".
        _ => String::new(),
    };
    Some(FeedItem {
        id,
        title: html_unescape(&title),
        subtitle: html_unescape(subtitle.trim()),
        image: image_url(&v["image"]),
        count: num_any(v, "count").unwrap_or(0.0) as u64,
        year: text(v, "year").unwrap_or_default(),
        token: text(v, "perma_url")
            .and_then(|u| u.rsplit('/').next().map(str::to_string))
            .unwrap_or_default(),
    })
}

/// Search page `page` (1-based) of albums, artists or playlists.
///
/// Only the first-party API is used: mirrors expose `/api/search/songs` only,
/// and there is nothing to fall back to if this rate-limits.
pub async fn search_entities(
    client: &reqwest::Client,
    kind: &str,
    query: &str,
    limit: u32,
    page: u32,
) -> Result<EntityPage, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("empty query".into());
    }
    let op = ENTITY_OPS
        .iter()
        .find(|(k, _)| *k == kind)
        .map(|(_, op)| *op)
        .ok_or_else(|| format!("unknown search kind: {kind}"))?;
    let limit = limit.clamp(1, MAX_PAGE_SIZE).to_string();
    let page = page.max(1).to_string();
    let value = call(
        client,
        &[
            ("__call", op),
            ("q", query),
            ("n", &limit),
            ("p", &page),
            ("_format", "json"),
            ("_marker", "0"),
        ],
    )
    .await?;

    let results = value
        .get("results")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{op} response missing results"))?;
    // `start` is 1-based, so this is how many rows upstream had served in
    // total; a short page (or none) means there is nothing left to load.
    let served = value.get("start").and_then(Value::as_u64).unwrap_or(1) + results.len() as u64 - 1;
    let total = value.get("total").and_then(Value::as_u64).unwrap_or(served);
    let items = dedup_feed(
        results
            .iter()
            .filter_map(|v| entity_item(kind, v))
            .collect(),
    );
    Ok(EntityPage {
        items,
        page_full: served < total,
    })
}

/// Inline search suggestions â€” the `autocomplete.get` call the web player
/// fires as you type. One round-trip returns the top match plus a handful of
/// songs, albums, artists and playlists.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct Suggestions {
    /// The single best match, whatever type it turned out to be.
    pub top: Option<FeedItem>,
    /// `top`'s own type (`song` / `album` / `artist`) â€” a card can't say.
    pub top_kind: Option<String>,
    pub songs: Vec<FeedItem>,
    pub albums: Vec<FeedItem>,
    pub artists: Vec<FeedItem>,
    pub playlists: Vec<FeedItem>,
}

/// Last path segment of a `url` â€” the token `album_tracks` / `artist_tracks`
/// take. Suggestions carry a full url, not a bare token.
fn token_from_url(url: &str) -> Option<String> {
    url.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// One suggestion row â†’ the card shape the grids already render. Rows without
/// an id or a title are skipped, never rendered blank.
fn sug_item(v: &Value, subtitle: String) -> Option<FeedItem> {
    let id = text(v, "id")?;
    let title = html_unescape(&text(v, "title").unwrap_or_default());
    if title.is_empty() {
        return None;
    }
    Some(FeedItem {
        id,
        title,
        subtitle: html_unescape(subtitle.trim()),
        image: image_url(&v["image"]),
        count: 0,
        year: text(v, "year").unwrap_or_default(),
        token: token_from_url(&text(v, "url").unwrap_or_default()).unwrap_or_default(),
    })
}

/// Song rows credit their singers in `more_info`; every other kind carries its
/// credit in a different field, so each names its own.
fn sug_rows(value: &Value, key: &str, subtitle: impl Fn(&Value) -> String) -> Vec<FeedItem> {
    value
        .get(key)
        .and_then(|v| v.get("data"))
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|v| sug_item(v, subtitle(v)))
                .collect()
        })
        .unwrap_or_default()
}

pub async fn suggestions(client: &reqwest::Client, query: &str) -> Result<Suggestions, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("empty query".into());
    }
    let value = call(
        client,
        &[
            // `autocomplete.get` reads `query`, not `q` — `q` answers `[]`.
            ("__call", "autocomplete.get"),
            ("query", query),
            ("_format", "json"),
        ],
    )
    .await?;
    suggestions_from_value(&value)
}

/// Pure half of `suggestions` â€” split out so tests can feed it recorded
/// bodies instead of the network.
fn suggestions_from_value(value: &Value) -> Result<Suggestions, String> {
    let top = value
        .get("topquery")
        .and_then(|v| v.get("data"))
        .and_then(Value::as_array)
        .and_then(|rows| rows.first())
        .and_then(|v| {
            let kind = text(v, "type").unwrap_or_default();
            sug_item(v, String::new()).map(|item| (kind, item))
        });
    Ok(Suggestions {
        top: top.as_ref().map(|(_, item)| item.clone()),
        top_kind: top.as_ref().map(|(kind, _)| kind.clone()),
        songs: sug_rows(value, "songs", |v| {
            let mi = v.get("more_info");
            mi.and_then(|m| text(m, "primary_artists"))
                .or_else(|| mi.and_then(|m| text(m, "singers")))
                .unwrap_or_default()
        })
        .into_iter()
        .take(5)
        .collect(),
        albums: sug_rows(value, "albums", |v| text(v, "music").unwrap_or_default())
            .into_iter()
            .take(3)
            .collect(),
        artists: sug_rows(value, "artists", |v| {
            text(v, "description").unwrap_or_default()
        })
        .into_iter()
        .take(3)
        .collect(),
        playlists: sug_rows(value, "playlists", |v| text(v, "extra").unwrap_or_default())
            .into_iter()
            .take(3)
            .collect(),
    })
}

/// Resolve a song id into its metadata plus every rendition of the full file.
pub async fn fetch_song(client: &reqwest::Client, id: &str) -> Result<Song, String> {
    check_id(id)?;
    let value = call(
        client,
        &[
            ("__call", "song.getDetails"),
            ("pids", id),
            ("api_version", "4"),
            ("_format", "json"),
            ("_marker", "0"),
            ("ctx", "web6dot0"),
        ],
    )
    .await?;

    let song_value = value
        .get("songs")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .ok_or_else(|| format!("song not found: {id}"))?;

    let encrypted = song_value
        .pointer("/more_info/encrypted_media_url")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("song has no media url: {id}"))?;

    let qualities = renditions(&decrypt_media_url(encrypted)?);
    if qualities.is_empty() {
        return Err("no stream qualities".into());
    }

    Ok(Song {
        track: parse_song(song_value),
        qualities,
    })
}

// ---------------------------------------------------------------------------
// Home feed
// ---------------------------------------------------------------------------

/// One row on the Home screen (a playlist or chart).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct FeedItem {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub image: String,
    /// Track count when the payload declares one, else 0.
    pub count: u64,
    /// Release year when the payload declares one, else empty.
    pub year: String,
    /// Last path segment of `perma_url` â€” resolves albums/artists via
    /// `webapi.get`. Empty when the payload carries no url.
    pub token: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct HomeFeed {
    /// Hero banner â€” a real playlist the buttons can start.
    pub spotlight: Option<FeedItem>,
    pub playlists: Vec<FeedItem>,
    pub charts: Vec<FeedItem>,
    /// Chart the "Full 100 Charts" button plays in full.
    pub chart_id: String,
    /// First five tracks of `chart_id` â€” the countdown rows.
    pub top_tracks: Vec<Track>,
    /// New releases ("New Lossless Masters").
    pub albums: Vec<FeedItem>,
    /// Recommended artists ("Featured Artists in Residence").
    pub artists: Vec<FeedItem>,
}

fn feed_item(v: &Value) -> Option<FeedItem> {
    Some(FeedItem {
        id: text(v, "id")?,
        title: html_unescape(&text(v, "title").unwrap_or_default()),
        subtitle: html_unescape(&text(v, "subtitle").unwrap_or_default()),
        image: image_url(&v["image"]),
        count: v
            .get("count")
            .and_then(Value::as_u64)
            .or_else(|| {
                v.pointer("/more_info/song_count")
                    .and_then(|x| x.as_str())
                    .and_then(|s| s.parse().ok())
            })
            .unwrap_or(0),
        year: text(v, "year").unwrap_or_default(),
        token: text(v, "perma_url")
            .and_then(|u| u.rsplit('/').next().map(str::to_string))
            .unwrap_or_default(),
    })
}

/// Keep only the entries of `kind` (launch data mixes songs/albums/playlists).
fn feed_list(v: &Value, kind: &str) -> Vec<FeedItem> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some(kind))
        .filter_map(feed_item)
        .collect()
}

/// Launch data repeats cards across its arrays (and sometimes within one);
/// the UI must show each id once, first occurrence wins.
fn dedup_feed(items: Vec<FeedItem>) -> Vec<FeedItem> {
    let mut seen = std::collections::HashSet::new();
    items
        .into_iter()
        .filter(|i| seen.insert(i.id.clone()))
        .collect()
}

/// Home screen data: one launch-data call plus the top chart's track list.
pub async fn home(client: &reqwest::Client) -> Result<HomeFeed, String> {
    let value = call(
        client,
        &[
            ("__call", "webapi.getLaunchData"),
            ("is_server_side_load", "true"),
            ("api_version", "4"),
            ("_format", "json"),
            ("_marker", "0"),
            ("ctx", "web6dot0"),
        ],
    )
    .await?;

    let playlists = dedup_feed(feed_list(&value["top_playlists"], "playlist"));
    let charts = dedup_feed(feed_list(&value["charts"], "playlist"));
    let spotlight = feed_list(&value["new_trending"], "playlist")
        .into_iter()
        .next()
        .or_else(|| playlists.first().cloned());
    let chart_id = charts.first().map(|c| c.id.clone()).unwrap_or_default();
    let mut albums = dedup_feed(feed_list(&value["new_trending"], "album"));
    for extra in feed_list(&value["new_albums"], "album") {
        if !albums.iter().any(|a| a.id == extra.id) {
            albums.push(extra);
        }
    }
    let artists = dedup_feed(feed_list(&value["artist_recos"], "radio_station"));
    // The hero playlist must not reappear as a card in the carousel below it.
    let spotlight_id = spotlight.as_ref().map(|s| s.id.clone()).unwrap_or_default();
    let playlists: Vec<FeedItem> = playlists
        .into_iter()
        .filter(|p| p.id != spotlight_id)
        .collect();
    // A missing chart only costs the countdown rows â€” the rest still renders.
    let top_tracks = match playlist_tracks(client, &chart_id).await {
        Ok(tracks) => tracks.into_iter().take(5).collect(),
        Err(_) => Vec::new(),
    };

    Ok(HomeFeed {
        spotlight,
        playlists,
        charts,
        chart_id,
        top_tracks,
        albums,
        artists,
    })
}

/// Every track of an album, resolved through `webapi.get` + the album token
/// (the last segment of its `perma_url`). `album.getDetails` is dead upstream.
pub async fn album_tracks(client: &reqwest::Client, token: &str) -> Result<Vec<Track>, String> {
    check_id(token)?;
    let value = call(
        client,
        &[
            ("__call", "webapi.get"),
            ("token", token),
            ("type", "album"),
            ("includeMetaTags", "0"),
            ("ctx", "web6dot0"),
            ("api_version", "4"),
            ("_format", "json"),
            ("_marker", "0"),
        ],
    )
    .await?;
    let songs = value
        .get("list")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| format!("album has no songs: {token}"))?;
    Ok(dedup_tracks(songs.iter().map(parse_song).collect()))
}

// ---------------------------------------------------------------------------
// Artist catalogue
// ---------------------------------------------------------------------------

/// One page of an artist's songs. Page 0 is the popular set the artist screen
/// opens on; `p` walks the rest of the catalogue behind it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ArtistSongPage {
    pub tracks: Vec<Track>,
    /// Upstream answered with rows at all. The screen hangs "load more" off it
    /// and stops for good once a page brings back nothing new.
    pub page_full: bool,
}

/// One row of an artist's discography: the card the screen already renders,
/// plus which shelf it came from so the filter chips can split the two.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ArtistRelease {
    #[serde(flatten)]
    pub item: FeedItem,
    /// "album" for LPs/EPs, "single" for the singles shelf.
    pub kind: String,
}

/// Header data the artist screen shows above the tracks.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ArtistOverview {
    pub name: String,
    pub image: String,
    /// `fan_count` - the number printed under the artist's name.
    pub listeners: u64,
    pub verified: bool,
    /// First paragraph of the upstream biography, flattened to plain text.
    pub bio: String,
    /// Albums, singles and EPs; every row resolves through its `token`.
    pub releases: Vec<ArtistRelease>,
}

/// One `webapi.get` page of an artist's catalogue.
///
/// `n_song`/`n_album` size the two lists and `p` walks them. Upstream hands
/// back only 7 songs when neither is set, which is exactly where the artist
/// screen used to stop.
async fn artist_page(
    client: &reqwest::Client,
    token: &str,
    page: u32,
    n_song: u32,
    n_album: u32,
    sub_type: &str,
) -> Result<Value, String> {
    check_id(token)?;
    let p = page.to_string();
    let songs = n_song.to_string();
    let albums = n_album.to_string();
    call(
        client,
        &[
            ("__call", "webapi.get"),
            ("token", token),
            ("type", "artist"),
            ("p", &p),
            ("n", ""),
            ("n_song", &songs),
            ("n_album", &albums),
            ("sub_type", sub_type),
            ("category", ""),
            ("sort_order", ""),
            ("includeMetaTags", "0"),
            ("ctx", "web6dot0"),
            ("api_version", "4"),
            ("_format", "json"),
            ("_marker", "0"),
        ],
    )
    .await
}

/// One page of an artist's songs, deduped. `page` is 0-based.
pub async fn artist_tracks(
    client: &reqwest::Client,
    token: &str,
    page: u32,
) -> Result<ArtistSongPage, String> {
    let value = artist_page(client, token, page, ARTIST_PAGE_SIZE, 0, "songs").await?;
    let songs = value
        .get("topSongs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(ArtistSongPage {
        page_full: !songs.is_empty(),
        tracks: dedup_tracks(songs.iter().map(parse_song).collect()),
    })
}

/// The artist header plus every release the catalog ties to them, newest
/// year first, each release once.
pub async fn artist_overview(
    client: &reqwest::Client,
    token: &str,
) -> Result<ArtistOverview, String> {
    let value = artist_page(client, token, 0, 0, ARTIST_RELEASES, "").await?;
    // The two shelves upstream keeps: LPs/EPs and the singles list.
    let shelves: [(&str, &str); 3] = [
        ("topAlbums", "album"),
        ("latest_release", "album"),
        ("singles", "single"),
    ];
    let mut releases = Vec::new();
    for (key, kind) in shelves {
        for row in value
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(item) = feed_item(row) {
                releases.push(ArtistRelease {
                    item,
                    kind: kind.to_string(),
                });
            }
        }
    }
    // Undated rows sink to the bottom instead of floating to the top.
    releases.sort_by_key(|r| std::cmp::Reverse(r.item.year.parse::<u32>().unwrap_or(0)));
    let mut seen = std::collections::HashSet::new();
    releases.retain(|r| seen.insert(r.item.id.clone()));
    Ok(ArtistOverview {
        name: text(&value, "name").unwrap_or_default(),
        image: image_url(&value["image"]),
        listeners: num_any(&value, "fan_count").unwrap_or(0.0).max(0.0) as u64,
        verified: flag(&value, "isVerified").unwrap_or(false),
        bio: artist_bio(&value["bio"]),
        releases,
    })
}

/// The biography ships as a JSON string of paragraphs; only the first one is
/// ever shown, and only as flat text (the payload carries line breaks).
fn artist_bio(v: &Value) -> String {
    let parsed = match v {
        Value::String(s) => serde_json::from_str::<Value>(s).ok(),
        other => Some(other.clone()),
    };
    parsed
        .as_ref()
        .and_then(Value::as_array)
        .and_then(|rows| rows.first())
        .and_then(|row| text(row, "text"))
        .map(|raw| html_unescape(&raw))
        .map(|raw| raw.split_whitespace().collect::<Vec<_>>().join(" "))
        .unwrap_or_default()
}

/// Every song of a playlist / chart, in order.
pub async fn playlist_tracks(client: &reqwest::Client, id: &str) -> Result<Vec<Track>, String> {
    check_id(id)?;
    let value = call(
        client,
        &[
            ("__call", "playlist.getDetails"),
            ("listid", id),
            ("type", "song"),
            ("_format", "json"),
            ("_marker", "0"),
        ],
    )
    .await?;
    let songs = value
        .get("songs")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("playlist has no songs: {id}"))?;
    Ok(dedup_tracks(songs.iter().map(parse_song).collect()))
}

// ---------------------------------------------------------------------------
// Lyrics
// ---------------------------------------------------------------------------

/// Plain lyrics from `lyrics.getLyrics`: the same `api.php` entry point the
/// web player uses, so no extra host and no key.
///
/// Line breaks arrive as `<br>`; they are converted here so every caller can
/// hand the text straight to `textContent`.
pub async fn lyrics(
    client: &reqwest::Client,
    id: &str,
) -> Result<Option<(String, Option<String>)>, String> {
    check_id(id)?;
    let value = call(
        client,
        &[
            ("__call", "lyrics.getLyrics"),
            ("lyrics_id", id),
            ("ctx", "web6dot0"),
            ("api_version", "4"),
            ("_format", "json"),
            ("_marker", "0"),
        ],
    )
    .await?;

    let body = match value.get("lyrics").and_then(Value::as_str) {
        Some(s) if !s.trim().is_empty() => s,
        // `{"lyrics": null}` / empty string â€” this song has no lyrics here.
        _ => return Ok(None),
    };
    let copyright = value
        .get("lyrics_copyright")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    Ok(Some((br_to_newline(&html_unescape(body)), copyright)))
}

/// JioSaavn separates lines with `<br>` in every casing/spacing variant.
fn br_to_newline(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let is_br = rest
            .get(..4)
            .map(|t| t.eq_ignore_ascii_case("<br>"))
            .unwrap_or(false);
        let is_br_tag = rest
            .get(..4)
            .map(|t| t.eq_ignore_ascii_case("<br "))
            .unwrap_or(false);
        if is_br {
            out.push('\n');
            rest = &rest[4..];
        } else if is_br_tag {
            match rest.find('>') {
                Some(j) => {
                    out.push('\n');
                    rest = &rest[j + 1..];
                }
                None => break,
            }
        } else {
            out.push('<');
            rest = &rest[1..];
        }
    }
    out.push_str(rest);
    out
}

// ---------------------------------------------------------------------------
// Radio (endless playback)
// ---------------------------------------------------------------------------

/// One answer from the radio: the station id to keep calling with, plus the
/// batch of songs it just handed over.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RadioPage {
    pub station: String,
    pub tracks: Vec<Track>,
}

/// Songs per radio batch — upstream's own default.
const RADIO_BATCH: u32 = 10;

/// Seed a station from one song id (`webradio.createEntityStation`).
async fn create_station(client: &reqwest::Client, song_id: &str) -> Result<String, String> {
    check_id(song_id)?;
    let entity = format!("[\"{song_id}\"]");
    let value = call(
        client,
        &[
            ("__call", "webradio.createEntityStation"),
            ("api_version", "4"),
            ("_format", "json"),
            ("_marker", "0"),
            ("ctx", "android"),
            ("entity_id", &entity),
            ("entity_type", "queue"),
        ],
    )
    .await?;
    text(&value, "stationid").ok_or_else(|| "radio: no station id".to_string())
}

/// The next batch for a station (`webradio.getSong`). Upstream keeps its own
/// cursor — repeating the call yields new songs, so there is no page number.
async fn station_songs(
    client: &reqwest::Client,
    station: &str,
    k: u32,
) -> Result<Vec<Track>, String> {
    let limit = k.to_string();
    let value = call(
        client,
        &[
            ("__call", "webradio.getSong"),
            ("api_version", "4"),
            ("_format", "json"),
            ("_marker", "0"),
            ("ctx", "android"),
            ("stationid", station),
            ("k", &limit),
        ],
    )
    .await?;
    Ok(songs_from_value(&value))
}

/// Pure half of `station_songs`: the observed keyed map
/// `{"0":{"song":{...}}, ..., "stationid": "..."}` (neighbour values fall out
/// via the `song` probe), tolerating a plain array as well.
fn songs_from_value(value: &Value) -> Vec<Track> {
    let raw: Vec<&Value> = match value {
        Value::Array(items) => items.iter().filter(|v| v.is_object()).collect(),
        Value::Object(map) => map.values().filter_map(|v| v.get("song")).collect(),
        _ => Vec::new(),
    };
    dedup_tracks(
        raw.into_iter()
            .map(parse_song)
            .filter(|t| !t.id.is_empty())
            .collect(),
    )
}

/// Endless playback's feed: continue `station` when we still have one, else
/// seed a new one from `song`. Drained/exhausted stations re-seed instead of
/// failing — the frontend carries its own last-resort fallbacks.
pub async fn recommend(
    client: &reqwest::Client,
    song: Option<&str>,
    station: Option<&str>,
) -> Result<RadioPage, String> {
    if let Some(sid) = station.map(str::trim).filter(|s| !s.is_empty()) {
        if let Ok(tracks) = station_songs(client, sid, RADIO_BATCH).await {
            if !tracks.is_empty() {
                return Ok(RadioPage {
                    station: sid.to_string(),
                    tracks,
                });
            }
        }
    }
    let seed = song
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "radio: no station and no seed song".to_string())?;
    let sid = create_station(client, seed).await?;
    let tracks = station_songs(client, &sid, RADIO_BATCH).await?;
    Ok(RadioPage {
        station: sid,
        tracks,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured from `song.getDetails` for `aRZbUYD7` â€” the vector that
    /// pins the DES key, the base64 alphabet and the PKCS#7 unpad.
    const ENCRYPTED: &str = "ID2ieOjCrwfgWvL5sXl4B1ImC5QfbsDySan+n+AW12BvOaQj7cuGfg8Ed085rYUtqDj8DQY3nIMQdr42ScGdtRw7tS9a8Gtq";
    const DECRYPTED: &str = "https://aac.saavncdn.com/450/f467e05e2825cec2203546333e0d0550_96.mp4";

    #[test]
    fn decrypts_media_url_to_a_cdn_asset() {
        assert_eq!(decrypt_media_url(ENCRYPTED).unwrap(), DECRYPTED);
    }

    #[test]
    fn decrypt_rejects_malformed_input() {
        assert!(decrypt_media_url("not base64 !!!").is_err());
        assert!(decrypt_media_url("").is_err());
        // Valid base64 that is not a multiple of the 8 byte DES block.
        assert!(decrypt_media_url("AAAAAAA").is_err());
        // Right shape, wrong key material: padding check must fail.
        assert!(decrypt_media_url("AAAAAAAAAAAAAAAA").is_err());
    }

    #[test]
    fn renditions_cover_the_five_cdn_bitrates() {
        let qs = renditions(DECRYPTED);
        let labels: Vec<&str> = qs.iter().map(|q| q.quality.as_str()).collect();
        assert_eq!(labels, ["12kbps", "48kbps", "96kbps", "160kbps", "320kbps"]);
        assert!(qs.iter().all(|q| q.url.ends_with(".mp4")));
        assert!(qs
            .iter()
            .all(|q| q.url.starts_with("https://aac.saavncdn.com/450/")));
        assert_eq!(
            qs.last().unwrap().url,
            "https://aac.saavncdn.com/450/f467e05e2825cec2203546333e0d0550_320.mp4"
        );
    }

    #[test]
    fn parse_song_reads_official_field_names_and_unescapes() {
        let v: Value = serde_json::from_str(
            r#"{
              "id": "abc123",
              "song": "Tum Hi Ho (From &quot;Aashiqui 2&quot;)",
              "album": "Aashiqui 2",
              "primary_artists": "Mithoon, Arijit Singh",
              "duration": "262",
              "play_count": "1234567",
              "320kbps": "true",
              "image": "https://c.saavncdn.com/450/x-150x150.jpg",
              "perma_url": "https://www.jiosaavn.com/song/x"
            }"#,
        )
        .unwrap();
        let t = parse_song(&v);
        assert_eq!(t.id, "abc123");
        assert_eq!(t.title, "Tum Hi Ho (From \"Aashiqui 2\")");
        assert_eq!(t.artist, "Mithoon, Arijit Singh");
        assert_eq!(t.album, "Aashiqui 2");
        assert_eq!(t.duration, "4:22");
        assert_eq!(t.duration_secs, 262);
        assert_eq!(t.plays, 1_234_567);
        assert!(t.hq);
        assert_eq!(t.image, "https://c.saavncdn.com/450/x-500x500.jpg");
    }

    #[test]
    fn parse_song_tolerates_missing_fields() {
        let v: Value = serde_json::from_str(r#"{"id": "x", "song": null}"#).unwrap();
        let t = parse_song(&v);
        assert_eq!(t.id, "x");
        assert_eq!(t.title, "");
        assert_eq!(t.duration_secs, 0);
        assert!(!t.hq);
        assert_eq!(t.plays, 0);
    }

    /// `webapi.get` album/artist items nest duration, album and the 320
    /// flag under `more_info` â€” the shape the detail screens resolve.
    #[test]
    fn parse_song_reads_webapi_get_nested_fields() {
        let v: Value = serde_json::from_str(
            r#"{
              "id": "Yw_FPwcp",
              "title": "Samjho Na",
              "subtitle": "Tanishk Bagchi - The Vvaan",
              "image": "https://c.saavncdn.com/765/x-150x150.jpg",
              "play_count": "537010",
              "more_info": {
                "duration": "253",
                "album": "The Vvaan",
                "320kbps": "true"
              }
            }"#,
        )
        .unwrap();
        let t = parse_song(&v);
        assert_eq!(t.title, "Samjho Na");
        assert_eq!(t.artist, "Tanishk Bagchi - The Vvaan");
        assert_eq!(t.duration_secs, 253);
        assert_eq!(t.album, "The Vvaan");
        assert!(t.hq);
        assert_eq!(t.image, "https://c.saavncdn.com/765/x-500x500.jpg");
    }

    /// Radio batches keep the artist credit only under `more_info.music` and
    /// nest duration/album/320 there — the shape endless playback parses.
    #[test]
    fn parse_song_reads_radio_credits_from_more_info() {
        let v: Value = serde_json::from_str(
            r#"{
              "id": "W4v72VOw",
              "title": "Krishna Trance",
              "subtitle": "",
              "image": "https://c.saavncdn.com/765/x-150x150.jpg",
              "more_info": {
                "music": "Kaala Bhairava",
                "duration": "420",
                "album": "Trance One",
                "320kbps": true
              }
            }"#,
        )
        .unwrap();
        let t = parse_song(&v);
        assert_eq!(t.artist, "Kaala Bhairava");
        assert_eq!(t.album, "Trance One");
        assert_eq!(t.duration_secs, 420);
        assert!(t.hq);
    }

    // ---- Radio (endless playback) ----

    /// `webradio.getSong` answers a keyed map: every value carries its song
    /// under `song`, and `stationid` sits beside them (no `song` → skipped).
    #[test]
    fn radio_songs_parse_the_keyed_map_and_skip_neighbours() {
        let v: Value = serde_json::from_str(
            r#"{
              "0": {"song": {"id": "a1", "title": "One", "more_info": {"music": "Artist A", "duration": "100"}}},
              "1": {"song": {"id": "b2", "title": "Two", "more_info": {"music": "Artist B", "duration": "200"}}},
              "2": {"song": {"id": "a1", "title": "One", "more_info": {"music": "Artist A", "duration": "100"}}},
              "stationid": "STATION-ID"
            }"#,
        )
        .unwrap();
        let tracks = songs_from_value(&v);
        assert_eq!(tracks.len(), 2, "the stationid neighbour and the dup drop");
        assert_eq!(tracks[0].id, "a1");
        assert_eq!(tracks[0].artist, "Artist A");
        assert_eq!(tracks[1].id, "b2");
    }

    #[test]
    fn radio_songs_tolerate_a_plain_array() {
        let v: Value = serde_json::from_str(
            r#"[{"id": "z9", "title": "Solo", "more_info": {"music": "M", "duration": "60"}},
                 {"title": "no id"}]"#,
        )
        .unwrap();
        let tracks = songs_from_value(&v);
        assert_eq!(tracks.len(), 1, "id-less rows are dropped");
        assert_eq!(tracks[0].id, "z9");
        assert_eq!(tracks[0].duration, "1:00");
    }

    /// The live flow endless playback leans on: seed a station from a real
    /// search hit, read its first batch. Skipped when `OP_OFFLINE` is set.
    #[tokio::test]
    async fn live_radio_station_yields_songs() {
        if std::env::var("OP_OFFLINE").is_ok() {
            return;
        }
        let client = crate::jiosaavn::api_client();
        let hits = search(&client, "trance", 5, 1).await.expect("search");
        let seed = hits.first().expect("a seed song").id.clone();
        let page = recommend(&client, Some(&seed), None).await.expect("radio");
        assert!(!page.station.is_empty(), "a station id comes back");
        assert!(!page.tracks.is_empty(), "the first batch carries songs");
        assert!(
            page.tracks
                .iter()
                .all(|t| !t.id.is_empty() && !t.title.is_empty()),
            "every radio row is a playable song"
        );
    }

    // ---- Home feed ----

    #[test]
    fn feed_list_keeps_only_playlists_and_reads_counts() {
        let v: Value = serde_json::from_str(
            r#"{
              "top_playlists": [
                {"id": "1302033575", "title": "Romantic Hits 2026 - Hindi",
                 "subtitle": "2.1K Followers", "type": "playlist",
                 "image": "https://c.saavncdn.com/x.jpg",
                 "more_info": {"song_count": "20"}},
                {"id": "9", "title": "Not A Playlist", "type": "song"}
              ],
              "charts": [
                {"id": "1134543272", "title": "Hindi: India Superhits Top 50",
                 "type": "playlist", "image": "https://c.saavncdn.com/c.jpg", "count": 50}
              ]
            }"#,
        )
        .unwrap();

        let playlists = feed_list(&v["top_playlists"], "playlist");
        assert_eq!(playlists.len(), 1, "song entries must be filtered out");
        assert_eq!(playlists[0].id, "1302033575");
        assert_eq!(
            playlists[0].count, 20,
            "count comes from more_info.song_count"
        );

        let charts = feed_list(&v["charts"], "playlist");
        assert_eq!(charts[0].count, 50, "charts declare count at the top level");
        assert!(feed_list(&v["missing"], "playlist").is_empty());
    }

    /// Launch data repeats cards across (and within) its arrays; the UI must
    /// show each id once, first occurrence wins.
    #[test]
    fn dedup_feed_keeps_the_first_copy_of_each_id() {
        let card = |id: &str, title: &str| FeedItem {
            id: id.into(),
            title: title.into(),
            subtitle: String::new(),
            image: String::new(),
            count: 0,
            year: String::new(),
            token: String::new(),
        };
        let out = dedup_feed(vec![
            card("1", "First"),
            card("2", "Second"),
            card("1", "Repeat Of First"),
            card("3", "Third"),
            card("2", "Repeat Of Second"),
        ]);
        let ids: Vec<&str> = out.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["1", "2", "3"]);
        assert_eq!(out[0].title, "First", "first occurrence wins");
    }

    /// Home cards used to render the launch data's 150px thumb verbatim.
    #[test]
    fn feed_item_upgrades_150px_artwork_to_the_500_master() {
        let v: Value = serde_json::from_str(
            r#"{
              "id": "1302033575",
              "title": "Romantic Hits 2026 - Hindi",
              "subtitle": "2.1K Followers",
              "type": "album",
              "image": "http://c.saavncdn.com/765/x-150x150.jpg"
            }"#,
        )
        .unwrap();
        let item = feed_item(&v).expect("item parses");
        assert_eq!(
            item.image, "https://c.saavncdn.com/765/x-500x500.jpg",
            "feed artwork must be the 500px master over https"
        );

        let array: Value = serde_json::from_str(
            r#"{
              "id": "1", "title": "T", "type": "album",
              "image": [
                {"quality": "150x150", "url": "https://c.saavncdn.com/a-150x150.jpg"},
                {"quality": "500x500", "url": "https://c.saavncdn.com/a-500x500.jpg"}
              ]
            }"#,
        )
        .unwrap();
        assert_eq!(
            feed_item(&array).expect("item parses").image,
            "https://c.saavncdn.com/a-500x500.jpg"
        );
    }

    // ---- Entity search ----

    /// The three entity rows carry different field names; each must map to
    /// the card shape without borrowing another kind's leftovers.
    #[test]
    fn entity_item_reads_each_kind_fields() {
        let album: Value = serde_json::from_str(
            r#"{
              "albumid": "1139549", "text": "Aashiqui 2", "title": "Aashiqui 2",
              "primary_artists": "Jeet Gannguli, Mithoon",
              "image": "https://c.saavncdn.com/430/Aashiqui-2-Hindi-2013-150x150.jpg",
              "perma_url": "https://www.jiosaavn.com/album/aashiqui-2/-iNdCmFNV9o_"
            }"#,
        )
        .unwrap();
        let a = entity_item("album", &album).expect("album parses");
        assert_eq!(a.id, "1139549");
        assert_eq!(a.title, "Aashiqui 2");
        assert_eq!(a.subtitle, "Jeet Gannguli, Mithoon");
        assert_eq!(a.token, "-iNdCmFNV9o_", "token is the perma_url tail");
        assert_eq!(
            a.image,
            "https://c.saavncdn.com/430/Aashiqui-2-Hindi-2013-500x500.jpg"
        );
        assert_eq!(a.count, 0, "albums report no count here");

        let artist: Value = serde_json::from_str(
            r#"{
              "id": "459320", "name": "Arijit Singh",
              "perma_url": "https://www.jiosaavn.com/artist/arijit-singh-songs/LlRWpHzy3Hk_"
            }"#,
        )
        .unwrap();
        let b = entity_item("artist", &artist).expect("artist parses");
        assert_eq!(b.id, "459320");
        assert_eq!(b.title, "Arijit Singh");
        assert!(b.subtitle.is_empty(), "ddCard falls back to its own label");
        assert_eq!(b.token, "LlRWpHzy3Hk_");

        let playlist: Value = serde_json::from_str(
            r#"{
              "listid": "1144298963", "listname": "Bholenath Trance",
              "firstname": "JioSaavn", "lastname": "Editor",
              "count": "41",
              "image": "https://c.saavncdn.com/editorial/BholenathTrance_20260731064000_150x150.jpg",
              "perma_url": "https://www.jiosaavn.com/featured/bholenath-trance/lRkkVXBvW549QYQLs6kZbg__"
            }"#,
        )
        .unwrap();
        let c = entity_item("playlist", &playlist).expect("playlist parses");
        assert_eq!(c.id, "1144298963", "playlists open by listid, not token");
        assert_eq!(c.title, "Bholenath Trance");
        assert_eq!(c.subtitle, "JioSaavn Editor");
        assert_eq!(c.count, 41, "string counts parse");
    }

    /// A row missing its identity must be skipped, not rendered as a blank card.
    #[test]
    fn entity_item_skips_rows_without_ids() {
        let v: Value = serde_json::from_str(r#"{"text": "Orphan"}"#).unwrap();
        assert!(entity_item("album", &v).is_none());
        let v: Value = serde_json::from_str(r#"{"id": "459320"}"#).unwrap();
        assert!(
            entity_item("artist", &v).is_none(),
            "a name is required too"
        );
    }

    /// The frontend reads `payload.items` / `payload.page_full` and each card's
    /// `id`/`title`/`subtitle`/`image`/`token` â€” a rename here silently blanks
    /// the grid, so pin the wire names.
    #[test]
    fn entity_page_serializes_the_field_names_the_ui_reads() {
        let page = EntityPage {
            items: vec![FeedItem {
                id: "1139549".into(),
                title: "Aashiqui 2".into(),
                subtitle: "Mithoon".into(),
                image: "https://c.saavncdn.com/x-500x500.jpg".into(),
                count: 0,
                year: String::new(),
                token: "-iNdCmFNV9o_".into(),
            }],
            page_full: true,
        };
        let v = serde_json::to_value(page).unwrap();
        assert_eq!(v["page_full"], true);
        let item = &v["items"][0];
        for key in ["id", "title", "subtitle", "image", "count", "token"] {
            assert!(item.get(key).is_some(), "card is missing `{key}`");
        }
    }

    /// A real `autocomplete.get` body, trimmed: every section must land in the
    /// right bucket, with the token pulled out of `url` and the song credit
    /// out of `more_info`.
    #[test]
    fn suggestions_read_every_section_of_an_autocomplete_body() {
        let body: Value = serde_json::from_str(
            r#"{
              "topquery": {"data": [{"id": "459320", "title": "Arijit Singh", "type": "artist",
                "image": "https://c.saavncdn.com/artists/x-500x500.jpg",
                "url": "https://www.jiosaavn.com/artist/arijit-singh-songs/LlRWpHzy3Hk_"}]},
              "songs": {"data": [
                {"id": "YiVML4Zo", "title": "Gehra Hua", "type": "song",
                 "image": "https://c.saavncdn.com/450/x-500x500.jpg",
                 "url": "https://www.jiosaavn.com/song/gehra-hua/KQE9fDgEbVw",
                 "more_info": {"primary_artists": "Shashwat Sachdev, Arijit Singh",
                               "singers": "Arijit Singh"}},
                {"id": "1gHtmQ3x", "title": "Gehra Hua (Reprise)", "type": "song",
                 "image": "https://c.saavncdn.com/475/x-500x500.jpg",
                 "url": "https://www.jiosaavn.com/song/gehra-hua-reprise/QQ8jRRlhBEs",
                 "more_info": {"singers": "Arijit Singh"}}]},
              "albums": {"data": [{"id": "1139549", "title": "Aashiqui 2", "type": "album",
                "image": "https://c.saavncdn.com/430/x-500x500.jpg", "music": "Mithoon",
                "url": "https://www.jiosaavn.com/album/aashiqui-2/-iNdCmFNV9o_"}]},
              "artists": {"data": [{"id": "1742694", "title": "Arijit", "type": "artist",
                "image": "https://www.jiosaavn.com/_i/3.0/artist-default.png",
                "url": "https://www.jiosaavn.com/artist/arijit-songs/FS8splHT06A_"}]},
              "playlists": {"data": [{"id": "802336660", "title": "Arijit Singh - Sad Songs", "type": "playlist",
                "image": "https://c.saavncdn.com/editorial/x-500x500.jpg", "extra": "Saavn",
                "url": "https://www.jiosaavn.com/featured/arijit-singh-sad-songs-hindi/8RkefqkCO1huOxiEGmm6lQ__"}]}
            }"#,
        )
        .unwrap();
        let s = suggestions_from_value(&body).unwrap();
        let top = s.top.expect("top query");
        assert_eq!(top.id, "459320");
        assert_eq!(top.token, "LlRWpHzy3Hk_");
        assert_eq!(s.top_kind.as_deref(), Some("artist"));

        assert_eq!(s.songs.len(), 2);
        assert_eq!(s.songs[0].id, "YiVML4Zo");
        assert_eq!(s.songs[0].subtitle, "Shashwat Sachdev, Arijit Singh");
        assert_eq!(s.songs[0].token, "KQE9fDgEbVw");
        // No `primary_artists` â†’ `singers` is the credit of record.
        assert_eq!(s.songs[1].subtitle, "Arijit Singh");

        assert_eq!(s.albums.len(), 1);
        assert_eq!(s.albums[0].subtitle, "Mithoon");
        assert_eq!(s.albums[0].token, "-iNdCmFNV9o_");
        assert_eq!(s.artists.len(), 1);
        assert_eq!(s.artists[0].id, "1742694");
        assert_eq!(s.playlists.len(), 1);
        assert_eq!(s.playlists[0].subtitle, "Saavn");
    }

    /// Rows without an id or title must be skipped, not rendered blank.
    #[test]
    fn suggestions_skip_orphan_rows() {
        let body: Value = serde_json::from_str(
            r#"{"songs": {"data": [{"title": "No id"}, {"id": "x", "title": ""}]},
               "topquery": {"data": []}}"#,
        )
        .unwrap();
        let s = suggestions_from_value(&body).unwrap();
        assert!(s.songs.is_empty());
        assert!(s.top.is_none());
    }

    /// The dropdown reads `top`/`top_kind`/`songs`/`albums`/`artists`/
    /// `playlists` â€” pin the wire names.
    #[test]
    fn suggestions_serialize_the_field_names_the_dropdown_reads() {
        let s = Suggestions {
            top: Some(FeedItem {
                id: "459320".into(),
                title: "Arijit Singh".into(),
                subtitle: String::new(),
                image: String::new(),
                count: 0,
                year: String::new(),
                token: "LlRWpHzy3Hk_".into(),
            }),
            top_kind: Some("artist".into()),
            songs: vec![],
            albums: vec![],
            artists: vec![],
            playlists: vec![],
        };
        let v = serde_json::to_value(s).unwrap();
        assert_eq!(v["top"]["id"], "459320");
        assert_eq!(v["top_kind"], "artist");
        for key in ["songs", "albums", "artists", "playlists"] {
            assert!(
                v.get(key).and_then(Value::as_array).is_some(),
                "missing {key}"
            );
        }
    }

    /// The discography card and its filter chip read `id`/`title`/`year`/
    /// `token` next to `kind` - flatten keeps the card fields at the top level.
    #[test]
    fn artist_releases_flatten_the_card_fields_and_carry_kind() {
        let release = ArtistRelease {
            item: FeedItem {
                id: "100000".into(),
                title: "Aashiqui 2".into(),
                subtitle: "Arijit Singh".into(),
                image: String::new(),
                count: 5,
                year: "2025".into(),
                token: "tok".into(),
            },
            kind: "single".into(),
        };
        let v = serde_json::to_value(release).unwrap();
        assert_eq!(v["id"], "100000");
        assert_eq!(v["title"], "Aashiqui 2");
        assert_eq!(v["year"], "2025");
        assert_eq!(v["token"], "tok");
        assert_eq!(v["kind"], "single");
        assert!(
            v.get("item").is_none(),
            "card fields must not nest under item"
        );
    }

    // ---- Live contract tests (require network) ----

    #[tokio::test]
    async fn live_search_pages_are_disjoint_and_unbounded() {
        if std::env::var("OP_OFFLINE").is_ok() {
            return;
        }
        let client = crate::jiosaavn::api_client();
        let first = search(&client, "arijit", 10, 1).await.expect("page 1");
        let second = search(&client, "arijit", 10, 2).await.expect("page 2");
        assert_eq!(first.len(), 10);
        assert_eq!(second.len(), 10);
        let seen: std::collections::HashSet<&str> = first.iter().map(|t| t.id.as_str()).collect();
        assert!(
            second.iter().all(|t| !seen.contains(t.id.as_str())),
            "page 2 must advance, not repeat page 1"
        );
        assert!(
            first.iter().any(|t| t.hq),
            "official results carry 320 kbps flags"
        );
        assert!(
            first.iter().any(|t| t.plays > 0),
            "official results carry play counts"
        );
    }

    /// The three entity searches must page independently and hand the UI a
    /// `page_full` it can trust (measured from `total`, not from deduped rows).
    #[tokio::test]
    async fn live_entity_search_pages_advance_per_kind() {
        if std::env::var("OP_OFFLINE").is_ok() {
            return;
        }
        let client = crate::jiosaavn::api_client();
        for (kind, _) in ENTITY_OPS {
            let p1 = search_entities(&client, kind, "arijit", 10, 1)
                .await
                .unwrap_or_else(|e| panic!("{kind} page 1: {e}"));
            assert!(!p1.items.is_empty(), "{kind} page 1 returns rows");
            assert!(p1.page_full, "{kind} has more than 10 rows for arijit");

            let p2 = search_entities(&client, kind, "arijit", 10, 2)
                .await
                .unwrap_or_else(|e| panic!("{kind} page 2: {e}"));
            let seen: std::collections::HashSet<&str> =
                p1.items.iter().map(|i| i.id.as_str()).collect();
            assert!(
                p2.items.iter().all(|i| !seen.contains(i.id.as_str())),
                "{kind} page 2 must advance, not repeat page 1"
            );
            if *kind == "playlist" {
                assert!(p1.items[0].count > 0, "playlists carry a track count");
            } else {
                assert!(
                    p1.items.iter().all(|i| !i.token.is_empty()),
                    "{kind} rows resolve through their perma_url token"
                );
            }
        }

        let unknown = search_entities(&client, "movie", "arijit", 10, 1).await;
        assert!(unknown.is_err(), "unknown kinds are rejected, not guessed");
    }

    #[tokio::test]
    async fn live_home_feed_carries_playlists_and_chart_tracks() {
        if std::env::var("OP_OFFLINE").is_ok() {
            return;
        }
        let client = crate::jiosaavn::api_client();
        let feed = home(&client).await.expect("home feed");
        assert!(feed.playlists.len() >= 5, "enough for one carousel page");
        assert!(!feed.charts.is_empty());
        assert!(
            feed.albums.len() >= 4 && feed.albums.iter().all(|a| !a.token.is_empty()),
            "albums carry resolve tokens"
        );
        assert!(feed.artists.len() >= 3, "artist row for Home");
        assert_eq!(feed.top_tracks.len(), 5, "countdown needs five rows");
        assert!(!feed.top_tracks[0].title.is_empty());
        // Nothing the Home screen renders may still point at a 150px thumb.
        let tiny = |s: &str| s.contains("150x150") || s.contains("50x50");
        let https = |s: &str| s.starts_with("https://");
        for item in feed
            .albums
            .iter()
            .chain(feed.artists.iter())
            .chain(feed.playlists.iter())
            .chain(feed.spotlight.iter())
        {
            assert!(!tiny(&item.image), "stale thumb: {}", item.image);
            assert!(https(&item.image), "insecure artwork: {}", item.image);
        }
        for t in &feed.top_tracks {
            assert!(!tiny(&t.image), "stale thumb: {}", t.image);
            assert!(https(&t.image), "insecure artwork: {}", t.image);
        }
        let tracks = playlist_tracks(&client, &feed.chart_id)
            .await
            .expect("chart");
        assert!(tracks.len() >= 5);
    }

    #[tokio::test]
    async fn live_album_and_artist_tokens_yield_playable_tracks() {
        if std::env::var("OP_OFFLINE").is_ok() {
            return;
        }
        let client = crate::jiosaavn::api_client();
        // Tokens captured from perma_url: an album and an artist page.
        let album = album_tracks(&client, "izWEkFlheoQ_")
            .await
            .expect("album tracks");
        assert!(!album.is_empty(), "album must yield its songs");
        assert!(album.iter().all(|t| t.duration_secs > 0), "durations parse");
        let artist = artist_tracks(&client, "634AK8t6tAU_", 0)
            .await
            .expect("artist tracks");
        assert!(
            !artist.tracks.is_empty(),
            "artist page 0 must yield its songs"
        );
        // Page 0 is capped at ARTIST_PAGE_SIZE rows, so a full answer means
        // the rest of the catalogue is still walkable.
        let more = artist_tracks(&client, "634AK8t6tAU_", 1)
            .await
            .expect("artist page 1");
        if artist.page_full {
            assert!(
                more.page_full || !more.tracks.is_empty(),
                "a full page 0 implies page 1 has something"
            );
        }
        let overview = artist_overview(&client, "634AK8t6tAU_")
            .await
            .expect("artist overview");
        assert!(!overview.name.is_empty(), "header carries the artist name");
        assert!(
            !overview.releases.is_empty(),
            "discography must list the releases"
        );
        assert!(
            overview.releases.iter().all(|r| !r.item.token.is_empty()),
            "every release resolves through its token"
        );
        assert!(
            overview
                .releases
                .iter()
                .all(|r| r.kind == "album" || r.kind == "single"),
            "every release sits on a shelf the chips can filter"
        );
    }

    #[tokio::test]
    async fn live_resolve_yields_all_renditions_of_the_full_file() {
        if std::env::var("OP_OFFLINE").is_ok() {
            return;
        }
        let client = crate::jiosaavn::api_client();
        let tracks = search(&client, "tum hi ho", 1, 1).await.expect("search");
        let song = fetch_song(&client, &tracks[0].id).await.expect("resolve");
        assert_eq!(
            song.qualities.len(),
            5,
            "every rendition must be synthesised"
        );
        let chosen = crate::jiosaavn::best_quality(&song.qualities, "320kbps").unwrap();
        assert!(chosen.url.ends_with("_320.mp4"), "full file, not a preview");
        let probe = crate::jiosaavn::qualify_url(&client, &chosen.url)
            .await
            .expect("probe");
        assert_eq!(
            probe.range_status,
            crate::jiosaavn::RangeStatus::Unrestricted
        );
        assert!(
            probe.content_length.unwrap_or(0) > 1_000_000,
            "a whole song is megabytes, not kilobytes"
        );
    }

    /// The dropdown's source: `autocomplete.get` must answer with a top match
    /// and at least the song section for a real query.
    #[tokio::test]
    async fn live_autocomplete_returns_a_top_match_and_songs() {
        if std::env::var("OP_OFFLINE").is_ok() {
            return;
        }
        let client = crate::jiosaavn::api_client();
        let s = suggestions(&client, "arijit").await.expect("autocomplete");
        assert!(s.top.is_some(), "top query is the dropdown's headline");
        assert!(!s.songs.is_empty(), "song suggestions must be offered");
        assert!(
            s.songs
                .iter()
                .all(|it| !it.id.is_empty() && !it.title.is_empty()),
            "every suggestion carries an id and a title"
        );
    }
}
