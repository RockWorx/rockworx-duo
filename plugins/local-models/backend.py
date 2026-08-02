"""Local Models plugin backend: proxy the OpenAI-compatible API that Ollama / LM Studio expose.

Base URL comes from env HARNESS_LOCAL_MODELS_URL (default: Ollama at http://localhost:11434).
Both Ollama and LM Studio serve /v1/models and /v1/chat/completions. ASCII-only. Uses only stdlib
(no extra deps) so the core stays dependency-light.

Plugin contract: register(ctx) mounts routes under /api/plugin/local-models/<subpath>. A GET handler
receives the query-params dict; a POST handler receives the already-parsed JSON body. Handlers return
a dict (serialized to JSON by the core).
"""
import json
import os
import urllib.error
import urllib.request


def _base():
    return os.environ.get("HARNESS_LOCAL_MODELS_URL", "http://localhost:11434").rstrip("/")


def _models_url(base):
    return base + "/v1/models"


def _chat_url(base):
    return base + "/v1/chat/completions"


def _get_json(url, timeout=10):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _post_json(url, payload, timeout=120):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def register(ctx):
    def models(_params):
        try:
            return _get_json(_models_url(_base()))
        except (urllib.error.URLError, OSError) as e:
            return {"data": [], "error": "no local model server at %s (%s)" % (_base(), e)}

    def chat(payload):
        try:
            return _post_json(_chat_url(_base()), payload)
        except (urllib.error.URLError, OSError) as e:
            return {"error": "chat failed: %s" % e}

    ctx.route("GET", "/models", models)     # -> /api/plugin/local-models/models
    ctx.route("POST", "/chat", chat)        # -> /api/plugin/local-models/chat
