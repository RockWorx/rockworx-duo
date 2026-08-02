#!/usr/bin/env bash
# RockWorx Duo installer (macOS / Linux): sets up a private venv, installs deps, adds a Desktop
# shortcut, and launches. Nothing leaves your machine -- every file here is readable.
cd "$(dirname "$0")" || exit 1
echo
echo "  ============================================================"
echo "   RockWorx Duo -- installer"
echo "  ------------------------------------------------------------"
echo "   This sets up RockWorx Duo on your computer and starts it."
echo "   Nothing leaves your machine. It takes about a minute."
echo "  ============================================================"
echo

echo "[1/4] Looking for Python 3..."
PY=""
if command -v python3 >/dev/null 2>&1; then PY=python3
elif command -v python  >/dev/null 2>&1; then PY=python
fi
if [ -z "$PY" ] && command -v brew >/dev/null 2>&1; then
  echo "      Python not found -- installing it via Homebrew..."
  brew install python && PY=python3
fi
if [ -z "$PY" ]; then
  echo "      Python 3 was not found. Please install Python 3.10 or newer:"
  echo "        macOS:  https://www.python.org/downloads/   (or: brew install python)"
  echo "        Linux:  e.g.  sudo apt install python3 python3-venv"
  echo "      Then run ./install.sh again."
  exit 1
fi
echo "      Found Python ($PY). Good."
echo

echo "[2/4] Creating a private environment (.venv) just for RockWorx Duo..."
if [ -x .venv/bin/python ]; then
  echo "      It already exists -- reusing it."
else
  "$PY" -m venv .venv || { echo "      Could not create the environment."; exit 1; }
  echo "      Done."
fi
echo

echo "[3/4] Downloading the small components it needs (this can take a minute)..."
.venv/bin/python -m pip install --upgrade pip >/dev/null 2>&1
.venv/bin/python -m pip install -r requirements.txt || { echo "      Install failed -- see the messages above."; exit 1; }
echo "      Done."
echo

echo "[4/4] Adding a Desktop shortcut..."
if [ "$(uname)" = "Darwin" ] && [ -d "$HOME/Desktop" ]; then
  SC="$HOME/Desktop/RockWorx Duo.command"
  printf '#!/bin/bash\ncd "%s" && ./launch.sh\n' "$(pwd)" > "$SC" && chmod +x "$SC" && echo "      Done -- 'RockWorx Duo' is on your Desktop."
elif [ -d "$HOME/Desktop" ]; then
  SC="$HOME/Desktop/rockworx-duo.desktop"
  printf '[Desktop Entry]\nType=Application\nName=RockWorx Duo\nExec=%s/launch.sh\nPath=%s\nTerminal=true\n' "$(pwd)" "$(pwd)" > "$SC" && chmod +x "$SC" && echo "      Done -- 'RockWorx Duo' is on your Desktop."
else
  echo "      (No Desktop folder found -- skipping; start it any time with ./launch.sh)"
fi
echo

echo "  ============================================================"
echo "   All set! Starting RockWorx Duo now..."
echo "     * Your web browser will open in a moment."
echo "     * KEEP THIS WINDOW OPEN while you use it."
echo "     * To stop RockWorx Duo: press Ctrl-C (or close this window)."
echo "     * To start it again later: the Desktop shortcut, or ./launch.sh"
echo "  ============================================================"
echo
exec .venv/bin/python server.py
