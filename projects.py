"""Project model for the harness -- pure and Windows-free (no pywinpty),
so it unit-tests off the harness runtime. A "project" is a program/pursuit declared
by a project.md manifest at its root.
ASCII-only."""
from __future__ import annotations
import re
import subprocess
from pathlib import Path

import yaml

_FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", re.S)


def parse_manifest(path):
    """Parse a project.md into a manifest dict (+ 'notes', '_manifest'). Returns None
    if there is no valid front-matter, it is not a mapping, or 'id'/'root' are absent."""
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    m = _FM_RE.match(text.replace("\r\n", "\n"))
    if not m:
        return None
    try:
        fm = yaml.safe_load(m.group(1))
    except yaml.YAMLError:
        return None
    if not isinstance(fm, dict) or not fm.get("id") or not fm.get("root"):
        return None
    if not _ID_RE.match(str(fm["id"])):
        return None   # SECURITY: a non-slug id must not reach the UI (it lands in a DOM handler)
    fm["notes"] = m.group(2).strip()
    fm["_manifest"] = str(Path(path))
    return fm


def discover_projects(repo_root, extra_dirs=()):
    """Find project.md at: repo_root/project.md, repo_root/aircraft/*/project.md, and
    repo_root/<d>/project.md for each d in extra_dirs. Parse each; skip malformed;
    resolve root_abs; de-dupe by id; return sorted by id."""
    repo_root = Path(repo_root)
    candidates = [repo_root / "project.md"]
    aircraft = repo_root / "aircraft"
    if aircraft.is_dir():
        candidates += sorted(aircraft.glob("*/project.md"))
    for d in extra_dirs:
        candidates.append(repo_root / d / "project.md")
    out, seen = [], set()
    for c in candidates:
        if not c.is_file():
            continue
        pj = parse_manifest(c)
        if pj and pj["id"] not in seen:
            seen.add(pj["id"])
            pj["root_abs"] = str((repo_root / pj["root"]).resolve())
            out.append(pj)
    return sorted(out, key=lambda p: p["id"])


def _git(repo_root, args):
    try:
        r = subprocess.run(["git", "-C", str(repo_root)] + args,
                           capture_output=True, text=True, timeout=8)
        return r.stdout.strip()
    except Exception:
        return ""


def project_detail(project, repo_root):
    """Augment a manifest with per-program live data: the current branch, and the last
    10 commits that touched the project's root (genuinely per-program, no mapping).
    Repo-wide git STATUS is served separately by the existing /api/git/status."""
    repo_root = Path(repo_root)
    root_rel = project.get("root", ".")
    branch = _git(repo_root, ["rev-parse", "--abbrev-ref", "HEAD"])
    log = _git(repo_root, ["log", "--oneline", "-10", "--", root_rel])
    recent = [ln for ln in log.splitlines() if ln.strip()]
    return {**project, "branch_current": branch, "recent_activity": recent}


def get_project(repo_root, project_id, extra_dirs=()):
    """Find one discovered project by id and return it with project_detail(), or None."""
    for pj in discover_projects(repo_root, extra_dirs):
        if pj["id"] == project_id:
            return project_detail(pj, repo_root)
    return None


_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def create_project_manifest(repo_root, id, name, root, objective="",
                            branch="", phase="", notes="", extra_dirs=()):
    """Write a NEW project.md manifest (the A.1 "New Project" scaffold) and return its
    parsed record (with root_abs). Pure/Windows-free: the CALLER is responsible for any
    home-jail check on the resolved root. Never clobbers -- raises ValueError on a bad
    field, an id collision with an existing project, or an existing manifest at the target.
    Values are emitted via yaml.safe_dump so a name/objective with YAML-special characters
    round-trips cleanly."""
    repo_root = Path(repo_root)
    id = (id or "").strip()
    name = (name or "").strip()
    root = (root or "").strip().replace("\\", "/").strip("/")
    if not _ID_RE.match(id):
        raise ValueError("id must be a slug [a-z0-9-] starting with a letter or digit")
    if not name:
        raise ValueError("name is required")
    if not root:
        raise ValueError("root is required")
    parts = Path(root).parts
    if Path(root).is_absolute() or ".." in parts:
        raise ValueError("root must be a repo-relative path with no '..'")
    if root == ".":
        raise ValueError("root must be a subdirectory, not the repo root")
    if any(p["id"] == id for p in discover_projects(repo_root, extra_dirs)):
        raise ValueError(f"a project with id '{id}' already exists")
    root_abs = (repo_root / root).resolve()
    manifest = root_abs / "project.md"
    if manifest.exists():
        raise ValueError(f"a project.md already exists at {root}")
    fm = {"id": id, "name": name, "root": root}
    if branch:
        fm["branch"] = branch
    if objective:
        fm["objective"] = objective
    if phase:
        fm["phase"] = phase
    block = yaml.safe_dump(fm, sort_keys=False, allow_unicode=True,
                           default_flow_style=False).strip()
    body = notes.strip() or f"{name} -- program notes."
    root_abs.mkdir(parents=True, exist_ok=True)
    manifest.write_text(f"---\n{block}\n---\n{body}\n", encoding="utf-8")
    pj = parse_manifest(manifest)
    pj["root_abs"] = str(root_abs)
    return pj
