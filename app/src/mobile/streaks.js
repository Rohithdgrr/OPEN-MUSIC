// streaks.js — listening streaks over the plays log (shared PLAYS_KEY).
// A "day" is a local calendar date with >= 1 play. The streak counts
// consecutive days ending today (or yesterday, so it never reads 0 while
// today is still young). Pure + dependency-free so Settings and Home share it.
import { load, PLAYS_KEY } from "./shared.js";

function dayKey(ts) {
  try {
    const d = new Date(Number(ts));
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  } catch {
    return "";
  }
}

function dayStart(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offsetDays);
  return d.getTime();
}

export function streakStats() {
  let plays;
  try {
    plays = load(PLAYS_KEY, []);
    if (!Array.isArray(plays)) plays = [];
  } catch {
    plays = [];
  }
  const days = new Set();
  let today = 0;
  const t0 = dayStart(0);
  for (const p of plays) {
    const ts = Number(p && p.ts);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    days.add(dayKey(ts));
    if (ts >= t0) today += 1;
  }
  // Streak walks back from today; a missing today still counts when
  // yesterday played (the day is not over yet).
  let streak = 0;
  const now = new Date();
  const dayKeyAt = (offset) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset, 12, 0, 0);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  };
  let cursor = days.has(dayKeyAt(0)) ? 0 : 1;
  for (;;) {
    if (days.has(dayKeyAt(cursor))) {
      streak += 1;
      cursor += 1;
    } else break;
    if (cursor > 3660) break; // sanity cap, not a goal
  }
  return { streak, today, totalDays: days.size, totalPlays: plays.length };
}

export function streakLabel(s) {
  const st = s || streakStats();
  if (st.streak <= 0) return "";
  if (st.streak === 1) return "1-day streak";
  return `${st.streak}-day streak`;
}
