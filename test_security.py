"""Network-exposure and token hand-out tests for RockWorx Duo (server.py).

Covers the defaults in docs/SECURITY.md:
  - the server binds loopback only unless the tailnet listener is explicitly opted in;
  - the session token (/api/config) goes only to a loopback peer or an allowed Origin;
  - the PTY WebSocket handshake refuses a no-Origin request from a non-loopback peer.

The HTTP tests run the real request handler on an ephemeral loopback port. The
non-loopback peer is simulated by overriding the client address the server hands
to the handler, so no second network interface is needed.
"""
import asyncio
import http.client
import json
import os
import tempfile
import threading

import pytest

# Import the server with a clean, loopback-only environment and a throwaway state dir.
for _v in ("HARNESS_TAILNET", "HARNESS_TAILNET_BIND", "HARNESS_TAILNET_HOST", "HARNESS_NO_TAILNET"):
    os.environ.pop(_v, None)
os.environ.setdefault("HARNESS_STATE_DIR", tempfile.mkdtemp(prefix="duo_test_state_"))

import server  # noqa: E402

TAILNET_IP = "100.64.0.1"        # generic CGNAT example address (100.64.0.0/10)
REMOTE_PEER = "100.64.0.5"       # a simulated non-loopback (tailnet) client
TAILNET_NAME = "duo-host.example"


# ---------------------------------------------------------------------------
# Opt-in detection
# ---------------------------------------------------------------------------

@pytest.fixture
def fake_tailscale(tmp_path, monkeypatch):
    """A Tailscale CLI that is installed and up; records every call."""
    exe = tmp_path / "tailscale"
    exe.write_text("")
    calls = []

    class _R:
        def __init__(self, out):
            self.stdout = out

    def fake_run(argv, **_kw):
        calls.append(list(argv[1:]))
        if argv[1:] == ["ip", "-4"]:
            return _R(TAILNET_IP + "\n")
        return _R(json.dumps({"Self": {"DNSName": TAILNET_NAME + "."}}))

    monkeypatch.setattr(server.shutil, "which", lambda name: str(exe))
    monkeypatch.setattr(server.subprocess, "run", fake_run)
    return calls


def test_default_does_not_probe_or_bind_tailnet(fake_tailscale):
    assert server._detect_tailnet({}) == (None, None)
    assert fake_tailscale == []   # Tailscale is never even queried without opt-in


def test_opt_in_finds_the_tailnet_address(fake_tailscale):
    assert server._detect_tailnet({"HARNESS_TAILNET": "1"}) == (TAILNET_IP, TAILNET_NAME)


@pytest.mark.parametrize("val", ["0", "", "no", "false"])
def test_falsy_opt_in_values_stay_loopback(fake_tailscale, val):
    assert server._detect_tailnet({"HARNESS_TAILNET": val}) == (None, None)


def test_explicit_bind_override_is_an_opt_in(fake_tailscale):
    ip, _host = server._detect_tailnet({"HARNESS_TAILNET_BIND": "100.64.0.9"})
    assert ip == "100.64.0.9"


def test_no_tailnet_beats_opt_in(fake_tailscale):
    env = {"HARNESS_TAILNET": "1", "HARNESS_TAILNET_BIND": TAILNET_IP, "HARNESS_NO_TAILNET": "1"}
    assert server._detect_tailnet(env) == (None, None)


def test_module_default_is_loopback_only():
    # The import above ran with no opt-in variables set.
    assert server.TAILNET_BIND is None and server.TAILNET_HOST is None
    assert server.bind_hosts() == ["127.0.0.1"]


# ---------------------------------------------------------------------------
# Listener addresses (HTTP + WS)
# ---------------------------------------------------------------------------

class _RecordingServer:
    bound = []

    def __init__(self, addr, _handler):
        _RecordingServer.bound.append(addr)

    def serve_forever(self):
        pass


def _start_http_binds(monkeypatch, tailnet_bind):
    _RecordingServer.bound = []
    monkeypatch.setattr(server, "TAILNET_BIND", tailnet_bind)
    monkeypatch.setattr(server, "ExclusiveHTTPServer", _RecordingServer)
    monkeypatch.setattr(server, "HTTP_PORTS", [18888])
    server.start_http()
    return [a[0] for a in _RecordingServer.bound]


def test_default_http_binds_loopback_only(monkeypatch):
    assert _start_http_binds(monkeypatch, None) == ["127.0.0.1"]


def test_opt_in_http_binds_tailnet_too(monkeypatch):
    assert _start_http_binds(monkeypatch, TAILNET_IP) == ["127.0.0.1", TAILNET_IP]


def _ws_hosts(monkeypatch, tailnet_bind):
    seen = []

    async def fake_ws_serve(_handler, hosts, _port):
        seen.append(hosts)
        return object()

    monkeypatch.setattr(server, "TAILNET_BIND", tailnet_bind)
    monkeypatch.setattr(server, "ws_serve", fake_ws_serve)
    monkeypatch.setattr(server, "start_http", lambda: 18888)
    monkeypatch.setenv("HARNESS_NO_BROWSER", "1")

    async def run():
        try:
            await asyncio.wait_for(server.main_async(), timeout=0.2)
        except asyncio.TimeoutError:
            pass

    asyncio.run(run())
    return seen[0]


def test_default_ws_binds_loopback_only(monkeypatch):
    assert _ws_hosts(monkeypatch, None) == "127.0.0.1"


def test_opt_in_ws_binds_tailnet_too(monkeypatch):
    assert _ws_hosts(monkeypatch, TAILNET_IP) == ["127.0.0.1", TAILNET_IP]


# ---------------------------------------------------------------------------
# Token hand-out over real HTTP
# ---------------------------------------------------------------------------

class _PeerServer(server.ExclusiveHTTPServer):
    """The real handler; fake_peer (when set) replaces the TCP client address."""
    fake_peer = None

    def finish_request(self, request, client_address):
        if self.fake_peer:
            client_address = (self.fake_peer, client_address[1])
        self.RequestHandlerClass(request, client_address, self)


@pytest.fixture
def live(monkeypatch):
    httpd = _PeerServer(("127.0.0.1", 0), server.HarnessHandler)
    port = httpd.server_address[1]
    monkeypatch.setattr(server, "ACTIVE_HTTP_PORT", port)
    monkeypatch.setattr(server, "TAILNET_BIND", None)
    monkeypatch.setattr(server, "TAILNET_HOST", None)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    yield httpd, port
    httpd.shutdown()
    httpd.server_close()


def _req(port, method="GET", path="/api/config", origin=None, host=None, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    h = {"Host": host or f"127.0.0.1:{port}"}
    if origin:
        h["Origin"] = origin
    h.update(headers or {})
    conn.request(method, path, body=(b"" if method == "POST" else None), headers=h)
    r = conn.getresponse()
    body = r.read().decode("utf-8", "replace")
    conn.close()
    return r.status, body


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_config_loopback_no_origin_gets_token(live, method):
    _httpd, port = live
    status, body = _req(port, method)
    assert status == 200
    assert json.loads(body)["token"] == server.SESSION_TOKEN


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_config_remote_no_origin_is_refused(live, method):
    httpd, port = live
    httpd.fake_peer = REMOTE_PEER
    status, body = _req(port, method)
    assert status == 403
    assert server.SESSION_TOKEN not in body


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_config_allowed_origin_gets_token(live, method):
    httpd, port = live
    httpd.fake_peer = REMOTE_PEER     # even from a non-loopback peer, an allowed Origin passes
    status, body = _req(port, method, origin=f"http://127.0.0.1:{port}")
    assert status == 200
    assert json.loads(body)["token"] == server.SESSION_TOKEN


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_config_foreign_origin_is_refused(live, method):
    _httpd, port = live
    status, body = _req(port, method, origin="http://attacker.example")
    assert status == 403
    assert server.SESSION_TOKEN not in body


def test_config_proxied_loopback_no_origin_is_refused(live):
    # A reverse proxy on this machine forwarding a remote request: peer is 127.0.0.1,
    # but the forwarding header shows the request did not originate locally.
    _httpd, port = live
    status, body = _req(port, headers={"X-Forwarded-For": REMOTE_PEER})
    assert status == 403
    assert server.SESSION_TOKEN not in body


def test_tailnet_origin_not_trusted_without_opt_in(live):
    httpd, port = live
    httpd.fake_peer = REMOTE_PEER
    status, _ = _req(port, origin=f"http://{TAILNET_IP}:{port}")
    assert status == 403


def test_tailnet_origin_trusted_after_opt_in(live, monkeypatch):
    httpd, port = live
    monkeypatch.setattr(server, "TAILNET_BIND", TAILNET_IP)
    httpd.fake_peer = REMOTE_PEER
    status, body = _req(port, "POST", origin=f"http://{TAILNET_IP}:{port}",
                        host=f"{TAILNET_IP}:{port}")
    assert status == 200
    assert json.loads(body)["token"] == server.SESSION_TOKEN


def test_token_gated_api_still_needs_the_token(live):
    httpd, port = live
    httpd.fake_peer = REMOTE_PEER
    assert _req(port, path="/api/sessions")[0] == 403
    ok, _ = _req(port, path="/api/sessions", headers={"X-Harness-Token": server.SESSION_TOKEN})
    assert ok == 200   # a same-origin GET (no Origin) with the token keeps working


# ---------------------------------------------------------------------------
# Loopback classification + WS handshake
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("peer,expected", [
    ("127.0.0.1", True), ("127.0.0.2", True), ("::1", True), ("::ffff:127.0.0.1", True),
    (REMOTE_PEER, False), ("192.168.1.10", False), ("", False), (None, False), ("junk", False),
])
def test_is_loopback_peer(peer, expected):
    assert server._is_loopback_peer(peer) is expected


class _FakeRequest:
    def __init__(self, path, headers):
        self.path, self.headers = path, headers


class _FakeWS:
    def __init__(self, peer, origin, token):
        hdrs = {"Origin": origin} if origin else {}
        self.request = _FakeRequest(f"/pty?token={token}&id=does-not-exist", hdrs)
        self.remote_address = (peer, 50000)
        self.closed, self.sent = None, []

    async def close(self, code=1000, reason=""):
        self.closed = (code, reason)

    async def send(self, msg):
        self.sent.append(msg)


def _ws(peer, origin, token=None):
    ws = _FakeWS(peer, origin, server.SESSION_TOKEN if token is None else token)
    asyncio.run(server.pty_ws_handler(ws))
    return ws


def test_ws_remote_no_origin_is_refused():
    assert _ws(REMOTE_PEER, None).closed == (1008, "unauthorized")


def test_ws_foreign_origin_is_refused():
    assert _ws("127.0.0.1", "http://attacker.example").closed == (1008, "unauthorized")


def test_ws_loopback_no_origin_with_token_passes_the_gate():
    ws = _ws("127.0.0.1", None)
    assert ws.closed != (1008, "unauthorized")
    assert ws.sent and json.loads(ws.sent[0])["type"] == "gone"   # reached session lookup


def test_ws_bad_token_is_refused():
    assert _ws("127.0.0.1", None, token="wrong").closed == (1008, "unauthorized")
