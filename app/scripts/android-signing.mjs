// android-signing.mjs — make `tauri android build --apk` emit an INSTALLABLE
// release APK instead of `app-universal-release-unsigned.apk`.
//
// Why a script and not a committed edit: the gradle file lives under
// `src-tauri/gen/`, which is gitignored and re-created by
// `tauri android init`, so the signing wiring has to be re-applied on every
// build — the same pattern as build.sh's permission/media injections.
//
// Key material, in priority order (the key is NEVER rotated silently — a new
// certificate makes every future update fail INSTALL_FAILED_UPDATE_INCOMPATIBLE):
//   1. `gen/android/keystore.properties` already present → use it as-is.
//   2. `%LOCALAPPDATA%/trance-music-signing/keystore.properties` → copy the
//      keystore into gen/ (survives `tauri android init` wiping gen/).
//   3. Nothing anywhere → mint `release.keystore` once, store it in the same
//      LOCALAPPDATA folder so step 2 restores it next time.
//
// The real OpenMusic release key (CN=TRANCE MUSIC, SHA-256 8ad4da6f…cadfb,
// the signer of the published v0.5.1 APK) lives in that LOCALAPPDATA folder.
//
// Also: patches `gen/android/app/build.gradle.kts` between
// `// openmusic-signing:start` / `:end` markers (idempotent — re-running
// replaces the block), skips when a non-managed signingConfigs block already
// exists (CI's `tauri android init` mints its own), and collapses the empty
// `jniLibs { }` blocks the old sed insertion accumulated.
//
// Usage: node scripts/android-signing.mjs   (from app/, or via build.sh)
// Docs:  docs/android-universal-release.md § "Release signing on a workstation"
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gen = path.join(app, "src-tauri", "gen", "android");
const moduleDir = path.join(gen, "app"); // gradle's `file()` base
const gradle = path.join(moduleDir, "build.gradle.kts");
const props = path.join(gen, "keystore.properties");

// Their key store: next to the Windows Authenticode .pfx that already lived
// here, so one folder holds every signing secret for this project.
const keyHome = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "trance-music-signing")
  : null;

const STORE_NAME = "release.keystore";
const STORE_REL = `../${STORE_NAME}`; // relative to gen/android/app, gradle's file() base
const DEFAULT_ALIAS = "trance-music";
const DN = "CN=TRANCE MUSIC, OU=Dev, O=OpenMusic, L=Local, ST=Local, C=IN";
const START = "// openmusic-signing:start";
const END = "// openmusic-signing:end";

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (!fs.existsSync(gradle)) {
  fail(`no generated Android project at ${gradle} — run \`tauri android init\` first`);
}

function keytool() {
  if (process.env.JAVA_HOME) {
    const exe = path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "keytool.exe" : "keytool");
    if (fs.existsSync(exe)) return exe;
  }
  return "keytool";
}

function readProps(file) {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z][\w.]*)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function writeProps(storeFile, p) {
  const store = p.storePassword || p.password;
  const key = p.keyPassword || p.password || store;
  fs.writeFileSync(
    props,
    `storeFile=${storeFile}\nstorePassword=${store}\nkeyAlias=${p.keyAlias || DEFAULT_ALIAS}\nkeyPassword=${key}\n`,
  );
}

// ── 1. key material ─────────────────────────────────────────────────────────
if (fs.existsSync(props)) {
  const p = readProps(props);
  const store = p.storeFile ? path.resolve(moduleDir, p.storeFile) : null;
  if (!store || !fs.existsSync(store)) {
    fail(`${path.relative(app, props)} points at a missing keystore (${p.storeFile ?? "no storeFile"}).`);
  }
  console.log(`✓ using existing keystore ${p.storeFile} (alias ${p.keyAlias})`);
} else if (keyHome && fs.existsSync(path.join(keyHome, "keystore.properties"))) {
  const p = readProps(path.join(keyHome, "keystore.properties"));
  const src = path.resolve(keyHome, p.storeFile || STORE_NAME);
  if (!fs.existsSync(src)) fail(`${keyHome} has keystore.properties but no ${path.basename(src)}.`);
  fs.copyFileSync(src, path.join(gen, STORE_NAME));
  writeProps(STORE_REL, p);
  console.log(`✓ restored release keystore from ${keyHome} (alias ${p.keyAlias || DEFAULT_ALIAS})`);
} else {
  const password = crypto.randomBytes(24).toString("base64url");
  try {
    execFileSync(
      keytool(),
      [
        "-genkeypair", "-v",
        "-storetype", "PKCS12",
        "-keystore", path.join(gen, STORE_NAME),
        "-alias", DEFAULT_ALIAS,
        "-keyalg", "RSA",
        "-keysize", "4096",
        "-validity", "10000",
        "-dname", DN,
        "-storepass", password,
        "-keypass", password,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    fail(`keytool failed: ${err.stderr?.toString().trim() || err.message}`);
  }
  writeProps(STORE_REL, { storePassword: password, keyAlias: DEFAULT_ALIAS });
  if (keyHome) {
    fs.mkdirSync(keyHome, { recursive: true });
    fs.copyFileSync(path.join(gen, STORE_NAME), path.join(keyHome, STORE_NAME));
    fs.copyFileSync(props, path.join(keyHome, "keystore.properties"));
    console.log(`✓ minted a NEW release keystore and backed it up to ${keyHome}`);
  } else {
    console.log("✓ minted a NEW release keystore (no LOCALAPPDATA — back it up by hand)");
  }
}

// ── 2. gradle wiring ────────────────────────────────────────────────────────
let src = fs.readFileSync(gradle, "utf8");
const eol = src.includes("\r\n") ? "\r\n" : "\n";

const startIdx = src.indexOf(START);
if (startIdx !== -1) {
  const endIdx = src.indexOf(END, startIdx);
  if (endIdx === -1) fail(`${path.relative(app, gradle)}: ${START} without ${END} — fix the file by hand.`);
  const lineStart = src.lastIndexOf("\n", startIdx) + 1;
  const lineEnd = src.indexOf("\n", endIdx) + 1;
  src = src.slice(0, lineStart) + src.slice(lineEnd);
}

// Empty jniLibs blocks: the old sed in tune_android_build inserted one per
// build and stripped its body. Harmless, but they hide the real config.
const before = src;
src = src.replace(/(?:[ \t]*jniLibs\s*\{\s*\}\r?\n)+/g, "");
if (before !== src) console.log("✓ collapsed accumulated empty jniLibs blocks");

const foreign = /signingConfigs\s*\{/.test(src) || /create\(\s*"release"\s*\)/.test(src);
if (foreign) {
  fs.writeFileSync(gradle, src);
  console.log("✓ existing (non-managed) release signing config found — left untouched");
} else {
  const anchor = /^([ \t]*)buildTypes\s*\{/m.exec(src);
  if (!anchor) fail(`${path.relative(app, gradle)}: no \`buildTypes {\` block to anchor on.`);
  const i = anchor[1];
  // NOTE: plain `Properties()`, never `java.util.Properties()` — inside
  // `android { }` the identifier `java` resolves to the Android DSL's `java`
  // extension, not the JDK package ("Unresolved reference 'util'").
  const block = [
    `${i}${START} (managed by app/scripts/android-signing.mjs — do not edit)`,
    `${i}val openMusicKeystore = Properties().apply {`,
    `${i}    val f = rootProject.file("keystore.properties")`,
    `${i}    if (f.exists()) f.inputStream().use { load(it) }`,
    `${i}}`,
    `${i}signingConfigs {`,
    `${i}    if (openMusicKeystore.isNotEmpty()) {`,
    `${i}        create("release") {`,
    `${i}            storeFile = file(openMusicKeystore.getProperty("storeFile"))`,
    `${i}            storePassword = openMusicKeystore.getProperty("storePassword")`,
    `${i}            keyAlias = openMusicKeystore.getProperty("keyAlias")`,
    `${i}            keyPassword = openMusicKeystore.getProperty("keyPassword")`,
    `${i}        }`,
    `${i}    }`,
    `${i}}`,
    `${i}val openMusicReleaseSigning = signingConfigs.findByName("release")`,
    `${i}${END}`,
    "",
  ].join(eol);
  src = src.slice(0, anchor.index) + block + src.slice(anchor.index);

  const release = /getByName\("release"\)\s*\{/.exec(src);
  if (!release) fail(`${path.relative(app, gradle)}: no release buildType to wire.`);
  // Drop a wiring line from an earlier run before inserting (it lives inside
  // the buildType, not inside the marker block, so the removal above misses it).
  src = src.replace(/^[ \t]*signingConfig = openMusicReleaseSigning[ \t]*\r?\n/gm, "");
  const at = release.index + release[0].length;
  const nl = src.indexOf("\n", at);
  const lineEnd = nl === -1 ? src.length : nl + 1;
  const lineStart = src.lastIndexOf("\n", at) + 1;
  const indent = /^[ \t]*/.exec(src.slice(lineStart, at))[0];
  src = `${src.slice(0, lineEnd)}${indent}    signingConfig = openMusicReleaseSigning${eol}${src.slice(lineEnd)}`;
  fs.writeFileSync(gradle, src);
  console.log("✓ wired signingConfigs.release into buildTypes.release");
}

// ── 3. report the certificate ───────────────────────────────────────────────
try {
  const p = readProps(props);
  const out = execFileSync(
    keytool(),
    [
      "-list", "-v",
      "-keystore", path.resolve(moduleDir, p.storeFile),
      "-alias", p.keyAlias,
      "-storepass", p.storePassword,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const sha = /SHA256:\s*([0-9A-F:]+)/i.exec(out);
  if (sha) console.log(`  cert SHA-256 ${sha[1].replace(/:/g, "").toLowerCase()}`);
} catch {
  /* fingerprint is a nicety; the build is the proof */
}
