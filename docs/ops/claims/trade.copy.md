# Claim trade.copy

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

- **Lane:** `trade.copy`
- **Tracker:** `trade.copy`
- **Branch:** `feat/trade-copy-place-mirror`
- **Scope:** `services/svc-trade/src/copy/**` + router `copy.placeMirror` only
- **Done bar:** `copy.placeMirror` places the planned mirror via spot `placeOrder` only when `TRADE_COPY_PLACE_MIRROR` is on; flag/blank §8 refuse by name; fillId idempotent; no live place from a paper leader fill; planned qty/price envelope (no invented mids)
- **Do not touch:** futures/otc/algo/mm/ccxt · invent profit-share · Denon open trade PR paths
- **Class:** M (spot place path)
- **status:** pr-open
- **proof:** https://github.com/Phantom-X-007/intafaced/pull/2219
- **owner:** nitro-agent
- **updated:** 2026-08-16
