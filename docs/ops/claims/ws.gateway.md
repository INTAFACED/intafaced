# Claim — ws.gateway

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**owner:** nitro-agent
**branch:** feat/ws-private-orders-snapshot
**status:** pr-open
**proof:** https://github.com/Phantom-X-007/intafaced/pull/2216
**paths:** `services/svc-ws/src/private/**`
**updated:** 2026-08-16

Private `/private/stream` snapshot-then-delta for open orders (and positions when the trade read answers). No depth clone. No invented mids.
