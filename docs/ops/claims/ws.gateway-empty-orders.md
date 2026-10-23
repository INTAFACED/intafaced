# Claim ws.gateway-empty-orders

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** claimed
**owner:** cursor-denon
**slice:** private-door empty orders/positions blotter ≠ zero book
**tracker:** ws.gateway
**branch:** feat/ws-empty-orders-honesty
**updated:** 2026-08-14

## Goal

Empty orders/positions fan-out is absent, not a live zero blotter. Matching 404 / seed failure must not fabricate `{ orders: [] }` / `{ positions: [] }` as a priced live book of nothing. Unknown markets stay a typed close.

## Done-bar

Tests fail if an unseeded orders (or positions) stream looks like a live zero blotter; unknown markets stay a typed close; no invented fills; tracker stays ready (not mountain-done — residual streams remain).

## Leverage

Phase A IN: existing `services/svc-ws` private hubs. Horizon `ws.gateway` = IN.

## Do not touch

- #1841 svc-agents · #1848/#1851/#1853 svc-pay · #1850 svc-notify · #1852 svc-trade
- academy.certs lane
- Vue · Shehzad · invent fills · revert empty-depth (#1844) or empty-trades (#1849)
- tracker stays `ready` (mountain event not this slice)
