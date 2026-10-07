// albumgroup.js — DOM-free catalog-quality helpers shared by desktop and
// mobile: language-variant album grouping + the conservative junk-track rule.
// Zero imports on purpose (util.js ↔ library.js already cycle); keep it so.

const JUNK_WORDS = new Set(["sample", "trailer", "testing", "demo"]);

/// The strings upstream ships where it has no value (mirrors the backend
/// `is_placeholder`). Empty counts as missing too.
export function isPlaceholder(s) {
  return ["", "null", "none", "undefined", "n/a", "na", "-"].includes(
    String(s || "").trim().toLowerCase(),
  );
}

/// Drop a row when a junk word is in the title AND the artist is missing —
/// a legit "Trailer Music" with a real artist always survives — OR when the
/// title carries two or more junk words no matter who is billed (mirrors the
/// backend `is_junk`: album pages inherit the album's real artist bill, so
/// the artist-missing guard alone lets "This is a sample trailer - testing"
/// through there).
export function isJunkTrack(t) {
  if (!t) return false;
  const hits = String(t.title || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => JUNK_WORDS.has(w)).length;
  if (hits >= 2) return true;
  if (hits === 0 || !isPlaceholder(t.artist)) return false;
  return true;
}

/// Lowercase base title with one trailing ` (X)` / ` - X` / ` [X]`
/// single-word suffix stripped ("Baahubali - The Beginning (Telugu)" →
/// "baahubali - the beginning"). Multi-word parentheticals like
/// `(From "Movie")` survive untouched.
export function baseAlbumTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/\s*[([]?\s*-\s*[a-z]+\s*[)\]]?\s*$/, "")
    .replace(/\s*[([][a-z]+[)\]]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/// Variant tokens per merged card, keyed by the kept card's token.
const variantRegistry = new Map();

/// Collapse language-variant album cards (same movie, one card per language
/// upstream) into one card carrying `langCount` + `languages`. Merges ONLY
/// when a group holds >= 2 distinct non-empty `language` values —
/// same-language editions, language-less rows and non-album kinds pass
/// through untouched, in order.
export function groupLangAlbums(list) {
  variantRegistry.clear();
  const groups = new Map();
  for (const a of list || []) {
    if (!a) continue;
    const key = !a.kind || a.kind === "album" ? `album\x00${baseAlbumTitle(a.title)}` : Symbol();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  const out = [];
  for (const [, g] of groups) {
    const langs = [...new Set(g.map((a) => String(a.language || "").toLowerCase()).filter(Boolean))];
    if (g.length < 2 || langs.length < 2) {
      for (const a of g) out.push(a);
      continue;
    }
    const kept = { ...g[0], langCount: g.length, languages: langs };
    variantRegistry.set(
      String(kept.token || kept.id),
      g
        .map((a) => ({
          token: a.token || a.id || "",
          language: String(a.language || "").toLowerCase(),
          title: a.title || "",
        }))
        .filter((v) => v.token),
    );
    out.push(kept);
  }
  return out;
}

/// Variant list for a merged card's token, else null (single album path).
export function variantsFor(token) {
  const v = variantRegistry.get(String(token || ""));
  return v && v.length ? v : null;
}
