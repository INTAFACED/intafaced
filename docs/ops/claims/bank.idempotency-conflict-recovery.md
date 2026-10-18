# Claim bank idempotency-conflict recovery

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session
**owner:** Nitro Codex
**branch:** `fix-bank-idempotency-conflict-recovery`
**class:** M
**scope:** `services/svc-bank` idempotency-conflict behavior and tests only
**done bar:** Reused earn position or loan ids are accepted only for the same owner and the same money terms; mismatches refuse without moving the second caller's value or returning another user's result.

## Leverage

Phase A IN: existing `svc-bank`, `packages/ledger-client`, and stranded tested commits `67a32e91` + `e42ddc2b`. Main already contains their first recovery via #1194, so this lane audits and closes only gaps against current semantics instead of rebuilding it.

## Do not touch

`svc-trade`, `svc-execution`, `packages/venue-adapter`, protocol, chain, DEX, frontend, PRs #2476/#2480, tracker state, balances, rates, custody, jurisdiction, or ledger recipes.
