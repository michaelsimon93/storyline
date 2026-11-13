# ADR-019: Personalization: shared core deck, signals from views and picks

**Status:** Accepted · **Date:** 2026-11-13

## Context
Personalization is layer 2 of the product ("the right fan"). Users will lean toward certain teams, players, stats and storyline types. We don't act on it yet, but the data must be right from day one, and the deck model must allow it without breaking social features.

## Options considered
- Fully personal decks (maximally relevant; breaks shared leaderboards, consensus, contests, tailing friends)
- One shared deck only (simplest; ignores the personalization layer)
- A shared core deck, with personalization via order and a few "for you" cards

## Decision
**Shared core deck + personalization at the edges.** Everyone sees the same core cards (`placement = 'core'`); later, ordering adapts to the user and 1–2 "for you" cards (`for_you_cards` config, 0 until built) come from a wider pool (`placement = 'pool'`).

**Signals captured now:**
- Every card records the **team at publish** (for player cards, the player's team that day), so picks keep crediting the right team after trades.
- `user_affinities` view: per user × dimension (team, player, stat, market kind, subject, storyline type): cards seen, picks, wins, pick rate. Built from `card_view` events *and* picks, so **skips are a signal**.
- Explicit preferences ("pick your teams") come with onboarding later, as a separate table.

## Consequences
- No new pipeline: the view is always current; materialize it if it gets slow.
- Requires the app to log `card_view` with `card_id` for every card shown.
- Worker-only for now; user-facing "your stats" would get its own scoped view.
