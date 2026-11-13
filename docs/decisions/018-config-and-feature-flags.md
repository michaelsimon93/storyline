# ADR-018: Configurable settings and feature flags in the database

**Status:** Accepted · **Date:** 2026-11-13

## Context
Tunable values (deck size, price band, stake, grants, intervals) were scattered in code; the $5 stake was hard-coded inside `place_pick`, so changing it required a migration. We also want kill switches, self-first testing, and gradual rollouts, and possibly experiments later.

## Options considered
- Constants in code / env vars (a deploy per change, no history)
- A third-party flag/experiment service (PostHog, LaunchDarkly): powerful, another dependency, overkill for ~10 users
- Settings and flags as validated, audited tables in our own database

## Decision
**`app_config`**: typed, range-checked settings (validated by trigger on every write) with an `is_public` flag for the few the app may read. Money logic reads from it (`pick_stake_cents`, `signup_grant_cents`).

**`feature_flags`**: master switch, allowlist (always on for named users), and stable percentage rollout via a per-(flag, user) hash bucket. Raising the rollout only ever adds users. The app gets only public flags, evaluated for itself, via `my_flags()`; it logs a `flag_exposure` event when a flag changes what a user sees.

**`config_audit`**: every change to either table, with old and new values.

**No A/B experiment framework.** With ~10 users an experiment can't reach significance. Stable bucketing + exposure events are the 90% we'd need later; past a few hundred users, move to a dedicated tool rather than extend this one.

**No defaults in code.** The database is the single source and rejects bad writes, so the worker's typed loader fails loudly on anything missing or mistyped instead of falling back to a second copy of the value.

## Consequences
- Tuning is a SQL update (later: the admin dashboard), with history.
- New tunables must be added as `app_config` rows with a type and range; new risky features ship behind a flag.
- `hashtext` bucketing is stable within a Postgres major version; a major upgrade could reshuffle buckets (acceptable at this scale).
