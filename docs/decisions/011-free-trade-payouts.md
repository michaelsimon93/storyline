# ADR-011: Free trades pay winnings only; voids reissue the credit

**Status:** Accepted · **Date:** 2026-11-13

## Context
Bonus "free trades" (e.g., a free $20 pick) need a payout rule. All money is play money, so this is game design, not finance.

## Options considered
- Pay the full return (stake + winnings)
- Pay winnings only (sportsbook "bonus bet" rule)

## Decision
Winnings only: a $20 free trade at 40% that wins pays $30, not $50. A voided free trade comes back as a **credit**, not cash.

## Consequences
- Matches how bettors already understand bonus bets.
- Reissuing as a credit prevents converting promos into cash by picking players likely to sit.
