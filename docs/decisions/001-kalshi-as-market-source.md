# ADR-001: Kalshi as the only market source for v1

**Status:** Accepted · **Date:** 2026-11-13

## Context
Storyline needs real, live player-prop markets. Candidates: Kalshi, Polymarket. A live check (Nov 13) found ~2,000 Kalshi NBA prop markets across 9 games and 121 players, with public market data requiring no API key.

## Options considered
- **Kalshi only**: deepest NBA prop coverage, US-regulated, keyless REST market data
- **Kalshi + Polymarket**: cross-venue prices, but double the integration for v1
- **Polymarket only**: thinner US prop coverage at the time

## Decision
Kalshi only for v1. Polymarket deferred to a later cross-venue feature.

## Consequences
- One integration to build and maintain.
- Kalshi rate-limits aggressively (429 after ~4 rapid calls), which forces ADR-003.
- Props arrive as *ladders* of binary markets (20+/25+/30+), not over/unders, which forces ADR-002.
