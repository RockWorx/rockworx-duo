#!/usr/bin/env bash
# Re-launch RockWorx Duo (macOS / Linux). Run ./install.sh first (creates .venv + installs deps).
cd "$(dirname "$0")" || exit 1
if [ -x .venv/bin/python ]; then
  exec .venv/bin/python server.py "$@"
else
  echo "No environment found -- run ./install.sh first. Falling back to system python3..."
  exec python3 server.py "$@"
fi
