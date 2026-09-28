//! JioSaavn catalog: first-party source first, community mirrors as fallback.
//!
//! Owns: source failover (`official.rs` -> `MIRRORS`), defensive JSON parsing,
//! quality selection and the three-probe range qualification that makes the
//! honesty badge possible. Must NOT know anything about HTTP servers
//! (that is `proxy.rs`'s job).

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Preference-ordered mirror list. Failover order is declaration order.
/// All mirrors must expose the same `/api/search/songs` and `/api/songs/{id}` contract.
/// Only mirrors verified to serve the same API shape are listed.
pub const MIRRORS: &[&str] = &[
    "https://jiosaavn-api.vercel.app",
    "https://saavn-api.vercel.app",
    "https://jiosaavn-api-privatecvc.vercel.app",
    "https://saavn.dev",
    "https://saavn.sumit.co",
];

/// Maximum retry attempts per mirror on transient failures (429, 5xx, timeouts).
const MAX_RETRIES: u32 = 2;

/// Base backoff for retry delay: 1s * 2^attempt, capped at 8s.
/// Jitter (±25%) is added to avoid synchronized retry storms.
const BACKOFF_BASE_MS: u64 = 1000;
const BACKOFF_CAP_MS: u64 = 8000;

/// Media hosts allowed for streaming (scheme must be https).
pub const MEDIA_HOSTS: &[&str] = &["saavncdn.com"];

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct Track {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_secs: u64,
    pub duration: String,
    pub image: String,
    pub page_url: String,
    /// The source declares a 320 kbps rendition for this song.
    #[serde(default)]
    pub hq: bool,
    /// Lifetime play count (sorting). 0 when the source omits it.
    #[serde(default)]
    pub plays: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct QualityUrl {
    pub quality: String,
    pub url: String,
}

#[derive(Clone, Debug)]
pub struct Song {
    pub track: Track,
    pub qualities: Vec<QualityUrl>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RangeStatus {
    Unrestricted,
    RestrictedFirstMb,
    Dead,
}

#[derive(Clone, Copy, Debug)]
pub struct Probe {
    pub range_status: RangeStatus,
    pub content_length: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct PlayableAudio {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub direct_url: String,
    pub proxy_url: String,
    pub qualities: Vec<QualityUrl>,
    pub chosen_quality: String,
    pub content_length: Option<u64>,
    pub host: String,
    pub range_status: RangeStatus,
}

// ---------------------------------------------------------------------------
// HTTP clients — the two-client rule (see architecture.md §7)
// ---------------------------------------------------------------------------

/// Metadata + probes: total 25 s timeout, must fail fast.
/// Sends browser-like headers to avoid being flagged as a bot.
pub fn api_client() -> reqwest::Client {
    use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, USER_AGENT};
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"));
    headers.insert(ACCEPT, HeaderValue::from_static("application/json, text/plain, */*"));
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(25))
        .default_headers(headers)
        .build()
        .expect("failed to build api client")
}

/// Media bodies: NO total timeout (a 10 MB song on a slow link takes > 25 s).
pub fn media_client() -> reqwest::Client {
    use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, USER_AGENT};
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"));
    headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
        .default_headers(headers)
        .build()
        .expect("failed to build media client")
}

// ---------------------------------------------------------------------------
// Input hardening
// ---------------------------------------------------------------------------

pub fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 32 {
        return Err(format!("invalid song id: {id}"));
    }
    // Real JioSaavn ids contain hyphens (e.g. "i-4OQoee"). Dots and slashes
    // stay banned: they are the only characters that enable path tricks.
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!("invalid song id: {id}"));
    }
    Ok(())
}

pub fn is_media_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    MEDIA_HOSTS.iter().any(|allowed| {
        host == *allowed || host.ends_with(&format!(".{allowed}"))
    })
}

/// Validate a user-supplied stream URL: https + allow-listed media host only.
pub fn validate_media_url(raw: &str) -> Result<String, String> {
    let parsed = url::Url::parse(raw).map_err(|e| format!("invalid url: {e}"))?;
    if parsed.scheme() != "https" {
        return Err(format!("media url must be https: {raw}"));
    }
    let host = parsed.host_str().unwrap_or("").to_string();
    if !is_media_host(&host) {
        return Err(format!("media host not allowed: {host}"));
    }
    Ok(raw.to_string())
}

// ---------------------------------------------------------------------------
// Defensive parsing helpers (mirror JSON has optional/null fields)
// ---------------------------------------------------------------------------

pub(crate) fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn number(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.as_f64())
}

/// Numbers arrive as JSON numbers on some sources and as strings on others.
pub(crate) fn num_any(v: &Value, key: &str) -> Option<f64> {
    number(v, key).or_else(|| text(v, key).and_then(|s| s.parse::<f64>().ok()))
}

/// Decode the handful of HTML entities JioSaavn ships inside titles.
pub(crate) fn html_unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if !s[i..].starts_with('&') {
            let next = s[i..].find('&').map(|o| i + o).unwrap_or(s.len());
            out.push_str(&s[i..next]);
            i = next;
            continue;
        }
        let end = s[i..]
            .find(';')
            .map(|o| i + o)
            .filter(|&j| j - i <= 10);
        match end {
            Some(j) => {
                let entity = &s[i + 1..j];
                let decoded = match entity {
                    "quot" => Some('"'),
                    "amp" => Some('&'),
                    "apos" | "#39" | "#x27" => Some('\''),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "nbsp" => Some(' '),
                    _ if entity.starts_with('#') => {
                        let digits = &entity[1..];
                        let (radix, digits) = match digits.strip_prefix('x') {
                            Some(hex) => (16, hex),
                            None => (10, digits),
                        };
                        u32::from_str_radix(digits, radix)
                            .ok()
                            .and_then(char::from_u32)
                    }
                    _ => None,
                };
                match decoded {
                    Some(c) => out.push(c),
                    None => out.push_str(&s[i..=j]),
                }
                i = j + 1;
            }
            None => {
                out.push('&');
                i += 1;
            }
        }
    }
    out
}

pub(crate) fn best_image(images: &Value) -> String {
    let arr = match images.as_array() {
        Some(a) => a,
        None => return String::new(),
    };
    // Prefer the largest declared artwork, fall back to the last entry.
    let preferred = ["500x500", "500x500x100", "150x150"];
    for q in preferred {
        for item in arr {
            if text(item, "quality").as_deref() == Some(q) {
                if let Some(u) = text(item, "url") {
                    return u;
                }
            }
        }
    }
    arr.iter()
        .filter_map(|item| text(item, "url"))
        .next_back()
        .unwrap_or_default()
}

fn artist_names(artists: &Value) -> String {
    let mut names: Vec<String> = Vec::new();
    for group in ["primary", "featured", "all"] {
        if let Some(list) = artists.get(group).and_then(|x| x.as_array()) {
            for a in list {
                if let Some(n) = text(a, "name") {
                    if !names.contains(&n) {
                        names.push(n);
                    }
                }
            }
        }
    }
    if !names.is_empty() {
        return names.join(", ");
    }
    text(artists, "name").unwrap_or_default()
}

pub(crate) fn fmt_duration(secs: u64) -> String {
    format!("{}:{:02}", secs / 60, secs % 60)
}

/// Mirror payload shape (`/api/search/songs`, `/api/songs/{id}`).
fn parse_song(v: &Value) -> Track {
    let album = v
        .get("album")
        .map(|a| {
            if let Some(s) = a.as_str() {
                s.to_string()
            } else {
                text(a, "name").unwrap_or_default()
            }
        })
        .unwrap_or_default();

    let duration_secs = num_any(v, "duration").unwrap_or(0.0).max(0.0) as u64;
    let title = text(v, "name").or_else(|| text(v, "title")).unwrap_or_default();
    let artist = {
        let a = artist_names(&v["artists"]);
        if a.is_empty() {
            text(v, "artist").or_else(|| text(v, "primary_artists")).unwrap_or_default()
        } else {
            a
        }
    };

    Track {
        id: text(v, "id").unwrap_or_default(),
        title: html_unescape(&title),
        artist: html_unescape(&artist),
        album: html_unescape(&album),
        duration_secs,
        duration: fmt_duration(duration_secs),
        image: best_image(&v["image"]),
        page_url: text(v, "url").or_else(|| text(v, "perma_url")).unwrap_or_default(),
        hq: match v.get("320kbps") {
            Some(Value::Bool(b)) => *b,
            Some(Value::String(s)) => s.eq_ignore_ascii_case("true"),
            _ => false,
        },
        plays: num_any(v, "playCount")
            .or_else(|| num_any(v, "play_count"))
            .unwrap_or(0.0)
            .max(0.0) as u64,
    }
}

// ---------------------------------------------------------------------------
// Mirror transport
// ---------------------------------------------------------------------------

/// Exponential backoff with ±25 % jitter so retries never synchronize.
fn backoff_ms(attempt: u32) -> u64 {
    let exp = BACKOFF_BASE_MS
        .saturating_mul(2u64.saturating_pow(attempt))
        .min(BACKOFF_CAP_MS);
    let jitter = (exp as f64 * 0.25) as u64;
    exp.saturating_sub(jitter / 2) + (jitter / 3)
}

async fn get_json(client: &reqwest::Client, path: &str) -> Result<Value, String> {
    let mut last_err = String::new();
    let mut mirrors_tried = Vec::new();

    for base in MIRRORS {
        let url = format!("{base}{path}");
        mirrors_tried.push(base.to_string());

        for attempt in 0..=MAX_RETRIES {
            match client.get(&url).send().await {
                Ok(resp) => {
                    let status = resp.status();
                    if status.as_u16() == 429 {
                        // Rate limited. Retrying the same host only extends the
                        // penalty, so name the failing URL and move on: the next
                        // mirror has its own budget. A 429 therefore costs one
                        // request, never MAX_RETRIES of them.
                        last_err = format!("{url} -> HTTP {status}");
                        break;
                    }
                    if status.is_server_error() {
                        last_err = format!("{url} -> HTTP {status}");
                        if attempt < MAX_RETRIES {
                            tokio::time::sleep(Duration::from_millis(backoff_ms(attempt))).await;
                            continue;
                        }
                        break;
                    }
                    if !status.is_success() {
                        last_err = format!("{url} -> HTTP {status}");
                        break;
                    }
                    match resp.text().await {
                        Ok(body) => match serde_json::from_str::<Value>(&body) {
                            Ok(v) => return Ok(v),
                            Err(e) => {
                                last_err = format!("decode {url}: {e}");
                                break;
                            }
                        },
                        Err(e) => {
                            last_err = format!("read {url}: {e}");
                            break;
                        }
                    }
                }
                Err(e) => {
                    last_err = format!("GET {url}: {e}");
                    if attempt < MAX_RETRIES {
                        tokio::time::sleep(Duration::from_millis(backoff_ms(attempt))).await;
                        continue;
                    }
                    break;
                }
            }
        }
    }
    Err(format!(
        "all {} mirrors failed (tried: {}). Last error: {}",
        MIRRORS.len(),
        mirrors_tried.join(", "),
        last_err
    ))
}

// ---------------------------------------------------------------------------
// Catalog operations
// ---------------------------------------------------------------------------

/// Search the catalog, page `page` (1-based).
///
/// Official JioSaavn first (paginated, no mirror rate limit); the community
/// mirrors are the fallback when the first-party call fails outright.
pub async fn search_songs(
    client: &reqwest::Client,
    query: &str,
    limit: u32,
    page: u32,
) -> Result<Vec<Track>, String> {
    match crate::official::search(client, query, limit, page).await {
        Ok(tracks) => Ok(tracks),
        Err(primary) => mirror_search_songs(client, query, limit)
            .await
            .map_err(|fallback| {
                format!("search failed — jiosaavn.com: {primary}; mirrors: {fallback}")
            }),
    }
}

/// Resolve a song id into metadata plus every rendition of the full file.
pub async fn fetch_song(client: &reqwest::Client, id: &str) -> Result<Song, String> {
    check_id(id)?;
    match crate::official::fetch_song(client, id).await {
        Ok(song) => Ok(song),
        Err(primary) => mirror_fetch_song(client, id).await.map_err(|fallback| {
            format!("resolve failed — jiosaavn.com: {primary}; mirrors: {fallback}")
        }),
    }
}

async fn mirror_search_songs(
    client: &reqwest::Client,
    query: &str,
    limit: u32,
) -> Result<Vec<Track>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("empty query".into());
    }
    let limit = limit.clamp(1, 50);
    let encoded = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("query", query)
        .finish();
    let path = format!("/api/search/songs?{encoded}&limit={limit}");
    let json = get_json(client, &path).await?;

    let results = json
        .pointer("/data/results")
        .and_then(|x| x.as_array())
        .ok_or_else(|| format!("search response missing data.results"))?;

    Ok(results.iter().map(parse_song).collect())
}

async fn mirror_fetch_song(client: &reqwest::Client, id: &str) -> Result<Song, String> {
    check_id(id)?;
    let path = format!("/api/songs/{id}");
    let json = get_json(client, &path).await?;

    let data = json.get("data").ok_or_else(|| "song not found".to_string())?;
    let song_value = if let Some(arr) = data.as_array() {
        arr.first().ok_or_else(|| "song not found".to_string())?
    } else {
        data
    };

    let qualities: Vec<QualityUrl> = song_value
        .get("downloadUrl")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    Some(QualityUrl {
                        quality: text(item, "quality")?,
                        url: text(item, "url")?,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    if qualities.is_empty() {
        return Err("no stream qualities".into());
    }

    Ok(Song {
        track: parse_song(song_value),
        qualities,
    })
}

/// Exact label match, otherwise highest bitrate.
pub fn best_quality(qualities: &[QualityUrl], prefer: &str) -> Option<QualityUrl> {
    if qualities.is_empty() {
        return None;
    }
    if let Some(hit) = qualities.iter().find(|q| q.quality == prefer) {
        return Some(hit.clone());
    }
    qualities
        .iter()
        .max_by_key(|q| {
            q.quality
                .trim_end_matches("kbps")
                .parse::<u32>()
                .unwrap_or(0)
        })
        .cloned()
}

// ---------------------------------------------------------------------------
// Range qualification — the honesty path
// ---------------------------------------------------------------------------

fn total_from_content_range(value: &str) -> Option<u64> {
    // "bytes 0-63/10527454" or "bytes 0-63/*"
    let total = value.rsplit('/').next()?;
    total.parse::<u64>().ok()
}

/// Three probes: bounded (ftyp liveness), mid-file, open-ended.
pub async fn qualify_url(client: &reqwest::Client, url: &str) -> Result<Probe, String> {
    let url = validate_media_url(url)?;

    // Probe 1: 64 bytes — must be 206 AND start with an ISO-BMFF ftyp box.
    let head = client
        .get(&url)
        .header(reqwest::header::RANGE, "bytes=0-63")
        .send()
        .await
        .map_err(|e| format!("probe head: {e}"))?;

    if head.status().as_u16() != 206 {
        return Ok(Probe {
            range_status: RangeStatus::Dead,
            content_length: None,
        });
    }
    let content_length = head
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(total_from_content_range);
    let body = head
        .bytes()
        .await
        .map_err(|e| format!("probe head body: {e}"))?;
    if body.len() < 8 || &body[4..8] != b"ftyp" {
        return Ok(Probe {
            range_status: RangeStatus::Dead,
            content_length: None,
        });
    }

    // Probe 2: mid-file, past the first megabyte — the range-gate detector.
    let mid = client
        .get(&url)
        .header(reqwest::header::RANGE, "bytes=2000000-2065535")
        .send()
        .await
        .map_err(|e| format!("probe mid: {e}"))?;
    if mid.status().as_u16() == 206 {
        return Ok(Probe {
            range_status: RangeStatus::Unrestricted,
            content_length,
        });
    }

    // Probe 3: open-ended — catches files smaller than the mid-file window
    // and servers that answer 200 to a Range request (full body).
    let open = client
        .get(&url)
        .header(reqwest::header::RANGE, "bytes=0-")
        .send()
        .await
        .map_err(|e| format!("probe open: {e}"))?;
    let status = open.status().as_u16();
    if status == 206 {
        let len = content_length.or_else(|| {
            open.headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(total_from_content_range)
        });
        return Ok(Probe {
            range_status: RangeStatus::Unrestricted,
            content_length: len,
        });
    }
    if status == 200 {
        let len = content_length.or_else(|| {
            open.headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse().ok())
        });
        return Ok(Probe {
            range_status: RangeStatus::Unrestricted,
            content_length: len,
        });
    }

    Ok(Probe {
        range_status: RangeStatus::RestrictedFirstMb,
        content_length,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_id_accepts_real_ids_and_rejects_injection() {
        assert!(check_id("aRZbUYD7").is_ok());
        assert!(check_id("i-4OQoee").is_ok(), "real ids contain hyphens");
        assert!(check_id("").is_err());
        assert!(check_id("../../etc/passwd").is_err());
        assert!(check_id("a.b.c").is_err());
        assert!(check_id(&"a".repeat(33)).is_err());
        assert!(check_id("has space").is_err());
    }

    #[test]
    fn durations_format_as_m_ss() {
        assert_eq!(fmt_duration(262), "4:22");
        assert_eq!(fmt_duration(0), "0:00");
        assert_eq!(fmt_duration(65), "1:05");
    }

    #[test]
    fn best_quality_prefers_exact_then_highest_bitrate() {
        let qs = vec![
            QualityUrl { quality: "12kbps".into(), url: "u12".into() },
            QualityUrl { quality: "96kbps".into(), url: "u96".into() },
            QualityUrl { quality: "320kbps".into(), url: "u320".into() },
        ];
        assert_eq!(best_quality(&qs, "96kbps").unwrap().url, "u96");
        assert_eq!(best_quality(&qs, "320kbps").unwrap().url, "u320");
        assert_eq!(best_quality(&qs, "256kbps").unwrap().url, "u320");
        assert!(best_quality(&[], "320kbps").is_none());
    }

    #[test]
    fn media_host_allow_list_is_suffix_safe() {
        assert!(is_media_host("aac.saavncdn.com"));
        assert!(is_media_host("c.saavncdn.com"));
        assert!(is_media_host("SAAVNCDN.COM"));
        assert!(!is_media_host("example.com"));
        assert!(!is_media_host("saavncdn.com.evil.net"));
        assert!(validate_media_url("https://aac.saavncdn.com/x.mp4").is_ok());
        assert!(validate_media_url("http://aac.saavncdn.com/x.mp4").is_err());
        assert!(validate_media_url("https://example.com/x.mp4").is_err());
    }

    #[test]
    fn parse_song_tolerates_nulls() {
        let v: Value = serde_json::from_str(
            r#"{
              "id": "abc123",
              "name": "Tum Hi Ho",
              "duration": 262,
              "url": "https://www.jiosaavn.com/song/x",
              "releaseDate": null,
              "playCount": null,
              "album": {"id": "1", "name": "Aashiqui 2"},
              "artists": {"primary": [{"name": "Mithoon"}], "featured": [], "all": []},
              "image": [
                {"quality": "50x50", "url": "https://c.saavncdn.com/a.jpg"},
                {"quality": "500x500", "url": "https://c.saavncdn.com/b.jpg"}
              ]
            }"#,
        )
        .unwrap();
        let t = parse_song(&v);
        assert_eq!(t.id, "abc123");
        assert_eq!(t.title, "Tum Hi Ho");
        assert_eq!(t.artist, "Mithoon");
        assert_eq!(t.album, "Aashiqui 2");
        assert_eq!(t.duration, "4:22");
        assert_eq!(t.image, "https://c.saavncdn.com/b.jpg");
    }

    #[test]
    fn html_entities_are_decoded_once() {
        assert_eq!(
            html_unescape("Gehra Hua (From &quot;Dhurandhar&quot;)"),
            "Gehra Hua (From \"Dhurandhar\")"
        );
        assert_eq!(html_unescape("A &amp; B &lt; C &gt; D"), "A & B < C > D");
        assert_eq!(html_unescape("it&#39;s / &#x27;s"), "it's / 's");
        assert_eq!(html_unescape("bare & symbol"), "bare & symbol");
        assert_eq!(html_unescape("no entities"), "no entities");
    }

    // ---- Live contract tests (require network) ----

    #[tokio::test]
    async fn live_search_returns_tracks() {
        if std::env::var("OP_OFFLINE").is_ok() {
            return;
        }
        let client = api_client();
        let tracks = search_songs(&client, "tum hi ho", 5, 1)
            .await
            .expect("live search must succeed");
        assert!(!tracks.is_empty(), "search returned no tracks");
        assert!(!tracks[0].id.is_empty());
        assert!(!tracks[0].title.is_empty());
    }

    #[tokio::test]
    async fn live_resolve_and_qualify_is_unrestricted() {
        if std::env::var("OP_OFFLINE").is_ok() {
            return;
        }
        let client = api_client();
        let tracks = search_songs(&client, "tum hi ho", 1, 1)
            .await
            .expect("search");
        let song = fetch_song(&client, &tracks[0].id).await.expect("resolve");
        assert!(song.qualities.len() >= 1);
        let chosen = best_quality(&song.qualities, "320kbps").unwrap();
        assert!(validate_media_url(&chosen.url).is_ok());
        let probe = qualify_url(&client, &chosen.url).await.expect("probe");
        assert_eq!(
            probe.range_status,
            RangeStatus::Unrestricted,
            "CDN should serve full ranges"
        );
        assert!(probe.content_length.unwrap_or(0) > 0);
    }
}
