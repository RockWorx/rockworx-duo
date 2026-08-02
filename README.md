# RockWorx Duo

*An open-source developer tool from [RockWorx](https://github.com/RockWorx) -- offered to the community in the spirit of power-factor Human-AI collaboration.*

A local, browser-based cockpit for driving multiple AI coding-agent CLIs side by side. It runs a
small HTTP server on your own machine that spawns real terminals (via a PTY) and fans them out to a
browser UI, with file explorer, git, and project panels alongside. Domain features are add-ons
through a simple **plugin** seam, so the core stays generic.

> Windows-first today (terminals spawn via `pywinpty`/ConPTY). The PTY layer is abstracted behind a
> small interface, so a POSIX backend is a fast-follow.

## Features

- **Dual CLI** -- two persistent terminal lanes in the browser; broadcast one prompt to both.
- **Provider presets** -- Claude Code, Google Gemini, and OpenAI Codex out of the box; add your own.
- **Projects** -- file explorer + git panel + side-by-side git-diff, per project.
- **Scrollback search**, named layouts, transcript export, screenshots.
- **Plugins** -- drop a directory in `plugins/` to add a tab, a panel, and API routes. Ships with a
  **Local Models** example plugin (chat with Ollama / LM Studio).

## Quickstart

Requirements: Python 3.10+ and, on Windows, `pip install pywinpty`.

```bash
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

## License

MIT -- see `LICENSE`.
