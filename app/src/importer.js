// importer.js — Exportify CSV → vault import
// Parses Spotify CSV exports into local playlists.

import { invoke } from "./core.js";

/// Parse Exportify CSV format into track objects.
/// Expected columns: Track URI, Track Name, Artist URI(s), Artist Name(s),
/// Album URI, Album Name, Track Duration (ms), ISRC, ...
export function parseExportifyCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { tracks: [], errors: ["Empty CSV"] };

  const headers = parseCsvLine(lines[0]);
  const tracks = [];
  const errors = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < headers.length) {
      errors.push(`Line ${i + 1}: insufficient columns`);
      continue;
    }

    const track = {
      uri: cols[headers.indexOf("Track URI")] || "",
      name: cols[headers.indexOf("Track Name")] || "",
      artists: (cols[headers.indexOf("Artist Name(s)")] || "").split(", ").filter(Boolean),
      album: cols[headers.indexOf("Album Name")] || "",
      duration_ms: parseInt(cols[headers.indexOf("Track Duration (ms)")] || "0", 10),
      isrc: cols[headers.indexOf("ISRC")] || "",
    };

    if (track.name && track.artists.length > 0) {
      tracks.push(track);
    } else {
      errors.push(`Line ${i + 1}: missing required fields`);
    }
  }

  return { tracks, errors };
}

/// Parse a single CSV line, handling quoted fields with commas.
function parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        current += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        result.push(current);
        current = "";
      } else {
        current += c;
      }
    }
  }
  result.push(current);
  return result;
}

/// Match CSV tracks to JioSaavn catalog via search.
/// Limits to 100 tracks per batch to avoid overwhelming the API.
export async function importCsvToPlaylist(csvText, playlistName) {
  const { tracks, errors } = parseExportifyCsv(csvText);

  if (tracks.length === 0) {
    return { matched: 0, missed: 0, errors };
  }

  const matched = [];
  const missed = [];
  const batchSize = 100;

  for (const t of tracks.slice(0, batchSize)) {
    try {
      // Search JioSaavn for ISRC (most reliable) or title+artist
      const query = t.isrc || `${t.name} ${t.artists[0]}`;
      const results = await invoke("search_songs", { query, limit: 1 });

      if (results.tracks && results.tracks.length > 0) {
        matched.push({
          ...results.tracks[0],
          original: t,
        });
      } else {
        missed.push(t);
      }
    } catch (err) {
      console.error(`Failed to match track: ${t.name} - ${err}`);
      missed.push(t);
    }
  }

  // Create local playlist from matched tracks
  const playlist = {
    id: `import-${Date.now()}`,
    title: playlistName || "Imported from Spotify",
    tracks: matched.map(m => ({
      id: m.id,
      title: m.title || m.name,
      artist: m.artist,
      album: m.album,
      image: m.image,
      duration: m.duration || m.duration_ms,
    })),
    imported: true,
    source: "spotify-csv",
    createdAt: new Date().toISOString(),
  };

  return {
    playlist,
    matched: matched.length,
    missed: missed.length,
    errors,
  };
}

/// Read a CSV file and return its text content.
export function readCsvFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = (e) => reject(new Error("Failed to read CSV file"));
    reader.readAsText(file);
  });
}
