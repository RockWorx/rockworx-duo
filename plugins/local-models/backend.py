"""Local Models plugin backend: proxy the OpenAI-compatible API that Ollama / LM Studio expose.

Auto-detects the local server: it probes the common defaults -- Ollama on :11434 and LM Studio on
:1234 -- and uses the first that answers. Override with env HARNESS_LOCAL_MODELS_URL (then only that
is used). Both apps serve /v1/models and /v1/chat/completions. Stdlib only. ASCII-only.

Plugin contract: register(ctx) mounts routes under /api/plugin/local-models/<subpath>. A GET handler
receives the query-params dict; a POST handler receives the already-parsed JSON body. Handlers return
a dict (serialized to JSON by the core).
"""
import json
import os
import urllib.error
import urllib.request

# Common local OpenAI-compatible servers, tried in order when no override is set.
DEFAULT_BASES = ["http://localhost:11434", "http://localhost:1234"]  # Ollama, LM Studio


def _models_url(base):
    return base + "/v1/models"


def _chat_url(base):
    return base + "/v1/chat/completions"


def _candidate_bases():
    env = os.environ.get("HARNESS_LOCAL_MODELS_URL")
    return [env.rstrip("/")] if env else list(DEFAULT_BASES)


def _get_json(url, timeout=10):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _post_json(url, payload, timeout=120):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _live_base():
    """Return the first candidate base whose /v1/models answers, else None."""
    for base in _candidate_bases():
        try:
            _get_json(_models_url(base), timeout=2)
            return base
        except (urllib.error.URLError, OSError):
            continue
    return None


def register(ctx):
    def models(_params):
        base = _live_base()
        if not base:
            return {"data": [], "error": "no local model server found (tried Ollama :11434 and "
                    "LM Studio :1234). Start one -- for LM Studio, enable its local server -- or set "
                    "HARNESS_LOCAL_MODELS_URL."}
        try:
            data = _get_json(_models_url(base))
            if isinstance(data, dict):
                data["base"] = base
            return data
        except (urllib.error.URLError, OSError) as e:
            return {"data": [], "error": "reaching %s failed: %s" % (base, e)}

    def chat(payload):
        base = _live_base()
        if not base:
            return {"error": "no local model server found (Ollama :11434 / LM Studio :1234)"}
        try:
            return _post_json(_chat_url(base), payload)
        except (urllib.error.URLError, OSError) as e:
            return {"error": "chat failed: %s" % e}

    ctx.route("GET", "/models", models)     # -> /api/plugin/local-models/models
    ctx.route("POST", "/chat", chat)        # -> /api/plugin/local-models/chat
