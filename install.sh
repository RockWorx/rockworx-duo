#!/usr/bin/env bash
# RockWorx Duo installer (macOS / Linux): sets up a private venv, installs deps, and launches.
cd "$(dirname "$0")" || exit 1
echo "=== RockWorx Duo -- installer ==="

PY=""
if command -v python3 >/dev/null 2>&1; then PY=python3
elif command -v python  >/dev/null 2>&1; then PY=python
fi

if [ -z "$PY" ] && command -v brew >/dev/null 2>&1; then
  echo "Python 3 not found -- installing via Homebrew..."
  brew install python && PY=python3
fi
if [ -z "$PY" ]; then
  echo "Python 3 not found. Install Python 3.10+ (https://www.python.org/downloads/ or your"
  echo "package manager, e.g. 'sudo apt install python3 python3-venv'), then re-run ./install.sh"
  exit 1
fi

echo "Using Python: $PY"
if [ ! -x .venv/bin/python ]; then
  echo "Creating a private environment (.venv)..."
  "$PY" -m venv .venv || { echo "Could not create the environment."; exit 1; }
fi
.venv/bin/python -m pip install --upgrade pip >/dev/null 2>&1
.venv/bin/python -m pip install -r requirements.txt || { echo "Dependency install failed -- see above."; exit 1; }

# --- create a Desktop shortcut (macOS .command / Linux .desktop) ---
if [ "$(uname)" = "Darwin" ] && [ -d "$HOME/Desktop" ]; then
  SC="$HOME/Desktop/RockWorx Duo.command"
  printf '#!/bin/bash\ncd "%s" && ./launch.sh\n' "$(pwd)" > "$SC" && chmod +x "$SC" && echo "Desktop shortcut created: $SC"
elif [ -d "$HOME/Desktop" ]; then
  SC="$HOME/Desktop/rockworx-duo.desktop"
  printf '[Desktop Entry]\nType=Application\nName=RockWorx Duo\nExec=%s/launch.sh\nPath=%s\nTerminal=true\n' "$(pwd)" "$(pwd)" > "$SC" && chmod +x "$SC" && echo "Desktop shortcut created: $SC"
fi

echo ""
echo "=== Starting RockWorx Duo -- your browser will open automatically. ==="
echo "Keep this terminal open while you use it; press Ctrl-C to stop."
echo "Next time, just run ./launch.sh"
exec .venv/bin/python server.py
