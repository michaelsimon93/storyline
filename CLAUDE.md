# Storyline: working agreement

**Read only what the task needs.** Start with the spec sections and ADRs the Linear issue links. Read other ADRs only when the change touches their area; `docs/decisions/README.md` indexes them in one line each. For `web/`, `docs/design.md` is the source of truth for UI. Don't read `docs/` end to end.

## Working with Michael
Michael is Head of Product and directs the build. Teaching matters as much as shipping, so he can defend every decision himself.
- With any code or architecture choice, give a 3–5 line **why**.
- For real architecture or pipeline choices, give **two options with tradeoffs** and let him pick.
- **State assumptions before building.** Say whether external API behavior is verified (fixture, docs, a real call) or a guess.
- Build the **smallest end-to-end version first**, then layer on.
- **Push back** on scope and ideas. Don't just execute.
- Be concise by default. Go deeper when he asks why.

## Testing is part of done
A change isn't finished until it has the tests its tier needs and CI is green. **A test earns its place if it would catch a bug that ships silently.** Depth follows risk (ADR-013):

| Tier | Code | Required tests | Where |
|---|---|---|---|
| 1. Money and integrity | picks, settlement, claims, ledger, locks, RLS and grants, job idempotency | Real Postgres. Prove it's **safe to re-run**. Security rules get a "can't do it" test. Concurrency claims get a concurrency test, shown to fail when the protection is removed. | `worker/test/*.integration.test.ts`, `supabase/tests/scenario_*.sql` |
| 2. External data | Kalshi, ESPN and Claude clients and parsers, the grounding check on Claude's answers (ADR-014), and matching players and teams across sources | **Recorded fixtures** with a mocked `fetch`, including odd real responses and error/retry paths. Never hit the network. | `worker/test/` + `worker/test/fixtures/` |
| 3. Taste logic | story detectors, shortlist, curation ranking and prompts | **Invariants** (size limits, only games on the slate, every story has a valid market) plus one golden fixture per story angle. Don't pin exact scores or weights. | `worker/test/*.test.ts` |
| 4. Glue | config loading, alert and feed text, CLI | `tsc`. Add a unit test only for a real branch. | `worker/test/*.test.ts` |
| Web app | | Component tests for card states; one end-to-end path: open → swipe → pick | `web/` |

The tier follows what the code does, not the file it lives in. A job's write path (rows written, money, locks, safe re-runs) is tier 1. The choices it makes (which stories, which order) are tier 3. Tier 1 cases can live in a tier 3 module's test file.

- **Test each rule in one place.** Pure logic gets unit tests. Integration tests prove the wiring, the database and safe re-runs. They don't re-check rules a unit test already covers.
- **Name test files for the code, not the ticket or reviewer.** Add cases to the module's existing test file or scenario. No `*_qa`, `*_adversary` or `sto123_*` files.
- **Write the failing case first** for money, results, or matching. **Bugs get a regression test** before the fix.
- **Don't mock the database.** Use real Postgres; `supabase/tests/supabase_stubs.sql` stands in for Supabase's auth layer.
- Keep fixtures small: trimmed real responses, not synthetic guesses.

## Running tests
```bash
PGHOST=localhost PGUSER=postgres ./supabase/tests/run.sh          # schema
cd worker && npm test                                             # unit
cd worker && TEST_DATABASE_URL=postgres://postgres@localhost/postgres npm run test:integration
```
Without a Postgres service, run one on a socket (agents use these commands; don't copy them into agent files):
```bash
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/pgdata -o '-k /tmp -p 5433' -l /tmp/pg.log start"   # if not running
PGHOST=/tmp PGPORT=5433 PGUSER=postgres ./supabase/tests/run.sh
cd worker && npm test && TEST_DATABASE_URL="postgresql://postgres@/postgres?host=/tmp&port=5433" npm run test:integration
```
CI runs Postgres 17 and is the source of truth.

## Workflow
- Never commit to `main`. Branch → PR → CI green → Michael merges. No agent merges.
- Work is tracked in Linear (team `STO`, project **Storyline**; milestones v1, v1.1, v2+). Spec and ADRs say *what and why*; Linear says *what's next*. Link spec sections, don't copy them.
- **The ticket is the brief.** A prompt may be just a ticket ID. Read the issue, its sub-issues and any decisions recorded on them. Its `Agent brief` section, if present, says what to read first, what to confirm before coding, and what's out of scope. Ask Michael only for what the brief leaves open.
- **Every PR has an issue** (check before creating one). Branch `<type>/sto-12-short-name` (`feat`, `fix`, `chore`, `docs`); PR title starts `STO-12:`; `Fixes STO-12` as the PR description's first line. Cloud sessions start on a random branch name: rename it when you start work, not at `/ship`.
- **Product calls go to Michael as `needs-decision`**: label the issue, state the question and options, and don't build past it.
- Labels: one area (`db`, `worker`, `curation`, `web`, `infra`) per issue. No cycles, no estimates.
- **One PR = one concern**, ~10 minutes to review (<400 changed lines excluding tests). Refactors go in their own PR first. Every commit passes tests on its own. Stack only true dependencies (2–3 max, merge commits, not squash).
- **When the work is done and tests pass locally, run `/ship` without asking.** It opens the PR and runs the reviews. Ask Michael only for product calls, things you can't get yourself (like data from a blocked network), and merges.

### Review depth (ADR-022)
| PR type | Reviewers |
|---|---|
| **Docs-only**: no SQL, TypeScript, scripts or CI config | None |
| **Code** (default) | `eng-lead` |
| **High-risk**: tier 1 code (see the testing table) | `qa`, then `eng-lead` |
| Touches `web/` | add `ui-reviewer` before `eng-lead` |

**Process evolves with the build.** Change it when the change saves time on every future PR, in its own small PR. Run `/retro` at the end of each milestone. Write an ADR only for a decision that would take a migration or a rewrite to reverse.

## Schema and code rules
- **Each schema change is a new migration** named `supabase/migrations/YYYYMMDDHHMMSS_name.sql` (UTC), dated after the newest one on `main`. Merged = deployed: CI applies migrations on merge, and any migration on `main` is frozen (CI enforces it). Bump `REQUIRED_MIGRATION` in `worker/src/lib/schema.ts` in the same PR (a test fails if you don't).
- New tables and functions are locked down by default. Grant deliberately and add a "can't do it" test (ADR-016).
- **No hard-coded tunables.** Sizes, thresholds, money amounts and intervals are `app_config` rows, read via `config_int()` / `loadConfig()`. No defaults in code (ADR-018).
- Risky or user-visible features ship behind a flag; log `flag_exposure` when a flag changes what a user sees.
- Events that involve a card carry `card_id` (ADR-019).
- Business rules live in one place. The slate day is `storyline_day()` in SQL (03:00 ET rollover by default); the worker, app and daily claim ask the database.
- Money is integer cents. Prices are integer cents 1–99.
- Only the worker calls Kalshi, ESPN, or Claude (ADR-003). Every worker job logs to `pipeline_runs` via `withRun`.
- Commits: small, one concern each, imperative subject line.
