# ADR: one pull request may carry one whole journey

**Status:** accepted 2026-11-06.
**Date:** 2026-11-06
**Source:** owner decision 2026-11-06.
**Area:** how work is split into pull requests (AGENTS.md "Services and events" items 1 and 2).
**Amends:** owner decisions 2026-10-20 and 2026-10-22 (one service per PR).

## Decision

1. One pull request may carry one whole journey: it may touch every service, `packages/contracts` and `packages/events` that the journey needs, in one PR, instead of one service per PR in order.
2. Money recipes in `packages/ledger-client`, and the security services and packages (`services/svc-edge`, `svc-ops`, `svc-protocol`, `svc-fix`, `packages/auth`, `packages/config`, `packages/db`), still go in their own PR, reviewed as AGENTS.md "Check, then merge" says.

## What does not change

- Two open PRs may touch one service when their files do not overlap; if another open PR touches the same files, take a different part. `Main trust` stays the safety net: a breaking commit is reverted first.
- Services never read each other's tables, and publish only subjects declared in `packages/events/src/catalog.ts` (AGENTS.md "Services and events" item 3).
- Review levels, required checks and the merge seal are untouched by this decision.

## Undo

Restore the earlier wording of AGENTS.md "Services and events" items 1 and 2.
