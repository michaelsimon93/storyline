# ADR-010: Harden the data model for the roadmap now

**Status:** Accepted · **Date:** 2026-11-13

## Context
Some future features are *additive* (a new table) and cheap later. Others are *structural* (they change what existing rows mean) and expensive once real data exists.

## Options considered
Each roadmap item was classified structural vs additive by asking: does adding it later require rewriting existing rows?

## Decision
Structural items modeled now:
- **league** on everything (NBA→NFL; MIN≠MIN)
- **subject** = player | team | game (team/matchup storylines)
- **wallets** (contests with separate bankrolls)
- **pick credits** (bonus "free trades")
- **per-card locks_at** (news-driven drops any time; in-game later)
- **one pick per card per wallet** (one line per player, even with adjustable lines)

Deferred as additive: parlays, follows/friends' picks, contests table, cash-out, admin roles.

## Consequences
- Slightly more schema up front; no planned feature requires a data migration.
- Two devices before login = two accounts (accepted, manual merge if needed).
