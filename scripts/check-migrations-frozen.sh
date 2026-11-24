#!/usr/bin/env bash
# Migrations on main are deployed: the migrate job applies them on every merge (STO-130).
# So a change may only ADD migrations, each dated after the newest one already on main.
# Fails if it edits, deletes or renames an existing migration, or adds one out of order.
# Usage: scripts/check-migrations-frozen.sh <base-ref> [migrations-dir]
set -euo pipefail
BASE="${1:?base ref required, e.g. origin/main}"
DIR="${2:-supabase/migrations}"
status=0

# Two-dot diff of the trees: works on CI's shallow checkout, which has no merge base.
while IFS=$'\t' read -r st path; do
  [[ -z "${st:-}" || "$st" == "A" ]] && continue
  echo "FAIL: $path is already on main, so it's deployed ($st). Add a new migration instead."
  status=1
done < <(git diff --no-renames --name-status "$BASE" -- "$DIR/*.sql")

newest_on_base=$(git ls-tree --name-only "$BASE" -- "$DIR/" | sed 's#.*/##' | grep -E '^[0-9]{14}_.*\.sql$' | sort | tail -1 || true)
while read -r path; do
  [[ -z "$path" ]] && continue
  f=${path##*/}
  if [[ ! "$f" =~ ^[0-9]{14}_[a-z0-9_]+\.sql$ ]]; then
    echo "FAIL: $f must be named YYYYMMDDHHMMSS_name.sql"; status=1; continue
  fi
  if [[ -n "$newest_on_base" && ! "$f" > "$newest_on_base" ]]; then
    echo "FAIL: $f is dated before $newest_on_base, the newest migration on main. Use a current timestamp."; status=1
  fi
done < <(git diff --no-renames --name-only --diff-filter=A "$BASE" -- "$DIR/*.sql")

[[ $status -eq 0 ]] && echo "OK: migrations on main unchanged; new ones are in order"
exit $status
