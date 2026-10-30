#!/usr/bin/env bash
# Run Tark from this checkout without changing the caller's working directory.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -d "$SCRIPT_DIR/node_modules" ]]; then
  printf '%s\n' "Dependencies are missing. Run npm install --ignore-scripts from $SCRIPT_DIR first." >&2
  exit 1
fi

exec bash "$SCRIPT_DIR/pi-test.sh" "$@"
