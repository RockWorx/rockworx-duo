# Writing a plugin

A plugin is a **directory** under `plugins/` (or under `$HARNESS_PLUGINS_DIR`), discovered at startup.
It may contribute a nav tab + panel (frontend), API routes (backend), and its own private state dir.

```
plugins/local-models/
  plugin.json     # manifest (required)
  panel.html      # markup injected into the tab's view area
  panel.js        # behavior; talks to the core via window.Harness.*
  panel.css       # optional styles
  backend.py      # optional; mounts /api/plugin/<id>/*
```

## Manifest (`plugin.json`)

```json
{
  "id": "local-models",
  "name": "Local Models",
  "tab":      { "label": "Local Models", "icon": "🤖" },
  "frontend": { "panel": "panel.html", "script": "panel.js", "style": "panel.css" },
  "backend":  "backend.py"
}
```

`id` MUST be a slug (`^[a-z0-9][a-z0-9-]*$`) -- it becomes a route path and a DOM id, so it is
validated for safety. A plugin that fails to load logs a warning and is skipped; it never takes down
the core.

## Backend (`backend.py`)

Define `register(ctx)`. The context exposes ONLY generic core services:

```python
def register(ctx):
    # ctx.PROJECT_ROOT  -> Path to the workspace root
    # ctx.STATE_DIR     -> Path to this plugin's OWN private state dir (already created)
    # ctx.git(args)     -> run a git command in PROJECT_ROOT
    # ctx.route(method, subpath, handler)

    def rubric(params):        # GET handler: receives the query-params dict
        return {"ok": True}    # return a dict; the core serializes it to JSON

    def save(payload):         # POST handler: receives the already-parsed JSON body
        return {"saved": True}

    ctx.route("GET",  "/rubric", rubric)   # -> /api/plugin/local-models/rubric
    ctx.route("POST", "/save",   save)
```

Plugin routes are namespaced under `/api/plugin/<id>/...`, inherit the core's token + Origin gates, and
get a private state dir at `<state>/plugins/<id>/`. Handlers **return a dict** (or raise -> the core
returns a 500 JSON error). Surface expected failures as `{"error": "..."}` so the panel can show them.

## Frontend (`panel.js`)

```js
Harness.registerPanel("local-models", {
  onActivate() {                                   // called when the tab is shown
    const data = await Harness.api("/api/plugin/local-models/models");  // token added automatically
    // Harness.api(path, opts?) returns PARSED JSON. opts is a normal fetch init (method, body, ...).
    // ... render into the panel's elements (referenced by their ids in panel.html) ...
  },
  onDeactivate() { /* optional cleanup */ }
});
```

`window.Harness` is the stable, documented frontend API:
`registerPanel(id, {onActivate, onDeactivate})`, `api(path, opts)` (token-wrapped fetch returning
parsed JSON), `openPreview(item)`, and `CONFIG`. The core promises not to break it.

See `plugins/local-models/` for a complete working example (a chat panel that proxies the
OpenAI-compatible API of Ollama / LM Studio).
