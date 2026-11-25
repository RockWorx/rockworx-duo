# Configuration

## `harness.config.json`

Optional. Copy `harness.config.example.json` to `harness.config.json` and edit. Currently the server
reads the `agents` key -- the provider presets shown in the New-tab menu:

```json
{
  "agents": {
    "claude": { "label": "Claude Code",   "cmd": "claude" },
    "gemini": { "label": "Google Gemini", "cmd": "gemini" },
    "codex":  { "label": "OpenAI Codex",  "cmd": "codex"  }
  }
}
```

Each preset is `id -> { label, cmd }`. `cmd` is the CLI executable to spawn for that lane. A missing or
invalid file falls back to the built-in Claude/Gemini/Codex defaults. Shells (bash / PowerShell / Git
Bash) are always available and are handled separately from presets.

## Environment variables

| Variable | Meaning | Default |
|---|---|---|
| `HARNESS_PROJECT_ROOT` | Workspace root the file/git/project panels operate on | current directory |
| `HARNESS_CONFIG` | Path to the config JSON | `harness.config.json` next to `server.py` |
| `HARNESS_PLUGINS_DIR` | Extra directory to discover plugins in | `<core>/plugins` |
| `HARNESS_LOCAL_MODELS_URL` | Base URL for the Local Models plugin (Ollama / LM Studio) | `http://localhost:11434` |
| `HARNESS_TAILNET` | `1` opts in to an extra listener on this machine's Tailscale address (see [`SECURITY.md`](SECURITY.md)) | off (loopback only) |
| `HARNESS_TAILNET_BIND` / `HARNESS_TAILNET_HOST` | Explicit tailnet address / DNS name; setting either also opts in | unset |
| `HARNESS_NO_TAILNET` | `1` forces the tailnet listener off, overriding the opt-in variables | unset |

## Access

On start, the server prints a local URL (and whether the optional tailnet listener is on). The UI
fetches a per-run session token from `/api/config`, which answers only a loopback client or an allowed
page Origin; every other API call and the terminal WebSocket require that token (query string or
header). Requests from disallowed Origins/Hosts are rejected. Keep the token local. Details:
[`SECURITY.md`](SECURITY.md).
