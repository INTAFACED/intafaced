# Claim trade.algo (place-grant wording covers VWAP/POV)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session
**tracker:** `trade.algo` (stays **ready** — jobs default OFF, icebergs out)
**owner session:** Denon · Grok residual for Nitro
**class:** N
**branch:** `feat/algo-place-grant-kind-honest`
**scope:** `services/svc-trade/src/algo/durable-principal.ts` + hydrate comments

`createTwap` is the public door for TWAP / VWAP / POV. Place-grant refusals must not say “TWAP” when the schedule is another kind.

## Leverage

Existing `captureAlgoPlaceGrant` / `principalFromAlgoGrant`. No iceberg, no invented fills.

## Non-goals

- Enabling `TRADE_ALGO_JOBS_ENABLED` in production
- Iceberg hidden orders
- Dual-edit `#1819` / `#1820`
