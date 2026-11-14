import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MIRROR_BASE = "https://saavn.sumit.co";
const LRCLIB_BASE = "https://lrclib.net/api";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

async function getJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declaredBytes = Number(response.headers.get("content-length") || 0);
  if (declaredBytes > MAX_RESPONSE_BYTES) throw new Error("response too large");
  const body = await response.text();
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error("response too large");
  return JSON.parse(body);
}

export async function runContracts({
  fetchImpl = fetch,
  mirrorBase = MIRROR_BASE,
  lrclibBase = LRCLIB_BASE,
} = {}) {
  const checks = [];
  let trackId = "";
  try {
    const url = new URL("/api/search/songs", mirrorBase);
    url.search = new URLSearchParams({ query: "believer", limit: "1", page: "1" });
    const payload = await getJson(fetchImpl, url);
    const rows = payload?.data?.results;
    if (!Array.isArray(rows) || !rows.length || typeof rows[0]?.id !== "string" || !rows[0].id) {
      throw new Error("search response missing data.results[0].id");
    }
    trackId = rows[0].id;
    checks.push({ name: "catalog search", ok: true });
  } catch (error) {
    checks.push({ name: "catalog search", ok: false, detail: String(error.message || error) });
  }

  if (trackId) {
    try {
      const payload = await getJson(fetchImpl, new URL(`/api/songs/${encodeURIComponent(trackId)}`, mirrorBase));
      const qualities = payload?.data?.[0]?.downloadUrl;
      if (!Array.isArray(qualities) || !qualities.length) {
        throw new Error("song response missing data[0].downloadUrl");
      }
      checks.push({ name: "catalog song resolution", ok: true });
    } catch (error) {
      checks.push({ name: "catalog song resolution", ok: false, detail: String(error.message || error) });
    }
  } else {
    checks.push({ name: "catalog song resolution", ok: false, detail: "skipped: search contract failed" });
  }

  try {
    const url = new URL("search", `${lrclibBase.replace(/\/+$/, "")}/`);
    url.search = new URLSearchParams({ q: "The Weeknd Blinding Lights" });
    const payload = await getJson(fetchImpl, url);
    if (!Array.isArray(payload)) throw new Error("LRCLIB search response is not an array");
    checks.push({ name: "LRCLIB search", ok: true });
  } catch (error) {
    checks.push({ name: "LRCLIB search", ok: false, detail: String(error.message || error) });
  }
  return checks;
}

async function main() {
  const checks = await runContracts();
  const summary = JSON.stringify(checks);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `checks=${summary}\n`);
  }
  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}${check.detail ? `: ${check.detail}` : ""}`);
  }
  if (checks.some((check) => !check.ok)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
