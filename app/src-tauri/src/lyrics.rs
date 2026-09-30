//! Lyrics, in the order the panel wants them: time-coded first, first-party
//! text second, community plain text last.
//!
//! Three sources, one answer:
//! 1. **LRCLIB** `/api/get` — free, no key, returns `syncedLyrics` *and*
//!    `plainLyrics` in one round trip. A duration match must agree within
//!    ~2 s or the record is refused (404).
//! 2. **JioSaavn** `lyrics.getLyrics` — the web player's own endpoint. Plain
//!    text with `<br>` breaks, but it covers Indian-language songs LRCLIB
//!    does not.
//! 3. **LRCLIB** `/api/search` — last resort when the duration drifted.
//!
//! All calls leave from Rust, so the WebView CSP is untouched.

use serde::Serialize;
use serde_json::Value;

use crate::jiosaavn::{check_id, html_unescape};

/// Base url of the community lyrics database.
const LRCLIB: &str = "https://lrclib.net/api";

/// One answer for the lyrics stage.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct Lyrics {
    /// `"lrclib"` | `"jiosaavn"` | `"none"`.
    pub source: String,
    pub plain: Option<String>,
    /// `(seconds, line)` parsed out of an LRC body, ascending.
    pub synced: Vec<(f64, String)>,
    pub copyright: Option<String>,
}

impl Lyrics {
    /// True when there is something to draw. Empty results are **not**
    /// memoised: a provider that was down must not be remembered as "this
    /// song has no lyrics" (see `proxy.rs::cached_lyrics`).
    pub fn has_content(&self) -> bool {
        self.plain.is_some() || !self.synced.is_empty()
    }
}

/// A raw LRCLIB record, before it is chosen between.
#[derive(Clone)]
struct Hit {
    plain: Option<String>,
    synced: Vec<(f64, String)>,
    /// LRCLIB's own `duration` field, when the record carries one.
    duration: Option<f64>,
}

impl Hit {
    fn is_empty(&self) -> bool {
        self.plain.is_none() && self.synced.is_empty()
    }

    /// Verify the record actually belongs to this track: LRCLIB matches on
    /// duration, but its tolerance is a server-side detail we should not
    /// trust blindly. A record without a duration cannot disagree.
    fn duration_ok(&self, wanted: u32) -> bool {
        match self.duration {
            None => true,
            Some(d) => (d - f64::from(wanted)).abs() <= 3.0,
        }
    }
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

/// Fetch the best lyrics available for one track.
pub async fn fetch(
    client: &reqwest::Client,
    id: &str,
    title: &str,
    artist: &str,
    album: &str,
    duration: u32,
) -> Result<Lyrics, String> {
    check_id(id)?;

    // ponytail: a provider that errors here is swallowed, not retried — the
    // empty answer is uncached, so the next play of this track retries it.
    // Upgrade path: surface the last error on the panel if it ever matters.

    // 1. LRCLIB exact record: synced and plain in one call.
    let hit = lrclib_get(client, artist, title, album, duration)
        .await
        .unwrap_or(None);
    if let Some(h) = &hit {
        if h.duration_ok(duration) && !h.synced.is_empty() {
            return Ok(from_hit(h));
        }
    }

    // 2. First-party plain text — the source Indian-language songs live on.
    if let Ok(Some((plain, copyright))) = crate::official::lyrics(client, id).await {
        return Ok(Lyrics {
            source: "jiosaavn".into(),
            plain: Some(plain),
            synced: Vec::new(),
            copyright,
        });
    }

    // 3. LRCLIB plain from the record we already hold: no extra request.
    //    Same duration gate as step 1 — a record for the wrong cut of the
    //    song is worse than no record at all.
    if let Some(h) = &hit {
        if h.duration_ok(duration) && !h.is_empty() {
            return Ok(from_hit(h));
        }
    }

    // 4. Duration missed the ±2 s window — search by text instead.
    if let Some(h) = lrclib_search(client, artist, title).await.unwrap_or(None) {
        if !h.is_empty() {
            return Ok(from_hit(&h));
        }
    }

    Ok(Lyrics {
        source: "none".into(),
        ..Lyrics::default()
    })
}

fn from_hit(h: &Hit) -> Lyrics {
    Lyrics {
        source: "lrclib".into(),
        plain: h
            .plain
            .clone()
            .or_else(|| Some(joined(&h.synced)).filter(|s| !s.is_empty())),
        synced: h.synced.clone(),
        copyright: None,
    }
}

fn joined(synced: &[(f64, String)]) -> String {
    synced
        .iter()
        .map(|(_, line)| line.as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

// ---------------------------------------------------------------------------
// LRCLIB
// ---------------------------------------------------------------------------

async fn lrclib_get(
    client: &reqwest::Client,
    artist: &str,
    title: &str,
    album: &str,
    duration: u32,
) -> Result<Option<Hit>, String> {
    let dur = duration.to_string();
    let query = [
        ("artist_name", first_artist(artist).to_string()),
        ("track_name", bare_title(title).to_string()),
        ("album_name", album.trim().to_string()),
        ("duration", dur),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.clone()))
    .collect::<Vec<_>>();
    let url = format!("{LRCLIB}/get?{}", encode(&query));
    match get_json(client, &url).await? {
        Some(v) => Ok(Some(record(&v))),
        None => Ok(None),
    }
}

async fn lrclib_search(
    client: &reqwest::Client,
    artist: &str,
    title: &str,
) -> Result<Option<Hit>, String> {
    let q = format!("{} {}", first_artist(artist), bare_title(title));
    let url = format!("{LRCLIB}/search?{}", encode(&[("q".to_string(), q)]));
    let Some(v) = get_json(client, &url).await? else {
        return Ok(None);
    };
    Ok(v.as_array()
        .into_iter()
        .flatten()
        .map(record)
        .find(|h| !h.is_empty()))
}

/// GET with the two statuses LRCLIB uses for "not here": `200` and `404`.
async fn get_json(client: &reqwest::Client, url: &str) -> Result<Option<Value>, String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("{url} -> HTTP {}", resp.status()));
    }
    let body = resp.text().await.map_err(|e| format!("read {url}: {e}"))?;
    serde_json::from_str(&body).map_err(|e| format!("decode {url}: {e}"))
}

fn record(v: &Value) -> Hit {
    let plain = v
        .get("plainLyrics")
        .and_then(Value::as_str)
        .map(html_unescape)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let synced = v
        .get("syncedLyrics")
        .and_then(Value::as_str)
        .map(parse_lrc)
        .unwrap_or_default();
    Hit {
        plain,
        synced,
        duration: v.get("duration").and_then(Value::as_f64),
    }
}

fn encode(pairs: &[(String, String)]) -> String {
    let mut ser = url::form_urlencoded::Serializer::new(String::new());
    ser.extend_pairs(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    ser.finish()
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/// `Kesariya (From "Brahmastra")` -> `Kesariya`: LRCLIB keys on the release
/// title, not the storefront decoration JioSaavn appends to it.
fn bare_title(title: &str) -> &str {
    let cut = title.split(['(', '[']).next().unwrap_or(title);
    cut.trim()
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '-' || c == ' ')
}

/// Only the lead artist: LRCLIB stores one artist per record.
fn first_artist(artist: &str) -> &str {
    artist.split(',').next().unwrap_or(artist).trim()
}

// ---------------------------------------------------------------------------
// LRC
// ---------------------------------------------------------------------------

/// Parse `[mm:ss.xx] line` into `(seconds, line)`, ascending.
///
/// Metadata tags (`[ar:Artist]`), untimed lines and lines without a stamp
/// are dropped; a line carrying several stamps is emitted once per stamp.
pub fn parse_lrc(src: &str) -> Vec<(f64, String)> {
    let mut out: Vec<(f64, String)> = Vec::new();
    for raw in src.lines() {
        let mut rest = raw.trim();
        let mut stamps = Vec::new();
        while let Some(after_bracket) = rest.strip_prefix('[') {
            let Some((stamp, tail)) = after_bracket.split_once(']') else {
                break;
            };
            match parse_stamp(stamp) {
                Some(secs) => {
                    stamps.push(secs);
                    rest = tail.trim();
                }
                None => break,
            }
        }
        if stamps.is_empty() || rest.is_empty() {
            continue;
        }
        for secs in stamps {
            out.push((secs, rest.to_string()));
        }
    }
    out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// `1:02.50` -> `62.5`. Rejects anything that is not a clock, which is what
/// makes `[ar:Artist]` fall out for free; a negative minute count is a
/// broken stamp too — such a line would sort before zero and never highlight.
fn parse_stamp(stamp: &str) -> Option<f64> {
    let (minutes, seconds) = stamp.trim().split_once(':')?;
    let minutes: f64 = minutes.trim().parse().ok()?;
    let seconds: f64 = seconds.trim().parse().ok()?;
    if minutes < 0.0 || !(0.0..60.0).contains(&seconds) {
        return None;
    }
    Some(minutes * 60.0 + seconds)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_lrc_reads_stamps_and_drops_metadata() {
        let src = "[ar:The Weeknd]\n[ti:Blinding Lights]\n[00:13.13] Yeah\n[00:27.16] I've been tryna call\n\nno stamp here\n[01:02] second";
        let lines = parse_lrc(src);
        assert_eq!(
            lines,
            vec![
                (13.13, "Yeah".to_string()),
                (27.16, "I've been tryna call".to_string()),
                (62.0, "second".to_string()),
            ]
        );
    }

    #[test]
    fn parse_lrc_emits_one_entry_per_stamp_and_sorts() {
        let lines = parse_lrc("[00:30.00][00:10.00] chorus\n[00:05] intro");
        assert_eq!(
            lines,
            vec![
                (5.0, "intro".to_string()),
                (10.0, "chorus".to_string()),
                (30.0, "chorus".to_string()),
            ]
        );
    }

    #[test]
    fn parse_lrc_drops_negative_and_malformed_stamps() {
        let lines =
            parse_lrc("[-01:30] before zero\n[00:00.00] start\n[-2:-5] broken\n[00:75] broken too");
        assert_eq!(lines, vec![(0.0, "start".to_string())]);
    }

    #[test]
    fn lrclib_records_are_gated_on_duration() {
        let close = Hit {
            plain: Some("x".into()),
            synced: Vec::new(),
            duration: Some(199.0),
        };
        let far = Hit {
            duration: Some(240.0),
            ..close.clone()
        };
        let unknown = Hit {
            duration: None,
            ..close.clone()
        };
        assert!(close.duration_ok(200));
        assert!(!far.duration_ok(200));
        assert!(unknown.duration_ok(200));
    }

    #[test]
    fn store_titles_are_stripped_to_what_lrclib_indexes() {
        assert_eq!(bare_title(r#"Kesariya (From "Brahmastra")"#), "Kesariya");
        assert_eq!(bare_title("Manasaagadhe"), "Manasaagadhe");
        assert_eq!(
            first_artist("Tanishk Bagchi, Arslan Nizami"),
            "Tanishk Bagchi"
        );
    }

    #[test]
    fn empty_results_have_no_content() {
        assert!(!Lyrics::default().has_content());
        let l = Lyrics {
            source: "none".into(),
            plain: None,
            synced: Vec::new(),
            copyright: None,
        };
        assert!(!l.has_content());
    }

    // ---- Live contract tests (require network) ----

    #[tokio::test]
    async fn live_first_party_lyrics_cover_an_indian_track() {
        if std::env::var("OP_OFFLINE").is_ok() {
            return;
        }
        let client = crate::jiosaavn::api_client();
        let tracks = crate::jiosaavn::search_songs(&client, "manasaagadhe", 1, 1)
            .await
            .expect("search")
            .tracks;
        let t = &tracks[0];
        let lyrics = fetch(
            &client,
            &t.id,
            &t.title,
            &t.artist,
            &t.album,
            t.duration_secs as u32,
        )
        .await
        .expect("lyrics");
        assert!(lyrics.has_content(), "JioSaavn must answer for this song");
        let body = lyrics.plain.unwrap_or_default();
        assert!(!body.contains("<br>"), "line breaks must be converted");
        assert!(body.lines().count() > 3, "a song has more than three lines");
    }

    #[tokio::test]
    async fn live_lrclib_returns_time_coded_lines_for_a_known_track() {
        if std::env::var("OP_OFFLINE").is_ok() {
            return;
        }
        let client = crate::jiosaavn::api_client();
        let hit = lrclib_get(&client, "The Weeknd", "Blinding Lights", "After Hours", 200)
            .await
            .expect("lrclib reachable")
            .expect("record exists");
        assert!(!hit.synced.is_empty(), "LRC body must parse");
        assert!(!hit.synced[0].1.is_empty());
        assert!(hit.plain.is_some());
    }
}
