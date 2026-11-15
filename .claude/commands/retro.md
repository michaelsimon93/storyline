---
description: Milestone retro on how the agent team built it. Proposes changes to CLAUDE.md, the agents, the PR template and how acceptance criteria are written; Michael decides.
argument-hint: <milestone or date range, e.g. "v1" or "since 2026-11-01">
---

Run a retro on how Storyline's agents built the work in: $ARGUMENTS

The question isn't "what did we ship" but "where did the process fail, and what change would have prevented it". Be specific and evidence-based; no praise padding.

## Gather
- The merged PRs in the range (`git log --merges`, and the PR descriptions and comments if `gh` works).
- Each PR's Linear issue and its acceptance criteria.
- The agent reports posted as PR comments (headed `qa (agent)`, `ui-reviewer (agent)`, `eng-lead (agent)`).
- Fix-up commits after review, reverted commits, and ADRs that were superseded in the range.

## Look for
1. **Spec → build misses:** where the build didn't match the issue or spec. Was the spec unclear, missing a criterion, or ignored?
2. **Sent back:** PRs that got CHANGES REQUESTED. What was the most common reason?
3. **Escapes:** bugs found after merge. Which reviewer should have caught them, and what check was missing?
4. **Reversed decisions:** what changed and what information would have changed it earlier.
5. **Agent value:** for `qa`, `eng-lead` and `ui-reviewer`, did each one change at least one decision in the range? An agent that didn't is a candidate to cut or merge.
6. **Friction:** steps Michael repeated by hand or that slowed merges.

## Output
1. **What happened**: 3–5 lines with numbers (PRs merged, sent back, escapes).
2. **Findings**: each with the evidence (PR/issue links) and the root cause.
3. **Proposed changes**: at most 5, each a concrete edit to `CLAUDE.md`, an agent in `.claude/agents/`, the PR template, or how acceptance criteria are written (the blocks in `docs/spec.md` and in Linear issues), with the exact wording. Rank by impact.
4. **Agents to cut or merge**, if any, with the reason.

Don't make the changes. Michael picks which to adopt, and each one ships as its own PR.
