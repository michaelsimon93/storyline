#!/usr/bin/env bash
# Tests for check-migrations.sh: unchanged passes, edited fails, deleted fails.
set -uo pipefail
CHECK="$(cd "$(dirname "$0")" && pwd)/check-migrations.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
echo "create table a();" > "$T/0001_a.sql"
sha256sum "$T/0001_a.sql" | awk '{print $1"  0001_a.sql"}' > "$T/DEPLOYED"
fails=0
expect() { local want=$1; shift; "$CHECK" "$T" >/dev/null 2>&1; local got=$?
  if [[ $got -eq $want ]]; then echo "PASS $*"; else echo "FAIL $* (exit $got)"; fails=1; fi; }
expect 0 "unchanged deployed migration passes"
echo "create table b();" > "$T/0002_b.sql"
expect 0 "adding a new migration passes"
echo "-- sneaky edit" >> "$T/0001_a.sql"
expect 1 "editing a deployed migration fails"
rm "$T/0001_a.sql"
expect 1 "deleting a deployed migration fails"
exit $fails
