# Architecture Decision Records

Short records of the decisions that shaped Storyline: the context, the options considered, what was chosen, and what it costs. Superseded decisions stay in the record with their history.

| # | Decision |
|---|---|
| 001 | [Kalshi as the only market source for v1](001-kalshi-as-market-source.md) |
| 002 | [Most-even line, locked at publish; prices stay live](002-line-selection-and-locking.md) *(line rule superseded by 014)* |
| 003 | [Only the worker calls Kalshi, ESPN and Claude](003-worker-owns-external-calls.md) |
| 004 | [Kalshi's result is the source of truth; "Out" locks, never voids](004-kalshi-is-source-of-truth.md) |
| 005 | [ESPN (undocumented) for tip-off times, stats and context](005-espn-for-schedule-and-context.md) |
| 006 | [Append-only ledger in integer cents](006-append-only-ledger.md) |
| 007 | [Supabase anonymous auth instead of a homemade cookie ID](007-anonymous-auth.md) |
| 008 | [Stack: Next.js + Supabase + an always-on worker](008-stack.md) |
| 009 | [v1 is the core loop; retention features follow](009-release-plan.md) |
| 010 | [Harden the data model for the roadmap now](010-future-proof-data-model.md) |
| 011 | [Free trades pay winnings only; voids reissue the credit](011-free-trade-payouts.md) |
| 012 | [In-house analytics via an events table](012-in-house-analytics.md) |
| 013 | [Testing is part of done](013-testing-strategy.md) |
| 014 | [The story chooses the line; every claim is grounded](014-story-chooses-the-line.md) |
| 015 | [A streak is consecutive card-days with a pick](015-streaks-are-pick-days.md) |
| 016 | [Explicit privileges, tested against real Supabase](016-defense-in-depth-privileges.md) |
| 017 | [Keep price history as snapshots](017-price-history.md) |
| 018 | [Configurable settings and feature flags in the database](018-config-and-feature-flags.md) |
| 019 | [Personalization: shared core deck, signals from views and picks](019-personalization-groundwork.md) |
| 020 | [Lock ordering for picks and settlement](020-lock-ordering.md) |
