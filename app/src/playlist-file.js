// Safe M3U/PLS import: imported paths are metadata only and are never opened.
import { matchTrackToCatalog } from "./spotmatch.js";

export const PLAYLIST_FILE_TRACK_CAP = 100;
const MAX_FILE_CHARS = 2 * 1024 * 1024;
const MAX_ENTRIES = 1000;

function splitCredit(value) {
  const parts = String(value || "").split(/\s+-\s+/, 2);
  return parts.length === 2
    ? { artists: [parts[0].trim()].filter(Boolean), name: parts[1].trim() }
    : { artists: [], name: String(value || "").trim() };
}

function displayName(path) {
  const safe = String(path || "").split(/[?#]/, 1)[0].replace(/\\/g, "/");
  const name = safe.slice(safe.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  try {
    return decodeURIComponent(name).trim();
  } catch {
    return name.trim();
  }
}

function makeTrack(title, durationSeconds) {
  const credit = splitCredit(title);
  const seconds = Number(durationSeconds);
  return {
    ...credit,
    duration_ms: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0,
  };
}

function parseM3u(text) {
  const tracks = [];
  const errors = [];
  let pending = null;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#EXTINF:/i.test(line)) {
      const comma = line.indexOf(",");
      const duration = comma < 0 ? 0 : Number(line.slice(8, comma).trim());
      const title = comma < 0 ? "" : line.slice(comma + 1).trim();
      pending = title ? makeTrack(title, duration) : null;
      if (!title) errors.push(`Line ${index + 1}: missing EXTINF title`);
      continue;
    }
    if (line.startsWith("#")) continue;
    const track = pending || makeTrack(displayName(line), 0);
    pending = null;
    if (track.name) tracks.push(track);
    else errors.push(`Line ${index + 1}: no usable track title`);
    if (tracks.length >= MAX_ENTRIES) {
      errors.push(`Playlist limited to ${MAX_ENTRIES} entries`);
      break;
    }
  }
  if (!tracks.length && !errors.length) errors.push("No playlist entries found");
  return { tracks, errors };
}

function parsePls(text) {
  const entries = new Map();
  const errors = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || /^\[playlist\]$/i.test(line)) continue;
    const match = line.match(/^(File|Title|Length)(\d+)\s*=\s*(.*)$/i);
    if (!match) {
      if (line.includes("=") && !/^NumberOfEntries\s*=/i.test(line) && !/^Version\s*=/i.test(line)) {
        errors.push(`Line ${index + 1}: unsupported PLS field`);
      }
      continue;
    }
    const [, field, rawNumber, value] = match;
    const number = Number(rawNumber);
    if (!Number.isSafeInteger(number) || number < 1) continue;
    const entry = entries.get(number) || {};
    entry[field.toLowerCase()] = value.trim();
    entries.set(number, entry);
  }

  const tracks = [];
  for (const [, entry] of [...entries].sort((a, b) => a[0] - b[0])) {
    const title = entry.title || displayName(entry.file);
    if (title) tracks.push(makeTrack(title, entry.length));
    else errors.push("PLS entry has no usable title");
    if (tracks.length >= MAX_ENTRIES) {
      errors.push(`Playlist limited to ${MAX_ENTRIES} entries`);
      break;
    }
  }
  if (!tracks.length && !errors.length) errors.push("No playlist entries found");
  return { tracks, errors };
}

export function parsePlaylistFile(text, extension) {
  const ext = String(extension || "").replace(/^\./, "").toLowerCase();
  if (!["m3u", "m3u8", "pls"].includes(ext)) {
    return { tracks: [], errors: ["Choose an M3U, M3U8, or PLS playlist"] };
  }
  if (typeof text !== "string" || text.length > MAX_FILE_CHARS) {
    return { tracks: [], errors: ["Playlist file is empty or larger than 2 MB"] };
  }
  const source = text.replace(/^\uFEFF/, "");
  return ext === "pls" ? parsePls(source) : parseM3u(source);
}

export async function importPlaylistFile(text, title, extension, invoke, onProgress) {
  const parsed = parsePlaylistFile(text, extension);
  const tracks = parsed.tracks.slice(0, PLAYLIST_FILE_TRACK_CAP);
  const errors = [...parsed.errors];
  if (parsed.tracks.length > tracks.length) {
    errors.push(`Only the first ${PLAYLIST_FILE_TRACK_CAP} entries are matched`);
  }
  if (!tracks.length) return { playlist: null, matched: 0, missed: 0, errors };

  const matched = [];
  for (let start = 0; start < tracks.length; start += 4) {
    const batch = tracks.slice(start, start + 4);
    const results = await Promise.all(batch.map((track) => matchTrackToCatalog(track, invoke)));
    for (const result of results) if (result.track) matched.push(result.track);
    if (typeof onProgress === "function") onProgress(Math.min(start + batch.length, tracks.length), tracks.length);
  }

  const playlist = matched.length
    ? {
        id: `import-${Date.now()}`,
        title: String(title || "").trim() || "Imported playlist",
        tracks: matched.map((track) => ({
          id: track.id,
          title: track.title || track.name,
          artist: track.artist,
          album: track.album,
          image: track.image,
          duration: track.duration || track.duration_secs,
        })),
        imported: true,
        source: "playlist-file",
        createdAt: new Date().toISOString(),
      }
    : null;
  return { playlist, matched: matched.length, missed: parsed.tracks.length - matched.length, errors };
}
