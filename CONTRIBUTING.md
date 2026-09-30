# Contributing to TRANCE MUSIC

Thanks for looking. This is a small project with a hard rule about scope: **the
Rust core is the tested part, the front end is not.** Please read
[`docs/architecture.md`](docs/architecture.md) before changing the streaming
path — most of the design decisions there look arbitrary until you know why.

## Getting set up

```bash
cd app
npm install
npm run tauri dev
```

Requirements: Rust 1.77+, Node 18+, MSVC build tools. Windows-first; the Rust
side is written to keep compiling elsewhere but is untested off Windows.

## Ground rules

- **No new runtime dependencies without discussion.** The front end has
  *zero* build tooling and *zero* runtime libraries on purpose. If something can
  be done with the platform (a native `<dialog>`, `<input type="date">`, CSS),
  do that instead. The Rust side is stricter still — `windows` and friends are
  target-gated so non-Windows builds keep working.
- **Comments explain *why*, never *what*.** Match the density of the file you
  are editing. A comment restating the line below it is noise; a comment
  recording a non-obvious constraint or a past bug is worth its weight.
- **Cite the docs by section** (`docs/architecture.md §6`) when a change
  touches a documented decision, the way the existing source does.
- **Never log or commit secrets.** No tokens, no user paths, no API keys.

## Tests

```bash
cd app/src-tauri && cargo test
```

Anything touching parsing, decryption, quality selection, range qualification,
the proxy, or lyrics source ordering needs a test. Pure-DOM changes cannot be
covered yet — if you change `main.js`, say in the PR description exactly what
you clicked to verify it.

The smallest thing that fails when the logic breaks is the bar. An `assert`-based
check is fine; a framework is not.

## Code style

- `.editorconfig` is the source of truth: LF, UTF-8, 2-space indent (4 for Rust),
  final newline.
- Follow the surrounding code rather than importing a style from elsewhere. The
  codebase is consistent about `///` doc comments on anything non-obvious in
  Rust, and flat `function` declarations in `main.js`.
- Keep diffs small. If a change touches 40 files, it is probably two changes.

## Commit messages

Short imperative subject, one line, no trailing period. Explain the *why* in the
body when it is not obvious. Add entries to `CHANGELOG.md` under
`[Unreleased]` for anything a user would notice.

## Reporting bugs

Include the app version/commit, your OS, and what you clicked. If it involves
playback, the Diagnostics panel on the Search screen has a trace of the last
backend calls — attach the relevant lines.
