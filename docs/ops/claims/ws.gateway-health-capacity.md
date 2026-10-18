# Claim ws.gateway (health capacity)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session
**tracker:** `ws.gateway` (stays **ready** — residual streams/ops; no invented process-wide cap)
**branch:** `feat/ws-health-capacity`
**class:** N

`GET /health` publishes per-hub `capacity` (connections vs the same max attach already enforces, plus private max-per-user). Occupancy does not 503. Summing the three ceilings is not a process-wide limit.

## Leverage

Phase A IN: existing svc-ws hubs + `/health`. Horizon `ws.gateway` = IN.

## Non-goals

- Process-wide connection cap
- Rate limiting on the socket
- Inventing aggressor side on the tape
- Dual-edit notify / trade open paths
