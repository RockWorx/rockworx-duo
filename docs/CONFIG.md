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

## Access

On start, the server prints a local URL and a session token. The token is required on every request
(query string or header); requests from disallowed Origins/Hosts are rejected. Keep the token local.
