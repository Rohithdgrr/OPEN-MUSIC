//! First-party JioSaavn adapter — `www.jiosaavn.com/api.php`.
//!
//! This is the API JioSaavn's own web player calls, so it is the primary
//! catalog source: no community-mirror rate limit, real pagination (`n`/`p`)
//! and a media url for every song. Mirrors (`jiosaavn.rs`) are the fallback.
//!
//! Media urls arrive as `encrypted_media_url`: base64 over DES-ECB with an
//! 8-byte key. Decrypting yields the CDN asset of the 96 kbps rendition, from
//! which the other four renditions are derived by suffix swap — so every song
//! resolves to the complete file, not a preview.
//!
//! Must NOT know anything about HTTP servers (that is `proxy.rs`'s job).

use base64::Engine;
use serde::Serialize;
use serde_json::Value;

use crate::jiosaavn::{
    best_image, check_id, fmt_duration, html_unescape, num_any, text, QualityUrl, Song, Track,
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
    let value: Value =
        serde_json::from_str(&body).map_err(|e| format!("decode {url}: {e}"))?;
    if let Some(err) = value.get("error") {
        let msg = err
            .get("msg")
            .and_then(Value::as_str)
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
    let cipher =
        des::Des::new_from_slice(MEDIA_KEY).map_err(|e| format!("des key: {e}"))?;

    let mut out = Vec::with_capacity(raw.len());
    for block in raw.chunks_exact(8) {
        let mut b = des::cipher::generic_array::GenericArray::clone_from_slice(block);
        cipher.decrypt_block(&mut b);
        out.extend_from_slice(&b);
    }

    // PKCS#7 unpad (DES block size is 8).
    let pad = *out.last().unwrap_or(&0) as usize;
    if pad == 0 || pad > 8 || out.len() < pad || !out[out.len() - pad..].iter().all(|&b| b == pad as u8) {
        return Err("media url padding is invalid".into());
    }
    out.truncate(out.len() - pad);

    String::from_utf8(out).map_err(|e| format!("media url is not utf-8: {e}"))
}

/// Derive every rendition url from a decrypted `…_96.mp4` asset url.
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
    let duration_secs = num_any(v, "duration").unwrap_or(0.0).max(0.0) as u64;
    let title = text(v, "song")
        .or_else(|| text(v, "title"))
        .unwrap_or_default();
    let artist = text(v, "primary_artists")
        .or_else(|| text(v, "singers"))
        .or_else(|| text(v, "music"))
        .or_else(|| text(v, "subtitle"))
        .unwrap_or_default();
    let album = text(v, "album").unwrap_or_default();
    // Prefer the 500x500 artwork when the payload only carries the 150px thumb.
    let image = text(v, "image")
        .or_else(|| Some(best_image(&v["image"])))
        .unwrap_or_default()
        .replace("-150x150", "-500x500");

    Track {
        id: text(v, "id").unwrap_or_default(),
        title: html_unescape(&title),
        artist: html_unescape(&artist),
        album: html_unescape(&album),
        duration_secs,
        duration: fmt_duration(duration_secs),
        image,
        page_url: text(v, "perma_url").or_else(|| text(v, "url")).unwrap_or_default(),
        hq: hq_available(v),
        plays: num_any(v, "play_count")
            .or_else(|| num_any(v, "playCount"))
            .unwrap_or(0.0)
            .max(0.0) as u64,
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
    Ok(results.iter().map(parse_song).collect())
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
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct HomeFeed {
    /// Hero banner — a real playlist the buttons can start.
    pub spotlight: Option<FeedItem>,
    pub playlists: Vec<FeedItem>,
    pub charts: Vec<FeedItem>,
    /// Chart the "Full 100 Charts" button plays in full.
    pub chart_id: String,
    /// First five tracks of `chart_id` — the countdown rows.
    pub top_tracks: Vec<Track>,
}

fn feed_item(v: &Value) -> Option<FeedItem> {
    Some(FeedItem {
        id: text(v, "id")?,
        title: html_unescape(&text(v, "title").unwrap_or_default()),
        subtitle: html_unescape(&text(v, "subtitle").unwrap_or_default()),
        image: text(v, "image").unwrap_or_default(),
        count: v
            .get("count")
            .and_then(Value::as_u64)
            .or_else(|| {
                v.pointer("/more_info/song_count")
                    .and_then(|x| x.as_str())
                    .and_then(|s| s.parse().ok())
            })
            .unwrap_or(0),
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

    let playlists = feed_list(&value["top_playlists"], "playlist");
    let charts = feed_list(&value["charts"], "playlist");
    let spotlight = feed_list(&value["new_trending"], "playlist")
        .into_iter()
        .next()
        .or_else(|| playlists.first().cloned());
    let chart_id = charts.first().map(|c| c.id.clone()).unwrap_or_default();
    // A missing chart only costs the countdown rows — the rest still renders.
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
    })
}

/// Every song of a playlist / chart, in order.
pub async fn playlist_tracks(
    client: &reqwest::Client,
    id: &str,
) -> Result<Vec<Track>, String> {
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
    Ok(songs.iter().map(parse_song).collect())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured from `song.getDetails` for `aRZbUYD7` — the vector that
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
        assert!(qs.iter().all(|q| q.url.starts_with("https://aac.saavncdn.com/450/")));
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
        assert_eq!(playlists[0].count, 20, "count comes from more_info.song_count");

        let charts = feed_list(&v["charts"], "playlist");
        assert_eq!(charts[0].count, 50, "charts declare count at the top level");
        assert!(feed_list(&v["missing"], "playlist").is_empty());
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
        assert!(first.iter().any(|t| t.hq), "official results carry 320 kbps flags");
        assert!(first.iter().any(|t| t.plays > 0), "official results carry play counts");
    }

    #[tokio::test]
    async fn live_home_feed_carries_playlists_and_chart_tracks() {
        if std::env::var("OP_OFFLINE").is_ok() {
            return;
        }
        let client = crate::jiosaavn::api_client();
        let feed = home(&client).await.expect("home feed");
        assert!(feed.playlists.len() >= 5, "enough for one carousel page");
        assert!(feed.charts.len() >= 1);
        assert_eq!(feed.top_tracks.len(), 5, "countdown needs five rows");
        assert!(feed.top_tracks[0].title.is_empty() == false);
        let tracks = playlist_tracks(&client, &feed.chart_id).await.expect("chart");
        assert!(tracks.len() >= 5);
    }

    #[tokio::test]
    async fn live_resolve_yields_all_renditions_of_the_full_file() {
        if std::env::var("OP_OFFLINE").is_ok() {
            return;
        }
        let client = crate::jiosaavn::api_client();
        let tracks = search(&client, "tum hi ho", 1, 1).await.expect("search");
        let song = fetch_song(&client, &tracks[0].id).await.expect("resolve");
        assert_eq!(song.qualities.len(), 5, "every rendition must be synthesised");
        let chosen = crate::jiosaavn::best_quality(&song.qualities, "320kbps").unwrap();
        assert!(chosen.url.ends_with("_320.mp4"), "full file, not a preview");
        let probe = crate::jiosaavn::qualify_url(&client, &chosen.url)
            .await
            .expect("probe");
        assert_eq!(probe.range_status, crate::jiosaavn::RangeStatus::Unrestricted);
        assert!(
            probe.content_length.unwrap_or(0) > 1_000_000,
            "a whole song is megabytes, not kilobytes"
        );
    }
}
