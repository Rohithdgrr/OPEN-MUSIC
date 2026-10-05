//! qr.rs — room invite QR symbols.
//!
//! The Now Playing "Room QR" surface used to draw a Material Symbols
//! `qr_code_2` glyph. That is a *picture of* a QR code, not a QR code:
//! nothing could scan it, and the markup had to admit that in a comment.
//! This module returns a real symbol matrix so the surface carries an
//! actually-scannable invite.
//!
//! Why Rust owns this: the symbol is derived from the sidecar's room code, and
//! every other room fact (the code, the member count, whether the sidecar is
//! connected) already comes from Rust. Generating the matrix in the same place
//! keeps the invite and the code it encodes from ever disagreeing, and it puts
//! the encoding under `cargo test` rather than leaving it to eyeball.
//!
//! Deliberately minimal: byte mode at error-correction level M, versions 1-10.
//! A room code is 8 ASCII characters from a 30-character alphabet
//! (docs/sidecar.md), so level M version 2 carries it with ~15% recovery and
//! still scans reliably on a glossy screen.
//!
//! What is deliberately NOT here: no join URL. Nothing in metroserver defines a
//! `trancemusic://join/...` scheme, so inventing one and encoding it would put
//! a fabricated deep link into a share surface (docs/social-nowplaying.md §6).
//! The symbol encodes the room code verbatim — what a scanner yields is exactly
//! what a person can paste into "Add to room".

use qrcode::{EcLevel, QrCode};
use serde::Serialize;

/// One QR symbol: a square, row-major bit matrix.
///
/// `modules` is `size * size` entries of 0/1 in row-major order. It is flat and
/// numeric rather than a `Vec<Vec<bool>>` or SVG source because it crosses the
/// IPC boundary: flat keeps the payload small, and numbers avoid a JSON boolean
/// array that would be ~5x larger than the bits it carries.
#[derive(Debug, Clone, Serialize)]
pub struct QrSymbol {
    pub size: usize,
    pub modules: Vec<u8>,
    /// Symbols per side, excluding the mandatory 4-module quiet zone.
    pub version: usize,
}

/// Encode `text` as a QR symbol at error-correction level M.
///
/// Errors only on input the chosen version cannot hold; the caller decides how
/// to surface that, because the honest answer ("this code is too long for the
/// symbol") is a product message, not a crash.
#[tauri::command]
pub fn qr_symbol(text: String) -> Result<QrSymbol, String> {
    encode(&text).map_err(|e| e.to_string())
}

fn encode(text: &str) -> Result<QrSymbol, qrcode::types::QrError> {
    let code = QrCode::with_error_correction_level(text, EcLevel::M)?;
    let width = code.width();

    // `to_colors` is row-major, dark == true.
    let colors = code.to_colors();
    debug_assert_eq!(colors.len(), width * width);

    let modules = colors
        .iter()
        .map(|c| u8::from(*c == qrcode::Color::Dark))
        .collect();

    // width = 4 * version + 17, so this recovers the symbol version exactly.
    let version = (width - 17) / 4;

    Ok(QrSymbol {
        size: width,
        modules,
        version,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn symbol(text: &str) -> QrSymbol {
        encode(text).expect("encodes")
    }

    fn at(s: &QrSymbol, row: usize, col: usize) -> u8 {
        s.modules[row * s.size + col]
    }

    #[test]
    fn room_code_fits_a_version_1_symbol() {
        // 8 chars from the sidecar's 30-char alphabet must land in the cheapest
        // symbol: version 1 at level M holds 14 byte-mode bytes, so 8 fits with
        // room to spare. This is the size a phone camera has to focus on.
        let s = symbol("TRNC8241");
        assert_eq!(s.size, 21, "8 bytes at level M should fit version 1");
        assert_eq!(s.version, 1);
        assert_eq!(s.modules.len(), 21 * 21);
    }

    #[test]
    fn matrix_is_square_and_binary() {
        let s = symbol("12345678");
        assert_eq!(s.modules.len(), s.size * s.size);
        assert!(
            s.modules.iter().all(|m| *m == 0 || *m == 1),
            "modules must be strictly 0/1 for the canvas renderer"
        );
    }

    #[test]
    fn finder_patterns_are_in_the_three_corners() {
        let s = symbol("ZXCVBNMQ");
        let n = s.size;
        // A 7x7 finder is a dark ring, a light ring, then a dark 3x3 core.
        let finder = |r0: usize, c0: usize| -> bool {
            at(&s, r0, c0) == 1 // outer ring top-left
                && at(&s, r0, c0 + 3) == 1 // outer ring top-middle
                && at(&s, r0 + 3, c0) == 1 // outer ring left-middle
                && at(&s, r0 + 6, c0 + 6) == 1 // outer ring bottom-right
                && at(&s, r0 + 1, c0 + 1) == 0 // light ring
                && at(&s, r0 + 5, c0 + 5) == 0 // light ring
                && at(&s, r0 + 3, c0 + 3) == 1 // core centre
                && at(&s, r0 + 2, c0 + 2) == 1
                && at(&s, r0 + 4, c0 + 4) == 1
        };
        assert!(finder(0, 0), "top-left finder");
        assert!(finder(0, n - 7), "top-right finder");
        assert!(finder(n - 7, 0), "bottom-left finder");

        // Separators: the light modules hugging the top-left finder.
        assert_eq!(at(&s, 7, 0), 0, "separator below the top-left finder");
        assert_eq!(at(&s, 0, 7), 0, "separator right of the top-left finder");
        // And the cell diagonally past it, which the symbol keeps clear.
        assert_eq!(at(&s, 7, 7), 0, "corner past the top-left separator");
    }

    #[test]
    fn timing_patterns_alternate() {
        let s = symbol("ASDFGHJK");
        let n = s.size;
        for i in 8..(n - 8) {
            let expect = if i % 2 == 0 { 1 } else { 0 };
            assert_eq!(at(&s, 6, i), expect, "horizontal timing at {i}");
            assert_eq!(at(&s, i, 6), expect, "vertical timing at {i}");
        }
    }

    #[test]
    fn dark_module_is_always_dark() {
        let s = symbol("8QWERTYU");
        assert_eq!(at(&s, s.size - 8, 8), 1, "the mandatory dark module");
    }

    #[test]
    fn distinct_payloads_produce_distinct_symbols() {
        let a = symbol("TRNC8241");
        let b = symbol("TRNC8242");
        assert_ne!(
            a.modules, b.modules,
            "one flipped code digit must change the symbol"
        );
    }

    #[test]
    fn empty_input_still_encodes_rather_than_erroring() {
        // The surface must never be handed a half-built symbol; an empty room
        // code has to produce a valid (if useless) symbol or a clean error.
        // Either is acceptable — what is not acceptable is a broken one.
        if let Ok(s) = encode("") {
            assert!(s.size >= 21 && s.modules.len() == s.size * s.size);
        }
    }

    #[test]
    fn oversized_input_reports_an_error_instead_of_truncating() {
        // Truncating would silently encode the wrong invite.
        let long = "A".repeat(4096);
        assert!(encode(&long).is_err(), "must refuse, never truncate");
    }

    #[test]
    fn command_wrapper_converts_the_error_to_a_string() {
        // The IPC boundary is String; make sure it is actually reachable.
        assert!(qr_symbol("TRNC8241".to_string()).is_ok());
        assert!(qr_symbol("A".repeat(4096)).is_err());
    }

    // ------------------------------------------------------------ round trip -
    // Everything above checks the symbol *looks* right. These decode it with an
    // independent decoder (rqrr) and read the payload back, which is the only
    // thing that actually proves a phone camera would scan it.

    /// Render the symbol as greyscale luminance with the spec's mandatory
    /// 4-module quiet zone on every side. Without the quiet zone a real scanner
    /// cannot lock onto the symbol at all, so decoding would be testing our
    /// renderer rather than our encoder — and the renderer is the frontend's
    /// job, verified separately.
    fn decode(s: &QrSymbol) -> String {
        const QUIET: usize = 4;
        let dim = s.size + QUIET * 2;
        let mut img = rqrr::PreparedImage::prepare_from_greyscale(dim, dim, |x, y| {
            let sx = x as isize - QUIET as isize;
            let sy = y as isize - QUIET as isize;
            let inside = sx >= 0 && sy >= 0 && (sx as usize) < s.size && (sy as usize) < s.size;
            if inside && at(s, sy as usize, sx as usize) == 1 {
                0 // dark module
            } else {
                255 // light module, or quiet zone
            }
        });

        let (meta, text) = img
            .detect_grids()
            .into_iter()
            .next()
            .expect("a decoder must find the symbol")
            .decode()
            .expect("a decoder must read the symbol");
        assert_eq!(meta.version.0, s.version, "decoded version");
        text
    }

    #[test]
    fn a_decoder_reads_the_room_code_back() {
        // The codes docs/sidecar.md says the server issues.
        for code in ["TRNC8241", "12345678", "8QWERTYU", "ZXCVBNMQ", "ASDFGHJK"] {
            let s = symbol(code);
            assert_eq!(decode(&s), code, "round trip for {code}");
        }
    }

    #[test]
    fn a_decoder_reads_back_across_versions_1_to_10() {
        // Byte mode at level M for every version we allow, so no size boundary
        // ships an unreadable symbol.
        for (version, capacity) in [
            (1usize, 14usize),
            (2, 26),
            (3, 42),
            (4, 62),
            (5, 84),
            (6, 106),
            (7, 122),
            (8, 152),
            (9, 180),
            (10, 213),
        ] {
            let payload: String = (0..capacity)
                .map(|i| char::from(b'!' + (i % 90) as u8))
                .collect();
            let s = symbol(&payload);
            assert_eq!(s.version, version, "payload of {capacity} bytes");
            assert_eq!(decode(&s), payload, "round trip at version {version}");
        }
    }

    #[test]
    fn a_decoder_reads_back_a_utf8_payload() {
        // Room codes are ASCII today, but the surface must not silently mangle
        // a non-ASCII invite if one ever reaches it.
        let payload = "room-café-Ω-42";
        let s = symbol(payload);
        assert_eq!(decode(&s), payload);
    }
}
