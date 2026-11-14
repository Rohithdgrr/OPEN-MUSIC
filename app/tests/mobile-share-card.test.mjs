import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

const shared = read("src/mobile/shared.js");
const bridge = read("src-tauri/android-overlay/kotlin/TmBridge.kt");
const mediaHub = read("src-tauri/android-overlay/kotlin/MediaHub.kt");
const provider = read("src-tauri/android-overlay/kotlin/ShareCardProvider.kt");
const build = read("build.sh");

const shareCardStart = shared.indexOf("export async function shareCard");
const shareCardEnd = shared.indexOf("// ---------------------------------------------------------------- haptic", shareCardStart);
const shareCard = shared.slice(shareCardStart, shareCardEnd);

test("shareCard sends the PNG through Android before Web Share and text fallbacks", () => {
  assert.ok(shareCardStart >= 0 && shareCardEnd > shareCardStart, "shareCard function not found");
  assert.match(shareCard, /readAsDataURL\(blob\)/);
  assert.match(shareCard, /native\.shareImage\(dataUrl,\s*t,\s*sub\)/);
  assert.ok(
    shareCard.indexOf("native.shareImage") < shareCard.indexOf("navigator.canShare"),
    "Android must get the image path before the Web Share fallback",
  );
  assert.match(shareCard, /native\.share\(line\)/);
  assert.match(shareCard, /navigator\.clipboard\.writeText\(line\)/);
  assert.match(shareCard, /console\.error/);
});

test("Android bridge validates PNG input and shares an app-private content URI", () => {
  assert.match(bridge, /fun shareImage\(dataUrl: String, title: String, text: String\): String/);
  assert.match(mediaHub, /MAX_SHARE_CARD_DATA_URL_CHARS/);
  assert.match(mediaHub, /data:image\/png;base64,/);
  assert.match(mediaHub, /Intent\.EXTRA_STREAM/);
  assert.match(mediaHub, /ClipData\.newUri/);
  assert.match(mediaHub, /FLAG_GRANT_READ_URI_PERMISSION/);
  assert.match(mediaHub, /content:\/\/\$\{app\.packageName\}\.sharecards/);
});

test("share-card provider confines granted reads to cached PNG files", () => {
  assert.match(provider, /File\(ctx\.cacheDir,\s*"share-cards"\)/);
  assert.match(provider, /mode\s*!=\s*"r"/);
  assert.match(provider, /canonicalFile/);
  assert.match(provider, /endsWith\("\.png",\s*ignoreCase\s*=\s*true\)/);
  assert.match(build, /if ! grep -q 'TM-SHARE-CARDS' "\$manifest"/);
  assert.match(build, /android:exported="false"/);
  assert.match(build, /android:grantUriPermissions="true"/);
});
