# ADR-007: Supabase anonymous auth instead of a homemade cookie ID

**Status:** Accepted · **Date:** 2026-11-13

## Context
v1 has no login, but needs a stable identity per device, and v2 will add real accounts.

## Options considered
- Random ID in a cookie/localStorage
- Supabase anonymous auth

## Decision
Supabase anonymous users. The user only enters a display name.

## Consequences
- Row-level security works ("you can only read your picks"); a homemade ID can't be verified by the database.
- Anonymous accounts upgrade in place to real accounts, so picks and balances carry over.
- Accepted: clearing browser data creates a new user; two devices = two accounts until login.
