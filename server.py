#!/usr/bin/env python3
"""Browser harness server (canonical backend).

Serves the harness UI plus:
  - Real ConPTY terminal sessions (agent CLIs) bridged over WebSockets.
    Multiple sessions ("tabs") per CLI, each with its own working directory.
  - Live JSON APIs: /api/config, /api/ls, /api/sessions (GET),
    /api/session + /api/session/kill (POST).

Security posture: binds 127.0.0.1 ONLY, with SO_EXCLUSIVEADDRUSE so another
process cannot silently hijack the port. There is NO arbitrary-shell endpoint;
the only way to run commands is through the visible PTY terminals.

NOTE: PtyProcess.spawn takes an ARGV LIST. Passing a pre-quoted string gets
re-quoted by pywinpty and the target receives literal escaped quotes.

Run:  python server.py          (opens browser)
      set HARNESS_NO_BROWSER=1 to suppress auto-open.
"""

import asyncio
import json
import mimetypes
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import websockets
from websockets.asyncio.server import serve as ws_serve

HARNESS_DIR = Path(__file__).resolve().parent

import harness_config as hcfg
import pty_backend
# PROJECT_ROOT is the CONTENT root (git, explorer, projects) -- env-overridable via
# HARNESS_PROJECT_ROOT, defaulting to the current working directory.
PROJECT_ROOT = hcfg.project_root(Path.cwd())
STATE_DIR = hcfg.state_dir(HARNESS_DIR)
STATE_DIR.mkdir(parents=True, exist_ok=True)

# Filesystem jail root: every path the harness browses / reads / serves must resolve
# under this directory. Env-overridable via HARNESS_ROOT; defaults to the content root.
ROOT_DIR = Path(os.environ.get("HARNESS_ROOT") or PROJECT_ROOT).resolve()

HTTP_PORTS = hcfg.resolve_ports("HARNESS_HTTP_PORT", [8888, 8889, 8900])
WS_PORTS = hcfg.resolve_ports("HARNESS_WS_PORT", [8877, 8878, 8879])
BIND = "127.0.0.1"

# Tailnet exposure. Binds an ADDITIONAL address (this machine's Tailscale IP)
# ALONGSIDE loopback so a device on the operator's own tailnet (e.g. an iPad) can
# reach the harness -- WITHOUT dropping the 127.0.0.1 bind and WITHOUT exposing
# 0.0.0.0 (which a no-Origin curl on an untrusted LAN could use to grab the
# token). The Origin allow-list (below) then trusts the tailnet page origin; the
# per-run TOKEN gate is UNCHANGED, so the tailnet remains the trust boundary.
#
# AUTO-DETECTED by default (zero config) via the Tailscale CLI. Precedence:
#   HARNESS_NO_TAILNET set        -> disabled (loopback only)
#   HARNESS_TAILNET_BIND/HOST env -> explicit override
#   else                          -> `tailscale ip -4` + `tailscale status --json`
# Falls back to loopback-only if Tailscale is absent/down (graceful).
def _detect_tailnet():
    if os.environ.get("HARNESS_NO_TAILNET"):
        return None, None
    ip = os.environ.get("HARNESS_TAILNET_BIND") or None
    host = os.environ.get("HARNESS_TAILNET_HOST") or None
    if ip and host:
        return ip, host
    ts = shutil.which("tailscale") or r"C:\Program Files\Tailscale\tailscale.exe"
    if not os.path.exists(ts):
        return ip, host
    try:
        if not ip:
            r = subprocess.run([ts, "ip", "-4"], capture_output=True, text=True, timeout=4)
            for line in (r.stdout or "").splitlines():
                line = line.strip()
                if line.startswith("100."):   # CGNAT tailnet range 100.64.0.0/10
                    ip = line
                    break
        if ip and not host:
            r = subprocess.run([ts, "status", "--json"], capture_output=True, text=True, timeout=5)
            host = ((json.loads(r.stdout or "{}").get("Self") or {}).get("DNSName") or "").rstrip(".") or None
    except Exception:
        pass
    return ip, host


TAILNET_BIND, TAILNET_HOST = _detect_tailnet()

# --- CSWSH / cross-origin defense -------------------------------------------
# Binding to 127.0.0.1 stops REMOTE hosts, but a malicious *webpage* the user
# visits can still open ws://127.0.0.1:<port>/pty (browsers do NOT enforce CORS
# on WebSockets) or fire cross-origin fetches at the JSON APIs. Two gates close
# that: (1) a per-run secret TOKEN handed only to the same-origin UI via
# /api/config (a cross-origin page cannot READ that response), required on every
# WS handshake + acting/JSON API call; (2) an Origin allow-list -- a page's
# fetch/WS always carries its Origin, so a foreign Origin is rejected outright.
SESSION_TOKEN = secrets.token_hex(16)
ACTIVE_HTTP_PORT = HTTP_PORTS[0]


def _allowed_origins():
    o = {f"http://127.0.0.1:{ACTIVE_HTTP_PORT}",
         f"http://localhost:{ACTIVE_HTTP_PORT}"}
    # Tailnet page origins (opt-in): the device may reach the harness by MagicDNS
    # name or tailnet IP, over http or https (e.g. plain http:PORT, or `tailscale
    # serve` https). Add all four forms so the WS + JSON-API Origin gate accepts them.
    for hv in (TAILNET_HOST, TAILNET_BIND):
        if hv:
            for scheme in ("http", "https"):
                o.add(f"{scheme}://{hv}")
                o.add(f"{scheme}://{hv}:{ACTIVE_HTTP_PORT}")
    return o


def _origin_ok(origin):
    """A cross-origin browser attack always carries a foreign Origin header;
    reject those. A None Origin (same-origin navigation or a non-browser client
    that is already the local user) is allowed -- the TOKEN is the hard gate."""
    return origin is None or origin in _allowed_origins()


def _token_ok(token):
    return bool(token) and secrets.compare_digest(str(token), SESSION_TOKEN)


def _allowed_hosts():
    """Host-header allow-list -- the anti-DNS-rebinding control. A rebound page reaches 127.0.0.1
    but the browser still sends the ATTACKER'S hostname in Host, so it fails this set. Mirrors the
    Origin allow-list (loopback + the tailnet host/IP), with and without the :PORT suffix."""
    hosts = {"127.0.0.1", "localhost"}
    for hv in (TAILNET_HOST, TAILNET_BIND):
        if hv:
            hosts.add(str(hv).lower())
    out = set()
    for h in hosts:
        out.add(h)
        out.add(f"{h}:{ACTIVE_HTTP_PORT}")
    return out


def _host_ok(host):
    return bool(host) and host.split(",")[0].strip().lower() in _allowed_hosts()


def _blocked_static(path):
    """Paths the static file-server fallthrough must NEVER serve -- runtime state, session
    transcripts, source, and generated artifacts. Without this a token-less local/tailnet client
    (or a rebound page, though Host now blocks that) could read them straight off the web root."""
    p = (path or "").lower()
    return (p.startswith("/_") or p.startswith("/.") or "/." in p or p.endswith(".py")
            or p in {"/duo_dossier.md", "/deck_qa_report.json", "/commit_composed.txt",
                     "/harness_reformat_mockups.html"})


SCROLLBACK_CAP = 300_000  # chars kept per session for reconnect replay

# Terminal QUERY sequences must not be replayed: every reconnecting browser
# would answer them again and the answer lands in the CLI's stdin as junk
# (e.g. a stray "1;2c" from a Device Attributes reply). Stripped from the
# scrollback buffer only -- live output passes through untouched.
REPLAY_QUERY_RE = re.compile(
    "\x1b\\[[>=?]?[0-9;]*c"            # DA1/DA2/DA3 queries
    "|\x1b\\[[0-9;?]*n"                # DSR / cursor-position report queries
    "|\x1b\\[(?:1[4689]|2[01])t"       # window/title size-report queries
    "|\x1b\\]1[01];\\?(?:\x07|\x1b\\\\)"  # OSC 10/11 color queries
)

# Scrollback ARCHIVE: the live buffer (SCROLLBACK_CAP) is replayed on reconnect and is Ctrl+F-
# searchable in xterm, but it is a bounded FIFO -- older lines age out. For "what did that error
# say an hour ago?", every session also streams a readable (ANSI-stripped) transcript to a capped
# per-session archive file that /api/scrollback/search can grep. Local, gitignored, never executed.
SCROLLBACK_ARCHIVE_DIR = STATE_DIR / "_scrollback"
ARCHIVE_CAP = 4 * 1024 * 1024      # per-session archive byte cap (rotate to last half when exceeded)
_ARCHIVE_ANSI = re.compile(
    r"\x1b\[[0-9;?]*[ -/]*[@-~]"           # CSI sequences (cursor moves, SGR color, ...)
    r"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC sequences (title, color) + terminator
    r"|\x1b[=>]|\x1b[()][0-9A-B]"          # keypad / charset selectors
    r"|[\x00-\x08\x0b\x0c\x0e-\x1f]")      # control chars except \t \n \r

def _load_agent_config():
    """Agent presets (id -> {label, cmd}). Read from harness.config.json (or $HARNESS_CONFIG);
    the code carries the same default so a missing/invalid file changes nothing. Shells stay
    special-cased in _argv; presets add 'codex' and let any provider CLI be spawned per lane."""
    default = {"claude": {"label": "Claude Code", "cmd": "claude"},
              "gemini": {"label": "Google Gemini", "cmd": "gemini"},
              "codex":  {"label": "OpenAI Codex", "cmd": "codex"}}
    f = Path(os.environ.get("HARNESS_CONFIG") or (HARNESS_DIR / "harness.config.json"))
    if f.is_file():
        try:
            cfg = json.loads(f.read_text(encoding="utf-8")).get("agents")
            if isinstance(cfg, dict) and cfg:
                return cfg
        except (ValueError, OSError):
            pass
    return default

AGENT_CONFIG = _load_agent_config()
AGENT_CMDS = {k: (v.get("cmd", k) if isinstance(v, dict) else k) for k, v in AGENT_CONFIG.items()}
import projects as projectsmod  # pure project-manifest logic (web/harness/projects.py)
import importlib.util
import harness_plugins as pluginsmod  # pure plugin discovery (web/harness/harness_plugins.py)

PLUGIN_ROUTES_GET, PLUGIN_ROUTES_POST = {}, {}
LOADED_PLUGINS = []


class PluginContext:
    """Generic core services handed to a plugin's register() -- no platform coupling.
    A plugin gets: the content root, its own state dir, the path jail, a git helper, and route()."""
    def __init__(self, pid):
        self.id = pid
        self.PROJECT_ROOT = PROJECT_ROOT
        self.STATE_DIR = STATE_DIR / "plugins" / pid
        self.STATE_DIR.mkdir(parents=True, exist_ok=True)
        self.safe_under_home = safe_under_home

    def git(self, args):
        r = subprocess.run(["git", "-C", str(self.PROJECT_ROOT)] + list(args),
                           capture_output=True, text=True, timeout=15,
                           creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0))
        return r.stdout

    def route(self, method, subpath, handler):
        sub = subpath if subpath.startswith("/") else "/" + subpath
        p = f"/api/plugin/{self.id}{sub}"
        (PLUGIN_ROUTES_GET if method.upper() == "GET" else PLUGIN_ROUTES_POST)[p] = handler


def load_plugins():
    """Discover + load plugins from the plugins dir(s). A plugin that raises on import/register is
    SKIPPED (logged), never fatal -- a bad third-party plugin must not take down the core."""
    dirs = [os.environ.get("HARNESS_PLUGINS_DIR") or str(HARNESS_DIR / "plugins"),
            str(STATE_DIR / "plugins")]
    for pj in pluginsmod.discover_plugins(*dirs):
        try:
            if pj.get("backend"):
                bpath = Path(pj["dir"]) / pj["backend"]
                spec = importlib.util.spec_from_file_location(f"harness_plugin_{pj['id']}", bpath)
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                mod.register(PluginContext(pj["id"]))
            LOADED_PLUGINS.append(pj)
            print(f"[plugin] loaded {pj['id']}", flush=True)
        except Exception as exc:
            print(f"[plugin] FAILED to load {pj.get('id', '?')}: {exc}", flush=True)

# Extra dirs to scan for a project.md. Repo-relative. This is the SEED list; projects
# created via the scaffold add their roots to a persisted registry (below) so discovery
# finds them wherever they live.
PROJECT_DIRS = []
PROJECT_REGISTRY_FILE = STATE_DIR / ".harness_projects.json"  # scaffold-created roots (gitignored)
PROJECT_REGISTRY_LOCK = threading.Lock()   # serialize the registry read-modify-write
# Extra shell profiles a tab can run instead of the card's agent CLI -- a real login shell in the
# tab's cwd, for local maintenance (git push from Git Bash, WSL, PowerShell) without leaving the
# harness. A shell tab still lives UNDER a card (claude/gemini); the card is just visual grouping.
SHELL_PROFILES = {
    "bash":    {"label": "WSL bash"},
    "gitbash": {"label": "Git Bash"},
    "pwsh":    {"label": "PowerShell"},
}
VALID_PROFILES = set(AGENT_CMDS) | set(SHELL_PROFILES)
DEFAULT_CWD = str(PROJECT_ROOT)

# ---------------------------------------------------------------------------
# PTY session management (multiple tabs per agent)
# ---------------------------------------------------------------------------

class PtySession:
    """One persistent ConPTY process with fan-out to any number of connected
    browser terminals."""

    def __init__(self, sid, agent, cmd, cwd, loop, profile=None, resume=False):
        self.sid = sid
        self.agent = agent          # the CARD this tab lives under (claude/gemini)
        self.cmd = cmd
        self.cwd = cwd
        self.profile = profile or agent   # what actually runs (agent CLI or a shell)
        self.resume = bool(resume)  # C: spawn the agent CLI resuming its last convo in cwd
        base = Path(cwd).name or cwd
        self.label = base if self.profile == agent else f"{self.profile}:{base}"
        self.loop = loop
        self.proc = None
        self.clients = set()
        self.scrollback = []
        self.scrollback_len = 0
        self.lock = threading.Lock()
        self.cols = 120
        self.rows = 30
        self.archive_path = SCROLLBACK_ARCHIVE_DIR / f"{sid}.log"
        self.archive_started = False   # first write truncates any stale same-sid file (per-run sids)
        self.archive_bytes = 0

    def _argv(self):
        prof = self.profile
        if prof == "bash":                       # WSL login shell
            return [shutil.which("wsl") or "wsl.exe", "-e", "bash", "-l"]
        if prof == "gitbash":                    # Git Bash (login, interactive)
            for cand in (r"C:\Program Files\Git\bin\bash.exe",
                         r"C:\Program Files\Git\usr\bin\bash.exe"):
                if Path(cand).is_file():
                    return [cand, "-l", "-i"]
            gb = shutil.which("bash")
            if gb:
                return [gb, "-l", "-i"]
            raise RuntimeError("Git Bash (bash.exe) not found")
        if prof == "pwsh":                       # PowerShell 7 or Windows PowerShell
            exe = shutil.which("pwsh") or shutil.which("powershell")
            if not exe:
                raise RuntimeError("PowerShell not found")
            return [exe, "-NoLogo"]
        # default: a provider CLI. The PROFILE decides which one (so a lane can spawn any
        # provider via the New-tab menu); falls back to the card's own cmd.
        cmd_to_resolve = AGENT_CMDS.get(self.profile, self.cmd)
        is_using_agy = False
        if cmd_to_resolve == "gemini":
            agy_exe = shutil.which("agy")
            if agy_exe:
                cmd_to_resolve = "agy"
                is_using_agy = True

        exe = shutil.which(cmd_to_resolve)
        if not exe:
            raise RuntimeError(f"'{cmd_to_resolve}' not found on PATH")
        # C (resume): both CLIs key resume off the working directory, which matches
        # cwd=project.root -- claude resumes the most recent conversation here, gemini/agy
        # the project's latest session. Opt-in: on a project's FIRST load (no prior
        # conversation) the CLI prints its own "nothing to resume" and exits, so the UI
        # offers this as an explicit "Resume last session", not the default Load.
        resume_args = []
        if self.resume:
            if self.profile == "claude":
                resume_args = ["--continue"]
            elif self.profile == "codex":
                resume_args = ["--continue"]
            elif self.profile == "gemini":
                if is_using_agy:
                    resume_args = ["-c"]
                else:
                    resume_args = ["--resume", "latest"]
        if exe.lower().endswith((".cmd", ".bat")):
            return ["cmd.exe", "/c", exe] + resume_args
        return [exe] + resume_args

    def ensure_started(self):
        with self.lock:
            if self.proc is not None and self.proc.isalive():
                return
            self._spawn_locked()

    def _spawn_locked(self):
        argv = self._argv()
        # xterm.js emulates xterm-256color with truecolor; without TERM set,
        # CLIs (gemini) warn "256-color support not detected".
        env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor")
        
        # Surgical Environmental Isolation: If we are running the interactive 'gemini' / 'agy' CLI,
        # strip the API keys so it falls back to the browser OAuth (Google AI Pro subscription),
        # preventing interactive developer queries from debiting your Google Cloud API bill.
        if self.profile in ("gemini", "agy"):
            env.pop("GEMINI_API_KEY", None)
            env.pop("GOOGLE_API_KEY", None)

        self.proc = pty_backend.spawn(argv, self.cwd, env, self.rows, self.cols)
        t = threading.Thread(target=self._read_loop, args=(self.proc,), daemon=True)
        t.start()
        print(f"[pty] {self.sid}: spawned {argv} cwd={self.cwd}", flush=True)

    def restart(self):
        with self.lock:
            if self.proc is not None and self.proc.isalive():
                try:
                    self.proc.terminate(force=True)
                except Exception:
                    pass
            self.proc = None
            self.scrollback = []
            self.scrollback_len = 0
            self._spawn_locked()
        self._broadcast({"type": "restarted"})

    def kill(self):
        with self.lock:
            if self.proc is not None and self.proc.isalive():
                try:
                    self.proc.terminate(force=True)
                except Exception:
                    pass
            self.proc = None
        self._broadcast({"type": "killed"})

    def is_alive(self):
        return self.proc is not None and self.proc.isalive()

    def _read_loop(self, proc):
        while True:
            try:
                data = proc.read(4096)
            except (EOFError, ConnectionAbortedError, OSError):
                break
            if not data:
                break
            self._append_scrollback(data)
            self._archive_append(data)
            self._broadcast({"type": "output", "data": data})
        # Only report exit if this proc is still the current one (not replaced).
        if self.proc is proc:
            print(f"[pty] {self.sid}: process exited", flush=True)
            self._broadcast({"type": "exit"})

    def _append_scrollback(self, data):
        data = REPLAY_QUERY_RE.sub("", data)
        if not data:
            return
        with self.lock:
            self.scrollback.append(data)
            self.scrollback_len += len(data)
            while self.scrollback_len > SCROLLBACK_CAP and len(self.scrollback) > 1:
                dropped = self.scrollback.pop(0)
                self.scrollback_len -= len(dropped)

    def _archive_append(self, data):
        """Stream a readable transcript to the per-session archive for history search. ANSI/control
        stripped; CR/LF normalized. First write truncates any stale same-sid file from a prior run."""
        txt = _ARCHIVE_ANSI.sub("", data).replace("\r\n", "\n").replace("\r", "\n")
        if not txt or (not txt.strip() and "\n" not in txt):
            return
        try:
            SCROLLBACK_ARCHIVE_DIR.mkdir(exist_ok=True)
            mode = "a"
            if not self.archive_started:
                mode, self.archive_started, self.archive_bytes = "w", True, 0
            with open(self.archive_path, mode, encoding="utf-8", errors="replace") as f:
                f.write(txt)
            self.archive_bytes += len(txt)
            if self.archive_bytes > ARCHIVE_CAP:
                self._archive_rotate()
        except OSError:
            pass   # archive is best-effort; never break the read loop

    def _archive_rotate(self):
        try:
            keep = self.archive_path.read_text(encoding="utf-8", errors="replace")[-(ARCHIVE_CAP // 2):]
            self.archive_path.write_text(keep, encoding="utf-8")
            self.archive_bytes = len(keep)
        except OSError:
            pass

    def _broadcast(self, msg):
        payload = json.dumps(msg)
        for ws in list(self.clients):
            try:
                asyncio.run_coroutine_threadsafe(ws.send(payload), self.loop)
            except Exception:
                self.clients.discard(ws)

    def write(self, data):
        with self.lock:
            if self.proc is not None and self.proc.isalive():
                self.proc.write(data)

    def resize(self, cols, rows):
        cols = max(20, min(500, int(cols)))
        rows = max(5, min(200, int(rows)))
        self.cols, self.rows = cols, rows
        with self.lock:
            if self.proc is not None and self.proc.isalive():
                try:
                    self.proc.setwinsize(rows, cols)
                except Exception:
                    pass

    def snapshot(self):
        with self.lock:
            return "".join(self.scrollback)

    def describe(self):
        return {"id": self.sid, "agent": self.agent, "profile": self.profile,
                "cwd": self.cwd, "label": self.label, "alive": self.is_alive(),
                "clients": len(self.clients), "resume": self.resume,
                "cols": self.cols, "rows": self.rows}


SESSIONS = {}
SESSIONS_LOCK = threading.Lock()
_SESSION_COUNTERS = {agent: 0 for agent in AGENT_CMDS}
MAIN_LOOP = None  # set in main_async


def create_session(agent, cwd, profile=None, resume=False):
    if agent not in AGENT_CMDS:
        raise ValueError(f"unknown agent '{agent}'")
    profile = profile or agent
    if profile not in VALID_PROFILES:
        raise ValueError(f"unknown profile '{profile}'")
    p = safe_under_home(cwd or DEFAULT_CWD)
    if not p.is_dir():
        raise FileNotFoundError(f"not a directory: {p}")
    # resume only makes sense for the agent CLI itself, not a shell profile.
    resume = bool(resume) and profile == agent
    with SESSIONS_LOCK:
        _SESSION_COUNTERS[agent] += 1
        sid = f"{agent}-{_SESSION_COUNTERS[agent]}"
        session = PtySession(sid, agent, AGENT_CMDS[agent], str(p), MAIN_LOOP,
                             profile=profile, resume=resume)
        SESSIONS[sid] = session
    print(f"[session] created {sid} profile={profile} cwd={p} resume={resume}", flush=True)
    return session


def kill_session(sid):
    with SESSIONS_LOCK:
        session = SESSIONS.pop(sid, None)
    if session is None:
        raise KeyError(f"unknown session '{sid}'")
    session.kill()
    print(f"[session] killed {sid}", flush=True)


async def pty_ws_handler(websocket):
    query = parse_qs(urlparse(websocket.request.path).query)
    # CSWSH gate: reject a cross-origin page or a missing/wrong token BEFORE any
    # session is touched. A malicious webpage cannot read /api/config, so it
    # cannot present the token -- and its fetch/WS always carries a foreign Origin.
    origin = websocket.request.headers.get("Origin")
    token = (query.get("token") or [""])[0]
    if not _origin_ok(origin) or not _token_ok(token):
        await websocket.close(1008, "unauthorized")
        return
    sid = (query.get("id") or [""])[0]

    # Back-compat: ?name=<agent> attaches to (or creates) that agent's first session.
    if not sid:
        agent = (query.get("name") or [""])[0]
        if agent in AGENT_CMDS:
            with SESSIONS_LOCK:   # snapshot before iterating; create_session (below) takes the lock itself
                existing = sorted(
                    (s for s in SESSIONS.values() if s.agent == agent),
                    key=lambda s: s.sid)
            session = existing[0] if existing else create_session(agent, DEFAULT_CWD)
            sid = session.sid

    with SESSIONS_LOCK:
        session = SESSIONS.get(sid)
    if session is None:
        await websocket.send(json.dumps({"type": "gone", "id": sid}))
        await websocket.close()
        return

    # Spawn at the CLIENT's real geometry. Booting at a default size makes
    # ink-based TUIs (gemini) paint wrong-width frames that wrap and leak
    # duplicated footers into scrollback forever.
    if not session.is_alive():
        try:
            qcols = int((query.get("cols") or ["0"])[0])
            qrows = int((query.get("rows") or ["0"])[0])
            if qcols and qrows:
                session.cols = max(20, min(500, qcols))
                session.rows = max(5, min(200, qrows))
        except ValueError:
            pass

    try:
        session.ensure_started()
    except Exception as exc:
        await websocket.send(json.dumps(
            {"type": "output",
             "data": f"[harness] failed to start {session.agent}: {exc}\r\n"}))
        await websocket.close()
        return

    # Replay scrollback so a page reload does not lose the session view.
    replay = session.snapshot()
    if replay:
        await websocket.send(json.dumps({"type": "scrollback", "data": replay}))

    session.clients.add(websocket)
    try:
        async for raw in websocket:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            mtype = msg.get("type")
            if mtype == "input":
                session.write(msg.get("data", ""))
            elif mtype == "resize":
                session.resize(msg.get("cols", 120), msg.get("rows", 30))
            elif mtype == "redraw":
                # Size-jiggle: full-screen TUIs repaint completely on resize.
                # Used after scrollback replay, whose cursor-addressed frames
                # may predate the current terminal geometry.
                cols, rows = session.cols, session.rows
                session.resize(cols - 1, rows)
                await asyncio.sleep(0.06)
                session.resize(cols, rows)
            elif mtype == "restart":
                session.restart()
    except websockets.ConnectionClosed:
        pass
    finally:
        session.clients.discard(websocket)


# ---------------------------------------------------------------------------
# JSON APIs
# ---------------------------------------------------------------------------

def safe_under_home(raw_path):
    p = Path(raw_path).resolve()
    try:
        p.relative_to(ROOT_DIR)
    except ValueError:
        raise PermissionError(f"path outside {ROOT_DIR}")
    return p


def api_ls(params):
    raw = (params.get("path") or [str(PROJECT_ROOT)])[0]
    p = safe_under_home(raw)
    if not p.is_dir():
        raise FileNotFoundError(f"not a directory: {p}")
    entries = []
    try:
        children = sorted(
            p.iterdir(),
            key=lambda c: (not c.is_dir(), c.name.lower()),
        )
    except PermissionError:
        children = []
    for child in children[:800]:
        try:
            st = child.stat()
            entries.append({
                "name": child.name,
                "type": "dir" if child.is_dir() else "file",
                "path": str(child),
                "size": 0 if child.is_dir() else st.st_size,
                "mtime": int(st.st_mtime),
            })
        except OSError:
            continue
    parent = str(p.parent) if p != ROOT_DIR else None
    return {"path": str(p), "parent": parent, "entries": entries,
            "truncated": len(children) > 800}


def api_config(_params):
    candidates = [
        (PROJECT_ROOT.name, PROJECT_ROOT, "active workspace root"),
    ]
    roots = [
        {"label": label, "path": str(p), "desc": desc}
        for (label, p, desc) in candidates if p.is_dir()
    ]
    return {"wsPort": ACTIVE_WS_PORT, "roots": roots,
            "agents": list(AGENT_CMDS.keys()), "defaultCwd": DEFAULT_CWD,
            "agentPresets": [{"id": k, "label": (v.get("label", k) if isinstance(v, dict) else k),
                              "cmd": AGENT_CMDS[k]} for k, v in AGENT_CONFIG.items()],
            "token": SESSION_TOKEN,
            "asyncComms": bool(_load_harness_state().get("async_comms", False)),
            "geminiUsesAgy": bool(shutil.which("agy")),
            "shellProfiles": [{"id": k, "label": v["label"]}
                              for k, v in SHELL_PROFILES.items()]}


def api_sessions(_params):
    with SESSIONS_LOCK:                       # snapshot under the lock; describe() runs outside it
        snap = list(SESSIONS.values())
    return {"sessions": [s.describe() for s in sorted(snap, key=lambda s: s.sid)]}


# --- Read-only file preview + git diff (Projects tab) ----------------------
_READ_MAX = 400_000       # cap a text preview at ~400 KB
_SERVE_MAX = 64 * 1024 * 1024   # cap a raw served artifact (png/pdf) at 64 MB


def api_read(params):
    """Return a text file's content for the in-dashboard reader (jailed under
    HOME, size-capped). Binary files report {binary:true} instead of bytes."""
    raw = (params.get("path") or [""])[0]
    p = safe_under_home(raw)
    if not p.is_file():
        raise FileNotFoundError(f"not a file: {p}")
    size = p.stat().st_size
    with open(p, "rb") as fh:
        data = fh.read(_READ_MAX + 1)   # bounded read -- never load a multi-GB file into RAM
    if b"\x00" in data[:8192]:
        return {"path": str(p), "binary": True, "size": size}
    truncated = len(data) > _READ_MAX
    text = data[:_READ_MAX].decode("utf-8", errors="replace")
    return {"path": str(p), "content": text, "size": size, "truncated": truncated}


def api_gitdiff(params):
    """git diff for a path inside the active workspace (repo-wide if no path).
    Scoped to PROJECT_ROOT -- a file outside the workspace has no diff to show."""
    raw = (params.get("path") or [""])[0]
    staged = (params.get("staged") or [""])[0] in ("1", "true")
    p = safe_under_home(raw) if raw else PROJECT_ROOT
    try:
        rel = p.relative_to(PROJECT_ROOT)
    except ValueError:
        raise PermissionError("git diff is scoped to the active workspace")
    
    diff_cmd = ["diff", "--staged"] if staged else ["diff"]
    args = diff_cmd + (["--", str(rel)] if (raw and p.is_file()) else [])
    
    res = subprocess.run(["git", "-C", str(PROJECT_ROOT)] + args,
                         capture_output=True, text=True, timeout=15,
                         creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0))
    diff = res.stdout[:_READ_MAX]
    return {"path": str(p), "diff": diff, "staged": staged, "empty": not diff.strip(),
            "truncated": len(res.stdout) > _READ_MAX}


# --- Named layouts (saved tab sets) ----------------------------------------

LAYOUTS_FILE = STATE_DIR / "layouts.json"
LAYOUTS_LOCK = threading.Lock()


def load_layouts():
    try:
        data = json.loads(LAYOUTS_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def api_layouts(_params):
    with LAYOUTS_LOCK:
        return {"layouts": load_layouts()}


def save_layout(name, tabs):
    name = (name or "").strip()
    if not name or len(name) > 60:
        raise ValueError("layout name must be 1-60 chars")
    clean = []
    for tab in tabs or []:
        agent = tab.get("agent", "")
        if agent not in AGENT_CMDS:
            raise ValueError(f"unknown agent '{agent}'")
        cwd = safe_under_home(tab.get("cwd", ""))
        if not cwd.is_dir():
            raise FileNotFoundError(f"not a directory: {cwd}")
        clean.append({"agent": agent, "cwd": str(cwd)})
    if not clean:
        raise ValueError("layout has no tabs")
    with LAYOUTS_LOCK:
        layouts = load_layouts()
        layouts[name] = clean
        LAYOUTS_FILE.write_text(json.dumps(layouts, indent=2), encoding="utf-8")
    return {"layouts": layouts}


def delete_layout(name):
    with LAYOUTS_LOCK:
        layouts = load_layouts()
        layouts.pop(name, None)
        LAYOUTS_FILE.write_text(json.dumps(layouts, indent=2), encoding="utf-8")
    return {"layouts": layouts}


# --- Repository status strip ------------------------------------------------

_GENOME_CACHE = {"at": 0.0, "data": None}
_GENOME_LOCK = threading.Lock()


def _git(args):
    res = subprocess.run(["git", "-C", str(PROJECT_ROOT)] + args,
                         capture_output=True, text=True, timeout=10)
    return res.stdout.strip()


def api_genome(_params):
    with _GENOME_LOCK:
        now = time.time()
        if _GENOME_CACHE["data"] is not None and now - _GENOME_CACHE["at"] < 30:
            return _GENOME_CACHE["data"]
        try:
            branch = _git(["rev-parse", "--abbrev-ref", "HEAD"])
            dirty = len([l for l in _git(["status", "--porcelain"]).splitlines()
                         if l.strip()])
            last = _git(["log", "-1", "--format=%ct|%s"])
            epoch, _, subject = last.partition("|")
            data = {"branch": branch, "dirty": dirty,
                    "last_commit_epoch": int(epoch or 0),
                    "last_subject": subject, "workspace": PROJECT_ROOT.name}
        except Exception as exc:
            data = {"error": str(exc)}
        _GENOME_CACHE["at"] = now
        _GENOME_CACHE["data"] = data
        return data


# --- Git status + diff ------------------------------------------------------
_BINARY_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".stl", ".step", ".stp",
               ".pdf", ".xlsx", ".xls", ".docx", ".doc", ".pptx", ".zip", ".7z", ".brep",
               ".igs", ".iges", ".blend", ".ttf", ".woff", ".woff2", ".mp4", ".bin",
               ".exe", ".dll", ".map"}


def _git_raw(args, timeout=15):
    res = subprocess.run(["git", "-C", str(PROJECT_ROOT)] + args,
                         capture_output=True, text=True, timeout=timeout,
                         creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0))
    return res.stdout


def api_git_status(_params):
    branch = _git(["rev-parse", "--abbrev-ref", "HEAD"])
    try:
        ahead = int(_git(["rev-list", "--count", f"origin/{branch}..HEAD"]) or 0)
    except Exception:
        ahead = -1  # no upstream ref
    staged, modified, untracked = [], [], []
    for line in _git_raw(["status", "--porcelain"]).splitlines():
        if len(line) < 4:
            continue
        code, p = line[:2], line[3:]
        ext = Path(p).suffix.lower()
        entry = {"path": p, "binary": ext in _BINARY_EXT}
        if code == "??":
            untracked.append(entry)
        else:
            if code[0] not in " ?":
                staged.append({**entry, "code": code[0]})
            if code[1] not in " ?":
                modified.append({**entry, "code": code[1]})
    return {"branch": branch, "ahead": ahead,
            "is_trade": bool(re.match(r"trade/TS-\d+", branch)),
            "staged": staged, "modified": modified, "untracked": untracked}


def api_tail(params):
    """Incrementally tail a file (a live solver log/CSV) from a byte offset -- the feed for the
    solver monitor. Jailed under HOME; capped per poll; restarts if the file was truncated."""
    raw = (params.get("path") or [""])[0]
    p = safe_under_home(raw)
    if not p.is_file():
        raise FileNotFoundError("not a file")
    try:
        offset = max(0, int((params.get("offset") or ["0"])[0]))
    except Exception:
        offset = 0
    size = p.stat().st_size
    if offset > size:
        offset = 0                    # rotated / truncated -> re-read from the top
    with open(p, "rb") as f:
        f.seek(offset)
        chunk = f.read(200_000)
    return {"text": chunk.decode("utf-8", errors="replace"),
            "offset": offset + len(chunk), "size": size}


def api_fsrecent(params):
    """Files under the genome modified within ``window`` seconds -- the 'actively being written'
    signal for the Duo collision monitor. Derived from git status + mtime (reliable), NOT from
    parsing agent terminal output (which cannot tell when a write actually lands)."""
    try:
        window = int((params.get("window") or ["25"])[0])
    except Exception:
        window = 25
    now = time.time()
    recent = []
    for line in _git_raw(["status", "--porcelain"]).splitlines():
        if len(line) < 4:
            continue
        rel = line[3:]
        try:
            mt = (PROJECT_ROOT / rel).stat().st_mtime
        except OSError:
            continue
        if now - mt <= window:
            recent.append({"path": rel.replace("\\", "/"), "age": round(now - mt, 1)})
    return {"recent": recent, "window": window}


# Native Windows file/folder picker, run as a subprocess so tkinter's main
# loop never runs inside a server thread. Blocks its HTTP thread until the
# user picks or cancels (ThreadingHTTPServer keeps everything else live).
PICKER_SCRIPT = """
import sys, json
import tkinter as tk
from tkinter import filedialog
mode, initial = sys.argv[1], sys.argv[2]
root = tk.Tk()
root.withdraw()
root.attributes("-topmost", True)
root.update()
if mode == "folder":
    p = filedialog.askdirectory(initialdir=initial, title="Select folder", parent=root)
    paths = [p] if p else []
else:
    paths = list(filedialog.askopenfilenames(initialdir=initial, title="Select file(s)", parent=root))
print(json.dumps(paths))
"""


def pick_paths(mode, initial):
    if mode not in ("files", "folder"):
        raise ValueError("mode must be 'files' or 'folder'")
    try:
        p = safe_under_home(initial or str(PROJECT_ROOT))
        initial = str(p) if p.is_dir() else str(PROJECT_ROOT)
    except PermissionError:
        initial = str(PROJECT_ROOT)
    res = subprocess.run(
        [sys.executable, "-c", PICKER_SCRIPT, mode, initial],
        capture_output=True, text=True, timeout=240)
    try:
        raw = json.loads(res.stdout.strip() or "[]")
    except json.JSONDecodeError:
        raise RuntimeError(f"picker failed: {res.stderr.strip()[:200]}")
    # askdirectory returns forward slashes; normalize to Windows form.
    return [str(Path(x)) for x in raw if x]


# --- Persisted harness focus/state -----------------------------------------
HARNESS_STATE_FILE = STATE_DIR / ".harness_state.json"


def _load_harness_state():
    """Best-effort read of the persisted focus/state file; {} if absent/unreadable."""
    try:
        return json.loads(HARNESS_STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_harness_state(payload):
    """Persist a ONE-WAY snapshot of what the operator is focused on -- active view, each agent's
    active cwd/model, the explorer dir, the previewed artifact -- to .harness_state.json so an agent
    can align to the human's focus (browser-use 'focus export', adapted). The harness WRITES; the
    file is read-only context for the agents. Whitelisted + length-capped keys (not a data sink);
    nothing here executes or mutates the genome."""
    if not isinstance(payload, dict):
        raise ValueError("state must be an object")
    state = {
        "active_view": str(payload.get("active_view", ""))[:40],
        "explorer_dir": str(payload.get("explorer_dir", ""))[:400],
        "preview": str(payload.get("preview", ""))[:400],
        "active_project": str(payload.get("active_project", ""))[:60],
        # async_comms: operator has switched to email/async comms (True) vs is at the
        # browser (False). BOSS reads this from .harness_state.json to know which channel
        # the Captain is on. See feedback_async_inbox_poll.
        "async_comms": bool(payload.get("async_comms", False)),
        "agents": {},
        "updated": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    ag = payload.get("agents")
    if isinstance(ag, dict):
        for k, v in list(ag.items())[:8]:
            if isinstance(v, dict):
                state["agents"][str(k)[:20]] = {
                    "cwd": str(v.get("cwd", ""))[:400],
                    "label": str(v.get("label", ""))[:80],
                    "model": str(v.get("model", ""))[:40],
                    "effort": str(v.get("effort", ""))[:20],
                }
    HARNESS_STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")
    return {"path": str(HARNESS_STATE_FILE), "updated": state["updated"]}


def api_scrollback_search(params):
    """Full-text search a session's scrollback archive (per-session .log files)."""
    q = (params.get("q") or [""])[0]
    sid = (params.get("id") or [""])[0]
    if len(q) < 2:
        raise ValueError("query must be >= 2 characters")

    # Raw archive search over the per-session transcript log.
    if sid and re.match(r"^[a-z]+-\d+$", sid):
        path = SCROLLBACK_ARCHIVE_DIR / f"{sid}.log"
        if not path.is_file():
            return {"matches": [], "total": 0, "lines": 0, "note": "no history archived yet"}
        ql = q.lower()
        matches, total = [], 0
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        for i, line in enumerate(lines):
            if ql in line.lower():
                total += 1
                if len(matches) < 200:
                    matches.append({"n": i + 1, "text": line.strip()[:400]})
        return {"matches": matches, "total": total, "lines": len(lines), "engine": "grep"}

    return {"matches": [], "total": 0, "lines": 0}


def _load_project_registry():
    """Repo-relative roots of projects created via the A.1 scaffold, so discovery finds
    them wherever they live (not only aircraft/* + PROJECT_DIRS). Missing/unreadable -> []."""
    try:
        data = json.loads(PROJECT_REGISTRY_FILE.read_text(encoding="utf-8"))
        return [str(r) for r in data.get("roots", []) if isinstance(r, str)]
    except Exception:
        return []


def _project_dirs():
    """PROJECT_DIRS seed + persisted registry, de-duped, order-stable."""
    seen, out = set(), []
    for d in list(PROJECT_DIRS) + _load_project_registry():
        if d not in seen:
            seen.add(d)
            out.append(d)
    return out


def _register_project_root(root):
    """Add a created project's root to the registry (idempotent, lock-guarded read-modify-write)."""
    with PROJECT_REGISTRY_LOCK:
        roots = _load_project_registry()
        if root not in roots:
            roots.append(root)
            PROJECT_REGISTRY_FILE.write_text(
                json.dumps({"roots": roots}, indent=2), encoding="utf-8")


def api_projects(_params):
    """List discovered projects (parsed project.md manifests). Read-only."""
    items = projectsmod.discover_projects(PROJECT_ROOT, _project_dirs())
    _read = _load_harness_state().get("active_project", "")
    return {"projects": items, "active": _read}


def api_project(params):
    """One project's manifest + per-program live data (branch, recent activity)."""
    pid = (params.get("id") or [""])[0]
    pj = projectsmod.get_project(PROJECT_ROOT, pid, _project_dirs())
    if pj is None:
        raise ValueError(f"unknown project: {pid}")
    return pj


def api_create_project(payload):
    """Scaffold: write a NEW project.md and register its root so discovery finds it.
    Path-jailed -- the resolved root must live under ROOT_DIR (defense-in-depth on top of
    projects.create_project_manifest's own no-absolute / no-'..' check)."""
    if not isinstance(payload, dict):
        raise ValueError("body must be an object")
    root = str(payload.get("root", "")).strip().replace("\\", "/").strip("/")
    if not root:
        raise ValueError("root is required")
    safe_under_home(PROJECT_ROOT / root)
    pj = projectsmod.create_project_manifest(
        PROJECT_ROOT,
        id=str(payload.get("id", "")),
        name=str(payload.get("name", "")),
        root=root,
        objective=str(payload.get("objective", "")),
        branch=str(payload.get("branch", "")),
        phase=str(payload.get("phase", "")),
        extra_dirs=_project_dirs(),
    )
    _register_project_root(pj["root"])
    return {"project": pj}


def api_plugins(_params):
    """The loaded-plugin manifest list for the frontend to build tabs (with asset URLs)."""
    return {"plugins": [
        {"id": p["id"], "name": p.get("name", p["id"]), "tab": p.get("tab", {}),
         "frontend": {k: f"/plugin/{p['id']}/{v}"
                      for k, v in (p.get("frontend") or {}).items()}}
        for p in LOADED_PLUGINS]}


API_ROUTES = {
    "/api/config": api_config,
    "/api/plugins": api_plugins,
    "/api/projects": api_projects,
    "/api/project": api_project,
    "/api/ls": api_ls,
    "/api/sessions": api_sessions,
    "/api/layouts": api_layouts,
    "/api/genome": api_genome,
    "/api/read": api_read,
    "/api/gitdiff": api_gitdiff,
    "/api/git/status": api_git_status,
    "/api/fsrecent": api_fsrecent,
    "/api/tail": api_tail,
    "/api/scrollback/search": api_scrollback_search,
}


class HarnessHandler(SimpleHTTPRequestHandler):
    # HTTP/1.1 keep-alive: the page pulls several large vendored assets at once (vis-network
    # ~0.7 MB, xterm ~0.3 MB, app.js); HTTP/1.0's connection-per-request churn intermittently
    # reset a transfer on Windows. Keep-alive reuses a few connections instead. Every response
    # here carries a Content-Length (static + _send_json + _serve_file), so keep-alive is safe.
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HARNESS_DIR), **kwargs)

    def log_message(self, fmt, *args):
        pass  # keep console output to PTY/API events only

    # A single large socket write (> ~0.5 MB) resets the connection on Windows
    # (WSAECONNRESET). Serve static files in bounded chunks so big vendored assets
    # (vis-network.min.js is ~0.7 MB) transfer reliably.
    _WRITE_CHUNK = 256 * 1024

    def copyfile(self, source, outputfile):
        shutil.copyfileobj(source, outputfile, length=self._WRITE_CHUNK)

    def _write_chunked(self, data):
        mv = memoryview(data)
        for i in range(0, len(mv), self._WRITE_CHUNK):
            self.wfile.write(mv[i:i + self._WRITE_CHUNK])

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _client_token(self):
        # fetch() sends it as a header; resource loads (<img>/<iframe> src) that
        # cannot set headers pass it as a ?token= query param instead.
        t = self.headers.get("X-Harness-Token")
        if not t:
            t = (parse_qs(urlparse(self.path).query).get("token") or [None])[0]
        return t

    def _gate(self, require_token=True):
        """True if the request may proceed; else emit 403 and return False."""
        if not _origin_ok(self.headers.get("Origin")):
            self._send_json({"error": "forbidden origin"}, 403)
            return False
        if require_token and not _token_ok(self._client_token()):
            self._send_json({"error": "unauthorized"}, 403)
            return False
        return True

    def end_headers(self):
        # Static UI assets (index.html/app.js/styles.css/vendor) are same-origin
        # and ungated; without this the browser heuristically caches them and a
        # code edit silently does not show until a hard-reload. no-cache = always
        # revalidate (cheap 304 when unchanged), so a normal reload picks up edits.
        if getattr(self, "_static_asset", False):
            self.send_header("Cache-Control", "no-cache")
            self._static_asset = False   # one-shot per response
        super().end_headers()

    def _serve_file(self, params):
        """Stream a raw file (png/pdf/...) under HOME with a guessed content-type,
        for the in-dashboard artifact previewer (<img>/<iframe> src). Jailed +
        size-capped. The token rides in the ?token= query (src cannot set headers)."""
        raw = (params.get("path") or [""])[0]
        try:
            p = safe_under_home(raw)
        except PermissionError as exc:
            return self._send_json({"error": str(exc)}, 400)
        if not p.is_file():
            return self._send_json({"error": "not a file"}, 404)
        if p.stat().st_size > _SERVE_MAX:
            return self._send_json({"error": "file too large to preview"}, 413)
        ctype = mimetypes.guess_type(str(p))[0] or "application/octet-stream"
        try:
            data = p.read_bytes()
        except OSError as exc:
            return self._send_json({"error": str(exc)}, 400)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")   # the ?token= must never leak via Referer
        # A previewed HTML deck runs same-origin (so Deck QA can measure it) -- block its scripts +
        # inline handlers via CSP so it can't read window.parent.CONFIG.token, and don't cache it.
        # PDFs/images get NEITHER: `Cache-Control: no-store` breaks Edge's PDF reader (Chrome's
        # PDFium tolerates it), and script-src does not gate the PDF viewer. Referrer-Policy above
        # (which stays for all responses) is the real token-leak protection.
        if (ctype or "").startswith("text/html"):
            self.send_header("Content-Security-Policy",
                             "script-src 'none'; object-src 'none'; base-uri 'none'")
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self._write_chunked(data)

    def _serve_plugin_asset(self, path):
        """Serve /plugin/<id>/<relpath> from that plugin's dir, JAILED (no ../ escape). Same-origin
        static asset (like the UI's app.js/styles.css) -- ungated but strictly path-confined."""
        rest = path[len("/plugin/"):]
        pid, _, rel = rest.partition("/")
        plugin = next((p for p in LOADED_PLUGINS if p["id"] == pid), None)
        if not plugin or not rel:
            return self._send_json({"error": "not found"}, 404)
        base = Path(plugin["dir"]).resolve()
        target = (base / rel).resolve()
        try:
            target.relative_to(base)        # jail: reject any traversal out of the plugin dir
        except ValueError:
            return self._send_json({"error": "forbidden"}, 403)
        if not target.is_file():
            return self._send_json({"error": "not found"}, 404)
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        try:
            data = target.read_bytes()
        except OSError as exc:
            return self._send_json({"error": str(exc)}, 400)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self._static_asset = True   # no-cache so plugin edits show on reload
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not _host_ok(self.headers.get("Host")):
            self._send_json({"error": "forbidden host"}, 403)
            return
        parsed = urlparse(self.path)
        if _blocked_static(parsed.path):
            self._send_json({"error": "not found"}, 404)
            return
        if parsed.path == "/api/file":
            if not self._gate(require_token=True):
                return
            return self._serve_file(parse_qs(parsed.query))
        route = API_ROUTES.get(parsed.path)
        if route is None and parsed.path.startswith("/plugin/"):
            return self._serve_plugin_asset(parsed.path)   # plugin frontend assets (jailed)
        if route is None:
            route = PLUGIN_ROUTES_GET.get(parsed.path)      # plugin API GET (inherits the gate below)
        if route is None:
            self._static_asset = True   # -> no-cache header (see end_headers): edits show on reload
            return super().do_GET()     # static UI assets: same-origin, ungated
        # /api/config HANDS OUT the token, so it cannot require one -- but it is
        # still Origin-gated so a foreign page cannot read the token out of it.
        if not self._gate(require_token=(parsed.path != "/api/config")):
            return
        try:
            self._send_json(route(parse_qs(parsed.query)))
        except (PermissionError, FileNotFoundError) as exc:
            self._send_json({"error": str(exc)}, 400)
        except Exception as exc:
            self._send_json({"error": f"internal: {exc}"}, 500)

    def do_POST(self):
        if not _host_ok(self.headers.get("Host")):
            self._send_json({"error": "forbidden host"}, 403)
            return
        parsed = urlparse(self.path)
        if not self._gate(require_token=True):
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._send_json({"error": "bad JSON body"}, 400)
        try:
            if parsed.path == "/api/session":
                session = create_session(
                    payload.get("agent", ""), payload.get("cwd", ""),
                    payload.get("profile"), bool(payload.get("resume", False)))
                return self._send_json(session.describe())
            if parsed.path == "/api/session/kill":
                kill_session(payload.get("id", ""))
                return self._send_json({"ok": True})
            if parsed.path == "/api/pickpath":
                paths = pick_paths(payload.get("mode", "files"),
                                   payload.get("initial", ""))
                return self._send_json({"paths": paths})
            if parsed.path == "/api/layouts":
                return self._send_json(
                    save_layout(payload.get("name"), payload.get("tabs")))
            if parsed.path == "/api/layouts/delete":
                return self._send_json(delete_layout(payload.get("name", "")))
            if parsed.path == "/api/harness/state":
                return self._send_json(save_harness_state(payload))
            if parsed.path == "/api/project/create":
                return self._send_json(api_create_project(payload))
            if parsed.path in PLUGIN_ROUTES_POST:
                return self._send_json(PLUGIN_ROUTES_POST[parsed.path](payload))
            return self._send_json({"error": "unknown endpoint"}, 404)
        except (PermissionError, FileNotFoundError, ValueError, KeyError) as exc:
            return self._send_json({"error": str(exc)}, 400)
        except Exception as exc:
            return self._send_json({"error": f"internal: {exc}"}, 500)


class ExclusiveHTTPServer(ThreadingHTTPServer):
    """Refuse SO_REUSEADDR port sharing: on Windows another process could
    otherwise bind the same port and silently hijack requests."""
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET,
                                   socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def handle_error(self, request, client_address):
        # A browser closing a keep-alive / speculative socket (common with Safari over
        # a tailnet) raises ConnectionResetError / BrokenPipeError deep in the stdlib
        # handler. That is normal CLIENT behavior, not a server fault -- swallow it
        # quietly instead of dumping a multi-line traceback (which reads as "broken").
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

ACTIVE_WS_PORT = WS_PORTS[0]


def start_http():
    global ACTIVE_HTTP_PORT
    for port in HTTP_PORTS:
        try:
            httpd = ExclusiveHTTPServer((BIND, port), HarnessHandler)
        except OSError:
            continue
        ACTIVE_HTTP_PORT = port   # the origin allow-list is built from this
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        if TAILNET_BIND:
            try:
                ts_httpd = ExclusiveHTTPServer((TAILNET_BIND, port), HarnessHandler)
                threading.Thread(target=ts_httpd.serve_forever, daemon=True).start()
                print(f"  UI(tailnet): http://{TAILNET_BIND}:{port}/index.html", flush=True)
            except OSError as exc:
                print(f"  [warn] tailnet HTTP bind {TAILNET_BIND}:{port} failed: {exc}", flush=True)
        return port
    raise RuntimeError("no free HTTP port")


async def main_async():
    global ACTIVE_WS_PORT, MAIN_LOOP
    MAIN_LOOP = asyncio.get_running_loop()

    ws_server = None
    # Bind loopback plus (opt-in) the tailnet IP on the PTY WS port. websockets'
    # serve() accepts a sequence of hosts -> one server on both addresses. If the
    # multi-host form is ever rejected, degrade to loopback-only so startup NEVER
    # fails on account of the tailnet opt-in.
    for port in WS_PORTS:
        try:
            hosts = [BIND, TAILNET_BIND] if TAILNET_BIND else BIND
            ws_server = await ws_serve(pty_ws_handler, hosts, port)
            ACTIVE_WS_PORT = port
            break
        except OSError:
            continue
        except Exception as exc:
            print(f"  [warn] tailnet WS bind failed ({exc}); loopback-only", flush=True)
            try:
                ws_server = await ws_serve(pty_ws_handler, BIND, port)
                ACTIVE_WS_PORT = port
                break
            except OSError:
                continue
    if ws_server is None:
        raise RuntimeError("no free WebSocket port")

    http_port = start_http()
    url = f"http://{BIND}:{http_port}/index.html"
    print("=" * 54, flush=True)
    print("Browser Harness", flush=True)
    print(f"  UI:        {url}", flush=True)
    print(f"  PTY WS:    ws://{BIND}:{ACTIVE_WS_PORT}", flush=True)
    if TAILNET_BIND:
        _tshost = TAILNET_HOST or TAILNET_BIND
        print(f"  Tailnet:   http://{_tshost}:{http_port}/  (open this on the iPad)", flush=True)
    print(f"  Agents:    {', '.join(AGENT_CMDS)}  (default cwd: {DEFAULT_CWD})",
          flush=True)
    print("=" * 54, flush=True)

    if not os.environ.get("HARNESS_NO_BROWSER"):
        try:
            webbrowser.open(url)
        except Exception:
            pass

    await asyncio.Future()  # run forever


def main():
    load_plugins()                 # discover + mount plugins (a bad plugin logs + skips, never fatal)
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        print("\n[harness] shutting down", flush=True)
        for s in list(SESSIONS.values()):
            try:
                if s.is_alive():
                    s.proc.terminate(force=True)
            except Exception:
                pass
        sys.exit(0)


if __name__ == "__main__":
    main()
