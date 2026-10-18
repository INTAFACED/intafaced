# Claim trade.futures (listOpen does not invent marks)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session
**tracker:** `trade.futures` (stays **wip**)
**owner session:** Denon agent
**class:** N
**branch:** `feat/futures-list-open-no-invent-mark`
**scope:** `PositionService.listOpen` source pin

`GET /positions` lists residual margin and entry. Mark stays null on the list door. Close may attach extras. Never invent `0`.

## Leverage

Phase A IN: existing `presentPosition(row)` with `markPrice: extras?.markPrice ?? null`.

## Non-goals

- Invent D3 maintenance on the list
- Dual-edit #1868 capabilities
