# ADR-022: Two review roles; the eng lead approves, Michael merges

**Status:** Accepted · **Date:** 2026-11-15

## Context
Storyline is built by Claude Code agents and directed by one person. Review agents already existed (`reviewer`, `test-adversary`, `ui-reviewer`), but each only advised: Michael read every report and made the call himself. Nothing owned the verdict, nothing checked a PR against its issue's acceptance criteria, and nothing looked back at whether the process was working.

We considered adding more roles (head of eng, head of design) as standing agents. Most of that work was already covered, and more reviewers means more reports to read, not better decisions.

## Options considered
- **Keep advisory reviewers; Michael decides on every PR.** Simple, but he triages every finding, including on trivial PRs.
- **A review lead approves, Michael merges everything.** One verdict to read, and he still sees every change.
- **Split merge rights by risk:** the review lead merges low-risk PRs (copy, styling, tests, docs) and Michael merges anything touching money, schema, RLS or the worker. Less of a bottleneck, but he reads less of the code, and v1 is almost all high-risk paths.

## Decision
Two review roles, modeled on a real team:
- **`qa`** (was `test-adversary`): proves the PR does what its issue asked, by mapping each acceptance criterion to a test, checking for regressions, and trying to break it.
- **`eng-lead`** (was `reviewer`): the required approver. Reviews correctness and security, reads QA's report, and gives one verdict. On approval it hands Michael a plain-language summary, one concept worth understanding, any product calls, and a ready-to-paste approval comment.
- **`ui-reviewer`** stays as a specialist for `web/` PRs.

**Michael merges every PR.** No agent merges. A `/retro` command runs at each milestone and proposes process changes; Michael decides which to adopt.

## Consequences
- Michael reads one handoff per PR instead of two or three reports, and every merge is a deliberate human sign-off.
- The handoff's "worth understanding" line keeps him able to defend each decision without the agent in the room.
- GitHub doesn't allow approving your own PR, and the agents push as Michael, so `eng-lead`'s approval is a PR comment, not a GitHub review. A bot account would fix this if we ever need branch protection on approvals.
- Revisit at the end of v1: if the core loop is stable, move to merge rights split by risk. If `/retro` shows an agent changed no decisions in a milestone, cut or merge it.

## Amendment (2026-11-15): review depth matches risk
Running `qa` and `eng-lead` on every PR cost more than it caught: a two-line docs change went through two review rounds, and three days of work went mostly to process. The roles stay the same; what changes is when they run. Docs-only PRs get no agent review, ordinary code gets `eng-lead`, and only high-risk code (money, security, concurrency) gets `qa` first. Only blockers trigger a re-review. Michael still merges every PR. The table lives in `CLAUDE.md`.
