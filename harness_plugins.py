"""Plugin discovery for the harness -- pure and Windows-free (no pywinpty), so it unit-tests off
the harness runtime like projects.py / harness_config.py. A plugin is a directory with a
plugin.json manifest. ASCII-only."""
import json
import re
from pathlib import Path

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def parse_manifest(path):
    """Parse a plugin.json into a validated manifest (+ 'dir'), or None if malformed / not an
    object / 'id' missing or not a slug. SECURITY: id reaches a route path and a DOM handler, so
    a non-slug id must never load. Optional fields default (name, tab, frontend, backend)."""
    p = Path(path)
    try:
        fm = json.loads(p.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None
    if not isinstance(fm, dict):
        return None
    pid = fm.get("id")
    if not isinstance(pid, str) or not _ID_RE.match(pid):  # str-only: a numeric id would stay int and break asset lookup (== str)
        return None
    fm["dir"] = str(p.parent)
    fm.setdefault("name", pid)
    fm.setdefault("tab", {})
    fm.setdefault("frontend", {})
    fm.setdefault("backend", None)
    try:
        fm["order"] = int(fm.get("order", 100))   # optional tab ordering; lower sorts further left
    except (TypeError, ValueError):
        fm["order"] = 100
    return fm


def discover_plugins(*dirs):
    """Find <dir>/*/plugin.json across each plugins dir; parse; skip malformed; de-dupe by id
    (first dir wins); return sorted by id."""
    out, seen = [], set()
    for d in dirs:
        base = Path(d)
        if not base.is_dir():
            continue
        for manifest in sorted(base.glob("*/plugin.json")):
            pj = parse_manifest(manifest)
            if pj and pj["id"] not in seen:
                seen.add(pj["id"])
                out.append(pj)
    return sorted(out, key=lambda p: (p.get("order", 100), p["id"]))
