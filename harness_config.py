"""Env-driven runtime configuration for the Duo harness -- pure and Windows-free
(no pywinpty), so it unit-tests off the harness runtime like projects.py. Resolves the
CONTENT root, the per-instance STATE dir, and the port lists from the environment, each
defaulting to today's single-world behavior (zero business regression). ASCII-only. See
docs/superpowers/specs/2026-08-01-harness-personal-track-design.md."""
from __future__ import annotations
import os
from pathlib import Path


def project_root(default_root, env=None):
    """The CONTENT root the harness operates on: git, the explorer jail, project
    discovery. Defaults to default_root (the current working directory) when
    HARNESS_PROJECT_ROOT is unset or blank."""
    env = os.environ if env is None else env
    v = (env.get("HARNESS_PROJECT_ROOT") or "").strip()
    return Path(v).resolve() if v else Path(default_root)


def state_dir(default_dir, env=None):
    """The per-instance directory for runtime STATE (.harness_state.json, scrollback,
    the project registry, layouts, dossier, voice, silhouettes). Defaults to default_dir
    (web/harness) so two instances never clobber each other's state."""
    env = os.environ if env is None else env
    v = (env.get("HARNESS_STATE_DIR") or "").strip()
    return Path(v) if v else Path(default_dir)


def resolve_ports(env_name, default_list, env=None):
    """A single env-pinned port REPLACES the bind-fallback list (deterministic for a
    bookmarked personal instance); unset/blank -> the default fallback list. A malformed
    or out-of-range value raises ValueError -- fail loud, never silently fall back to a
    default port (which could collide the personal instance onto the business port)."""
    env = os.environ if env is None else env
    v = (env.get(env_name) or "").strip()
    if not v:
        return list(default_list)
    try:
        port = int(v)
    except ValueError:
        raise ValueError(f"{env_name} must be an integer port, got {v!r}")
    if not (1 <= port <= 65535):
        raise ValueError(f"{env_name} out of range 1-65535: {port}")
    return [port]
