"""Cross-platform PTY backend for the harness. spawn(argv, cwd, env, rows, cols) returns a
handle exposing read(n) / write(data) / setwinsize(rows, cols) / isalive() / terminate(force).
The Windows backend wraps pywinpty; POSIX wraps ptyprocess.
ASCII-only."""
import sys


def spawn(argv, cwd=None, env=None, rows=24, cols=80):
    """Spawn argv in a PTY sized rows x cols; returns a backend handle. Platform-selected."""
    if sys.platform == "win32":
        from winpty import PtyProcess
        return _WinPtyHandle(
            PtyProcess.spawn(argv, cwd=cwd, env=env, dimensions=(rows, cols)))
    else:
        import ptyprocess
        return _PosixPtyHandle(
            ptyprocess.PtyProcessUnicode.spawn(argv, cwd=cwd, env=env, dimensions=(rows, cols)))


class _WinPtyHandle:
    """Adapts pywinpty's PtyProcess to the harness PTY interface (1:1 today)."""
    def __init__(self, proc):
        self._p = proc

    def read(self, n=1024):
        return self._p.read(n)

    def write(self, data):
        return self._p.write(data)

    def setwinsize(self, rows, cols):
        return self._p.setwinsize(rows, cols)

    def isalive(self):
        return self._p.isalive()

    def terminate(self, force=False):
        return self._p.terminate(force=force)


class _PosixPtyHandle:
    """Adapts ptyprocess's PtyProcessUnicode to the harness PTY interface."""
    def __init__(self, proc):
        self._p = proc

    def read(self, n=1024):
        return self._p.read(n)

    def write(self, data):
        return self._p.write(data)

    def setwinsize(self, rows, cols):
        return self._p.setwinsize(rows, cols)

    def isalive(self):
        return self._p.isalive()

    def terminate(self, force=False):
        return self._p.terminate(force=force)
