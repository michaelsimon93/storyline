# ADR-023: Run the book as if the money were real

**Status:** Accepted · **Date:** 2026-11-16

## Context
Every pick makes Storyline the counterparty: we sell the user a position at Kalshi's price and hold the other side. The money is play money, so nothing is actually lost. But Storyline is meant to show what it takes to run a product like this end to end, and play money has its own risks: balances inflate, curation can produce lopsided markets, and a bug in the ledger is invisible without checks.

The spec puts the admin dashboard in v2+ (STO-29) and says there are no dashboards in v1 (ADR-012).

## Options considered
- **Treat it as play money.** No risk tooling until v2. Cheapest, but the first time we see exposure is after a problem, and the data model is never tested against operating needs.
- **A full risk desk in v1:** views, exposure caps in `place_pick`, an admin page. That's most of a release of work before the first real pick, and it would set cap values with no data to base them on.
- **Measure now, add limits later.** Read-only risk views, a reconciliation check and a manual kill switch in v1, with reports in Discord. Caps and the admin page come after the views show real numbers.

## Decision
Measure now, add limits later (`docs/risk.md`):
- Storyline is the house. Exposure is liability per outcome, worst case, expected result at the current price, and hedge needed, per market, per game and per day.
- The payout rule lives in one SQL function, used by both settlement and the risk views, so they can't disagree.
- A reconciliation view that should always be empty is the books' health check. Any row is a critical alert.
- Grants are reported as promo spend, separate from the book's result. Money created vs. taken back is tracked to catch inflation.
- A manual suspend switch per card, audited. No admin voids: Kalshi's result still decides every void (ADR-004).
- No UI: views, the SQL editor and Discord reports. Exposure caps stay an open decision (STO-60).

## Consequences
- About four small issues added to v1, all in the database or the worker. None of them block the first real pick.
- The future admin dashboard is a page over views that already exist and are tested.
- Risk views read only the service role's data. A user can never see the book's position.
- If caps are adopted later, they're one more check in `place_pick` against a number we already calculate.
