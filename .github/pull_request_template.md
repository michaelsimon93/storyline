Fixes STO-<!-- issue number -->

## Why
<!-- The problem or decision this addresses. Link the ADR/spec section if there is one. -->

## What
<!-- One concern per PR. If this list needs "and", consider splitting. -->

## How it's tested
<!-- Which tests are new; which failed before the change. For concurrency/security claims, the test that proves it. -->

## Risks & where to look
<!-- The 1–3 spots a reviewer should read closely (file + what to check). Everything else can be skimmed. -->

## Checklist
- [ ] One concern; reviewable in ~10 minutes
- [ ] Tests added per CLAUDE.md; CI green
- [ ] No hard-coded tunables; no rule implemented twice
- [ ] New tables/functions locked down, with a "can't do it" test
- [ ] ADR/spec updated if a decision changed
- [ ] Review row (CLAUDE.md): docs-only / code / high-risk code
- [ ] `qa` run and findings answered (high-risk only)
- [ ] `ui-reviewer` run (`web/` only)
- [ ] `eng-lead` verdict: APPROVED (not needed for docs-only)
