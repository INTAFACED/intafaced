# Claim trade.futures (listed perp is not orderable by default)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session
**tracker:** `trade.futures` (stays **wip** — no mountain-done; D3 numbers still unset)
**owner session:** Denon agent
**class:** N
**branch:** `feat/futures-listing-orderable`
**scope:** `GET /api/v1/markets` `orderable` + capabilities `notes.futures.orderableEnabled`

An `active` listed swap with `TRADE_FUTURES_ENABLED` off is still listed and still `orderable: false`. Options stay unorderable. Next funding / index stay unpublished; ladder numbers stay `d3_unset`.

## Leverage

Phase A IN: existing `presentCcxtMarket` + `TRADE_FUTURES_ENABLED` + capabilities note from #1864. Horizon `trade.futures` = IN after Denon law.

## Non-goals

- Flip `TRADE_FUTURES_ENABLED` on
- Invent D3 rungs / nextFunding from the 8h interval
- Dual-edit `#1861` svc-agents, Shehzad chain
