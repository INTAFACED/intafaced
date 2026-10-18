# Claim ops.portfolio

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** pr-open
**owner:** ZenYoda3
**started:** 2026-08-16
**branch:** feat/ops-portfolio-ledger-view
**pr:** https://github.com/Phantom-X-007/intafaced/pull/2218
**title:** Portfolio Stage-1 — custodial ledger view, indexer named-absent
**slice:** Stage-1

Custodial holdings as a read view of existing `ledger.balances`. Indexer half is `{ status: 'absent', reason: 'indexer.readmodels_unbuilt' }`. No second money book. No post. No compose restamp. No promise-falsify door hunt.

Consumer: `services/svc-ledger` (`createLedgerRouter` `portfolio` procedure + `POST /trpc/portfolio` S2S). View lives in `packages/portfolio-view`.
