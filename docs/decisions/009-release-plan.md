# ADR-009: v1 is the core loop; retention features follow

**Status:** Accepted · **Date:** 2026-11-13

## Context
Scope grew quickly during planning (bankroll, daily claim, live stats, price-move prompts, analytics). The riskiest assumption is whether AI-curated cards are interesting enough to come back for.

## Options considered
- Ship everything at once
- Ship the core loop first, retention second

## Decision
**v1:** curation, cards, $5 picks, settlement, My Picks, $100 start, daily $10 claim, display name. **v1.1:** live stat progress, price-moved prompt. **v2+:** login, leaderboard, follows, sharing, contests…

*Amended 2026-11-15:* the daily claim moved from v1.1 to v1. It's the only way back in for a user who runs out of money (STO-22, STO-47).

## Consequences
- Friends see real cards sooner.
- v1's data model already contains v1.1's states and ledger types, so v1.1 adds features without refactoring (see ADR-010).
