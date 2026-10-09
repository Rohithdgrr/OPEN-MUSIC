// sync-android-icons.mjs — copy the branded Android launcher icons from the
// tracked source (src-tauri/icons/android) into the generated Android project
// (src-tauri/gen/android/app/src/main/res).
//
// Why a script and not committed files: `gen/` is gitignored and rebuilt by
// `tauri android init`, so the *source* of truth is `src-tauri/icons/android`
// (regenerated with `npx tauri icon src/mobile/logo.png`) and this copy is the
// reproducible step that lands them in the build input — the same pattern as
// build.sh's permission injection (docs/jam-upgrade.md §7, mobile 09 P38).
//
// Usage: node scripts/sync-android-icons.mjs   (from app/)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(app, "src-tauri", "icons", "android");
const resRoot = path.join(app, "src-tauri", "gen", "android", "app", "src", "main", "res");

if (!fs.existsSync(srcRoot)) {
  console.error(`no Android icon source at ${srcRoot}`);
  process.exit(1);
}
if (!fs.existsSync(resRoot)) {
  console.error(`no generated Android project at ${resRoot} — run \`tauri android init\` first`);
  process.exit(1);
}

let copied = 0;
for (const dir of fs.readdirSync(srcRoot, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const from = path.join(srcRoot, dir.name);
  const to = path.join(resRoot, dir.name);
  fs.mkdirSync(to, { recursive: true });
  for (const file of fs.readdirSync(from)) {
    fs.copyFileSync(path.join(from, file), path.join(to, file));
    copied += 1;
  }
}
console.log(`synced ${copied} Android icon file(s) → ${path.relative(app, resRoot)}`);
