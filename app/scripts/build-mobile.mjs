import { rm } from "node:fs/promises";
import { build } from "esbuild";

const outdir = "src/mobile/dist";
await rm(outdir, { recursive: true, force: true });

if (process.argv.includes("--clean")) {
  console.log("Removed generated mobile bundle; source entry will be used.");
} else {
  await build({
    absWorkingDir: process.cwd(),
    entryPoints: ["src/mobile/app.js"],
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: ["chrome63"],
    entryNames: "app",
    chunkNames: "chunks/[name]-[hash]",
    minify: true,
    sourcemap: false,
    legalComments: "none",
  });
  console.log(`Built mobile app bundle in ${outdir}`);
}
