import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function run(scriptArgs) {
  const result = spawnSync(process.execPath, scriptArgs, {
    cwd: appDir,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (!(args[0] === "android" && args[1] === "android-studio-script")) {
  run([resolve(appDir, "scripts/build-mobile.mjs"), "--clean"]);
}

run([resolve(appDir, "node_modules/@tauri-apps/cli/tauri.js"), ...args]);
