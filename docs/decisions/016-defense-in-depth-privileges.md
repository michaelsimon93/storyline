# ADR-016: Explicit privileges, tested against real Supabase

**Status:** Accepted · **Date:** 2026-11-13

## Context
Supabase grants ALL on every table, function and sequence in `public` to `anon` and `authenticated` by default. Our tests ran on plain Postgres with stand-in auth, so they couldn't see this. Mirroring Supabase's defaults locally made **10 security tests fail**: users could run `settle_market`, signed-out visitors could call `place_pick`, and RLS-blocked updates "succeeded" silently on zero rows.

## Options considered
- Rely on RLS alone
- Revoke everything, grant back exactly what's needed, and test on real Supabase

## Decision
Revoke all default privileges from `anon`/`authenticated`, then grant back the minimum: read-only selects, `insert` on `events`, `update(display_name)` on `profiles`, and `execute` on `place_pick`, `create_profile`, `storyline_today`. Worker-only functions are granted to `service_role` only. CI runs the scenario tests twice: on plain Postgres (fast) and on a **real local Supabase stack** (truth).

## Consequences
- Two layers (privileges + RLS) instead of one; "can't" tests now fail loudly with *permission denied*.
- New tables/functions are locked by default and must be granted deliberately.
- The real-Supabase CI job is slower (~1–2 min) but catches drift between our stubs and production.
