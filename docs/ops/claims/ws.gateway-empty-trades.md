# Claim ws.gateway-empty-trades

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** claimed
**owner:** cursor-denon
**slice:** public-door empty trades tape ≠ zero print
**tracker:** ws.gateway
**branch:** feat/ws-empty-trades-honesty
**updated:** 2026-08-14

## Goal

Empty trades tape is absent, not a live zero print. Matching 404 / seed failure must not fabricate `{ trades: [] }` as a priced empty market. Unknown markets stay a typed close.

## Done-bar

Tests fail if an empty/unseeded trades stream looks like a live zero tape; no invented prints/mids; no Vue; tracker stays ready (not mountain-done — residual streams remain).

## Leverage

Phase A IN: existing `services/svc-ws` trades hub. Horizon `ws.gateway` = IN.

## Do not touch

- #1841 svc-agents · #1845 svc-academy
- svc-pay KYB lane · svc-trade algo lane
- Vue · Shehzad · invent prints/mids · revert empty-depth (#1844)
- tracker stays `ready` (mountain event not this slice)
