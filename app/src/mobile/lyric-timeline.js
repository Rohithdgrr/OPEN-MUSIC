// Find the latest synced line whose timestamp is not after the playhead.
// `timestamps` must be a sorted array of finite seconds.
export function activeLyricIndex(timestamps, seconds) {
  if (!Array.isArray(timestamps) || !timestamps.length || !Number.isFinite(seconds)) return -1;
  let low = 0;
  let high = timestamps.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (timestamps[mid] <= seconds) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

export function normalizeSyncedLines(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row, order) => {
      const rawSeconds = Array.isArray(row) ? row[0] : undefined;
      const validType =
        typeof rawSeconds === "number" ||
        (typeof rawSeconds === "string" && rawSeconds.trim() !== "");
      return {
        seconds: validType ? Number(rawSeconds) : Number.NaN,
        text: Array.isArray(row) && typeof row[1] === "string" ? row[1] : "",
        order,
      };
    })
    .filter((row) => Number.isFinite(row.seconds) && row.text)
    .sort((a, b) => a.seconds - b.seconds || a.order - b.order)
    .map(({ seconds, text }) => [seconds, text]);
}
