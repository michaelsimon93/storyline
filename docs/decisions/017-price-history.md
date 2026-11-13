# ADR-017: Keep price history as snapshots

**Status:** Accepted · **Date:** 2026-11-13

## Context
Prices were overwritten on every update, discarding line movement, one of the best possible "why" sources ("38% → 61% since the injury news"), and the data to check whether curated markets are the ones that move.

## Options considered
- Overwrite only (no history)
- Log every poll (high volume, mostly duplicates)
- Snapshot on change, plus a heartbeat every 15 minutes

## Decision
`market_price_snapshots`, written by `snapshot_prices()`: a row when a price changes, or when the last snapshot is older than 15 minutes; settled markets are skipped. The rule lives in SQL so ingest and the poller share it.

## Consequences
- A few thousand small rows per day, bounded by price changes.
- Enables line-movement storylines and curation analysis.
- Users can read history (for movement on cards); only the worker writes it.
