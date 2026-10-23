# Claim trade.algo (live env → capabilities)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session
**tracker:** `trade.algo` (stays **ready** — jobs default OFF; icebergs out)
**branch:** `feat/algo-jobs-env-passthrough`
**class:** N

`registerPublicRest` now receives `TRADE_ALGO_ENABLED` / `TRADE_ALGO_JOBS_ENABLED` so `GET /api/v1/capabilities` `notes.algo` matches the live host. Does not start the scheduler. Does not flip jobs default ON.

## Leverage

Phase A IN: existing `presentAlgoCapabilityNote` + env. Horizon `trade.algo` = LAW→IN after D-S-04.

## Non-goals

- `TRADE_ALGO_JOBS_ENABLED` default ON
- Icebergs
- Vue
