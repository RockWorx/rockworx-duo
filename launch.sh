#!/usr/bin/env bash
# Launch Agent Harness (POSIX). Requires python 3.10+.
cd "$(dirname "$0")" || exit 1
exec python3 server.py "$@"
