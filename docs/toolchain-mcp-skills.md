# Toolchain rollout — MCP servers & agent skills (2026-10-06)

Docs-first record of the vetted toolchain expansion: 21 proposed MCP servers
(from a pasted list) + 10 skill repos (from the skill-leaderboard image).
Nothing is installed unless it **exists, is useful for OPEN-MUSIC, and cannot
break startup** (the "no problem" criterion).

## Method (reproducible)

1. **Existence check before install** (supply-chain vetting):
   - npm packages → `npm view <pkg> version` (404 = does not exist)
   - Python packages → `pip index versions <pkg>` (empty = does not exist)
   - Rust crates → `cargo search <crate>`
   - GitHub repos → `GET https://api.github.com/repos/<owner>/<repo>`
2. **Prerequisite check** — server only goes in if its runtime exists
   (`uv` and `ffmpeg` are **missing** on this machine; `python 3.12`, `pip 25.3`,
   `cargo 1.98.1`, `node 24`, `git 2.52` present).
3. **Config shape** — OpenCode **V2** uses `mcp.servers` and `permissions`
   (ordered rules); the pasted config used the **V1** flat `mcp` + `permission`
   shapes. The CLI (`opencode mcp add --global`) is the sanctioned path because
   it preserves unrelated settings.

## Verdict table — 21 pasted MCP servers

| # | Name | Verified? | Decision | Reason |
|---|------|-----------|----------|--------|
| 1 | rust-analyzer-mcp | ✔ crate 0.4.0 | **INSTALL** | Rust/Tauri core; hover/defs/refs/diagnostics |
| 2 | tauri-mcp (@hypothesi) | ✔ npm 0.13.0 | skip | needs `tauri-plugin-mcp-bridge` **inside the app** + POSIX `/tmp` socket — breaks on Windows |
| 3 | cargo-mcp | ✔ crate 0.2.0 | skip | duplicates plain `cargo` shell commands; context cost, no new capability |
| 4 | mcp-kb-sqlite | ✔ PyPI 0.2.0 (npm 404) | skip | `AGENTS.md` is the project's memory system; a second memory store drifts |
| 5 | mcp-json-yaml-toml | ✔ PyPI 0.10.2 | **INSTALL** | `tauri.conf.json`, `Cargo.toml`, CI YAML — comment/format-preserving edits |
| 6 | mcp-pytest | ✔ PyPI 0.1.1 | skip | project has no pytest (tests are `npm test` + `cargo test`) |
| 7 | portunusmcp-sentinel | ✔ PyPI 1.4.0 | skip | requires `OPENAI_API_KEY` — no such key on this machine |
| 8 | mcp-request | ✘ NOT FOUND | — | does not exist on PyPI |
| 9 | Playwright MCP | ✔ npm 0.0.83 | **INSTALL** | official; chromium already in `%LOCALAPPDATA%\ms-playwright` |
| 10 | ffmpeg-mcp-lite | ✔ PyPI 0.2.2 | skip | **ffmpeg binary missing** — server would fail on first call |
| 11 | GitHub MCP (remote) | ✔ hosted | skip (for now) | no `GITHUB_TOKEN` on this machine (AGENTS.md); add when token provided |
| 12 | DockerBro | ✔ PyPI 1.0.1 | skip | project has no Docker surface (CI runs on GH runners) |
| 13 | rust-docs-mcp | ✔ crate 0.1.1 | skip | 0.1.1 prototype; docs.rs/webfetch covers it |
| 14 | agentsec-cli | ✔ PyPI 1.3.0 | skip | better as a CI/CLI gate than an always-on server (context cost) |
| 15 | sast-mcp-server | ✔ PyPI 0.8.3 | skip | bundles 11 scanners (semgrep/trivy/CodeQL…) not installed → guaranteed failures |
| 16 | mcp-network | ✘ NOT FOUND | — | npm 404; `npm install -g mcp-network` cannot work |
| 17 | httpx-mcp | ✔ PyPI 1.0.1 | **INSTALL** | relay byte-range/Retry-After testing; `HTTPX_MCP_ALLOW_PRIVATE_NETWORK=true` for 127.0.0.1 |
| 18 | mcp-pulse | ✔ npm 1.0.0 | skip | observability for many servers; we run few |
| 19 | da2-mcp-multi-db | ✔ PyPI 0.1.1 | skip | no PostgreSQL exists yet (Phase-1 social is unbuilt) |
| 20 | ferret-mcp | ✔ PyPI 0.1.1 | skip | requires `FERRET_LLM_API_KEY` (placeholder `sk-ant-...`) |
| 21 | audio-analysis-mcp | ✘ NOT FOUND | — | not on PyPI; `uvx audio-analysis-mcp` cannot resolve |

**Net: 4 of 21 installed** (rust-analyzer, json-yaml-toml, playwright, httpx).
3 do not exist; the rest fail the "useful **and** no problem" test (missing
keys/runtimes, duplication, or app-side dependencies).

## Verdict table — 10 skill repos from the image

| # | Repo | API | Decision |
|---|------|-----|----------|
| 01 | obra/superpowers | ✔ 295.8k★ | install (inspect count first — multi-skill repo) |
| 02 | DietrichGebert/ponytail | ✔ 156.4k★ | **install** — user's standing "always use ponytail" request |
| 03 | nextlevelbuilder/ui-ux-pro-max-skill | ✔ 133.5k★ | already installed as skill `ui-ux-pro-max` |
| 04 | Graphify-Labs/graphify | ✔ 124.2k★ | install |
| 05 | JuliusBrussee/caveman | ✔ 110.1k★ | install |
| 06 | addyosmani/agent-skills | ✔ 101.7k★ | install |
| 07 | Egonex-AI/Understand-Anything | ✔ 85.4k★ | install |
| 08 | ComposioHQ/awesome-claude-skills | ✔ 76.6k★ | **aggregator** — per AGENTS.md rule 7, no bulk install; headline skills only |
| 09 | tt-ali/archify | ✘ **404** | does not exist — image entry is bogus |
| 10 | pbakaus/impeccable | ✔ 77.4k★ (565MB repo) | install shallow (`--depth 1`) |

Skills install target: `~/.config/opencode/skills/<id>/SKILL.md` (V2 documented
global source). Legacy `~/.opencode/skills/` (slim-readme, ui-ux-pro-max) is
still discovered and left untouched.

## Environment findings

- `uv` **missing** → all `uvx`/`uv run` commands from the pasted list would
  fail; PyPI servers installed with `pip` instead.
- `ffmpeg` **missing** → ffmpeg-mcp-lite skipped.
- Auto-approve **already configured** in `~/.config/opencode/opencode.jsonc`:
  `permissions: [{action:*, resource:*, effect:allow}, …]`. No change needed.
- OpenCode **restart required** after config edits; `opencode mcp list` shows
  live status.
- **No GitHub push** until the user gives the explicit go-ahead (AGENTS.md rule 1).

## Outcome (verified 2026-10-06, after restart)

**MCP — 5 connected** (`opencode mcp list`, tools live in-session):

| Server | Tools | Registration note |
|---|---|---|
| playwright | 25 | `npm i -g @playwright/mcp` → shim `playwright-mcp`; chromium pre-existing |
| rust-analyzer | 11 | `cargo install rust-analyzer-mcp` (2m07s); **positional** workspace arg |
| json-yaml-toml | 8 | `pip install mcp-json-yaml-toml` (uv missing) |
| httpx | 2 | `pip install httpx-mcp`; `HTTPX_MCP_ALLOW_PRIVATE_NETWORK=true` |
| context7 | 2 | from mcpmarket.com consult — replaces skipped rust-docs-mcp |

**Skills — 83 dirs** in `~/.config/opencode/skills/`: superpowers 15,
ponytail 6, caveman 23, agent-skills 25, understand 9, graphify 1 (renamed
`skill.md`→`SKILL.md`), impeccable 1 (`.opencode` copy; repo ships the same
skill ×24 agent dirs), + curated awesome-claude-skills picks `mcp-builder`,
`webapp-testing`, `skill-creator` (repo has **864** skills → aggregator cap,
rule 7).

**Incidents fixed during rollout:**
1. `opencode mcp add` migrated config to V2 `mcp.servers` and **dropped
   `agent-hub`**; user then said "skip agent-hub" → left out permanently.
2. pip pulled `starlette 1.7.0` → broke `fastapi 0.128.0`; pinned
   `starlette>=0.49.1,<0.51` → `pip check` clean.
3. CLI rejects `-y` anywhere in `mcp add` args → global-install npm servers,
   register the shim name (not `npm view bin`'s script-path value:
   `dist/index.js` is not spawnable).

**Also:** `.playwright-mcp/` (server's browser profile, created in repo root)
added to `.gitignore`. Auto-approve needed no change (`opencode.jsonc`
allow-all `permissions`). Temp clones deleted. No push — awaiting user call.
