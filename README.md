# RockWorx Duo

*An open-source developer tool from [RockWorx](https://github.com/RockWorx) -- offered to the community in the spirit of power-factor Human-AI collaboration.*

[![CI](https://github.com/RockWorx/rockworx-duo/actions/workflows/main.yml/badge.svg)](https://github.com/RockWorx/rockworx-duo/actions/workflows/main.yml)

A local, browser-based cockpit for driving multiple AI coding-agent CLIs side by side. It runs a
small HTTP server on your own machine that spawns real terminals (via a PTY) and fans them out to a
browser UI, with file explorer, git, and project panels alongside. Domain features are add-ons
through a simple **plugin** seam, so the core stays generic.

> **Cross-platform:** Windows (ConPTY via `pywinpty`) and macOS + Linux (via `ptyprocess`) -- the PTY
> backend is selected at runtime. CI runs the real terminal round-trip on all three (see the badge above).

## Features

- **Dual CLI** -- two persistent terminal lanes in the browser; broadcast one prompt to both.
- **Provider presets** -- Claude Code, Google Gemini, and OpenAI Codex out of the box; add your own.
- **Projects** -- file explorer + git panel + side-by-side git-diff, per project.
- **Scrollback search**, named layouts, transcript export, screenshots.
- **Plugins** -- drop a directory in `plugins/` to add a tab, a panel, and API routes. Ships with a
  **Local Models** example plugin (chat with Ollama / LM Studio).

## Quickstart

### Easiest -- no command line

1. Download the code: the green **Code** button above -> **Download ZIP**, then unzip it.
2. **Windows:** double-click **`install.bat`**.  **macOS / Linux:** run **`./install.sh`**.
   It creates a private environment, installs everything, and opens RockWorx Duo in your browser.
   (The first run will offer to install Python if you don't already have it.)
3. Next time, just use **`launch.bat`** (Windows) / **`./launch.sh`** (macOS/Linux).

### Manual (developers)

Requirements: Python 3.10+.

```bash
pip install -r requirements.txt   # websockets, + pywinpty (Windows) / ptyprocess (macOS/Linux)
cp harness.config.example.json harness.config.json   # optional; edit provider presets
python server.py
```

The server prints a local URL and an access token. Open the URL in your browser; the token gates all
requests. Point the workspace at a folder with `HARNESS_PROJECT_ROOT` (defaults to the current dir).

## Provider presets

Edit `harness.config.json` (see `docs/CONFIG.md`). Each preset is an `id -> { label, cmd }`; the `cmd`
is whatever CLI you launch (e.g. `claude`, `gemini`, `codex`). Shells (bash / PowerShell) are built in.

## Plugins

A plugin is a directory under `plugins/` with a `plugin.json` manifest; it may add a nav tab + panel
(frontend) and API routes (backend). See `docs/PLUGINS.md` and the bundled `plugins/local-models/`
as a copy-paste template. Plugins run in-process as **trusted local code** -- install only what you
trust (see `docs/SECURITY.md`).

## Feedback & contributing

RockWorx Duo is built in the open and shaped by the people who use it. If it's useful, **star the repo**;
if it's not quite right, tell us:
- **Bug or idea?** Open an [issue](../../issues/new/choose).
- **Question, or built a plugin?** Start a [discussion](../../discussions).
- **Want to contribute?** See [`CONTRIBUTING.md`](CONTRIBUTING.md). Security reports go
  [privately](../../security/advisories/new), not to public issues.

## License

MIT -- see `LICENSE`.
