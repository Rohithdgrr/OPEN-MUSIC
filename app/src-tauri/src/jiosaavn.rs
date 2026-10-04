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

/// A `Retry-After` asking us to wait longer than this is not honoured:
/// moving to the next mirror (with its own budget) is faster and kinder.
const RETRY_AFTER_CAP_SECS: u64 = 4;

/// Refuse mirror bodies bigger than this before handing them to serde
/// (review 5.5: a hostile/broken mirror must not OOM the parser).
const MAX_JSON_BYTES: usize = 10 * 1024 * 1024;

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
    /// `None` when the source does not report the flag — never assume "no",
    /// because the lyrics command only skips the first-party fetch on a
    /// definite `false`.
    #[serde(default)]
    pub has_lyrics: Option<bool>,
    #[serde(default)]
    pub artist_ids: Vec<String>,
    #[serde(default)]
    pub album_id: String,
    #[serde(default)]
    pub year: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub explicit: bool,
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
// HTTP clients — the two-client rule (see docs/architecture.md §7)
// ---------------------------------------------------------------------------

/// Metadata + probes: total 25 s timeout, must fail fast.
/// Sends browser-like headers to avoid being flagged as a bot.
// review 5.6: a client that cannot build (TLS backend broken at install
// time) is fatal by design — fail loudly at boot, not on first request.
#[allow(clippy::expect_used)]
pub fn api_client() -> reqwest::Client {
    use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, USER_AGENT};
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"));
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/json, text/plain, */*"),
    );
    headers.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(25))
        // review 5.1: a redirect loop must abort after a handful of hops,
        // not spin on reqwest's default of ten.
        .redirect(reqwest::redirect::Policy::limited(5))
        .pool_max_idle_per_host(10)
        .tcp_keepalive(Duration::from_secs(60))
        .default_headers(headers)
        .build()
        .expect("failed to build api client")
}

/// Media bodies: NO total timeout (a 10 MB song on a slow link takes > 25 s).
// review 5.6: same fatal-by-design invariant as `api_client`.
#[allow(clippy::expect_used)]
pub fn media_client() -> reqwest::Client {
    use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, USER_AGENT};
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"));
    headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(5))
        .pool_max_idle_per_host(10)
        .tcp_keepalive(Duration::from_secs(60))
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
    // One validator for two shapes: song ids (e.g. "i-4OQoee") and the
    // webapi page tokens they share a URL with (e.g. ",gDuHtyl,iA_", the last
    // segment of an artist's perma_url) — hence commas are allowed. Dots and
    // slashes stay banned: they are the only characters that enable path
    // tricks, and no real id or token contains them.
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == ',')
    {
        return Err(format!("invalid song id: {id}"));
    }
    Ok(())
}

pub fn is_media_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    MEDIA_HOSTS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
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

/// The mirror sends the literal strings "NULL" / "null" where it has no value
/// (artist, album, label on album-track listings), which would otherwise be
/// rendered to the user as metadata text.
pub(crate) fn is_placeholder(s: &str) -> bool {
    matches!(
        s.trim().to_ascii_lowercase().as_str(),
        "" | "null" | "none" | "undefined" | "n/a" | "na" | "-"
    )
}

pub(crate) fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !is_placeholder(s))
        .map(str::to_string)
}

fn number(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.as_f64())
}

/// Numbers arrive as JSON numbers on some sources and as strings on others.
pub(crate) fn num_any(v: &Value, key: &str) -> Option<f64> {
    number(v, key).or_else(|| text(v, key).and_then(|s| s.parse::<f64>().ok()))
}

/// Flags arrive as bools on mirrors and as `"true"`/`"1"` strings officially.
pub(crate) fn flag(v: &Value, key: &str) -> Option<bool> {
    match v.get(key)? {
        Value::Bool(b) => Some(*b),
        Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => Some(true),
            "false" | "0" | "no" => Some(false),
            _ => None,
        },
        Value::Number(n) => n.as_i64().map(|n| n != 0),
        _ => None,
    }
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
        let end = s[i..].find(';').map(|o| i + o).filter(|&j| j - i <= 10);
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
                    // Punctuation JioSaavn actually ships in titles and
                    // artist credits; anything else falls through raw.
                    "copy" => Some('©'),
                    "reg" => Some('®'),
                    "trade" => Some('™'),
                    "hellip" => Some('…'),
                    "mdash" => Some('—'),
                    "ndash" => Some('–'),
                    "middot" => Some('·'),
                    "lsquo" => Some('\u{2018}'),
                    "rsquo" => Some('\u{2019}'),
                    "ldquo" => Some('\u{201C}'),
                    "rdquo" => Some('\u{201D}'),
                    "bull" => Some('•'),
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

/// Rewrite the small CDN renditions (`-50x50`, `-150x150`, `-150x150x100`,
/// dashed or underscored) to the 500px master and force the CDN onto https.
/// The size token in the filename is the only signal the payload gives us
/// about the dimensions of the file behind the URL.
pub(crate) fn upgrade_image(url: &str) -> String {
    // Longest tokens first: `-150x150x100` must match before `-150x150`.
    // Dashed forms keep their dash; bare forms cover `..._150x150.jpg`.
    const SMALL: [(&str, &str); 6] = [
        ("-50x50x100", "-500x500"),
        ("-150x150x100", "-500x500"),
        ("-50x50", "-500x500"),
        ("-150x150", "-500x500"),
        ("50x50", "500x500"),
        ("150x150", "500x500"),
    ];
    let mut out = url.to_string();
    for (small, big) in SMALL {
        out = out.replace(small, big);
    }
    if let Some(rest) = out.strip_prefix("http://") {
        let authority = rest.split('/').next().unwrap_or("");
        if authority.eq_ignore_ascii_case("saavncdn.com")
            || authority.to_ascii_lowercase().ends_with(".saavncdn.com")
        {
            out = format!("https://{rest}");
        }
    }
    out
}

/// Largest artwork for an `image` field — a rendition array (`[{quality,url}]`)
/// or a plain URL string — always upgraded to the 500px master.
pub(crate) fn image_url(images: &Value) -> String {
    let raw = match images {
        Value::String(s) => s.clone(),
        other => best_image(other),
    };
    upgrade_image(&raw)
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
    let title = text(v, "name")
        .or_else(|| text(v, "title"))
        .unwrap_or_default();
    let artist = {
        let a = artist_names(&v["artists"]);
        if a.is_empty() {
            text(v, "artist")
                .or_else(|| text(v, "primary_artists"))
                .unwrap_or_default()
        } else {
            a
        }
    };
    let artist_ids = v["artists"]
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
        image: image_url(&v["image"]),
        page_url: text(v, "url")
            .or_else(|| text(v, "perma_url"))
            .unwrap_or_default(),
        hq: match v.get("320kbps") {
            Some(Value::Bool(b)) => *b,
            Some(Value::String(s)) => s.eq_ignore_ascii_case("true"),
            _ => false,
        },
        plays: num_any(v, "playCount")
            .or_else(|| num_any(v, "play_count"))
            .unwrap_or(0.0)
            .max(0.0) as u64,
        has_lyrics: flag(v, "has_lyrics").or_else(|| flag(v, "hasLyrics")),
        artist_ids,
        album_id: text(&v["album"], "id").unwrap_or_default(),
        year: text(v, "year").unwrap_or_default(),
        label: text(v, "label").unwrap_or_default(),
        language: text(v, "language").unwrap_or_default(),
        explicit: flag(v, "explicit").unwrap_or(false),
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
    get_json_from(client, MIRRORS, path).await
}

/// Mirror walk with an injectable base list (tests point this at a local
/// wiremock server; production always passes [`MIRRORS`]).
async fn get_json_from(
    client: &reqwest::Client,
    bases: &[&str],
    path: &str,
) -> Result<Value, String> {
    let mut last_err = String::new();
    let mut mirrors_tried = Vec::new();

    for base in bases {
        let url = format!("{base}{path}");
        mirrors_tried.push(base.to_string());

        for attempt in 0..=MAX_RETRIES {
            match client.get(&url).send().await {
                Ok(resp) => {
                    let status = resp.status();
                    if status.as_u16() == 429 {
                        last_err = format!("{url} -> HTTP {status}");
                        // Honour a short `Retry-After`: one calm retry beats
                        // hammering the same host. A long (or missing) wait
                        // falls through to the next mirror, which has its own
                        // budget — a 429 never costs more than one request.
                        if attempt < MAX_RETRIES {
                            if let Some(delay) = retry_after_delay(&resp) {
                                tokio::time::sleep(delay).await;
                                continue;
                            }
                        }
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
                        Ok(body) => {
                            if body.len() > MAX_JSON_BYTES {
                                last_err = format!(
                                    "refusing oversized body from {url}: {} bytes",
                                    body.len()
                                );
                                break;
                            }
                            match serde_json::from_str::<Value>(&body) {
                                Ok(v) => return Ok(v),
                                Err(e) => {
                                    last_err = format!("decode {url}: {e}");
                                    break;
                                }
                            }
                        }
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
        bases.len(),
        mirrors_tried.join(", "),
        last_err
    ))
}

/// Seconds the server asked us to wait, when the answer is a sane short
/// pause. Malformed or long values return `None` (skip to next mirror).
fn retry_after_delay(resp: &reqwest::Response) -> Option<Duration> {
    let raw = resp
        .headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?;
    let secs: u64 = raw.trim().parse().ok()?;
    (secs <= RETRY_AFTER_CAP_SECS).then_some(Duration::from_secs(secs))
}

// ---------------------------------------------------------------------------
// Catalog operations
// ---------------------------------------------------------------------------

/// One page of search results after duplicate collapsing.
///
/// `page_full` reports whether upstream still had a *full* page to give,
/// measured **before** dedup shrinks it — the UI decides "no more results"
/// from this, never from `tracks.len()`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SearchPage {
    pub tracks: Vec<Track>,
    pub page_full: bool,
}

/// Upstream pages merged into one app-level page.
///
/// JioSaavn's `search.getResults` hands back degenerate pages — a single hit
/// can fill 28 of 30 rows (verified live: query "love", page 1) — which
/// collapses to a couple of songs after dedup. Merging a span of upstream
/// pages keeps one app page full of distinct songs; the pages are fetched
/// together, so the extra calls cost one round trip, not four.
const UPSTREAM_SPAN: u32 = 4;

/// The upstream pages merged into app-level `page` (1-based, gapless).
fn upstream_pages(page: u32) -> std::ops::RangeInclusive<u32> {
    let start = (page.max(1) - 1) * UPSTREAM_SPAN + 1;
    start..=start + UPSTREAM_SPAN - 1
}

/// One upstream search page: the first-party API first, the community
/// mirrors as the fallback when it fails outright.
async fn fetch_search_page(
    client: &reqwest::Client,
    query: &str,
    limit: u32,
    page: u32,
) -> Result<Vec<Track>, String> {
    match crate::official::search(client, query, limit, page).await {
        Ok(rows) => Ok(rows),
        Err(primary) => mirror_search_songs(client, query, limit, page)
            .await
            .map_err(|fallback| format!("jiosaavn.com: {primary}; mirrors: {fallback}")),
    }
}

/// Search the catalog, page `page` (1-based).
///
/// One app page spans [`UPSTREAM_SPAN`] upstream pages (see
/// [`upstream_pages`]); partial failures still serve whatever arrived, and
/// only an empty merge with errors fails outright. Duplicate collapsing
/// happens here, once, so the raw page lengths stay available for
/// `page_full` — measured from the *last* page in the span, before dedup
/// shrinks it, so "Load more" survives heavy collapsing.
pub async fn search_songs(
    client: &reqwest::Client,
    query: &str,
    limit: u32,
    page: u32,
) -> Result<SearchPage, String> {
    let pages = futures::future::join_all(
        upstream_pages(page).map(|p| fetch_search_page(client, query, limit, p)),
    )
    .await;

    let mut raw: Vec<Track> = Vec::new();
    let mut errs: Vec<String> = Vec::new();
    let mut page_full = false;
    for res in pages {
        match res {
            Ok(rows) => {
                // join_all preserves span order, so this is the highest page
                // seen — "more results exist" is judged from it alone.
                page_full = rows.len() as u32 >= limit.clamp(1, 40);
                raw.extend(rows);
            }
            Err(e) => errs.push(e),
        }
    }
    if raw.is_empty() && !errs.is_empty() {
        errs.sort();
        errs.dedup();
        return Err(format!("search failed — {}", errs.join("; ")));
    }
    Ok(SearchPage {
        tracks: dedup_tracks(raw),
        page_full,
    })
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
    page: u32,
) -> Result<Vec<Track>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("empty query".into());
    }
    let limit = limit.clamp(1, 50);
    let page = page.max(1);
    let encoded = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("query", query)
        .finish();
    let path = format!("/api/search/songs?{encoded}&limit={limit}&page={page}");
    let json = get_json(client, &path).await?;

    let results = json
        .pointer("/data/results")
        .and_then(Value::as_array)
        .ok_or_else(|| "search response missing data.results".to_string())?;

    // Raw parse: `search_songs` collapses duplicates once, page length intact.
    Ok(results.iter().map(parse_song).collect())
}

async fn mirror_fetch_song(client: &reqwest::Client, id: &str) -> Result<Song, String> {
    check_id(id)?;
    let path = format!("/api/songs/{id}");
    let json = get_json(client, &path).await?;

    let data = json
        .get("data")
        .ok_or_else(|| "song not found".to_string())?;
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
// Duplicate collapsing
// ---------------------------------------------------------------------------

/// Collapsed copies may disagree on duration by this much (upstream rounds
/// the same recording differently across albums).
const DURATION_TOLERANCE_S: u64 = 3;

/// Collapse duplicate catalog entries, keeping the best copy.
///
/// Upstream repeats songs two ways: byte-identical entries with the same id,
/// and the same recording under different ids (original vs remaster vs
/// compilation — different album/year, sometimes a "Remastered" title
/// suffix, sometimes the same song credited with a different bill).
///
/// Pass 1 drops exact-id repeats. Pass 2 buckets candidates by normalized
/// title; inside a bucket two copies merge when their artist credits agree
/// (order-insensitive, extra credits tolerated — see [`credit_names`] /
/// [`credits_overlap`]) and their durations are within
/// [`DURATION_TOLERANCE_S`]. The surviving copy is the one with a 320 kbps
/// rendition, then the highest play count, then the shortest title; ties
/// keep first-seen order.
///
/// Entries without an id or without a duration carry no reliable
/// fingerprint, so they only match themselves.
pub fn dedup_tracks(tracks: Vec<Track>) -> Vec<Track> {
    // Pass 1: exact ids (empty ids are not identity — keep those rows).
    let mut seen_ids = std::collections::HashSet::new();
    let mut unique: Vec<Track> = Vec::with_capacity(tracks.len());
    for t in tracks {
        if t.id.is_empty() || seen_ids.insert(t.id.clone()) {
            unique.push(t);
        }
    }
    // Pass 2: same recording under different ids. Each surviving title bucket
    // is scanned with set intersections, so cost is O(n·k) over same-title
    // candidates — fine at page size 40 and for artist catalogues in the
    // hundreds; if catalogues ever reach 1000+ songs sharing titles, index by
    // (title_key, duration_bucket) instead (review B7).
    let mut by_title: std::collections::HashMap<String, Vec<usize>> =
        std::collections::HashMap::new();
    let mut out: Vec<Track> = Vec::with_capacity(unique.len());
    for t in unique {
        let title_key = norm_text(&t.title);
        let fingerprinted = !t.id.is_empty() && t.duration_secs > 0;
        let mut matched: Option<usize> = None;
        if fingerprinted {
            let artists = credit_names(&t.artist);
            if let Some(candidates) = by_title.get(&title_key) {
                matched = candidates.iter().copied().find(|&i| {
                    let kept = &out[i];
                    kept.duration_secs.abs_diff(t.duration_secs) <= DURATION_TOLERANCE_S
                        && credits_overlap(&credit_names(&kept.artist), &artists)
                });
            }
        }
        match matched {
            Some(i) => {
                if better_copy(&t, &out[i]) {
                    out[i] = t;
                }
            }
            None => {
                if fingerprinted {
                    by_title.entry(title_key).or_default().push(out.len());
                }
                out.push(t);
            }
        }
    }
    out
}

/// Split a credit string into comparable artist names: lowercase, internal
/// whitespace collapsed, split on the separators JioSaavn bills with
/// (`, ; & /` and the `feat`/`ft`/`featuring` markers). Hyphenated billing
/// like "Shankar-Ehsaan-Loy" stays one name.
fn credit_names(s: &str) -> std::collections::HashSet<String> {
    const SEPS: [char; 4] = [',', ';', '&', '/'];
    const MARKERS: [&str; 3] = ["feat", "ft", "featuring"];
    let mut names = std::collections::HashSet::new();
    let mut cur = String::new();
    for segment in s.to_lowercase().split(SEPS) {
        for word in segment.split_whitespace() {
            // "feat." and "ft," count as markers too — trim the punctuation.
            let word = word.trim_matches(|c: char| !c.is_alphanumeric());
            if word.is_empty() {
                continue;
            }
            if MARKERS.contains(&word) {
                push_credit_name(&mut cur, &mut names);
            } else if !cur.is_empty() {
                cur.push(' ');
                cur.push_str(word);
            } else {
                cur.push_str(word);
            }
        }
        push_credit_name(&mut cur, &mut names);
    }
    names
}

fn push_credit_name(cur: &mut String, names: &mut std::collections::HashSet<String>) {
    let name = cur.split_whitespace().collect::<Vec<_>>().join(" ");
    cur.clear();
    if !name.is_empty() {
        names.insert(name);
    }
}

/// True when two credit lists plausibly bill the same artist set: at least
/// half of the smaller list matches (order never matters; an empty list is
/// no evidence, so it never merges).
fn credits_overlap(
    a: &std::collections::HashSet<String>,
    b: &std::collections::HashSet<String>,
) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let common = a.intersection(b).count();
    common * 2 >= a.len().min(b.len())
}

/// Lowercase alphanumeric fingerprint: bracketed version tags
/// ("(Remastered 2024)") and bare remaster/year tokens are dropped so the
/// original and its reissues share one key — but brackets marking a
/// different recording ("(Live)", "[Remix]") are kept as key material, as
/// are unbracketed remix/live/acoustic suffixes.
fn norm_text(s: &str) -> String {
    /// Bracket words that mark a different recording: keep the group.
    const KEEP: &[&str] = &[
        "live",
        "remix",
        "remixed",
        "acoustic",
        "unplugged",
        "edit",
        "mix",
        "version",
        "cover",
        "karaoke",
        "instrumental",
        "demo",
        "reimagined",
        "rework",
        "slowed",
        "reverb",
        "sped",
        "nightcore",
        "extended",
        "club",
        "radio",
    ];
    let lower = s.to_lowercase();
    let mut kept = String::with_capacity(lower.len());
    let mut depth = 0u32;
    let mut inner = String::new();
    for c in lower.chars() {
        match c {
            '(' | '[' => {
                if depth == 0 {
                    inner.clear();
                }
                depth += 1;
                if depth > 1 {
                    inner.push(c);
                }
            }
            ')' | ']' => {
                if depth == 0 {
                    continue; // Unbalanced closer: ignore it.
                }
                depth -= 1;
                if depth == 0 {
                    let words: Vec<&str> = inner.split(|c: char| !c.is_alphanumeric()).collect();
                    if words.iter().any(|w| KEEP.contains(w)) {
                        kept.push(' ');
                        kept.push_str(&inner);
                    }
                    inner.clear();
                } else {
                    inner.push(c);
                }
            }
            _ => {
                if depth == 0 {
                    kept.push(c);
                } else {
                    inner.push(c);
                }
            }
        }
    }
    if depth > 0 {
        // Unclosed bracket: treat the remainder as plain text rather than
        // dropping the rest of the title.
        kept.push(' ');
        kept.push_str(&inner);
    }
    kept.split(|c: char| !c.is_alphanumeric())
        .filter(|w| {
            !w.is_empty()
                && !matches!(*w, "remaster" | "remastered" | "remastering")
                && !(w.len() == 4 && w.bytes().all(|b| b.is_ascii_digit()))
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Ordering for colliding copies: 320 kbps rendition, then play count, then
/// the shortest title (fewest version suffixes); ties keep first-seen.
fn better_copy(a: &Track, b: &Track) -> bool {
    if a.hq != b.hq {
        return a.hq;
    }
    if a.plays != b.plays {
        return a.plays > b.plays;
    }
    if a.title.len() != b.title.len() {
        return a.title.len() < b.title.len();
    }
    false
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
    fn upstream_pages_span_four_without_gaps_or_overlap() {
        assert_eq!(upstream_pages(1).collect::<Vec<_>>(), vec![1, 2, 3, 4]);
        assert_eq!(upstream_pages(2).collect::<Vec<_>>(), vec![5, 6, 7, 8]);
        assert_eq!(upstream_pages(9).collect::<Vec<_>>(), vec![33, 34, 35, 36]);
    }

    #[test]
    fn upstream_pages_clamps_page_zero_to_the_first_span() {
        assert_eq!(upstream_pages(0).collect::<Vec<_>>(), vec![1, 2, 3, 4]);
    }

    #[test]
    fn check_id_accepts_real_ids_and_rejects_injection() {
        assert!(check_id("aRZbUYD7").is_ok());
        assert!(check_id("i-4OQoee").is_ok(), "real ids contain hyphens");
        assert!(
            check_id(",gDuHtyl,iA_").is_ok(),
            "artist page tokens contain commas"
        );
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
            QualityUrl {
                quality: "12kbps".into(),
                url: "u12".into(),
            },
            QualityUrl {
                quality: "96kbps".into(),
                url: "u96".into(),
            },
            QualityUrl {
                quality: "320kbps".into(),
                url: "u320".into(),
            },
        ];
        assert_eq!(best_quality(&qs, "96kbps").unwrap().url, "u96");
        assert_eq!(best_quality(&qs, "320kbps").unwrap().url, "u320");
        assert_eq!(best_quality(&qs, "256kbps").unwrap().url, "u320");
        assert!(best_quality(&[], "320kbps").is_none());
    }

    fn dup_track(id: &str, title: &str, artist: &str, secs: u64, hq: bool, plays: u64) -> Track {
        Track {
            id: id.into(),
            title: title.into(),
            artist: artist.into(),
            album: "Album".into(),
            duration_secs: secs,
            duration: fmt_duration(secs),
            image: String::new(),
            page_url: String::new(),
            hq,
            plays,
            has_lyrics: None,
            artist_ids: Vec::new(),
            album_id: String::new(),
            year: String::new(),
            label: String::new(),
            language: String::new(),
            explicit: false,
        }
    }

    #[test]
    fn dedup_removes_same_id_repeats() {
        let tracks = vec![
            dup_track("a", "Song", "Singer", 200, false, 5),
            dup_track("b", "Other", "Singer", 200, false, 5),
            dup_track("a", "Song", "Singer", 200, false, 5),
        ];
        let out = dedup_tracks(tracks);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].id, "a");
        assert_eq!(out[1].id, "b");
    }

    #[test]
    fn dedup_collapses_remaster_under_a_different_id_and_keeps_hq() {
        let tracks = vec![
            dup_track(
                "std1",
                "Midnight City Lights",
                "Solaris & Kaelen",
                240,
                false,
                900,
            ),
            dup_track(
                "rem9",
                "Midnight City Lights (Remastered 2024)",
                "Solaris & Kaelen",
                241,
                true,
                100,
            ),
        ];
        let out = dedup_tracks(tracks);
        assert_eq!(out.len(), 1, "same recording, one row");
        assert_eq!(out[0].id, "rem9", "320 kbps copy wins over play count");
    }

    #[test]
    fn dedup_prefers_more_plays_then_shorter_title() {
        let tracks = vec![
            dup_track("x", "Song - 2024 Remaster", "Singer", 200, false, 10),
            dup_track("y", "Song", "Singer", 200, false, 50),
        ];
        let out = dedup_tracks(tracks);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "y");
    }

    #[test]
    fn dedup_keeps_distinct_songs() {
        let tracks = vec![
            dup_track("a", "Song", "Singer One", 200, false, 5),
            dup_track("b", "Song", "Singer Two", 200, false, 5),
            dup_track("c", "Song (Live)", "Singer One", 200, false, 5),
            dup_track("d", "Song Remix", "Singer One", 200, false, 5),
        ];
        let out = dedup_tracks(tracks);
        assert_eq!(
            out.len(),
            4,
            "different artist and live/remix markers survive"
        );
    }

    #[test]
    fn dedup_only_matches_durationless_entries_by_id() {
        let tracks = vec![
            dup_track("a", "Song", "Singer", 0, false, 5),
            dup_track("b", "Song", "Singer", 0, false, 5),
            dup_track("a", "Song", "Singer", 0, false, 5),
        ];
        let out = dedup_tracks(tracks);
        assert_eq!(out.len(), 2, "no duration, no content merging");
    }

    #[test]
    fn dedup_ignores_artist_credit_order() {
        // Live JioSaavn shape: same song, bills swapped, ±1s rounding.
        let tracks = vec![
            dup_track("a", "Tum Hi Ho", "Mithoon, Arijit Singh", 262, false, 900),
            dup_track(
                "b",
                "Tum Hi Ho (From \"Aashiqui 2\")",
                "Arijit Singh, Mithoon",
                261,
                false,
                50,
            ),
        ];
        let out = dedup_tracks(tracks);
        assert_eq!(out.len(), 1, "credit order must not split one recording");
        assert_eq!(out[0].id, "a", "more plays wins");
    }

    #[test]
    fn dedup_tolerates_extra_lyricist_credits() {
        let tracks = vec![
            dup_track(
                "a",
                "Mast Magan",
                "Shankar-Ehsaan-Loy, Arijit Singh, Chinmayi Sripada",
                280,
                false,
                10,
            ),
            dup_track(
                "b",
                "Mast Magan (From \"2 States\")",
                "Amitabh Bhattacharya, Shankar-Ehsaan-Loy, Arijit Singh, Chinmayi Sripada",
                280,
                false,
                20,
            ),
        ];
        let out = dedup_tracks(tracks);
        assert_eq!(out.len(), 1, "an extra composer credit is still one song");
        assert_eq!(out[0].id, "b", "higher plays wins");
    }

    #[test]
    fn dedup_merges_within_three_seconds_and_splits_beyond() {
        let close = vec![
            dup_track("a", "Song", "Singer", 261, false, 1),
            dup_track("b", "Song", "Singer", 264, false, 1),
        ];
        assert_eq!(dedup_tracks(close).len(), 1, "±3s counts as the same cut");

        let far = vec![
            dup_track("a", "Song", "Singer", 261, false, 1),
            dup_track("b", "Song", "Singer", 265, false, 1),
        ];
        assert_eq!(dedup_tracks(far).len(), 2, "beyond tolerance stays apart");
    }

    #[test]
    fn dedup_keeps_same_title_by_unrelated_credits() {
        let tracks = vec![
            dup_track("a", "Intro", "One Artist", 60, false, 1),
            dup_track("b", "Intro", "Totally Different Act", 61, false, 1),
        ];
        assert_eq!(
            dedup_tracks(tracks).len(),
            2,
            "disjoint credits never merge"
        );
    }

    /// Captured live from `search.getResults?q=arijit&n=20&p=1`: twenty rows,
    /// nine unique songs. Bills reordered, lyricists added, ±1s rounding —
    /// every way upstream re-bills one recording.
    #[test]
    fn dedup_collapses_a_real_twenty_row_page_to_nine_songs() {
        let rows: &[(&str, &str, &str, u64)] = &[
            (
                "g1",
                "Gehra Hua (From \"Dhurandhar\")",
                "Shashwat Sachdev, Arijit Singh, Irshad Kamil, Armaan Khan",
                362,
            ),
            (
                "g2",
                "Gehra Hua",
                "Irshad Kamil, Arijit Singh, Shashwat Sachdev, Armaan Khan",
                362,
            ),
            ("t1", "Tum Hi Ho", "Mithoon, Arijit Singh", 262),
            (
                "t2",
                "Tum Hi Ho (From \"Aashiqui 2\")",
                "Arijit Singh, Mithoon",
                261,
            ),
            (
                "t3",
                "Tum Hi Ho (From \"Aashiqui 2\")",
                "Mithoon, Arijit Singh",
                261,
            ),
            (
                "m1",
                "Mast Magan (From \"2 States\")",
                "Amitabh Bhattacharya, Shankar-Ehsaan-Loy, Arijit Singh, Chinmayi Sripada",
                280,
            ),
            (
                "m2",
                "Mast Magan",
                "Shankar-Ehsaan-Loy, Arijit Singh, Chinmayi Sripada",
                280,
            ),
            (
                "s1",
                "Samjhawan",
                "Jawad Ahmad, Sharib Toshi, Arijit Singh, Shreya Ghoshal",
                269,
            ),
            ("o1", "O Maahi", "Pritam, Arijit Singh, Irshad Kamil", 233),
            (
                "o2",
                "O Maahi (From \"Dunki\")",
                "Irshad Kamil, Pritam, Arijit Singh",
                233,
            ),
            (
                "h1",
                "Tere Hawaale (From \"Laal Singh Chaddha\")",
                "Amitabh Bhattacharya, Pritam, Arijit Singh, Shilpa Rao",
                346,
            ),
            (
                "h2",
                "Tere Hawaale",
                "Pritam, Arijit Singh, Shilpa Rao",
                346,
            ),
            (
                "r1",
                "Sanam Re (From \"Sanam Re\")",
                "Mithoon, Arijit Singh",
                308,
            ),
            ("r2", "Sanam Re", "Mithoon, Arijit Singh", 308),
            (
                "k1",
                "Tum Kya Mile - Pritam' s Version (From \"Rocky Aur Rani Kii Prem Kahaani\")",
                "Amitabh Bhattacharya, Pritam, Arijit Singh, Shreya Ghoshal",
                192,
            ),
            (
                "a1",
                "Apna Bana Le",
                "Amitabh Bhattacharya, Sachin-Jigar, Arijit Singh",
                261,
            ),
            (
                "a2",
                "Apna Bana Le",
                "Amitabh Bhattacharya, Sachin-Jigar, Arijit Singh",
                261,
            ),
            (
                "a3",
                "Apna Bana Le",
                "Amitabh Bhattacharya, Sachin-Jigar, Arijit Singh",
                261,
            ),
            (
                "a4",
                "Apna Bana Le",
                "Amitabh Bhattacharya, Sachin-Jigar, Arijit Singh",
                261,
            ),
            (
                "a5",
                "Apna Bana Le",
                "Amitabh Bhattacharya, Sachin-Jigar, Arijit Singh",
                261,
            ),
        ];
        let tracks = rows
            .iter()
            .map(|(id, title, artist, secs)| dup_track(id, title, artist, *secs, false, 5))
            .collect();
        let out = dedup_tracks(tracks);
        assert_eq!(out.len(), 9, "20 upstream rows are 9 unique songs");
    }

    #[test]
    fn credit_names_split_bills_and_ignore_order() {
        let a = credit_names("Mithoon, Arijit Singh");
        let b = credit_names("Arijit Singh & Mithoon");
        assert_eq!(a, b, "separators and order are cosmetic");

        let feat = credit_names("Arijit Singh feat. Pritam");
        assert!(feat.contains("arijit singh") && feat.contains("pritam"));

        let hyphen = credit_names("Shankar-Ehsaan-Loy");
        assert!(hyphen.contains("shankar-ehsaan-loy"), "billing stays whole");
    }

    #[test]
    fn credits_overlap_requires_half_of_the_smaller_bill() {
        let full = credit_names("A, B, C, D");
        let half = credit_names("B, C, D");
        assert!(credits_overlap(&full, &half), "3 of 4 matches");

        let some = credit_names("A, X, Y");
        assert!(!credits_overlap(&full, &some), "1 of 4 is not the same act");

        let empty = std::collections::HashSet::new();
        assert!(!credits_overlap(&empty, &full), "no credit is no evidence");
    }

    #[test]
    fn media_host_allow_list_is_suffix_safe() {
        assert!(is_media_host("c.saavncdn.com"));
        assert!(is_media_host("SAAVNCDN.COM"));
        assert!(!is_media_host("example.com"));
        assert!(!is_media_host("saavncdn.com.evil.net"));
        assert!(validate_media_url("https://aac.saavncdn.com/x.mp4").is_ok());
        assert!(validate_media_url("http://aac.saavncdn.com/x.mp4").is_err());
        assert!(validate_media_url("https://example.com/x.mp4").is_err());
        // SSRF shapes (review 5.5): non-https schemes and link-local /
        // metadata endpoints never reach the media client.
        assert!(validate_media_url("file:///C:/Windows/System32/calc.exe").is_err());
        assert!(validate_media_url("ftp://aac.saavncdn.com/x.mp4").is_err());
        assert!(validate_media_url("http://169.254.169.254/latest/meta-data").is_err());
        assert!(validate_media_url("https://169.254.169.254/latest/meta-data").is_err());
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
    fn upgrade_image_upscales_small_renditions_and_forces_https() {
        // Launch-data album art: dashed size token, plain http.
        assert_eq!(
            upgrade_image("http://c.saavncdn.com/765/x-150x150.jpg"),
            "https://c.saavncdn.com/765/x-500x500.jpg"
        );
        // Artist art uses an underscored token and keeps its cache-buster.
        assert_eq!(
            upgrade_image("http://c.saavncdn.com/artists/A_150x150.jpg?bch=1"),
            "https://c.saavncdn.com/artists/A_500x500.jpg?bch=1"
        );
        // 50px variant and the x100 marker both land on the 500px master.
        assert_eq!(
            upgrade_image("https://c.saavncdn.com/x-50x50.jpg"),
            "https://c.saavncdn.com/x-500x500.jpg"
        );
        assert_eq!(
            upgrade_image("https://c.saavncdn.com/x-150x150x100.jpg"),
            "https://c.saavncdn.com/x-500x500.jpg"
        );
        // Already-maximal and size-less URLs pass through untouched.
        assert_eq!(
            upgrade_image("https://c.saavncdn.com/x-500x500.jpg"),
            "https://c.saavncdn.com/x-500x500.jpg"
        );
        assert_eq!(
            upgrade_image("https://c.saavncdn.com/editorial/E.jpg?bch=9"),
            "https://c.saavncdn.com/editorial/E.jpg?bch=9"
        );
    }

    #[test]
    fn placeholder_strings_never_reach_the_ui() {
        // The mirror answers "NULL" where a track has no artist/album; it
        // must read as absent, not as metadata text.
        let v = serde_json::json!({
            "artist": "NULL",
            "album": "null",
            "label": "  ",
            "year": "none",
            "language": "Tamil",
        });
        assert_eq!(text(&v, "artist"), None);
        assert_eq!(text(&v, "album"), None);
        assert_eq!(text(&v, "label"), None);
        assert_eq!(text(&v, "year"), None);
        assert_eq!(text(&v, "language").as_deref(), Some("Tamil"));
        assert_eq!(text(&serde_json::json!({"a": "N/A"}), "a"), None);
        assert_eq!(text(&serde_json::json!({"a": "-"}), "a"), None);
    }

    #[test]
    fn image_url_handles_both_string_and_rendition_array_payloads() {
        assert_eq!(
            image_url(&serde_json::json!("http://c.saavncdn.com/a-150x150.jpg")),
            "https://c.saavncdn.com/a-500x500.jpg"
        );
        let arr = serde_json::json!([
            {"quality": "150x150", "url": "https://c.saavncdn.com/a-150x150.jpg"},
            {"quality": "500x500", "url": "https://c.saavncdn.com/a-500x500.jpg"}
        ]);
        assert_eq!(
            image_url(&arr),
            "https://c.saavncdn.com/a-500x500.jpg",
            "array payloads pick the largest entry, not the first"
        );
        assert_eq!(image_url(&serde_json::Value::Null), "");
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
        // unknown entities pass through untouched — never guessed, never dropped
        assert_eq!(html_unescape("Love &foo; life"), "Love &foo; life");
        assert_eq!(html_unescape("&notreal"), "&notreal", "no terminator");
        assert_eq!(html_unescape("&amp; &unknown; &lt;"), "& &unknown; <");
    }

    // ---- Transport edge cases (review 5.1) — wiremock, runs offline ----

    use wiremock::matchers::{method, path as url_path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn ok_json() -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(serde_json::json!({"ok": true}))
    }

    /// 429 with a short `Retry-After` is honoured: one calm retry succeeds.
    #[tokio::test]
    async fn mirror_honours_short_retry_after_on_429() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(url_path("/api/test"))
            .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "0"))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(url_path("/api/test"))
            .respond_with(ok_json())
            .mount(&server)
            .await;

        let base = server.uri();
        let json = get_json_from(&api_client(), &[base.as_str()], "/api/test")
            .await
            .expect("429 then 200 succeeds");
        assert_eq!(json["ok"], true);
        assert_eq!(
            server.received_requests().await.unwrap().len(),
            2,
            "exactly one retry"
        );
    }

    /// A long `Retry-After` is not waited out — the next mirror (its own
    /// budget) answers instead, and the rate-limited host is hit once.
    #[tokio::test]
    async fn long_retry_after_falls_through_to_next_mirror() {
        let slow = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(429).insert_header("Retry-After", "3600"))
            .mount(&slow)
            .await;
        let fast = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ok_json())
            .mount(&fast)
            .await;

        let slow_uri = slow.uri();
        let fast_uri = fast.uri();
        let json = get_json_from(
            &api_client(),
            &[slow_uri.as_str(), fast_uri.as_str()],
            "/api/test",
        )
        .await
        .expect("second mirror answers");
        assert_eq!(json["ok"], true);
        assert_eq!(
            slow.received_requests().await.unwrap().len(),
            1,
            "no blind retry against a host that asked us to back off"
        );
    }

    /// 429 without `Retry-After` costs one request against that host —
    /// retrying the same mirror only extends the penalty.
    #[tokio::test]
    async fn bare_429_costs_exactly_one_request_then_fails() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(429))
            .mount(&server)
            .await;

        let base = server.uri();
        let err = get_json_from(&api_client(), &[base.as_str()], "/api/test")
            .await
            .expect_err("rate limit with no guidance fails");
        assert!(err.contains("429"), "{err}");
        assert_eq!(server.received_requests().await.unwrap().len(), 1);
    }

    /// 503 is retried with the jittered backoff and can succeed.
    #[tokio::test]
    async fn server_error_retries_with_backoff_then_succeeds() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .respond_with(ok_json())
            .mount(&server)
            .await;

        let base = server.uri();
        let json = get_json_from(&api_client(), &[base.as_str()], "/api/test")
            .await
            .expect("503 then 200 succeeds");
        assert_eq!(json["ok"], true);
        assert_eq!(server.received_requests().await.unwrap().len(), 2);
    }

    /// Bodies over 10 MB are refused before serde ever sees them (5.5).
    #[tokio::test]
    async fn oversized_mirror_body_is_refused_before_parse() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(vec![b'x'; MAX_JSON_BYTES + 1]))
            .mount(&server)
            .await;

        let base = server.uri();
        let err = get_json_from(&api_client(), &[base.as_str()], "/api/test")
            .await
            .expect_err("oversized body refused");
        assert!(err.contains("oversized"), "{err}");
    }

    /// A 200 carrying HTML (captive portal / intercepting proxy) fails as a
    /// decode error — never a panic, never cached.
    #[tokio::test]
    async fn html_body_from_interceptor_fails_cleanly() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_raw("<html><body>Sign in to continue</body></html>", "text/html"),
            )
            .mount(&server)
            .await;

        let base = server.uri();
        let err = get_json_from(&api_client(), &[base.as_str()], "/api/test")
            .await
            .expect_err("html is not json");
        assert!(err.contains("decode"), "{err}");
    }

    /// A circular redirect aborts after the configured handful of hops
    /// (Policy::limited(5)), not reqwest's default ten.
    #[tokio::test]
    async fn redirect_loop_aborts_after_five_hops() {
        let server = MockServer::start().await;
        let uri = server.uri();
        Mock::given(method("GET"))
            .and(url_path("/loop"))
            .respond_with(
                ResponseTemplate::new(302)
                    .insert_header("location", format!("{uri}/loop").as_str()),
            )
            .mount(&server)
            .await;

        let resp = api_client().get(format!("{uri}/loop")).send().await;
        assert!(resp.is_err(), "redirect loop must abort, not spin");
        let hops = server.received_requests().await.unwrap().len();
        assert!(hops <= 7, "bounded hops (got {hops}, default policy is 10)");
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
            .expect("live search must succeed")
            .tracks;
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
            .expect("search")
            .tracks;
        let song = fetch_song(&client, &tracks[0].id).await.expect("resolve");
        assert!(!song.qualities.is_empty());
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
