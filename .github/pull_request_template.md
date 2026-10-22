<!--
Title: <type>(<scope>): <what changed>
   e.g. feat(svc-identity): rank recalculation on XP events
   A PR that changes a gate file (for example tooling/ci, .github/workflows,
   AGENTS.md, CLAUDE.md, .cursor/rules, tooling/agent-protocol) needs a ci: or gate: title.

Keep it small. One service per PR. If describing it needs the word "and", it is
two PRs. A slice is the exception: its contracts or events, one service and that
service's screen land as one PR.
-->

## What changed

<!-- One or two sentences. The diff shows how; this says what. -->

## Why

<!-- The part a reviewer cannot reconstruct from the diff. What problem, whose
     decision. -->

## How I know it works

<!-- Tests added, what you ran, what you saw. "CI is green" is not an answer on
     a money path. Name any check you could not run. -->

---

## Checks

- [ ] Ran on my machine before pushing: affected tests, typecheck, `pnpm exec prettier --check` on changed files
- [ ] Small and focused: one service (a slice may also carry its contracts or events and its screen)
- [ ] No balance held outside the ledger; value moves only through `packages/ledger-client`
- [ ] Cross-service calls go through `packages/contracts` or `packages/events`
- [ ] Migrations have a `.down.sql` reversal
- [ ] Nothing "temporary", and nothing faked to look live: a blank setting refuses with a typed error and an honest empty state
- [ ] Merge: the required checks are green on this exact head and an independent review passed it (`Independent review: PASS <40-character head sha>` as a PR comment; every PR needs one)

## Money paths

<!-- Delete this section if the PR moves no value. -->

- [ ] Every recipe used has an invariant test
- [ ] Failure branches tested: insufficient funds, retry, partial, cancel
- [ ] Idempotency keys are business keys, not `randomUUID()`
- [ ] Answered: _if this crashes exactly here, whose funds are stranded?_
