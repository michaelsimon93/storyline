#!/usr/bin/env bash
# Tests for check-deployed-append-only.sh in a throwaway git repo.
set -uo pipefail
CHECK="$(cd "$(dirname "$0")" && pwd)/check-deployed-append-only.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cd "$T" && git init -q && git config user.email t@t && git config user.name t
echo "aaa  0001_a.sql" > DEPLOYED && git add DEPLOYED && git commit -qm base && git tag base
fails=0
expect() { local want=$1; shift; "$CHECK" base DEPLOYED >/dev/null 2>&1; local got=$?
  if [[ $got -eq $want ]]; then echo "PASS $*"; else echo "FAIL $* (exit $got)"; fails=1; fi; }
expect 0 "unchanged manifest passes"
echo "bbb  0002_b.sql" >> DEPLOYED; git commit -qam add
expect 0 "appending a newly deployed migration passes"
sed -i 's/^aaa/zzz/' DEPLOYED; git commit -qam rehash
expect 1 "re-hashing a frozen migration fails"
git reset -q --hard HEAD~1; sed -i '1d' DEPLOYED; git commit -qam drop
expect 1 "removing a frozen migration fails"
exit $fails
