# ADR: money and security PRs are sealed like every other PR until launch hardening

**Status:** accepted 2026-11-06 (owner decision 2026-11-06).
**Date:** 2026-11-06
**Area:** AGENTS.md "Check, then merge" 2; the merge seal's review rule (`tooling/ci/review-marker.mjs` `reviewReason`).

## Context

Until now, a PR that changed money code (`packages/ledger-client` and every package that depends on it directly) or security code needed two reviews that other PRs did not. AGENTS.md named security code as `services/svc-edge`, `svc-ops`, `svc-protocol`, `svc-fix`, `packages/auth`, `packages/config`, `packages/db`, `.github/` and the lockfile. The seal's own list (`SECURITY_PATHS` in `tooling/ci/review-marker.mjs`) also covered `packages/ledger-client`, `pnpm-workspace.yaml`, `.npmrc`, Dockerfiles, `.dockerignore`, compose files, `tsconfig.base.json` and `tooling/infra/`. It needed `/security-review`, and the seal waited for the independent review (the `CI review` job, AGENTS.md item 8). No real money moves on the platform yet. The owner chose to stop these two extras now and to do the deep money and security work in one phase before any real money moves.

## Decision

1. **What changes.** A PR that changes money or security code, and no gate file, supply-chain path or look baseline, no longer needs the extra `/security-review` or the independent review (item 8). The seal treats it like every other PR.
2. **What keeps its review.**
   - A gate-file PR (`GATE_PATHS` in `tooling/scripts/gate-file-guard.mjs`) still gets `/security-review` and still needs the independent review.
   - A supply-chain PR still gets `/security-review` and still needs the independent review. Supply-chain paths are `SUPPLY_CHAIN_PATHS` in `tooling/ci/review-marker.mjs`: `.github/` (workflows and actions), the lockfile, `pnpm-workspace.yaml`, `.npmrc`, Dockerfiles and `.dockerignore`, compose files, `tsconfig.base.json` and `tooling/infra/`.
   - A look-baseline PR (`<package>/look-baselines/<room>/`, named on a `Baseline-change:` line) still needs the independent review.
   - A PR whose changed files can't be read still fails the seal (fail closed).
3. **What stays as it is.**
   - Money law 2 to 5.
   - Every test, and the automated code review every PR gets.
   - "Check, then merge" 3: a red in a money or security package the PR changes always blocks the merge.
   - Fix-or-revert on `main`.
   - The required checks and the `main` ruleset.
   - "Check, then merge" 5: real funds, deploys and outside contact need the owner.
4. **Launch hardening.** A written phase must pass before any real money moves. It covers:
   - exploit hunting across every service;
   - large security reviews;
   - an outside audit;
   - a proof that every cent reconciles;
   - a bug bounty.

   Its scope never shrinks. The plan is kept with the owner's records, not in this repository.

## Consequences

- Money and security PRs merge on their checks alone. The deep review they lose moves to launch hardening, which comes before real money.
- The money and security paths, the ledger-client dependency test and the manifest reads are removed from `review-marker.mjs`, because the seal no longer uses them. The supply-chain entries of the old `SECURITY_PATHS` stay, as `SUPPLY_CHAIN_PATHS`. `tooling/ci/journey-verdict.mjs` keeps its own `dependsOnLedgerClient` for the regression-issue money rule.
