#!/usr/bin/env bash
# Runs the schema test suite against a throwaway database.
# Usage: PGHOST=... PGPORT=... PGUSER=... ./supabase/tests/run.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${REAL_SUPABASE:-0}" = "1" ]; then
  # Against a real local Supabase (`supabase start`), which has already applied
  # the migrations and has the real auth schema and default privileges.
  DB="${PGDATABASE:-postgres}"
else
  # Plain Postgres + stand-in auth layer. Fast, no Docker needed.
  DB="${TEST_DB:-storyline_test}"
  psql -q -d postgres -c "drop database if exists ${DB};" -c "create database ${DB};" >/dev/null
  psql -q -d "$DB" -v ON_ERROR_STOP=1 -f tests/supabase_stubs.sql 2>/dev/null
  for f in migrations/*.sql; do
    psql -q -d "$DB" -v ON_ERROR_STOP=1 -f "$f"
  done
fi

out="$(psql -q -d "$DB" -f tests/scenarios.sql 2>&1 | grep -v '^$')"
echo "$out"

pass=$(grep -c '^PASS' <<<"$out" || true)
fail=$(grep -vc '^PASS' <<<"$out" || true)
echo "----"
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
