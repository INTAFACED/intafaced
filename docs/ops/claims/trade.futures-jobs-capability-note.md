# Claim trade.futures (capabilities advertise jobs default OFF)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session
**tracker:** `trade.futures` (stays **wip** — no mountain-done; D3 ladder still uninvented)
**owner session:** Denon agent
**class:** N
**branch:** `feat/futures-jobs-capability-note`
**scope:** `GET /api/v1/capabilities` notes.futures + index env passthrough

Bots must not infer funding/liq ticks from a listed perp. `jobsEnabled` is true only when the host passes `TRADE_FUTURES_JOBS_ENABLED`; `jobsDefault` is always false.

## Leverage

Phase A IN: existing capabilities note (algo pattern) + `TRADE_FUTURES_JOBS_ENABLED`. Horizon `trade.futures` = IN after Denon law. Does not start jobs or invent rates.

## Non-goals

- Flip `TRADE_FUTURES_JOBS_ENABLED` on
- Invent `TRADE_FUTURES_FUNDING_MAX_ABS_RATE` / market ids
- Dual-edit `#1863` private-rest, `#1851` pay, Shehzad chain
