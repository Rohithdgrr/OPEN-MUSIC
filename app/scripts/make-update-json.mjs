#!/usr/bin/env node
// make-update-json.mjs — assemble the signed updater manifests from the .sig
// files `tauri build` leaves beside the zipped bundles. Two files come out,
// both with the same body:
//   latest.json — uploaded so the fixed endpoint
//                 releases/latest/download/latest.json always answers
//   update.json — attached to the tag itself, so Settings / Updates can point
//                 the updater at any older release to revert to it
//
// One run covers every OS that has its zips in <bundle-root>: the release
// workflow downloads all three matrix jobs into that root before calling
// this, so the manifest carries windows + linux + macos keys at once.
//
// Usage: node scripts/make-update-json.mjs <tag> <bundle-root>
// e.g.   node scripts/make-update-json.mjs v0.2.0 src-tauri/target/release/bundle
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [tag, bundleRoot] = process.argv.slice(2);
if (!tag || !bundleRoot) {
  console.error("usage: make-update-json.mjs <tag> <bundle-root>");
  process.exit(2);
}

const here = dirname(fileURLToPath(fileURLToPath(import.meta.url)));
const conf = JSON.parse(readFileSync(join(here, "..", "src-tauri", "tauri.conf.json"), "utf8"));
const version = String(conf.version);
const normalizedTag = tag.trim().replace(/^[vV]/, "");

// The manifest announces `version`; a tag that disagrees would make the
// updater compare the wrong numbers. Refuse loudly instead.
if (normalizedTag !== version) {
  console.error(`tag ${tag} does not match tauri.conf.json version ${version} — bump the version first`);
  process.exit(1);
}

const repo = process.env.GITHUB_REPOSITORY || "Rohithdgrr/OPEN-MUSIC";

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const files = walk(resolve(bundleRoot));

// The updater resolves `{os}-{arch}-{installer}` first, then `{os}-{arch}`.
// Each bundle type gets its own key; the arch is read from the artifact name
// so an arm64 Mac and an x64 Linux box both land on the right entry.
const archOf = (name) => (/aarch64|arm64/i.test(name) ? "aarch64" : "x86_64");
const pick = (ext) => files.find((f) => f.endsWith(ext)) || null;

const bundles = [
  { key: () => `windows-${archOf("x64")}-nsis`, zip: pick(".nsis.zip"), os: "windows" },
  { key: () => `windows-${archOf("x64")}-msi`, zip: pick(".msi.zip"), os: "windows" },
  { key: () => `linux-${archOf(files.find((f) => f.endsWith(".AppImage.tar.gz")) || "x86_64")}-appimage`, zip: pick(".AppImage.tar.gz"), os: "linux" },
  { key: () => `darwin-${archOf(pick(".app.tar.gz") || "x86_64")}`, zip: pick(".app.tar.gz"), os: "macos" },
].filter((b) => b.zip);

if (!bundles.length) {
  console.error(`no updater artifacts (*.nsis.zip / *.msi.zip / *.AppImage.tar.gz / *.app.tar.gz) under ${bundleRoot}`);
  process.exit(1);
}

const platform = (zip) => {
  const sig = `${zip}.sig`;
  if (!statSyncExists(sig)) {
    console.error(`missing signature for ${zip} — was TAURI_SIGNING_PRIVATE_KEY set?`);
    process.exit(1);
  }
  return {
    url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(zip.split(/[\\/]/).pop())}`,
    signature: readFileSync(sig, "utf8").trim(),
  };
};
function statSyncExists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

const platforms = {};
for (const b of bundles) platforms[b.key()] = platform(b.zip);
// Plain `{os}-{arch}` fallback — the shape the updater falls back to when no
// installer-specific key matches the installed bundle.
const plain = bundles.find((b) => b.os === "windows") || bundles[0];
platforms[plain.key().split("-").slice(0, 2).join("-")] = platform(plain.zip);

const manifest = {
  version,
  notes: process.env.RELEASE_NOTES || `TRANCE MUSIC ${version}`,
  pub_date: new Date().toISOString(),
  platforms,
};

const out = resolve(bundleRoot, "latest.json");
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(resolve(bundleRoot, "update.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote latest.json + update.json for v${version} (${Object.keys(platforms).join(", ")})`);
