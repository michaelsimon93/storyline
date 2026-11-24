#!/usr/bin/env bash
# Tests for check-migrations-frozen.sh against a throwaway git repo.
set -uo pipefail
CHECK="$(cd "$(dirname "$0")" && pwd)/check-migrations-frozen.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cd "$T" && git init -q && git config user.email t@t && git config user.name t
mkdir -p supabase/migrations
echo "create table a();" > supabase/migrations/20260101000000_a.sql
git add -A && git commit -qm base && git branch -q base
fails=0
expect() { local want=$1; shift; "$CHECK" base >/dev/null 2>&1; local got=$?
  if [[ $got -eq $want ]]; then echo "PASS $*"; else echo "FAIL $* (exit $got)"; fails=1; fi
  git reset -q --hard base; git clean -qfd; }
expect 0 "no change passes"
echo "create table b();" > supabase/migrations/20260102000000_b.sql; git add -A
expect 0 "adding a newer migration passes"
echo "-- edit" >> supabase/migrations/20260101000000_a.sql
expect 1 "editing a migration on main fails"
rm supabase/migrations/20260101000000_a.sql
expect 1 "deleting a migration on main fails"
git mv supabase/migrations/20260101000000_a.sql supabase/migrations/20260101000000_renamed.sql
expect 1 "renaming a migration on main fails"
echo "create table c();" > supabase/migrations/20251231000000_c.sql; git add -A
expect 1 "adding a migration dated before main's newest fails"
echo "create table d();" > supabase/migrations/badname.sql; git add -A
expect 1 "a badly named migration fails"
exit $fails
