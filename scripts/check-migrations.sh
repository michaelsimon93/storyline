#!/usr/bin/env bash
# Fails if any migration listed in supabase/migrations/DEPLOYED was edited or deleted.
# Usage: scripts/check-migrations.sh [migrations_dir]
set -euo pipefail
DIR="${1:-$(dirname "$0")/../supabase/migrations}"
status=0
while read -r sha file; do
  [[ -z "${sha:-}" || "$sha" == \#* ]] && continue
  if [[ ! -f "$DIR/$file" ]]; then
    echo "FAIL: deployed migration $file was deleted"; status=1; continue
  fi
  actual=$(sha256sum "$DIR/$file" | cut -d' ' -f1)
  if [[ "$actual" != "$sha" ]]; then
    echo "FAIL: deployed migration $file was modified. Add a new migration instead."; status=1
  fi
done < "$DIR/DEPLOYED"
[[ $status -eq 0 ]] && echo "OK: deployed migrations unchanged"
exit $status
