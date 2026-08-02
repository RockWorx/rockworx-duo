# RockWorx Duo

*An open-source developer tool from [RockWorx](https://github.com/RockWorx) -- offered to the community in the spirit of power-factor Human-AI collaboration.*

[![CI](https://github.com/RockWorx/rockworx-duo/actions/workflows/main.yml/badge.svg)](https://github.com/RockWorx/rockworx-duo/actions/workflows/main.yml)

A local, browser-based cockpit for driving multiple AI coding-agent CLIs side by side. It runs a small
HTTP server on your own machine that spawns real terminals (via a PTY) and fans them out to a browser UI,
with file explorer, git, and project panels alongside. Domain features are add-ons through a simple
**plugin** seam, so the core stays generic.

> **Cross-platform:** Windows (ConPTY via `pywinpty`) and macOS + Linux (via `ptyprocess`) -- the PTY
> backend is selected at runtime, and CI runs the real terminal round-trip on all three (see the badge).
>
> **Everything runs locally -- and hardened even so.** The server binds to `127.0.0.1` only, but because a
> page in another browser tab can still reach a local server, **every request is gated by a per-session
> token** (printed at startup) **plus Origin/Host checks** -- so a stray or malicious website can't drive
> your terminals, and the port is bound exclusively so another process can't hijack it. Nothing is sent
> anywhere except to the agent CLIs you choose to run. See [Security](#security).

---

## Easy install (no command line)

For most people -- no Python knowledge or terminal required.

1. **Download it.** Click the green **`< > Code`** button near the top of this page, then **Download ZIP**.
   Unzip the file somewhere you'll find it (e.g. your Documents folder).
2. **Run the installer:**
   - **Windows:** double-click **`install.bat`**.
   - **macOS:** double-click **`install.sh`**. The first time, if macOS blocks it, right-click it →
     **Open** (that clears Apple's "unidentified developer" warning).
   - **Linux:** run **`./install.sh`** (from your file manager or a terminal).
3. **Let it work.** It tells you what it's doing at each step: it checks for Python (and offers to install
   it if you don't have it), sets up a private environment, downloads a couple of small components, then
   **opens RockWorx Duo in your web browser** and adds a **"RockWorx Duo" shortcut to your Desktop**.
4. **From then on,** just use the **Desktop shortcut** (or `launch.bat` / `launch.sh` in the folder) to
   start it again -- no reinstall needed.

> **Heads-up, Windows:** because this is a program you downloaded, Windows SmartScreen may say *"Windows
> protected your PC."* Click **More info → Run anyway**. That warning appears for any unsigned downloaded
> program -- every file here is plain text you can read first.
>
> **First run may install Python.** If you don't already have Python, the Windows installer uses `winget`
> to add it, then asks you to **close the window and double-click `install.bat` once more** to finish.

## Developer install

Requirements: Python 3.10+.

```bash
pip install -r requirements.txt   # websockets, + pywinpty (Windows) / ptyprocess (macOS/Linux)
cp harness.config.example.json harness.config.json   # optional; edit provider presets
python server.py
```

The server prints a local URL and an access token, then opens your browser. `HARNESS_NO_BROWSER=1`
suppresses auto-open; `HARNESS_PROJECT_ROOT` points the file/git/project panels at a folder (defaults to
the current directory). See [`docs/CONFIG.md`](docs/CONFIG.md) for all settings.

## What you need

- **To drive an AI agent in a lane,** install that CLI separately: **Claude Code** (`claude`),
  **Google Gemini** (`gemini`), or **OpenAI Codex** (`codex`) -- each has its own sign-in. RockWorx Duo
  drives whichever ones you have.
- **You don't need any of those to get value:** the built-in **shells** and the **Local Models** chat
  (Ollama / LM Studio) work on their own.

## Using it

- **Dual CLI** -- two persistent terminal lanes in the browser; the **broadcast box** sends one prompt to
  both, so you can compare agents side by side.
- **Tabs own their identity** -- each lane holds multiple tabs, and the toolbar under the tab strip follows
  the **active tab's** provider: model, effort, resume, and restart all act on that tab. Tabs are labeled
  `provider:folder` (e.g. `gemini:my-project`), so a Gemini tab opened in the Claude lane is Gemini through
  and through.
- **The `+` in a lane** -- a menu led by your **Projects**: hover a project and pick the agent to run it
  with (Claude / Gemini / Codex), or start an agent / shell in the default folder, or a custom path. (Click
  `+` again to close the menu.)
- **duo_inbox** -- the **envelope** on a tab sends a short message to any other tab (in this or another
  browser window); the **inbox** shows messages for the active tab and stages a chosen one at its prompt for
  you to send. Messages ride your browser's local storage -- nothing leaves the machine.
- **Projects** -- file explorer, git panel, and a side-by-side git diff.
- **Working aids** -- scrollback search, named layouts, screenshots, and **Transcript**, which saves the
  terminal's text into the active tab's project directory (with a browser-download fallback).

## Local models (Ollama / LM Studio)

The bundled **Local Models** plugin chats with a local OpenAI-compatible server. It **auto-detects**
**Ollama** (`http://localhost:11434`) and **LM Studio** (`http://localhost:1234`) and uses whichever is
running -- no configuration. For **LM Studio**, start its local server first (**Developer → Start Server**).
To point at a different address, set `HARNESS_LOCAL_MODELS_URL=http://localhost:<port>` before launching.

## Plugins

A plugin is a directory under `plugins/` with a `plugin.json` manifest; it may add a nav tab + panel
(frontend) and API routes (backend). See [`docs/PLUGINS.md`](docs/PLUGINS.md) and the bundled
`plugins/local-models/` as a copy-paste template. Plugins run in-process as **trusted local code** --
install only what you trust (see [`docs/SECURITY.md`](docs/SECURITY.md)).

## Troubleshooting

- **Windows "protected your PC" / SmartScreen:** click **More info → Run anyway** (it's an unsigned
  downloaded script).
- **macOS "cannot verify developer":** right-click `install.sh` (or the Desktop `RockWorx Duo.command`) →
  **Open**.
- **"Python was not found":** let the installer add it (winget on Windows, Homebrew on macOS), or install
  from https://www.python.org/downloads/ -- on Windows, tick **Add python.exe to PATH** -- then run the
  installer again.
- **The browser didn't open:** open the URL the window prints, e.g. `http://127.0.0.1:8888/index.html`.
  If a port is busy it automatically uses the next free one, so read the printed URL.
- **Local Models tab is empty:** start Ollama, or start LM Studio's **local server** (Developer → Start
  Server). Confirm it's up by opening `http://localhost:1234/v1/models` in a browser.
- **An agent lane won't start:** that provider's CLI isn't installed or isn't on your PATH -- install
  `claude`, `gemini`, or `codex`.
- **Stop it:** close the server window (or press `Ctrl-C` in it).
- **Update:** download the latest ZIP (or `git pull`) and run the installer again.

## Security

RockWorx Duo runs entirely on your machine -- but "local" is not the same as "unprotected," and it is built
that way on purpose:

- **`127.0.0.1`-only bind** -- the server never listens on a public interface.
- **Per-session token on every request** -- printed at startup and required by every API and WebSocket
  call, so another program on your machine can't quietly drive your terminals.
- **Origin / Host validation (anti-hijacking)** -- a webpage you open in another tab *can* fire requests at
  `localhost`; those are rejected, so a malicious site can't reach your session.
- **Exclusive port bind** -- the port is claimed outright so another process can't share or hijack it.
- **Path jail** -- file, transcript, and plugin-asset access is confined under your home directory; `..`
  escapes are refused.

Plugins are trusted, in-process local code (no sandbox, like editor extensions) -- install only what you
trust. Full details and how to report a vulnerability privately: [`docs/SECURITY.md`](docs/SECURITY.md).

## Feedback & contributing

RockWorx Duo is built in the open and shaped by the people who use it. If it's useful, **star the repo**;
if it's not quite right, tell us:
- **Bug or idea?** Open an [issue](../../issues/new/choose).
- **Question, or built a plugin?** Start a [discussion](../../discussions).
- **Want to contribute?** See [`CONTRIBUTING.md`](CONTRIBUTING.md). Security reports go
  [privately](../../security/advisories/new), not to public issues.

## License

MIT -- see [`LICENSE`](LICENSE).
