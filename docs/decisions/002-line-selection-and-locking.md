# ADR-002: Most-even line, locked at publish; prices stay live

**Status:** Line-selection rule superseded by [ADR-014](014-story-chooses-the-line.md); locking still applies · **Date:** 2026-11-13

## Context
Each player/stat has a ladder of Yes/No markets. A card shows one line. The product should feel like a prediction market, not a sportsbook.

## Options considered
- Show the full ladder (more choice, harder to read on a card)
- Show the line closest to 50/50
- Re-pick the most-even line as prices move (always current, but the line flips and blurbs go stale)

## Decision
Show the strike where Yes and No asks are closest to even, **locked at publish** so everyone picks the same line. Prices update live. Buttons read Yes/No with percentages, plus a payout line, never over/under.

## Consequences
- Every card is roughly a coin flip (~2x payout). Watch pick rates; a daily long-shot card is the first experiment if engagement is flat.
- The full ladder is stored anyway, for adjustable lines later.
