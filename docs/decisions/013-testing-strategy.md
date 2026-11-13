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
