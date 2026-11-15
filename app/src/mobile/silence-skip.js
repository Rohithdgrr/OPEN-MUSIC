export const SILENCE_RMS_THRESHOLD = 0.006;
export const SILENCE_HOLD_MS = 1100;

export function silenceStep(rms, since, now, threshold = SILENCE_RMS_THRESHOLD, holdMs = SILENCE_HOLD_MS) {
  if (!Number.isFinite(rms) || rms >= threshold) return { since: 0, skip: false };
  const started = Number.isFinite(since) && since > 0 ? since : now;
  return { since: started, skip: now - started >= holdMs };
}
