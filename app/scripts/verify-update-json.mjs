#!/usr/bin/env node
// verify-update-json.mjs — check that every URL in a generated manifest
// actually resolves against the release. Catches encoding/name drift
// (GitHub rewrites spaces in asset names to dots) before anything ships.
//
// A missing manifest is fine: an unsigned build (no
// TAURI_SIGNING_PRIVATE_KEY) never produces one.
//
// Usage: node app/scripts/verify-update-json.mjs <manifest.json>
import { existsSync, readFileSync } from "node:fs";

const [manifestPath] = process.argv.slice(2);
if (!manifestPath) {
  console.error("usage: verify-update-json.mjs <manifest.json>");
  process.exit(2);
}
if (!existsSync(manifestPath)) {
  console.warn(`no ${manifestPath} — unsigned build, nothing to verify`);
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const entries = Object.entries(manifest.platforms ?? {});
if (!entries.length) {
  console.error("manifest lists no platforms");
  process.exit(1);
}

let bad = 0;
for (const [key, entry] of entries) {
  const url = entry?.url;
  if (!url) {
    console.error(`  ${key}: no url`);
    bad++;
    continue;
  }
  let status;
  try {
    // Releases answers 302 -> CDN; 404 means the asset name is wrong.
    const res = await fetch(url, { redirect: "manual" });
    status = res.status;
  } catch (err) {
    console.error(`  ${key}: request failed: ${err.message}`);
    bad++;
    continue;
  }
  const ok = status === 200 || (status >= 300 && status < 400);
  if (ok) {
    console.log(`  ${key}: ok (HTTP ${status})`);
  } else {
    console.error(`  ${key}: HTTP ${status} ${url}`);
    bad++;
  }
}

if (bad) {
  console.error(`${bad} manifest URL(s) do not resolve`);
  process.exit(1);
}
console.log(`all ${entries.length} manifest URLs resolve`);
