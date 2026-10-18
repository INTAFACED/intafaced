# Claim trade.copy (unique follow race)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session
**tracker:** `trade.copy` (stays **wip** — geo unpublished, session-key caps protocol)
**branch:** `feat/copy-follow-unique-race`
**class:** N

`copy_follows_follower_leader_idx` already exists. Concurrent follows that both pass the list check must become `trade.copy_already_following`, not a raw Postgres 23505.

## Leverage

Existing unique index + `CopyError`. No invented geo list.

## Non-goals

- `TRADE_COPY_JURISDICTION_LAW` content
- Dual-edit `#1822` / `#1823`
