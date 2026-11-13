# ADR-005: ESPN (undocumented) for tip-off times, stats and context

**Status:** Accepted · **Date:** 2026-11-13

## Context
Kalshi provides no tip-off time (`occurrence_datetime` is roughly game *end*). Blurbs need game logs, splits, injuries and news.

## Options considered
- Paid stats provider (stable, costs money)
- ESPN's public-but-undocumented site API (free, may change)
- NBA CDN (returned 403)

## Decision
ESPN for v1. Accepted risk for a side project. The worker validates response shapes and logs/alerts on breakage.

## Consequences
- Requires Kalshi↔ESPN player matching (name + team), persisted once.
- Team abbreviations differ (NY/NYK, GS/GSW…) → mapping table.
- ESPN is also one of Kalshi's own settlement sources, so the data agrees.
