# Claim — trade.algo hydrate on mutate

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** pr-open
**proof:** https://github.com/Phantom-X-007/intafaced/pull/2215
**owner:** nitro-agent trade.algo hydrate-on-mutate
**class:** M
**branch:** feat/trade-algo-hydrate-on-mutate
**paths:** `services/svc-trade/src/algo/**` · `pauseAlgo` / `resumeAlgo` / `cancelAlgo` (+ helpers) in `services/svc-trade/src/spot/trade-service.ts`
**updated:** 2026-08-16

## Slice

Restart mutate: pause / resume / cancel load+hydrate from `algoStore` the same way `getAlgo` does, then `algoStore.save` so status/haltReason survive. cancel_incomplete resume still refused.

## Non-goals

- VWAP/POV invent
- `src/copy/**`
- compose / promise-falsify doors
- principal durability socket (still §13)
