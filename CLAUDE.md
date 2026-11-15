# Storyline: working agreement

Read `docs/product.md` (why), `docs/spec.md` (what), and `docs/decisions/` (how and why we chose it) before making changes. For anything in `web/`, `docs/design.md` is the source of truth for UI.

## Testing is part of done
A change isn't finished until it has tests and CI is green. No exceptions for "small" changes.

| What you're changing | Required tests | Where |
|---|---|---|
| Pure logic (parsing, mapping, matching, math, money) | Unit tests covering normal cases **and** the edge cases that would silently corrupt data | `worker/test/*.test.ts` |
| External API clients | Tests against **recorded fixtures** with a mocked `fetch`, including error/retry paths. Tests never hit the network. | `worker/test/` + `worker/test/fixtures/` |
| Worker jobs (ingest, poller, curation, settlement) | Integration test: fixtures in, real Postgres, assert rows written. Must also prove the job is **safe to re-run**. | `worker/test/*.integration.test.ts` |
| Schema, RLS, SQL functions | A scenario in `supabase/tests/scenario_*.sql` that prints `PASS`/`FAIL`. Security rules get a "can't do it" test, not just a "can do it" test. | `supabase/tests/` |
| Web app (when built) | Component tests for card states; one end-to-end path: open → swipe → pick | `web/` |

Rules of thumb:
- **Write the failing case first** for anything involving money, results, or matching.
- **Bugs get a regression test** before the fix.
- **Don't mock the database.** Use real Postgres; the stubs in `supabase/tests/supabase_stubs.sql` stand in for Supabase's auth layer and mirror its default privileges. CI also runs the SQL tests against a real local Supabase.
- **Concurrency claims need a concurrency test**, and the test must be shown to fail when the protection is removed.
- Keep fixtures small: trimmed real responses, not synthetic guesses.

## Running tests
```bash
PGHOST=localhost PGUSER=postgres ./supabase/tests/run.sh          # schema
cd worker && npm test                                             # unit
cd worker && TEST_DATABASE_URL=postgres://postgres@localhost/postgres npm run test:integration
```

In a Claude session without a Postgres service, run a local one on a socket and point the same commands at it. Agents use these commands; don't copy them into agent files.
```bash
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgdata -o '-k /tmp -p 5433' -l /tmp/pg.log start"   # if it isn't running
PGHOST=/tmp PGPORT=5433 PGUSER=postgres ./supabase/tests/run.sh
cd worker && npm test && TEST_DATABASE_URL="postgresql://postgres@/postgres?host=/tmp&port=5433" npm run test:integration
```
CI runs Postgres 17; a local 16 is fine for development, but CI is the source of truth.

## Workflow
- Never commit to `main`. Branch → PR → CI green → merge.

### Planning in Linear
- Work is tracked in Linear (team `STO`, project **Storyline**). Milestones mirror the release plan: v1, v1.1, v2+.
- **Docs vs. Linear:** `docs/spec.md` and ADRs record *what and why*; Linear tracks *what's next and its status*. Don't copy spec text into issues; link the section.
- **Every PR has an issue.** Check for one before creating it. One issue ≈ one PR; split bigger issues.
- **Put the issue ID in the branch and the PR:** branch `feat/sto-12-short-name`, and `Fixes STO-12` as the PR description's first line. Linear moves the issue to In Review when the PR opens and Done when it merges.
- **Product calls go to Michael as `needs-decision`.** Label the issue, state the question and the options in it, and don't build past the open decision.
- Labels: one area (`db`, `worker`, `curation`, `web`, `infra`) per issue. No cycles.
- **Estimates are for Michael's reference only**: how much effort a task would take a team. They never change how work is planned or built. When creating an issue, set points (1 / 2 / 3 / 5 / 8) as a mid-level engineer without AI help would size it, and end the description with `**Estimate: N.**` plus one line on what drives the size.

### Pull requests
- **One PR = one concern**, reviewable in ~10 minutes (roughly <400 changed lines excluding tests). If the title needs "and", split it.
- **Refactors go in their own PR**, before the feature that needs them.
- **Every commit passes tests on its own.**
- Stack PRs only when one truly depends on another; keep stacks to 2–3 and merge promptly.
- **Each schema change gets its own new migration file**, named with a UTC timestamp (`supabase/migrations/YYYYMMDDHHMMSS_name.sql`), even before deploy. Timestamps (not 0003, 0004…) keep parallel branches from colliding.
- Fill in the PR template, especially **Risks & where to look**, which tells the human reviewer what to read closely.
- Merge stacked PRs with a merge commit (not squash) so the PRs above them don't conflict.

### Reviews (agents in `.claude/agents/`, ADR-022)
Review depth matches risk. Each reviewer runs in a fresh context and is never the agent that wrote the code.

| PR type | Reviewers | Then |
|---|---|---|
| **Docs-only**: no SQL, TypeScript, scripts or CI config (includes agent files and this file) | None | CI green, Michael merges |
| **Code** (default) | `eng-lead` | Michael merges |
| **High-risk code**: money (`place_pick`, settlement, claims, ledger), security (RLS, grants, `security definer`), concurrency (locks, job overlap) | `qa`, then `eng-lead` | Michael merges |
| Anything in `web/` | add `ui-reviewer` before `eng-lead` | |

- **`qa`** maps each acceptance criterion to a test, checks for regressions, and tries to break the change with failing tests. Only touches test files.
- **`ui-reviewer`** reviews against `docs/design.md`. Reads only.
- **`eng-lead`** is the approver for every code PR. It checks which row the PR belongs in, reviews against the issue, the spec, this file and a security checklist, and gives one verdict. APPROVED comes with a handoff for Michael: a checklist to verify himself, then a pre-written approval comment.
- **Michael merges every PR.** No agent merges.

**Keep rounds short:**
- Only a **blocker** sends the PR back through `eng-lead`. The author fixes should-fix items in the same PR without another round; nits are optional.
- On a high-risk PR, re-run `qa` only if the fix touched money, security or concurrency code.
- A finding outside the PR's scope gets a new issue only if it's a bug. Otherwise it's one line in the handoff.

**Running the reviewers (the launching session's job):**
- Pass each reviewer the base..head range, the PR description, and the Linear issue's acceptance criteria word for word (plus any open `needs-decision`). The reviewers can't read Linear.
- Tell `eng-lead` which row you picked, and pass it the `qa` and `ui-reviewer` reports when they ran.
- **Post every report as a PR comment**, headed `**qa (agent) report**`, `**ui-reviewer (agent) report**` or `**eng-lead (agent) verdict: …** (round n)`, so agent comments are told apart from Michael's and `/retro` has the record.

**Process is paused until a real pick is placed on a live card.** No new agents, commands or process docs before then; fix a process problem only if it blocks a product PR. ADRs are for decisions that are hard to reverse, not for every choice.

At the end of each milestone, run `/retro`.

### Schema and code rules
- **Migrations are frozen once deployed** (listed in `supabase/migrations/DEPLOYED`). Change the schema with a new migration; CI enforces this.
- New tables and functions are locked down by default. Grant access deliberately, and add a "can't do it" test (ADR-016).
- **No hard-coded tunables.** Anything we might want to adjust (sizes, thresholds, money amounts, intervals) is an `app_config` row with a type and range, read via `config_int()` in SQL or `loadConfig()` in the worker. No defaults in code (ADR-018).
- **Risky or user-visible new features ship behind a feature flag**, and the app logs `flag_exposure` when a flag changes what a user sees.
- **Events that involve a card carry `card_id`.** Personalization depends on it (ADR-019).
- Business rules live in exactly one place. The slate day (03:00 ET rollover by default) is `storyline_day()` in SQL, and the worker and app ask the database. The daily claim uses the same day.

## Other conventions
- Money is integer cents. Prices are integer cents 1–99.
- Only the worker calls Kalshi, ESPN, or Claude (ADR-003).
- Every worker job logs to `pipeline_runs` via `withRun`.
- Significant decisions get an ADR in `docs/decisions/`.
- Commits: small, one concern each, imperative subject line.
