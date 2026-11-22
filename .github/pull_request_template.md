<!--
Title: <type>(<scope>): <what changed>, or <service>: <journey> <what a person gets> (<steps>).
A gate-file PR (GATE_PATHS in tooling/scripts/gate-files.mjs) needs the CI review's PASS on its exact head.
Rules: AGENTS.md.
-->

## What changed and why

## Proof

<!-- Commands you ran and what you saw: the checks CI runs, the journey steps in the
     running app (local stack or a journeys run on this exact head), the code review's
     findings and your answers. Name anything you could not run, and why. -->

## Left or replaced

<!-- The journey's steps this PR doesn't finish, anything it replaces, and anything reverting
     this squash commit doesn't undo (a migration, an event already published, state written
     elsewhere). "None" if so. -->

## Money paths

<!-- Delete this section if the PR moves no value. -->

- [ ] Value moves only through `packages/ledger-client` recipes, each with an invariant test
- [ ] Failure branches tested: insufficient funds, retry, partial, cancel
- [ ] Idempotency keys are business keys, not `randomUUID()`
- [ ] Answered: _if this crashes exactly here, whose funds are stranded?_
