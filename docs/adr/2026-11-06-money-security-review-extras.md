# ADR: money, security and supply-chain PRs are sealed like every other PR until launch hardening

**Status:** accepted 2026-11-06. Owner decisions 179 and 189 (6 Nov 2026), recorded with the owner's records. The change that carries them out lands separately, after this record.
**Date:** 2026-11-06
**Area:** AGENTS.md "Check, then merge" 2; the merge seal's review rule (`tooling/ci/review-marker.mjs` `reviewReason`).

## Context

Until now, a PR that changed money code or security code needed two reviews that other PRs did not: `/security-review`, and the independent review (the `CI review` job, AGENTS.md item 8), which the merge seal waited for.

- **Money code:** `packages/ledger-client` and every package that depends on it directly.
- **Security code, as AGENTS.md named it:** `services/svc-edge`, `svc-ops`, `svc-protocol`, `svc-fix`, `packages/auth`, `packages/config`, `packages/db`, `.github/` and the lockfile.
- **The seal's own list** (`SECURITY_PATHS` in `tooling/ci/review-marker.mjs`) also covered `pnpm-workspace.yaml`, `.npmrc`, Dockerfiles, `.dockerignore`, compose files, `tsconfig.base.json` and `tooling/infra/`, the supply-chain paths.

No real money moves on the platform yet. The owner chose to stop these two extras now, and to do the deep money and security work in one phase before any real money moves.

## Decision

1. **What changes (owner decision 179).** A PR that changes money or security code no longer needs the extra `/security-review` or the independent review, as long as it changes no gate file or look baseline. The seal treats it like every other PR.
2. **Supply-chain paths too (owner decision 189).** The supply-chain paths listed above lose both extras as well. No path is added to `GATE_PATHS` in their place.
3. **What keeps its review.**
   - **Gate-file PRs:** a PR that changes a file in `GATE_PATHS` (`tooling/scripts/gate-file-guard.mjs`, unchanged) still gets `/security-review` and still needs the independent review.
   - **Look-baseline PRs:** a PR that changes `<package>/look-baselines/<room>/`, named on a `Baseline-change:` line, still needs the independent review.
   - **Unreadable PRs:** a PR whose changed files can't be read still fails the seal (fail closed).
4. **What stays as it is.**
   - Money law 2 to 5.
   - Every test, and the automated code review every PR gets.
   - "Check, then merge" 3: a red in a money or security package the PR changes always blocks the merge.
   - Fix-or-revert on `main`.
   - The required checks and the `main` ruleset.
   - "Check, then merge" 5: real funds, deploys and outside contact need the owner.
5. **Launch hardening.** A written phase must pass before any real money moves. It covers:
   - exploit hunting across every service;
   - large security reviews;
   - an outside audit;
   - a proof that every cent reconciles;
   - a bug bounty.

   Its scope never shrinks. The plan is kept with the owner's records, not in this repository.

## Exact scope of the change that carries this out

Only the following change. Nothing else in the merge rules moves.

- **`tooling/ci/review-marker.mjs` `reviewReason`:** returns a reason only for a gate file, a look baseline, or an empty or unreadable file list.
  - `SECURITY_PATHS`, the ledger-client dependency test (`packageRootOf`, `dependsOnLedgerClient`), the manifest reads and the default-branch read that fed them are removed.
  - `tooling/ci/journey-verdict.mjs` keeps its own `dependsOnLedgerClient` for the regression-issue money rule; `docs/runbooks/regression-issue-state.md` points there.
- **Tests:** the self-test cases and their planted-fault tests assert this rule. Every earlier case stays, with its new expected result.
- **Rule text:** AGENTS.md "Check, then merge" 2, and the places that restate it (`CONTRIBUTING.md`, `docs/agents/build-slice.md`, `.github/pull_request_template.md`, `tooling/ci/gates.mjs`, `docs/adr/2026-10-22-service-access-calls.md`), say the same.
- **Not changed:** `GATE_PATHS`, the CI review's brief (`tooling/ci/ci-review/REVIEW.md`) and its workflow.

## Consequences

- Money, security and supply-chain PRs merge on their checks alone. The deep review they lose moves to launch hardening, which comes before real money.
- The owner also approved one line for the CI review's brief so that a recorded decision isn't blocked as weakening (owner decision 188). That line lands separately and isn't part of this record's scope.
