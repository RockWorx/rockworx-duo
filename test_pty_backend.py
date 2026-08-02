"""Cross-platform PTY backend tests for RockWorx Duo.

Delegation tests are OS-agnostic. The spawn round-trip proves a REAL pseudo-terminal on each OS --
Windows (pywinpty/ConPTY), Linux, and macOS (ptyprocess) -- and is what CI runs on all three.
"""
import sys
import time

import pty_backend as pb


class _FakeProc:
    def __init__(self):
        self.written, self.size, self.alive, self.terminated = [], None, True, None

    def read(self, n=1024):
        return "out"

    def write(self, d):
        self.written.append(d)

    def setwinsize(self, r, c):
        self.size = (r, c)

    def isalive(self):
        return self.alive

    def terminate(self, force=False):
        self.terminated = force


def test_win_handle_delegates():
    h = pb._WinPtyHandle(_FakeProc())
    assert h.read(10) == "out"
    h.write("hi"); assert h._p.written == ["hi"]
    h.setwinsize(30, 120); assert h._p.size == (30, 120)
    assert h.isalive() is True
    h.terminate(force=True); assert h._p.terminated is True


def test_posix_handle_delegates():
    h = pb._PosixPtyHandle(_FakeProc())
    assert h.read(10) == "out"
    h.write("hi"); assert h._p.written == ["hi"]
    h.setwinsize(30, 120); assert h._p.size == (30, 120)
    assert h.isalive() is True
    h.terminate(force=True); assert h._p.terminated is True


def _read_until(handle, marker, timeout=20):
    buf = ""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            buf += handle.read(1024)
        except EOFError:
            break
        if marker in buf:
            break
    return buf


def test_spawn_roundtrip():
    """Spawn a real shell in a PTY, echo a marker, read it back, resize, terminate."""
    marker = "PTY_ROUNDTRIP_OK_42"
    if sys.platform == "win32":
        h = pb.spawn(["cmd.exe"], rows=24, cols=80)
        assert isinstance(h, pb._WinPtyHandle)
        newline = "\r\n"
    else:
        h = pb.spawn(["/bin/bash"], rows=24, cols=80)
        assert isinstance(h, pb._PosixPtyHandle)
        newline = "\n"
    try:
        assert h.isalive() is True
        h.write("echo " + marker + newline)
        out = _read_until(h, marker)
        assert marker in out, "marker not echoed back; got: " + repr(out)
        h.setwinsize(30, 120)   # resize must not raise
    finally:
        h.terminate(force=True)
