// home-browse.test.mjs — home's one chip strip, two verbs (docs/mobile/
// 06-features.md "Home chips", 2026-10-15b): Charts/Playlists/Albums/Artists
// chips open the mined browsers (early return in the chip handler);
// All/Genres/Heavy Rotation filter the shelves in place. The selected pill
// keys on .bg-primary — the class the theme CSS inverts (the old
// bg-on-surface key left the active chip white-on-white in light mode,
// measured 2026-10-15). The tile-grid trial was reverted to this strip on
// user call, same day — this file pins the strip, not the grid.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const home = fs.readFileSync(path.join(src, "mobile", "screens", "home.html"), "utf8");
const binders = fs.readFileSync(path.join(src, "mobile", "binders.js"), "utf8");
const shell = fs.readFileSync(path.join(src, "mobile", "index.html"), "utf8");

const BROWSE = ["artists", "albums", "playlists", "charts"];
const ORDER = ["all", "charts", "playlists", "albums", "artists", "genres", "jump"];

test("home: the seven-chip strip in the old order, a navigate branch per browse chip", () => {
  const cats = [...home.matchAll(/data-home-cat="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(cats, ORDER, "chip strip must keep the old order");
  for (const key of BROWSE) {
    assert.ok(
      binders.includes(`if (cat === "${key}") return go("${key}");`),
      `navigate branch for ${key} missing`,
    );
  }
});

test("home: the selected pill keys on .bg-primary (the class the theme CSS inverts)", () => {
  assert.ok(binders.includes("bg-primary text-on-primary"), "CHIP_ON must carry bg-primary");
  const all = home.match(/data-home-cat="all"[^>]*class="([^"]*)"/);
  assert.ok(all && all[1].includes("bg-primary"), "All is on at boot");
});

test("home: no tile-grid leftovers in markup, handler, or shell CSS", () => {
  assert.ok(!home.includes("data-browse-grid"), "grid markup must be gone");
  assert.ok(!home.includes("data-browse-count"), "count hooks must be gone");
  assert.ok(
    !binders.includes("paintBrowseCount") && !binders.includes("BROWSE_NOUNS"),
    "count machinery must be gone",
  );
  assert.ok(!shell.includes("browse-tile-icon"), "tile CSS must be gone");
});
