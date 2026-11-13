# ADR-012: In-house analytics via an events table

**Status:** Accepted · **Date:** 2026-11-13

## Context
We need to see how users move through the product (opens, swipes, picks, tab switches) to judge curation quality.

## Options considered
- Third-party analytics (PostHog, etc.): dashboards for free, another tool
- An `events` table queried with SQL

## Decision
An append-only `events` table. Users can insert their own events and read none. Analysis is SQL.

## Consequences
- Zero extra services and full data ownership.
- No dashboards in v1; revisit if analysis outgrows SQL.
