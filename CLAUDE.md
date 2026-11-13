# Storyline: working agreement

Read `docs/product.md` (why), `docs/spec.md` (what), and `docs/decisions/` (how and why we chose it) before making changes.

## Testing is part of done
A change isn't finished until it has tests and CI is green. No exceptions for "small" changes.

| What you're changing | Required tests | Where |
|---|---|---|
| Pure logic (parsing, mapping, matching, math, money) | Unit tests covering normal cases **and** the edge cases that would silently corrupt data | `worker/test/*.test.ts` |
| External API clients | Tests against **recorded fixtures** with a mocked `fetch`, including error/retry paths. Tests never hit the network. | `worker/test/` + `worker/test/fixtures/` |
| Worker jobs (ingest, poller, curation, settlement) | Integration test: fixtures in, real Postgres, assert rows written. Must also prove the job is **safe to re-run**. | `worker/test/*.integration.test.ts` |
| Schema, RLS, SQL functions | A scenario in `supabase/tests/scenarios.sql` that prints `PASS`/`FAIL`. Security rules get a "can't do it" test, not just a "can do it" test. | `supabase/tests/` |
| Web app (when built) | Component tests for card states; one end-to-end path: open → swipe → pick | `web/` |

Rules of thumb:
- **Write the failing case first** for anything involving money, results, or matching.
- **Bugs get a regression test** before the fix.
- **Don't mock the database.** Use real Postgres; the stubs in `supabase/tests/supabase_stubs.sql` stand in for Supabase's auth layer.
- Keep fixtures small: trimmed real responses, not synthetic guesses.

## Running tests
```bash
PGHOST=localhost PGUSER=postgres ./supabase/tests/run.sh          # schema
cd worker && npm test                                             # unit
cd worker && TEST_DATABASE_URL=postgres://postgres@localhost/postgres npm run test:integration
```

## Other conventions
- Money is integer cents. Prices are integer cents 1–99.
- Only the worker calls Kalshi, ESPN, or Claude (ADR-003).
- Every worker job logs to `pipeline_runs` via `withRun`.
- Significant decisions get an ADR in `docs/decisions/`.
- Commits: small, one concern each, imperative subject line.
