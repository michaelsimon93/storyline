# ADR-013: Testing is part of done

**Status:** Accepted · **Date:** 2026-11-13

## Context
Storyline moves play money, settles results, and depends on two external APIs (one undocumented). The failures that matter most are **silent** ones: a mis-parsed strike, a wrong player match, a double payout. Those don't crash; they quietly write bad data. It's also a solo build, so there's no reviewer to catch them.

## Options considered
- Test only the risky parts, add more later (fast now, and "later" rarely comes)
- A test pyramid scoped to Storyline's real risks, enforced in CI on every push

## Decision
Every change ships with tests, and CI must be green:
- **Unit tests** for pure logic, with the silent-corruption edge cases written first
- **Fixture-based tests** for API clients (recorded real responses, mocked `fetch`, no network), including retry and error paths
- **Integration tests** for worker jobs against real Postgres, including a re-run to prove idempotency
- **SQL scenario tests** for schema, RLS, and money functions, including "can't do it" security tests
- No mocking the database

The rules live in `CLAUDE.md` so every Claude Code session follows them.

## Consequences
- Slower per feature, much cheaper over time, especially once real users hold balances.
- Fixtures must be refreshed when ESPN or Kalshi change shape. That's a feature: a failing fixture test is how we'll notice.

## Amendment (2026-11-23): test depth matches risk
As of STO-123 the worker had about 4,000 lines of code, 6,500 lines of TypeScript tests and 1,800 lines of SQL scenarios. Every change got the full treatment. Story and curation heuristics, which we tune often and review after publishing, were tested as heavily as money. Each QA pass also added a new `*_qa` file next to the module's own tests, so some rules were asserted twice. The tests were green and fast (unit suite about 9 s), but they made diffs bigger and reviews longer, and cost tokens, without adding the same amount of safety.

The goal stays the same: catch the **silent** failures. A test earns its place if it would catch a bug that ships without anyone noticing. A bug that crashes, fails `tsc`, or shows up in the post-publish review of curation doesn't need a test of its own.

**Tiers.** Test depth follows the tier of the code being changed:

| Tier | Code | Tests |
|---|---|---|
| 1. Money and integrity | picks, settlement, claims, ledger, locks, RLS and grants, job idempotency | Full treatment: real Postgres, re-run tests, "can't do it" tests, concurrency tests, `qa` review |
| 2. External data | Kalshi and ESPN parsers and clients, Claude reply parsing, the grounding check on Claude's answers (ADR-014), and matching players and teams across sources | Recorded-fixture tests, including odd real responses, retries and errors |
| 3. Taste logic | story detectors, shortlist, curation ranking and prompts | **Invariants** (never more than the size you asked for, never a game off the slate, every story has a valid market) plus one golden fixture per story angle. Don't pin exact scores or weights. |
| 4. Glue | config loading, alert and feed text, CLI wiring | `tsc`, plus a unit test only when there is a real branch to get wrong |

The tier follows what the code does, not the file it lives in. A job's write path (rows written, money, locks, safe re-runs) is tier 1. The choices it makes (which stories, which order) are tier 3. Tier 1 cases can live in a tier 3 module's test file.

**Two rules that apply to every tier:**
- **Test each rule in one place.** Pure logic gets unit tests. Integration tests prove the wiring, the database and safe re-runs. They don't re-check rules a unit test already covers.
- **Name test files for the code, not the ticket or the reviewer.** QA cases go into the module's existing test file (or SQL scenario). No `*_qa`, `*_adversary` or `sto123_*` files.

**What doesn't change:** no mocking the database, a failing test before the fix for money, results and matching, and concurrency claims need a concurrency test.

**Consequences.** Smaller diffs and faster reviews on tier 3 and 4 changes. Tier 3 tests are less precise: a scoring change that is valid but worse won't fail a test. That's deliberate, because curation quality is judged by reviewing the published stories, not by tests. Existing QA files are folded into their modules under STO-125. Tier 3 tests are rewritten as invariants the next time that logic is tuned, not in a separate pass.
