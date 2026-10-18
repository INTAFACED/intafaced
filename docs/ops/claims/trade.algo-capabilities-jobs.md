# Claim trade.algo (capabilities jobs honesty)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session
**tracker:** `trade.algo` (stays **ready** — jobs default OFF; icebergs out)
**branch:** `feat/algo-jobs-capabilities`
**class:** N

`GET /api/v1/capabilities` `notes.algo` publishes create vs jobs flags. Jobs default false. Icebergs `out`. Does not start the scheduler. Does not touch `index.ts` while #1831 is open — optional deps; omitted = shipped defaults.

## Leverage

Phase A IN: existing public capabilities + env law. Horizon `trade.algo` = LAW→IN after D-S-04 (sealed).

## Non-goals

- `TRADE_ALGO_JOBS_ENABLED` default ON
- Icebergs
- Dual-edit #1831 `index.ts`
