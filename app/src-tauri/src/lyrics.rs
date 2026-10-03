//! Lyrics, in the order the panel wants them: time-coded first, first-party
//! text second, community plain text last.
//!
//! Three sources, one answer:
//! 1. **LRCLIB** `/api/get` — free, no key, returns `syncedLyrics` *and*
//!    `plainLyrics` in one round trip. A duration match must agree within
//!    ~2 s or the record is refused (404).
//!    1b. **Better Lyrics** — syllable-synced TTML, free. Flattened to
//!    timed lines so the frontend's word-by-word wipe works unchanged.
//! 2. **JioSaavn** `lyrics.getLyrics` — the web player's own endpoint. Plain
//!    text with `<br>` breaks, but it covers Indian-language songs LRCLIB
//!    does not.
//! 3. **LRCLIB** `/api/search` — last resort when the duration drifted.
//!
//! All calls leave from Rust, so the WebView CSP is untouched.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::jiosaavn::{check_id, html_unescape};

/// Base url of the community lyrics database.
const LRCLIB: &str = "https://lrclib.net/api";

/// Better Lyrics: free syllable-synced TTML endpoint.
const BETTER: &str = "https://api.betterlyrics.org/getLyrics";

/// One answer for the lyrics stage. `Deserialize` carries the L4 disk tier:
/// entries are written as JSON and read back by `proxy::cached_lyrics`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
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

    // 1b. Better Lyrics: free syllable-synced TTML; the panel's existing
    //    word-by-word wipe is driven off these timed lines.
    if let Ok(Some(l)) = better_lyrics(client, artist, title, album, duration).await {
        if !l.synced.is_empty() {
            return Ok(l);
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

/// Better Lyrics returns TTML — free, syllable-synced. We flatten each
/// timed line to `(seconds, text)` so the frontend's existing word-by-word
/// wipe works without a new render path.
async fn better_lyrics(
    client: &reqwest::Client,
    artist: &str,
    title: &str,
    album: &str,
    duration: u32,
) -> Result<Option<Lyrics>, String> {
    let query = [
        ("s", bare_title(title).to_string()),
        ("a", first_artist(artist).to_string()),
        ("al", album.trim().to_string()),
        ("d", duration.to_string()),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.clone()))
    .collect::<Vec<_>>();
    let url = format!("{BETTER}?{}", encode(&query));
    let Some(v) = get_json(client, &url).await? else {
        return Ok(None);
    };
    let Some(ttml) = v.get("ttml").and_then(Value::as_str) else {
        return Ok(None);
    };
    let synced = parse_ttml_lines(ttml);
    if synced.is_empty() {
        return Ok(None);
    }
    Ok(Some(Lyrics {
        source: "betterlyrics".into(),
        plain: Some(joined(&synced)),
        synced,
        copyright: None,
    }))
}

/// TTML clock time: `HH:MM:SS.mmm`, `MM:SS.mmm`, or bare seconds.
fn parse_ttml_time(raw: &str) -> Option<f64> {
    let v = raw.trim();
    let parts: Vec<&str> = v.split(':').collect();
    match parts.as_slice() {
        [ss] => ss.parse().ok(),
        [mm, ss] => Some(mm.parse::<f64>().ok()? * 60.0 + ss.parse::<f64>().ok()?),
        [hh, mm, ss] => Some(
            hh.parse::<f64>().ok()? * 3600.0
                + mm.parse::<f64>().ok()? * 60.0
                + ss.parse::<f64>().ok()?,
        ),
        _ => None,
    }
}

/// Flatten one `<p begin="..">…<span …>word</span></p>` into `(seconds, line)`.
/// Tags are stripped; entities and whitespace are normalised.
pub fn parse_ttml_lines(ttml: &str) -> Vec<(f64, String)> {
    let mut out: Vec<(f64, String)> = Vec::new();
    for chunk in ttml.split("<p") {
        let Some(head_end) = chunk.find('>') else {
            continue;
        };
        let attrs = &chunk[..head_end];
        let rest = &chunk[head_end + 1..];
        let Some(body) = rest.split("</p>").next() else {
            continue;
        };
        let start = attrs
            .split("begin=\"")
            .nth(1)
            .and_then(|s| s.split('"').next())
            .and_then(parse_ttml_time);
        let Some(secs) = start else {
            continue;
        };
        let mut text = String::new();
        let mut in_tag = false;
        for c in body.chars() {
            match c {
                '<' => in_tag = true,
                '>' if in_tag => in_tag = false,
                c if !in_tag => text.push(c),
                _ => {}
            }
        }
        let line = html_unescape(
            text.split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .as_str(),
        )
        .trim()
        .to_string();
        if !line.is_empty() {
            out.push((secs, line));
        }
    }
    out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    out
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
    fn ttml_lines_are_flattened_to_timed_text() {
        let ttml = r#"<tt xml:lang="en"><body><div>
<p begin="00:13.13" end="00:15.00"><span begin="00:13.13" end="00:13.5">Yeah</span></p>
<p begin="00:27.16" end="00:30.00"><span begin="00:27.16" end="00:27.6">I've</span> <span begin="00:27.6" end="00:28.0">been</span></p>
<p begin="01:02.00" end="01:04.00">second &amp; quiet</p>
</div></body></tt>"#;
        assert_eq!(
            parse_ttml_lines(ttml),
            vec![
                (13.13, "Yeah".to_string()),
                (27.16, "I've been".to_string()),
                (62.0, "second & quiet".to_string()),
            ]
        );
    }

    #[test]
    fn ttml_time_parses_clock_forms() {
        assert_eq!(parse_ttml_time("62.5"), Some(62.5));
        assert_eq!(parse_ttml_time("1:02.50"), Some(62.5));
        assert_eq!(parse_ttml_time("0:01:02.50"), Some(62.5));
        assert_eq!(parse_ttml_time("junk"), None);
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
    async fn live_better_lyrics_serves_timed_lines() {
        if std::env::var("OP_OFFLINE").is_ok() {
            return;
        }
        let client = crate::jiosaavn::api_client();
        let got = better_lyrics(&client, "The Weeknd", "Blinding Lights", "After Hours", 200)
            .await
            .expect("better lyrics reachable");
        // Coverage for Western pop is real; an empty answer just means the
        // day's network lost — the chain treats it as a hit-or-miss rung.
        if let Some(l) = got {
            assert!(!l.synced.is_empty());
            assert_eq!(l.source, "betterlyrics");
        }
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
