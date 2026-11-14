# ADR-021: Core tables speak Storyline, not provider

**Status:** Accepted · **Date:** 2026-11-13

## Context
Storyline reads markets from Kalshi and stats from ESPN (ADR-003). The first schema used their
vocabulary directly: `markets.kalshi_status` held Kalshi's raw status, and `card_feed` decided
whether a card was out by comparing it to Kalshi's word `'active'`. Market IDs were Kalshi tickers,
and teams, players and games carried columns named after each provider's IDs.

That couples product rules to a provider's API. If Kalshi renames a status, or we add a second
market or stats source, rules break silently, and every provider adds columns to core tables.
Nothing is deployed yet, so changing this now costs only code.

## Options considered
- **Fix only what rules depend on.** Normalize market status and keep provider-named ID columns.
  Smallest, but provider names stay in the core model.
- **Source-neutral core (chosen).** Core tables use only our own IDs and vocabulary. Provider
  IDs live in a cross-reference table, and one adapter per provider translates at the boundary.
  This is the standard "anti-corruption layer" pattern.

## Decision
1. **No provider names in core tables.** `teams`, `players`, `games`, `markets`, `cards` and
   `picks` hold only Storyline IDs and Storyline vocabulary.
2. **Our own vocabularies.** Market status is `open | paused | closed | settled` (SQL enum
   `market_status`). Game status was already ours (`game_status`).
3. **One adapter per provider** (`worker/src/sources/*`, `worker/src/domain/<provider>Parse.ts`)
   is the only code that knows that provider's words and IDs. It maps unknown values to the safe
   side (an unknown market status → `paused`, so cards go out) and reports them loudly.
4. **Provider IDs live in one cross-reference table**, as (source, kind, external ID → our ID),
   unique per source and kind. Adding a provider adds rows, not columns.
5. **A market is identified by what it is**: game, kind, player or team, stat and line
   (`markets_identity`), not by who lists it. Provider IDs attach to that market. A lost or
   re-sent provider ID re-attaches instead of creating a duplicate, racing runs are no-ops
   instead of errors, and two providers listing the same market map to one Storyline market.
   (Found by the test adversary on STO-38.)
6. **Guardrail: no speculative frameworks.** Build only abstractions with a real provider
   behind them. One adapter each for Kalshi and ESPN; no generic plugin system.

Kalshi's status mapping follows its documented lifecycle. A determined result can still be
disputed or amended, so `determined`, `disputed` and `amended` map to `closed`. Only `finalized`
maps to `settled`. Results stay settlement's job (ADR-004, ADR-020 rule 4).

## Rollout
Three PRs, each one concern, all before settlement (STO-13) and curation (STO-10):
1. STO-37: market status in our own words.
2. STO-38: our own market IDs; Kalshi tickers move to the cross-reference table.
3. STO-39: team, player and game provider IDs move to the cross-reference table.

Also in scope, so nothing provider-specific is left behind:
- `markets.kalshi_series` is dropped (STO-38): it's the first part of Kalshi's ticker, and the
  market's own `kind` and `stat` already say what it measures.
- `markets.result` uses Kalshi's word `scalar` for a void market. Settlement (STO-13) maps
  results into our own vocabulary when it starts reading them.
- `markets.title` stays: it's display text, and the provider's wording is the content.

## Consequences
- A provider renaming or adding a status changes one mapping in its adapter. Unknown values
  turn cards out and fail the run (ingest and the poller both), so they're noticed the same day.
- Lookups by provider ID (ingest, the poller) take one extra join. User-facing reads don't.
- A second market or stats source means a new adapter plus cross-reference rows, with no schema
  change to core tables.
