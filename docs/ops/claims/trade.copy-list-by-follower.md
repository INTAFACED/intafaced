# Claim trade.copy (follower-scoped follow list)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session  
**tracker:** `trade.copy` (stays **wip** — geo table unpublished, session-key caps protocol)  
**owner session:** Denon · Grok residual for Nitro  
**class:** N  
**branch:** `feat/copy-list-by-follower`  
**scope:** `services/svc-trade/src/copy/follow-store.ts` + `copy-service.ts` + tests

`listMyFollows` and already-following read `WHERE follower_id = …`. They do not load every follow in the table then filter in process.

## Leverage

Existing `copy_follows` table + `CopyFollowStore`. No invented geo list.

## Non-goals

- `TRADE_COPY_JURISDICTION_LAW` content
- Session-key caps (protocol)
- Dual-edit `#1818` / `#1819`
