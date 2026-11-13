# ADR-014: The story chooses the line; every claim is grounded

**Status:** Accepted · **Date:** 2026-11-13

## Context
ADR-002 picked each card's line by price alone (closest to 50/50), then wrote a story about it. That can mismatch: a story about "30 points in 3 straight" paired with a 27+ line. Separately, the blurb check ("contains a number from the context") was weak: a wrong claim passes if the number appears anywhere.

## Options considered
- Keep most-even line, story written afterward
- Story first; pick the ladder line that fits the story, within a price band
- Blurb validation by "contains a number"
- Every claim must cite a specific fact we supplied

## Decision
**The story chooses the line.** Curation picks the storyline first, then the strike on that player's ladder that best fits it, constrained to a **price band (default 25–75%)** so cards stay competitive. Supersedes the line-selection rule in ADR-002 (the line still locks at publish; prices stay live).

**Every claim is grounded.** The model gets a list of facts, each with an ID: **stats** (game logs, splits, streaks) *and* **news** (back from suspension, return from injury, just traded). It returns the blurb plus the fact IDs each claim relies on; a validator rejects any claim without a valid fact. A blurb doesn't need a number: "Back from his 5-game suspension, facing the team that suspended him" is a valid card.

## Consequences
- Cards read coherently: the story and the question match.
- The fact check becomes structural, not a string match, and every card is auditable to its sources.
- Curation needs a news/context source beyond stats (ESPN news + injuries to start).
- `cards.blurb_facts` stores the cited facts.
