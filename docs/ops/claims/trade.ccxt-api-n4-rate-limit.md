# Claim trade.ccxt-api (N4 rate-limit honesty)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session
**tracker:** `trade.ccxt-api` (already **done** — this is the N4 residual)
**branch:** `feat/ccxt-n4-rate-limit-honest`
**class:** N

Publish the rate limit bots actually hit: edge **300/min**, not the dead 1200/600/20 contract. Capabilities returns that object. No second limiter invented.

## Leverage

Existing `RATE_LIMITS` + `GET /api/v1/capabilities` + `EDGE_RATE_LIMIT_MAX`.

## Non-goals

- Dual-edit #1826 copy geo
- Inventing a separate order/weight governor
- Paper-list exclude (N3)
