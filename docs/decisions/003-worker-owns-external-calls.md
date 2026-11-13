# ADR-003: Only the worker calls Kalshi, ESPN and Claude

**Status:** Accepted · **Date:** 2026-11-13

## Context
Kalshi rate-limits hard. If every client called it directly, a busy night would break the app.

## Options considered
- Clients call Kalshi directly (simplest, breaks under load)
- Backend proxy per request (still N calls per N users)
- Always-on worker polls once and writes to the DB; clients read the DB

## Decision
An always-on worker polls every 30–60s with backoff, writes prices to Postgres, and Supabase Realtime pushes changes to open cards. The web app never talks to third parties.

## Consequences
- External call volume is independent of user count.
- Prices can be up to ~60s old, which is fine for pre-game picks. Picks are rejected if prices are >2 min stale.
- WebSocket feeds (which require a Kalshi key) were not needed.
