<!--
Title: <type>(<scope>): <what changed>, or <service>: <journey> <what a person gets> (<steps>).
A gate-file PR (GATE_PATHS in tooling/scripts/gate-file-guard.mjs) needs a ci: or gate: title.
Rules: AGENTS.md.
-->

## What changed and why

## Proof

<!-- Commands you ran and what you saw: the checks CI runs, the journey steps in the
     running app (local stack or a journeys run on this exact head), the code review's
     findings and your answers. Name anything you could not run, and why. -->

## Left or replaced

<!-- The journey's steps this PR doesn't finish, and anything it replaces. "None" if so. -->

## How to revert

<!-- Usually "revert this squash commit". Say so when it isn't enough: a migration,
     an event already published, state written elsewhere. -->

## Risk

<!-- What could break, for whom, and how you would notice. "None" only for docs. -->

## Money paths

<!-- Delete this section if the PR moves no value. -->

- [ ] Value moves only through `packages/ledger-client` recipes, each with an invariant test
- [ ] Failure branches tested: insufficient funds, retry, partial, cancel
- [ ] Idempotency keys are business keys, not `randomUUID()`
- [ ] Answered: _if this crashes exactly here, whose funds are stranded?_
