# Changelog

All notable changes to `@aitherium/awsh` are documented here.

## [2.0.0] — 2026-11-25

Paired with **`awdk 4.0.0`** — overhauled as a daily-driver multi-harness terminal cockpit with proper terminal avatars back and working out of the box.

### Terminal Avatars Overhaul
- **Multi-protocol native terminal graphics engine (`src/tui/terminal-graphics.ts`)**: auto-detects and renders **Kitty Graphics Protocol** (Kitty, Ghostty, WezTerm), **iTerm2 Inline Images** (OSC 1337), **Sixel Graphics** (Windows Terminal 1.22+, foot, mlterm, Contour, Mintty), and crisp **area-averaged 24-bit half-block** fallback (universal, tmux/SSH safe). Zero external dependencies.
- **Fixed 50% vertical portrait clipping bug in `portrait.ts`**: replaced doubled `scaleY * 2` nearest-neighbor sampling with premultiplied-alpha box-filter area averaging across every cell's top and bottom halves, plus full 8-bit PNG color-type decoding (greyscale, RGB, palette, grey+alpha, RGBA).
- **Smart portrait bust framing**: automatically trims transparent headroom and frames head & shoulders (`bust`, switchable to `full`) so faces are crisp and expressive at 16–32 terminal columns.
- **Bundled avatar packs ship inside npm (`assets-bundled/`, 1.71 MB for 5 animated characters)**: `aither`, `blob`, `bun`, `bunny`, and `pip` now work out of the box on every `npm i -g @aitherium/awsh` install — plus `~/.aither/avatars/<name>-portrait/` for custom avatars and `awdesk` `cast.json` sync.
- **Fixed TUI avatar docking geometry (`screen.ts`)**: docked portraits now start on row 2 (never overwriting the top status bar), reserve columns from `output` when `trace` is hidden (never overlapping chat text), pause cleanly behind open overlays/pickers, clear Kitty image IDs cleanly on hide/detach, and display a live `✦ <name> · <emotion>` caption underneath.
- **New `awsh avatar` CLI & upgraded `/avatar` slash command**: `awsh avatar [show|list|use|protocol|crop|demo|sync]` and `/avatar protocol|crop|mood|sync`.

### Daily-Driver Cockpit & `awdk 4.0` Pairing
- **`awsh up` / `awsh harness up`**: one-command local harness bootstrap paired with `adk harness up` (`hookd`, `awsh` :8362, `aw-hub`, Antigravity & Claude Code wiring) plus avatar/graphics readiness summary.
- **`awsh antigravity`**: first-class 2-way Google Antigravity bridge (`setup`, `doctor`, `sessions`, `spawn`, `steer`).
- **Multi-harness `awsh agent`**: `--harness <antigravity|claude|codex|gemini|aider|opencode|adk>` (no longer hardcoded to Claude Code), fairy-colored headers, plus `/harness` and `/avatar` inside the agent REPL.
- **Interactive Sessions Cockpit (`Ctrl+S`)**: press `i` inside the live cockpit to `steer <n> <msg>`, `focus <n>`, `new <harness> [title]`, or `kill <n>` without leaving the view.
- **Updated docs & `--help`**: accurate TUI-default documentation, unified `@aitherium/awsh` package name.
