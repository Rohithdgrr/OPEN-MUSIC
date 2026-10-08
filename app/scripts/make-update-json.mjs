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

const here = dirname(fileURLToPath(import.meta.url));
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

// Tauri 2 signs the installer file itself (`OPEN MUSIC_0.4.0_x64-setup.exe`
// + `.exe.sig`), while older builds wrapped it in a `.zip`. Accept either so
// the manifest keeps working across versions. Older installers from previous
// builds sit in the same folder, so a file carrying this release's version
// always wins over one that does not.
const pick = (...exts) => {
  for (const ext of exts) {
    const hits = files.filter((f) => f.endsWith(ext));
    const hit = hits.find((f) => f.includes(version)) || hits[hits.length - 1];
    if (hit) return hit;
  }
  return null;
};

const nsisExe = pick("-setup.exe", ".exe");
const msi = pick(".msi");
const appimage = pick(".AppImage.tar.gz", ".AppImage");
const appTar = pick(".app.tar.gz");

const bundles = [
  { key: () => `windows-${archOf(nsisExe || "x64")}-nsis`, zip: nsisExe, os: "windows" },
  { key: () => `windows-${archOf("x64")}-msi`, zip: msi, os: "windows" },
  { key: () => `linux-${archOf(appimage || "x86_64")}-appimage`, zip: appimage, os: "linux" },
  { key: () => `darwin-${archOf(appTar || "x86_64")}`, zip: appTar, os: "macos" },
].filter((b) => b.zip);

if (!bundles.length) {
  console.error(
    `no updater artifacts (*.exe / *.msi / *.AppImage / *.app.tar.gz) under ${bundleRoot}`,
  );
  process.exit(1);
}

const platform = (zip) => {
  const sig = `${zip}.sig`;
  if (!statSyncExists(sig)) {
    // An unsigned artifact (a build made without TAURI_SIGNING_PRIVATE_KEY)
    // cannot be offered for in-app update — say so and leave it out rather
    // than failing the whole release.
    console.warn(`skipping ${zip}: no ${sig} (build it with TAURI_SIGNING_PRIVATE_KEY set)`);
    return null;
  }
  // GitHub rewrites release asset names on upload: spaces become dots
  // (same rule as action-gh-release's alignAssetName). The URL must
  // reference the stored name — a space-encoded name 404s forever.
  const stored = zip.split(/[\\/]/).pop().replace(/ /g, ".");
  return {
    url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(stored)}`,
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
for (const b of bundles) {
  const entry = platform(b.zip);
  if (entry) platforms[b.key()] = entry;
}
// Plain `{os}-{arch}` fallback — the shape the updater falls back to when no
// installer-specific key matches the installed bundle.
const plain = bundles.find((b) => b.os === "windows") || bundles[0];
if (plain) {
  const entry = platform(plain.zip);
  if (entry) platforms[plain.key().split("-").slice(0, 2).join("-")] = entry;
}

if (!Object.keys(platforms).length) {
  console.error(`no signed updater artifacts under ${bundleRoot} — nothing to offer in-app`);
  process.exit(1);
}

const manifest = {
  version,
  notes: process.env.RELEASE_NOTES || `OPEN MUSIC ${version}`,
  pub_date: new Date().toISOString(),
  platforms,
};

const out = resolve(bundleRoot, "latest.json");
writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(resolve(bundleRoot, "update.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote latest.json + update.json for v${version} (${Object.keys(platforms).join(", ")})`);
