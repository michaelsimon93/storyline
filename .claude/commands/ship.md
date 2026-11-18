---
description: Open a PR and run it through review per CLAUDE.md's review-depth table, then hand off to Michael.
argument-hint: <Linear issue, e.g. STO-12>
---

Ship the current branch for: $ARGUMENTS

## 1. Open the PR
- Fill in `.github/pull_request_template.md`, especially **Risks & where to look**, which tells Michael what to read closely. The **Why** section carries the 3–5 line reasoning for each non-obvious choice.
- Pick the review row from CLAUDE.md → "Review depth". Docs-only PRs skip review: once CI is green, go straight to the handoff in step 4 and write the checklist and approval comment yourself.

## 2. Run the reviewers
Each reviewer runs in a fresh context and is never the agent that wrote the code. Pass each one:
- the base..head range and the PR description;
- the Linear issue's acceptance criteria **word for word**, plus any open `needs-decision` (reviewers can't read Linear);
- the spec sections and ADRs the issue links.

Order: `qa` (high-risk only) → `ui-reviewer` (`web/` only) → `eng-lead`. Tell `eng-lead` which row you picked and pass it the other reports.

**Post every report as a PR comment**, headed `**qa (agent) report**`, `**ui-reviewer (agent) report**` or `**eng-lead (agent) verdict: …** (round n)`.

## 3. Keep rounds short
- Only a **blocker** sends the PR back through `eng-lead`. Fix should-fix items in the same PR without another round; nits are optional.
- On a high-risk PR, re-run `qa` only if the fix touched money, security or concurrency code.

## 4. File follow-ups, then hand off
After the last fix commit, go through every non-blocker finding (`eng-lead`'s numbered follow-ups, plus `qa`/`ui-reviewer` items it didn't cover):
- Fixed → name the commit.
- Not fixed → **its own** Linear issue (one finding = one issue). Title says what to change; labels `follow-up` + one area; description links the PR comment and names `path:line`, the finding and the suggested fix; related to the PR's issue.

Post a PR comment headed `**Follow-ups**` listing every finding → commit or `STO-NN`. Then hand off to Michael with `eng-lead`'s handoff. Michael merges only once the follow-ups comment is posted.

**Your final message to Michael always ends with** the verify checklist and the approval comment in a code block, copied in full, never summarized. The approval comment is plain English (see `eng-lead.md`, handoff item 5).
