#!/usr/bin/env bash
# Launch RockWorx Duo (POSIX). Requires python 3.10+.
cd "$(dirname "$0")" || exit 1
exec python3 server.py "$@"
