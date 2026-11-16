# ADR-024: Sources are pluggable; curation finds stories first

**Status:** Accepted · **Date:** 2026-11-16

## Context
v1 reads markets and results from Kalshi (ADR-001), stats and news from ESPN (ADR-005), and uses
Claude to curate. Those are the v1 choices, not the architecture. Storyline should be able to
curate stories from more places (X, news, injury feeds) and list markets from more than one
venue, by adding sources rather than rewriting curation. ADR-021 already made the core tables
source-neutral; this ADR does the same for the code that feeds curation.

Separately, the spec's pipeline (§3) started from markets: list in-band lines, filter, attach
ESPN context, shortlist by liquidity. ADR-014 says the story chooses the line, but a
market-first pipeline still lets the market decide which players get a story at all. The
product question is "why should a fan care?", so curation should start there.

## Options considered
**Sources**
- **One interface per kind of source, in the worker (chosen).** `MarketSource`, `ContextSource`
  and `Curator`, each with one real implementation today. Small and readable; adding a source
  is a new module.
- **Sources registered in the database.** Providers, settings and weights in a table, loaded at
  runtime. No deploy to add or tune a source, but a framework built before a second source
  exists (ADR-021 rule 6).

**Order**
- **Markets first:** in-band lines → context → stories. Cheap, every candidate has a card, but
  the line drives selection and stories get written to fit it.
- **Stories first (chosen):** find the most interesting stories on the slate, then pick the
  market that fits each one. A story with no market is skipped for the next one.

## Decision
1. **Three kinds of source, one interface each** (`worker/src/sources/types.ts`):
   - `MarketSource`: lists markets, prices and results. v1: Kalshi.
   - `ContextSource`: returns **signals** about players, teams and games. v1: ESPN.
   - `Curator`: ranks stories and writes blurbs. v1: Claude.
   Only real providers get an implementation (ADR-021 rule 6 still holds: no plugin system).
2. **A signal is a fact with a source.** Each signal has an ID, source, kind (`stat`, `news`,
   `injury`, `buzz`), subject (our player, team or game ID, resolved through `external_ids`),
   a one-line summary, evidence (URL or quote, observed time) and `verified`. Signals are the
   facts ADR-014 talks about: blurbs cite signal IDs, and only `verified` signals can ground a
   claim. Unverified signals (e.g. social buzz) can inform ranking, never a stated fact.
3. **Context sources declare a stage.** `discover` sources are cheap enough to run over the whole
   slate (ESPN). `enrich` sources are costly and run only on the shortlist (e.g. a Grok/X search,
   later).
4. **Curation finds stories first.**
   1. Discover: run `discover` sources for every player on the slate.
   2. Story candidates: group signals into stories (player, angle, the stat it's about,
      supporting signals).
   3. Rank by "why should a fan care?"
   4. Match: walk the ranked list; for each story, find an open, in-band market on that stat
      that passes the filters. No market → skip it, log it as "no market", take the next story.
   5. Enrich the matched shortlist with `enrich` sources.
   6. Curate and write: the curator picks the final N and the strike that fits each story
      (ADR-014), citing signal IDs.
5. **Turning sources on and off** uses `feature_flags` (ADR-018), so a source can be disabled
   without a deploy. A new source ships behind its own flag.
6. **Failure rules.** A context source that fails is reported and skipped; curation runs on the
   rest. A market source failing stops the run (there's nothing to attach stories to).

## Consequences
- A new context source is a module plus a flag; curation doesn't change. A new market source is
  an adapter plus cross-reference rows (ADR-021).
- Every card traces back to the signals that produced it, stored per run.
- "No market" stories are logged each night. They show where market coverage is thin, which is
  the evidence for adding a market source.
- Discovery touches every player on the slate, not ~30 candidates, so ESPN call volume rises.
  ESPN's limits are unknown (undocumented API); measure it in STO-10.
- Supersedes the market-first steps 1–5 of spec §3 and the "~30 by liquidity" shortlist rule.
- Open: spec §2 says curation still runs on Kalshi alone if ESPN fails. With stories first, no
  ESPN means no stories. What to do then is Michael's call (tracked on STO-10).
- How stories are scored (rules in code, the model, or both) is decided in STO-10.
