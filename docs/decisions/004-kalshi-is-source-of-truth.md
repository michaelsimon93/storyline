# ADR-004: Kalshi's result is the source of truth; "Out" locks, never voids

**Status:** Accepted · **Date:** 2026-11-13

## Context
Picks must be resulted. Players get ruled out before games. Kalshi settles DNPs as `scalar` (fair price).

## Options considered
- Grade results ourselves from box scores
- Void picks immediately when ESPN lists a player Out
- Lock the card on Out; let Kalshi's result decide everything

## Decision
Kalshi's `result` is the only source of truth. When ESPN lists a player Out, the card stops taking new picks; existing picks wait for Kalshi. `scalar` → void → refund.

## Consequences
- Our results can never disagree with the market's.
- Refunds for ruled-out players arrive at settlement, not instantly (the card says so).
- If a player listed Out plays anyway, picks settle on what actually happened.
