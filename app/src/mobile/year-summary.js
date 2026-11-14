export const PLAY_EVENT_READ_LIMIT = 2000;
export const PLAY_EVENT_STORE_CAP = 3000;

export function availableYears(events, currentYear = new Date().getFullYear()) {
  const years = new Set([currentYear]);
  for (const event of Array.isArray(events) ? events : []) {
    const ts = Number(event && event.ts);
    const date = new Date(ts);
    if (Number.isFinite(ts) && ts > 0 && Number.isFinite(date.getTime())) years.add(date.getFullYear());
  }
  return [...years].sort((a, b) => b - a);
}

export function summarizeYear(events, year, storedCount = null) {
  if (!Number.isInteger(year) || year < 1 || year > 9998) {
    throw new RangeError("year must be an integer between 1 and 9998");
  }

  const startDate = new Date(0);
  startDate.setFullYear(year, 0, 1);
  startDate.setHours(0, 0, 0, 0);
  const endDate = new Date(0);
  endDate.setFullYear(year + 1, 0, 1);
  endDate.setHours(0, 0, 0, 0);
  const start = startDate.getTime();
  const end = endDate.getTime();
  const tracks = new Set();
  const artists = new Set();
  let playCount = 0;
  let playheadMs = 0;

  for (const event of Array.isArray(events) ? events : []) {
    const ts = Number(event && event.ts);
    const id = String((event && event.id) || "").trim();
    if (!id || !Number.isFinite(ts) || ts < start || ts >= end) continue;

    playCount += 1;
    tracks.add(id);

    const artist = String(event.artist || "").split(",")[0].trim();
    if (artist) artists.add(artist.toLocaleLowerCase());

    const msPlayed = Number(event.ms_played);
    if (Number.isFinite(msPlayed) && msPlayed > 0) playheadMs += msPlayed;
  }

  const knownStoredCount = Number.isInteger(storedCount) && storedCount >= 0 ? storedCount : null;
  const returnedCount = Array.isArray(events) ? events.length : 0;
  const truncated =
    knownStoredCount === null ||
    knownStoredCount > returnedCount ||
    returnedCount >= PLAY_EVENT_READ_LIMIT ||
    knownStoredCount >= PLAY_EVENT_STORE_CAP;

  return {
    year,
    playCount,
    uniqueTracks: tracks.size,
    uniqueArtists: artists.size,
    playheadMs,
    storedCount: knownStoredCount,
    returnedCount,
    truncated,
  };
}
