# ADR-006: Append-only ledger in integer cents

**Status:** Accepted · **Date:** 2026-11-13

## Context
Users hold play-money balances that change via grants, stakes, payouts, refunds and future corrections (re-resulting).

## Options considered
- A `balance` column updated in place
- An append-only ledger; balance = sum

## Decision
Append-only ledger, integer cents, with database-enforced uniqueness: one signup grant per user, one daily grant per user per day, and at most one stake/payout/refund per pick.

## Consequences
- Every balance is explainable line by line; corrections are reversing entries.
- **Settlement can be re-run safely**: paying twice is impossible at the database level, not just in code.
- No floating-point money bugs.
