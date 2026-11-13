#!/usr/bin/env bash
# Fails if a change edits or removes an existing line of supabase/migrations/DEPLOYED.
# Adding lines (newly deployed migrations) is fine. Without this, someone could edit a
# frozen migration AND update its hash in the same PR, and check-migrations.sh would pass.
# Usage: scripts/check-deployed-append-only.sh <base-ref> [manifest-path]
set -euo pipefail
BASE="${1:?base ref required, e.g. origin/main}"
FILE="${2:-supabase/migrations/DEPLOYED}"
removed=$(git diff --unified=0 "$BASE" -- "$FILE" | grep -E '^-[^-]' || true)
if [[ -n "$removed" ]]; then
  echo "FAIL: existing lines in $FILE were changed or removed (it is append-only):"
  echo "$removed"
  exit 1
fi
echo "OK: $FILE is append-only"
