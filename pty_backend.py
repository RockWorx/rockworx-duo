"""Cross-platform PTY backend for the harness. spawn(argv, cwd, env, rows, cols) returns a
handle exposing read(n) / write(data) / setwinsize(rows, cols) / isalive() / terminate(force).
The Windows backend wraps pywinpty (byte-identical to today). POSIX (ptyprocess) is a Phase-3
fast-follow: the interface + selection exist now so PtySession never touches pywinpty directly.
ASCII-only."""
import sys


def spawn(argv, cwd, env, rows, cols):
    """Spawn argv in a PTY sized rows x cols; returns a backend handle. Platform-selected."""
    if sys.platform == "win32":
        from winpty import PtyProcess
        return _WinPtyHandle(
            PtyProcess.spawn(argv, cwd=cwd, env=env, dimensions=(rows, cols)))
    raise NotImplementedError(
        "POSIX PTY backend not yet implemented (Phase 3); harness is Windows-only for now")


class _WinPtyHandle:
    """Adapts pywinpty's PtyProcess to the harness PTY interface (1:1 today)."""
    def __init__(self, proc):
        self._p = proc

    def read(self, n):
        return self._p.read(n)

    def write(self, data):
        return self._p.write(data)

    def setwinsize(self, rows, cols):
        return self._p.setwinsize(rows, cols)

    def isalive(self):
        return self._p.isalive()

    def terminate(self, force=False):
        return self._p.terminate(force=force)
