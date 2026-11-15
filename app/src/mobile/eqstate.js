export const MOBILE_EQ_KEY = "tm-eq-bands";
export const MOBILE_EQ_LABELS = ["60 Hz", "240 Hz", "1 kHz", "3.5 kHz", "10 kHz"];
export const MOBILE_EQ_DEFAULT = [0, 0, 0, 0, 0];

export function normalizeEqBands(value) {
  if (!Array.isArray(value) || value.length !== MOBILE_EQ_DEFAULT.length) return [...MOBILE_EQ_DEFAULT];
  return value.map((gain) => {
    const number = Number(gain);
    return Number.isFinite(number) ? Math.max(-12, Math.min(12, Math.round(number))) : 0;
  });
}

export function parseEqBands(raw) {
  if (typeof raw !== "string" || !raw.trim()) return [...MOBILE_EQ_DEFAULT];
  try {
    return normalizeEqBands(JSON.parse(raw));
  } catch {
    return [...MOBILE_EQ_DEFAULT];
  }
}

export function applyEqBands(chain, values) {
  if (!chain || !Array.isArray(chain.bands) || chain.bands.length !== MOBILE_EQ_DEFAULT.length) return false;
  const gains = normalizeEqBands(values);
  chain.bands.forEach((band, index) => {
    try {
      band.gain.setTargetAtTime(gains[index], chain.ctx.currentTime, 0.03);
    } catch {
      try {
        band.gain.value = gains[index];
      } catch {}
    }
  });
  return true;
}
