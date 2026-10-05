# AGENTS.md — memory for agent sessions

Repository memory. Read this first in any new session; append verified findings
below rather than re-deriving them. Every entry needs evidence (file, command
exit code, or URL). Unverified entries are marked `HYPOTHESIS`.

## User's standing rules (non-negotiable)

1. **Never push to GitHub without an explicit go-ahead.** The earlier
   ".yml files are pre-authorized" exception is **superseded** — hold every
   push until the user calls for it. Commit locally, report, wait.
2. **Git identity:** commits must be `Rohithdgrr <rohit93dgrr@gmail.com>`.
   Check `git config user.email` before committing. Do NOT rewrite pushed
   history (force-push) to fix an old identity — report it instead.
3. **Docs-first.** Before implementing a fix, feature, or upgrade, write it into
   the relevant `docs/*.md`; create a new doc if none fits.
4. **Answer confirmation/info/detail/concept questions in 1-9 lines**, relevant
   info only.
5. **Explain prompt improvement before starting a task** — how to phrase it
   better, and the right technical term for what they're asking.
6. Answer in the user's language (English).
7. **Tools:** for complex tasks, consider mcpmarket.com skills — but never
   bulk-install an aggregator's servers; add only a specifically named tool.
8. **NEVER stage-check and push in the same shell command.** `git push origin
   main` pushes every commit between the remote and `HEAD`, **not** just the
   files you staged. Verify, *read the output*, then push as a separate
   command. Violated 2026-10-06: a two-commit range
   (`751a773` Social Now Playing, `b5d013b` sidecar bridge — neither authored
   by this session) rode along with `99f245b`, publishing the user's
   in-progress feature work while only `tests/smoke-test.mjs` was approved.
   The guard printed the 14-file list in the *same* command as the push, so
   it executed after the push had already run — a check that cannot block is
   not a check.
   **Correct procedure:** (a) `git log --oneline origin/main..HEAD` first,
   (b) confirm every commit and author is intended, (c) only then push,
   (d) if an unintended push lands, **report it immediately and do not
   rewrite history** — force-push is forbidden by rule 2.

## Project facts (T0-verified)

- **Stack:** Tauri 2 (`app/src-tauri`, Rust) + zero-build vanilla JS
  (`app/src`). Frontend has no bundler — JS/CSS are served as-is.
- **Toolchain on this machine:** Rust 1.98.1 stable MSVC, Node v24.11.0,
  npm 11.6.1. No `gh` CLI, no `GITHUB_TOKEN`/`GH_TOKEN`, no `sccache`.
- **Commands:**
  - Tests: `npm test` (82 pass), `cd app/src-tauri; cargo test` (152 pass)
  - Lint: `npm run lint` (eslint, clean)
  - Format: `cargo fmt --check` (clean)
  - Clippy: `cargo clippy --all-targets -- -D warnings` (clean)
  - Build dev: `npm run tauri dev` from repo root (root script delegates
    via `npm --prefix app`)
  - First build ~5 min (488 crates); incremental much faster
- **CI workflows:** `ci.yml` (tests only), `linux.yml`, `macos.yml`,
  `release.yml` (tag-driven), `ios.yml`.
- **Repo:** `https://github.com/Rohithdgrr/OPEN-MUSIC`, public. Pages site:
  `https://rohithdgrr.github.io/OPEN-MUSIC/`

## CI status (checked 2026-10-06, public API)

| Workflow | Builds app? | Signing var names | Record |
|---|---|---|---|
| `ci.yml` | no (tests only) | n/a | **#58 success** |
| `release.yml` | yes | correct | 3 pass / 7 fail |
| `linux.yml` | yes | correct (since `cc04b05`) | **#18 success (green)** |
| `macos.yml` | yes | correct (since `cc04b05`) | **#16, #17, #18 success (green)** |

**OBJECTIVE MET — run #18 on `56c6544`, all 18 macOS steps green.** The proof
is in the annotations on job `111913156896`
(`check-runs/111913156896/annotations`), which are readable without auth:
- `[notice] DMG verification` — *"mounted and found TRANCE MUSIC.app inside —
  TRANCE MUSIC_0.4.0_aarch64.dmg"*
- `[notice] App launch verification` — *"binary alive after 12s (pid 25817) —
  dyld/rpath OK"*

So the `.dmg` is produced, `hdiutil attach` mounts it, `TRANCE MUSIC.app` is
inside the image, and the binary launches and survives 12 seconds. No
`::warning title=No DMG produced` appeared, so the ambiguous skip path was
**not** taken — this is a real pass, not a vacuous one.

**A watcher reported ZERO annotations for that job while the API returned
four.** Cause: unauthenticated API allows 60 req/hour, the watcher polled
every 45s (≈80/hour), got 403, and its `catch{}` swallowed it. **Never poll
on a tight loop; read annotations once, individually.** Silence from a
watcher is not evidence that no annotations exist.

**Trust ladder for runs on this repo:**
- #16/#17 — carried the unguarded `if | tee`. macOS passes are corroborated
  by later steps finding real artifacts; **Linux #16 was invalid** (false
  pass, see the pipefail section below).
- #18 — annotations present, wrapper still unguarded. The DMG/launch notices
  remain trustworthy: they are emitted in branches the step demonstrably
  reached, and `Verify build artifacts` independently reads `PIPESTATUS[0]`.
- #19 (`4fd7b1d`) onward — first runs with **both** `pipefail` and
  annotations. Treat these as first-grade.

**How the macOS build got green** (each fix fixed a *newly reachable* step):
1. `TAURI_SIGNING_PRIVATE_KEY` (v2 names, not v1 `TAURI_PRIVATE_KEY`) — the
   key insight: v1 names are silently ignored while
   `createUpdaterArtifacts: true` makes the key mandatory.
2. Unset `APPLE_*` vars that arrive as `""` — a missing GitHub secret
   expands to empty, Rust's `env::var` returns `Ok("")` not `Err`, so Tauri
   thinks signing is configured. Confirmed by the build passing right after.
3. `[ -f ... TRANCE MUSIC.app ]` → `-e`; an `.app` is a directory.
4. Quoted globs (`[ -f "*.deb" ]`) → resolve into a variable first; `test -f`
   never expands a quoted pattern.
5. `set -o pipefail` on every capture wrapper — else failures report green.
6. Annotate notices/warnings, not just failures, or "green" cannot be told
   apart from "never checked".

- **Job logs return `403 Must have admin rights to Repository`** even on this
  public repo. Anonymous HTML returns a JS shell; JSON route returns `404`.
  Step conclusions and annotations **are** public — that's the only channel.
  Annotation ids are **job** ids (`.../check-runs/{job_id}/annotations`), not
  run ids. Generic annotations say "Process completed with exit code 1" with
  meaningless `.github` line numbers — never treat those as the root cause.
  Fix: have the failing step emit `::error title=...::$(tail ...)` itself.
  **Every step that can fail should do this** — `Run smoke tests` failed in
  #15 with no annotation, forcing inference from the step name alone.

### CRITICAL: `if cmd | tee` without `pipefail` = false green

**I shipped this bug and it made a broken test report as passing.**

```bash
if npm run test:smoke 2>&1 | tee /tmp/smoke.log; then   # ← WRONG
```

A pipeline's status is its **last** element's status. `tee` exits 0, so the
`if` always takes the success branch. No failure, no annotation, and the
wrapper *claims* to be checking — worse than no wrapper.

- Observed: run #15 failed at smoke; run #16 passed it; the only change
  between them was this wrapper; the script was broken in **both** runs
  (`app/tests/smoke-test.mjs` does not exist in any revision — verified with
  `git ls-tree`). Linux #16 was a **false pass**.
- Runner default here does **not** set `pipefail` (neither `macos.yml` nor
  `linux.yml` declares `shell:`, only `ci.yml` does). Proven by #16 passing.
- Fix: `set -o pipefail` as the first line of the block. `set -e` does **not**
  help — without pipefail there is no error to catch — but `set -e` also does
  **not** abort an `if` condition, so the `::error` annotation still fires.
- Alternative: `rc=${PIPESTATUS[0]}` read immediately (used by the macOS
  `Verify build artifacts` step). Not `$?`.
- Gate now enforced: a script asserts every run block containing `| tee`
  also contains `set -o pipefail` or `PIPESTATUS`.
- **Review rule:** any step piping into `tee`/`grep`/`head`/`cat` for capture
  needs one of those. A test step that discards its status is not a test.
- Full write-up: `docs/cross-platform-ci.md`.

**Trust status of runs:** #16 and #17 both carried the unguarded wrapper, so
their passes are not independently trustworthy. #16's macOS pass *is* solid —
later steps (`Verify build artifacts`, smoke, DMG) run *after* the build and
found real artifacts, which corroborates it. Treat run #18+ as first-grade.

## Root cause: macOS/Linux build failure — CONFIRMED (run #14/#15)

**CONFIRMED by observed behaviour, not just docs.** `tauri.conf.json` sets
`bundle.createUpdaterArtifacts: true`, making the updater key mandatory.
Tauri v2 reads `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
`macos.yml` and `linux.yml` set the v1 names `TAURI_PRIVATE_KEY` /
`TAURI_KEY_PASSWORD`, which Tauri silently ignores.

Evidence, two kinds:
1. Correlational, at the time: the only two workflows that had *never* passed
   were the two with wrong names; `release.yml` (correct names) did pass.
2. Decisive, after `cc04b05`: renaming the vars flipped `linux.yml` from
   *build fails* to *build succeeds* in the very next run. Cause-and-effect,
   not correlation. Source: Tauri v2 updater docs,
   <https://v2.tauri.app/plugin/updater/>.

Note we never did see the error text — logs stayed 403 throughout. The fix was
validated by the state change it produced, which is the available evidence
channel on this repo.

## Environment walls (do not retry these)

- **No macOS cross-compile from this machine.** `cargo check --target
  x86_64-apple-darwin` fails in `objc2-exception-helper` (builds `try_catch.m`).
  Missing everywhere: `clang`, `clang-cl`, `cc`, `gcc`, `zig`, `xcrun`. No
  macOS SDK. Installing LLVM = new dependency = needs approval.
- **No macOS simulator on Windows.** Apple SLA restricts macOS to Apple
  hardware. Appetize.io API: `platform` is `enum:["ios","android"]` only.
  BrowserStack: installing desktop apps on their macOS machines "is
  unavailable at the moment". CI on `macos-latest` is the only free path.
- **PowerShell reports `exit code 1` spuriously** when a native tool writes to
  stderr (`NativeCommandError`). Re-check `$LASTEXITCODE` before believing a
  failure — `cargo test` showed exit 1 while passing 152/152.

## Skills actually available

`opencode`, `report`, `slim-readme`, `ui-ux-pro-max`.
**There is no "ponytail" skill** — if asked for it, say so; do not simulate.

## Known defects

- `app/package.json` `test:smoke` pointed at `app/tests/smoke-test.mjs`; real
  file is `tests/smoke-test.mjs` at repo root. Fixed locally
  (`node ../tests/smoke-test.mjs`).
- `macos.yml` line ~100: `[ -f ".../dmg/TRANCE MUSIC_*.dmg" ]` never matches —
  `test -f` does not glob a quoted pattern.
- `macos.yml` "Run smoke tests" step removed (it failed the runner: the built
  `.app` is never installed to `/Applications` there).
