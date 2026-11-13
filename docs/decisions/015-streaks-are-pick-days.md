# ADR-015: A streak is consecutive card-days with a pick

**Status:** Accepted · **Date:** 2026-11-13

## Context
Units' 100+ day streaks were a proven retention lever. "Streak" can mean days opened, days picked, or picks won; each drives different behavior.

## Options considered
- Days opened (too easy; rewards nothing meaningful)
- Consecutive winning picks (punishing; variance ends streaks)
- Consecutive days with at least one pick

## Decision
A streak is **consecutive slate days with cards on which the user made at least one pick.** Days with no cards (no games) don't break a streak.

## Consequences
- Rewards the behavior we want: engaging with a market daily, not just opening.
- Computable from `picks` + `cards`; no new tracking needed.
- Built in v2 (with the gamification layer); the definition is fixed now so data is right from day one.
