# ARTEMIS — Android mobile automation for OpenMusic

**Scope of this document: Android only.** ARTEMIS drives an Android device or
emulator through ADB. It has no desktop concept, and installing it required
**zero changes to the OpenMusic desktop surface** (no `app/src/*.js` desktop
file, no `styles.css`, no desktop-only Tauri plugin, no desktop build).

---

## 1. What ARTEMIS is

[google/artemis](https://github.com/google/artemis) (Apache 2.0) is Google's
open-source **autonomous Android automation agent**. It:

- takes a natural-language goal ("open Settings, go to Battery, report the level"),
- observes the live screen (accessibility hierarchy + OCR + visual model),
- acts (tap / swipe / type / launch), reacting to what it actually sees,
- returns a verdict, a trace of every step, screenshots, and logcat.

Two execution profiles:

| Profile | Latency/step | Use |
|---|---|---|
| `flash` | ~3–5 s | routine, deterministic UI checks (this repo's default) |
| `pro` | ~15–40 s | multi-step journeys, planning + verification checkpoints |

It ships a **native MCP server**, so an AI agent (this one, Claude Code,
Cursor…) can dispatch mobile tasks, read the device state, and pull traces
directly.

Why it matters here: OpenMusic's Android surface was verified with
hand-written CDP probes (`app/tests/live-android-emulator.mjs`,
`live-canvas.mjs`, `live-lan-join.mjs`) that assert **known ids and states**.
ARTEMIS covers the complementary case — *"does the screen a human sees actually
work"*, which no id-based assertion can answer.

## 2. Install layout on this machine

Everything lives **outside** the OpenMusic repo, so the app's `git status`
stays clean and the tool never lands in a release artifact.

| Component | Path |
|---|---|
| ARTEMIS source | `C:\Users\rohit\desktop\artemis` (git clone, commit `351ca84`) |
| Python venv (deps) | `C:\Users\rohit\desktop\artemis\.venv` (uv-managed) |
| `uv` (package manager) | `C:\Users\rohit\AppData\Local\Programs\Python\Python312\Scripts\uv.exe` (installed via `pip install uv`) |
| scrcpy 5.0.1 | `C:\Users\rohit\desktop\tools\scrcpy-win64-v5.0.1\` |
| ffmpeg | **no install needed** — resolved from the venv's embedded `imageio-ffmpeg` binary |
| Device | AVD `Pixel6_API36` → `emulator-5554` (1080×2400) |

The repo's own `.env` (`C:\Users\rohit\desktop\artemis\.env`) holds **no
secrets** — see §3.

## 3. Configuration

`C:\Users\rohit\desktop\artemis\.env`:

```ini
ADB_HOST=127.0.0.1
ADB_PORT=5037
ARTEMIS_KEEP_DEVICE_AWAKE=true
ARTEMIS_HIERARCHY_BACKEND=auto
ARTEMIS_DEFAULT_PROFILE=flash
ARTEMIS_SCRCPY_PATH=C:\Users\rohit\desktop\tools\scrcpy-win64-v5.0.1\scrcpy.exe
```

**The multimodal model key is never written to disk.** ARTEMIS inherits
`GEMINI_API_KEY` from the Windows *user-level* environment variable, so it is
present in any process this user starts and absent from every file. The
`.env` deliberately contains **no `GEMINI_API_KEY=` line** — an empty line
there would shadow the environment variable and break perception.

Binary resolution is ARTEMIS's own resolver
(`artemis/toolchain/resolver.py`), in tiers: explicit env override →
SDK env vars → common OS paths → `PATH` → embedded binary. Verified on this
box:

| Tool | Resolved to | Tier |
|---|---|---|
| `adb` | `…\Android\Sdk\platform-tools\adb.exe` | 2 (`ANDROID_HOME`) |
| `ffmpeg` | `…\.venv\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe` | 5 (embedded) |
| `scrcpy` | `C:\Users\rohit\desktop\tools\scrcpy-win64-v5.0.1\scrcpy.exe` | 1 (`ARTEMIS_SCRCPY_PATH`) |
| `uv` | `…\Python312\Scripts\uv.exe` | 4 (`PATH`) |

`ARTEMIS_SCRCPY_PATH` exists because PATH is unreliable here: the Git-Bash
shell this repo's tooling runs under mangles a `C:\…` entry appended to
`PATH` (the colon in `C:` splits the entry), so `shutil.which("scrcpy")`
returned `None`. The env override sidesteps PATH entirely.

## 4. Daily use

**CLI (one-shot task):**

```bash
cd C:/Users/rohit/desktop/artemis
uv run artemis run "Open the Settings app, go to Battery, report the level" \
  --profile flash --device-serial emulator-5554
```

> The flag is `--device-serial` for `run`; `artemis helper install` takes
> `--serial`. Passing the wrong one aborts with `No such option`.

**Web console** (screen mirroring, live reasoning, replays):
`uv run artemis ui` → <http://localhost:8000>. `uv run artemis status` /
`stop` / `restart` manage the daemon.

**Pre-flight:** `uv run artemis doctor` — must print
`Status: Ready — All system checks passed!`

## 5. MCP integration with OpenCode (live)

Registered in the **global** OpenCode config
(`C:\Users\rohit\.config\opencode\opencode.json`, V2 `mcp.servers` shape):

```json
"artemis": {
  "type": "local",
  "command": ["C:\\Users\\rohit\\desktop\\artemis\\.venv\\Scripts\\python.exe", "-m", "mcp_server"],
  "cwd": "C:\\Users\\rohit\\desktop\\artemis",
  "environment": {
    "PYTHONUNBUFFERED": "1",
    "PYTHONPATH": "C:\\Users\\rohit\\desktop\\artemis"
  }
}
```

`cwd` is required — the MCP module resolves its own package relative to the
project root. `opencode mcp list` shows `✓ artemis connected`.

Tools exposed to the agent:

| Tool | Use |
|---|---|
| `mobile_run_task` | dispatch an autonomous task; returns a `trace_id` |
| `mobile_manage_task` | poll / steer / release a running task |
| `mobile_get_device_state` | live screenshot or UI hierarchy |
| `mobile_inspect_trace` | per-step trace, action overlays |
| `mobile_diagnose` | ordered fix steps when something is not working |

## 6. Driving the OpenMusic Android app

ARTEMIS talks to **any** installed app, so the flow is the usual one:

```bash
# 1. build + install the Android app
npm install && npm run css
npm run tauri -- android init
npm run tauri -- android build --debug --target x86_64
adb install -r app/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk

# 2. dispatch a natural-language check
uv run artemis run "Launch OpenMusic, search for 'believer', play the first result and confirm audio starts" \
  --profile pro --device-serial emulator-5554
```

`mobile_run_task` also accepts `locked_app_package` (force the task to stay
inside one app) and `app_path` (install an APK as part of the task).

## 7. Relationship to the existing CDP probes

**Complementary, not a replacement.**

| | Existing `app/tests/live-*.mjs` | ARTEMIS |
|---|---|---|
| Selects UI by | known element ids / selectors | natural language + visual grounding |
| Asserts | exact state (`paused:false`, `ct` advancing, drift `±0.09s`) | a verdict on a goal |
| Good at | regressions, drift numbers, byte-level checks | "does the flow a human walks still work?" |
| Determinism | high — same script, same assertion | model-driven — can vary between runs |

Keep the CDP probes for anything that must be *exactly* reproducible; use
ARTEMIS for journeys and for the "did we break the human path?" class of
question.

## 8. Traps (measured on this box)

- **`--serial` vs `--device-serial`** — different per subcommand; the wrong one
  aborts before the task starts.
- **PATH mangling in Git Bash** — a `C:\…` entry appended to `PATH` is split at
  the colon. Use `ARTEMIS_<TOOL>_PATH` env overrides instead of PATH surgery.
- **The emulator must be unlocked and awake.** `doctor` reports
  `Device / Emulator Connected` only when the keyguard is down. Recover with
  `adb shell input keyevent KEYCODE_WAKEUP` + `adb shell wm dismiss-keyguard`.
- **`scrcpy`'s bundled adb is version-matched** to the system adb here
  (both `37.0.1-15733141`) — a mismatch would restart the adb server and drop
  the device mid-task.
- **The Accessibility Helper is installed on the device** (v1.2.0, service
  enabled). It listens only on the phone's loopback port. Remove it with
  `uv run artemis helper uninstall`.
- **The daemon keeps running between tasks** — `uv run artemis stop` if a
  task leaves the device locked or the app foregrounded.

## 9. Verification record

| Check | Result |
|---|---|
| `uv sync` | exit 0 — full dependency tree resolved into `.venv` |
| `artemis doctor` | `Status: Ready — All system checks passed!` |
| Accessibility helper | `installed (version 6, service enabled)` on `emulator-5554` |
| MCP handshake (standalone probe) | `serverInfo: {name: artemis, version: 1.29.0}`, 5 tools advertised |
| `opencode mcp list` | `✓ artemis connected` |
| `mobile_get_device_state` (from the agent session) | returned a live screenshot of the emulator home screen |
| `mobile_run_task` (from the agent session) | enqueued, trace `87a0a7f1-e54e-4398-b207-fbc09996478f` |
