<!--
Title: <type>(<scope>): <what changed>
   e.g. feat(svc-identity): rank recalculation on XP events
   A PR that changes a gate file (for example tooling/ci, .github/workflows,
   AGENTS.md, CLAUDE.md, .cursor/rules, tooling/agent-protocol, docs/agents) needs a ci: or gate: title.

One PR may carry one whole journey: every service, contracts and events it
needs. Ledger-client money recipes and the security services and packages go in
their own PR (AGENTS.md "Services and events" 1 and 2).
-->

## What changed

<!-- One or two sentences. The diff shows how; this says what. -->

## Why

<!-- The part a reviewer cannot reconstruct from the diff. What problem, whose
     decision. -->

## How I know it works

<!-- Tests added, what you ran, what you saw. "CI is green" is not an answer on
     a money path. Name any check you could not run. -->

## Risk

<!-- What could break, for whom, and how you would notice. "None" is an answer
     only for docs. -->

## How to revert

<!-- Usually "revert this squash commit". Say so when it is not enough: a
     migration, an event already published, state written elsewhere. -->

---

## Checks

- [ ] Ran on my machine before pushing: affected tests, typecheck, `pnpm exec prettier --check` on changed files
- [ ] Focused: one journey; any ledger-client money recipe or security service or package change is in its own PR
- [ ] No balance held outside the ledger; value moves only through `packages/ledger-client`
- [ ] Cross-service calls go through `packages/contracts` or `packages/events`
- [ ] Migrations have a `.down.sql` reversal
- [ ] Nothing "temporary", and nothing faked to look live: a blank setting refuses with a typed error and an honest empty state
- [ ] Merge: the required checks are green on this exact head; a money, security or gate-file change also needs the `CI review` job's PASS on it (it runs on every push; a comment counts for nothing)

## Money paths

<!-- Delete this section if the PR moves no value. -->

- [ ] Every recipe used has an invariant test
- [ ] Failure branches tested: insufficient funds, retry, partial, cancel
- [ ] Idempotency keys are business keys, not `randomUUID()`
- [ ] Answered: _if this crashes exactly here, whose funds are stranded?_
