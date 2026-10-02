//! Audio encoding for the offline vault: source rendition -> Opus, EBU R128.
//!
//! Owns: finding ffmpeg, the two-pass `loudnorm` measurement, the Opus encode
//! and the bitrate mapping. Knows nothing about HTTP (`proxy.rs`) or the
//! command surface (`lib.rs`).
//!
//! ponytail: uses whatever ffmpeg is on PATH and stores the source rendition
//! untouched when there is none — no sidecar download, no zip extraction, no
//! platform paths. Add a bundled/lazy-downloaded ffmpeg only when users
//! without one become a support burden; upgrade path is a `ffmpeg_path()`
//! override that checks an app-data directory first.

use std::path::Path;
use std::process::Stdio;

use tokio::process::Command;

/// Loudness target: -16 LUFS integrated, -1.5 dBTP ceiling, 11 LU range —
/// the usual streaming normalization (Spotify/Apple Music ballpark).
const TARGET_I: &str = "-16";
const TARGET_TP: &str = "-1.5";
const TARGET_LRA: &str = "11";

/// ffmpeg's binary name on this platform.
#[cfg(windows)]
const FFMPEG: &str = "ffmpeg.exe";
#[cfg(not(windows))]
const FFMPEG: &str = "ffmpeg";

/// Is an encoder available at all? Callers use this to decide between
/// "encode to Opus" and "keep the source rendition".
pub fn available() -> bool {
    ffmpeg_path().is_some()
}

/// Locate ffmpeg: `$FFMPEG` if set, else the first hit on PATH.
pub fn ffmpeg_path() -> Option<std::path::PathBuf> {
    if let Ok(custom) = std::env::var("FFMPEG") {
        let p = std::path::PathBuf::from(custom);
        if p.is_file() {
            return Some(p);
        }
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(FFMPEG))
        .find(|candidate| candidate.is_file())
}

/// Loudness figures ffmpeg measured in pass 1, echoed back into pass 2 so the
/// gain is a single linear adjustment instead of dynamic limiting (no
/// pumping). Missing fields degrade to dynamic mode rather than failing.
#[derive(Debug, Default, PartialEq)]
pub struct Measured {
    pub input_i: String,
    pub input_tp: String,
    pub input_lra: String,
    pub input_thresh: String,
    pub target_offset: String,
}

impl Measured {
    /// True when every field needed for a linear pass is present.
    pub fn complete(&self) -> bool {
        !self.input_i.is_empty()
            && !self.input_tp.is_empty()
            && !self.input_lra.is_empty()
            && !self.input_thresh.is_empty()
            && !self.target_offset.is_empty()
    }

    /// The `loudnorm` filter for pass 2. `linear=true` when the measurement
    /// is usable — ffmpeg refuses a linear pass it cannot satisfy, so an
    /// unusable measurement falls back to plain dynamic normalization.
    fn pass2_filter(&self) -> String {
        let base = format!("loudnorm=I={TARGET_I}:TP={TARGET_TP}:LRA={TARGET_LRA}");
        if self.complete() {
            format!(
                "{base}:measured_I={}:measured_TP={}:measured_LRA={}:measured_thresh={}:offset={}:linear=true",
                self.input_i,
                self.input_tp,
                self.input_lra,
                self.input_thresh,
                self.target_offset
            )
        } else {
            format!("{base}:print_format=summary")
        }
    }
}

/// Pull the measurement object out of ffmpeg's stderr.
///
/// `loudnorm` prints the JSON as the last `{ ... }` block, unindented from the
/// rest of the log. Values are strings; only numbers pass through.
pub fn parse_measurement(stderr: &str) -> Measured {
    Measured {
        input_i: measured_value(stderr, "input_i"),
        input_tp: measured_value(stderr, "input_tp"),
        input_lra: measured_value(stderr, "input_lra"),
        input_thresh: measured_value(stderr, "input_thresh"),
        target_offset: measured_value(stderr, "target_offset"),
    }
}

/// One `"key": "value"` pair from the measurement JSON, or empty when it is
/// missing or not a number (`-inf` shows up on silence).
fn measured_value(stderr: &str, key: &str) -> String {
    let Some(after) = stderr.split(&format!("\"{key}\"")).nth(1) else {
        return String::new();
    };
    let Some(colon) = after.find(':') else {
        return String::new();
    };
    let rest = after[colon + 1..].trim_start();
    let Some(rest) = rest.strip_prefix('"') else {
        return String::new();
    };
    let Some(end) = rest.find('"') else {
        return String::new();
    };
    let value = &rest[..end];
    // `-inf`/`inf` parse as floats but cannot drive a filter argument — a
    // silent source measures that way, and ffmpeg wants the field dropped.
    match value.parse::<f64>() {
        Ok(n) if n.is_finite() => value.to_string(),
        _ => String::new(),
    }
}

/// Which JioSaavn rendition to feed the encoder.
///
/// Encoding from the best available source costs the same download as a
/// smaller one and keeps the most for the encoder to work with, so the target
/// Opus bitrate never limits the input. Without an encoder there is no
/// re-encode to hide behind, and the closest native rendition is the only
/// knob — so the target picks the source instead.
pub fn source_rendition(target_kbps: u32, encode: bool) -> &'static str {
    if encode {
        "320kbps"
    } else {
        match target_kbps {
            0..=63 => "48kbps",
            64..=95 => "96kbps",
            96..=127 => "96kbps",
            _ => "320kbps",
        }
    }
}

/// Encode `input` to Opus in `output` at `target_kbps`, normalized to -16 LUFS.
///
/// Returns the encoded size in bytes. Decode/encode happen exactly once each:
/// pass 1 measures and discards its output, pass 2 re-decodes the source.
/// A failed *linear* pass 2 is retried dynamically rather than failing the
/// download — the file is already on disk either way.
pub async fn encode_opus(input: &Path, output: &Path, target_kbps: u32) -> Result<u64, String> {
    let ffmpeg = ffmpeg_path().ok_or_else(|| "ffmpeg not found".to_string())?;
    let src = input.to_string_lossy().into_owned();
    let dst = output.to_string_lossy().into_owned();

    // Pass 1 — measure. Output is thrown away; only stderr matters.
    let measured = Command::new(&ffmpeg)
        .args(["-hide_banner", "-nostdin", "-i"])
        .arg(&src)
        .args([
            "-af",
            &format!("loudnorm=I={TARGET_I}:TP={TARGET_TP}:LRA={TARGET_LRA}:print_format=json"),
            "-f",
            "null",
            "-",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("loudnorm measure: {e}"))?;
    let measured = parse_measurement(&String::from_utf8_lossy(&measured.stderr));

    let mut filter = measured.pass2_filter();
    let mut last_err = String::new();
    for attempt in 0..2 {
        if attempt == 1 {
            // Linear normalization was refused: redo the pass dynamically.
            filter = format!("loudnorm=I={TARGET_I}:TP={TARGET_TP}:LRA={TARGET_LRA}");
        }
        let out = Command::new(&ffmpeg)
            .args(["-hide_banner", "-nostdin", "-y", "-i"])
            .arg(&src)
            .args(["-af", &filter, "-c:a", "libopus", "-application", "audio"])
            .args(["-b:a", &format!("{target_kbps}k"), "-vbr", "on"])
            .args(["-compression_level", "10", &dst])
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .await
            .map_err(|e| format!("opus encode: {e}"))?;
        if out.status.success() {
            return tokio::fs::metadata(output)
                .await
                .map(|m| m.len())
                .map_err(|e| format!("stat {}: {e}", output.display()));
        }
        last_err = tail(&String::from_utf8_lossy(&out.stderr));
    }
    // A half-written file is never left behind to look playable.
    let _ = tokio::fs::remove_file(output).await;
    Err(format!("opus encode failed: {last_err}"))
}

/// Content-Type for a vault file, by extension.
pub fn content_type(ext: Option<&str>) -> &'static str {
    match ext.map(str::to_ascii_lowercase).as_deref() {
        Some("mp3") => "audio/mpeg",
        Some("opus") | Some("ogg") => "audio/ogg",
        _ => "audio/mp4",
    }
}

/// Last few stderr lines — ffmpeg's useful error is always at the end.
fn tail(stderr: &str) -> String {
    stderr
        .lines()
        .rev()
        .take(3)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" | ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
[Parsed_loudnorm_0 @ 0000] 
{
	"input_i" : "-12.34",
	"input_tp" : "0.56",
	"input_lra" : "8.20",
	"input_thresh" : "-22.10",
	"output_i" : "-16.00",
	"target_offset" : "0.12"
}
"#;

    #[test]
    fn measurement_reads_the_last_json_block() {
        let m = parse_measurement(SAMPLE);
        // Values pass through exactly as ffmpeg printed them — ffmpeg parses
        // the strings, so re-formatting them would only risk precision drift.
        assert_eq!(m.input_i, "-12.34");
        assert_eq!(m.input_tp, "0.56");
        assert_eq!(m.input_lra, "8.20");
        assert_eq!(m.input_thresh, "-22.10");
        assert_eq!(m.target_offset, "0.12");
        assert!(m.complete());
    }

    #[test]
    fn a_log_without_measurements_degrades_instead_of_panicking() {
        let m = parse_measurement("ffmpeg: command not found\n");
        assert!(!m.complete());
        assert!(m.pass2_filter().contains("I=-16"));
    }

    /// Silence measures as `-inf`, which parses as a float but is not a value
    /// a filter argument can carry.
    #[test]
    fn non_finite_values_are_dropped() {
        let m = parse_measurement(r#"{"input_i" : "-inf", "target_offset" : "0.1"}"#);
        assert!(m.input_i.is_empty());
        assert!(!m.complete());
        assert!(m.pass2_filter().contains("print_format=summary"));
    }

    #[test]
    fn encoding_takes_the_best_source() {
        assert_eq!(source_rendition(64, true), "320kbps");
        assert_eq!(source_rendition(128, true), "320kbps");
    }

    /// Without an encoder the target bitrate is the only knob left.
    #[test]
    fn no_encoder_maps_the_target_onto_a_native_rendition() {
        assert_eq!(source_rendition(64, false), "96kbps");
        assert_eq!(source_rendition(96, false), "96kbps");
        assert_eq!(source_rendition(128, false), "320kbps");
        assert_eq!(source_rendition(32, false), "48kbps");
    }

    #[test]
    fn opus_is_served_as_ogg() {
        assert_eq!(content_type(Some("opus")), "audio/ogg");
        assert_eq!(content_type(Some("OPUS")), "audio/ogg");
        assert_eq!(content_type(Some("mp3")), "audio/mpeg");
        assert_eq!(content_type(Some("m4a")), "audio/mp4");
        assert_eq!(content_type(None), "audio/mp4");
    }
}
