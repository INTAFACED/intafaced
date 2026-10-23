# Claim trade.otc (MaintainedBook mid)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session  
**tracker:** `trade.otc` (stays **wip** — §8 numbers and maker-routing recipe still owner)  
**owner session:** Denon · Grok residual for Nitro  
**class:** N (no money movement; mid withhold only)  
**branch:** `feat/otc-mid-maintained-book`  
**scope:** `services/svc-trade/src/otc/venue-mid-source.ts` + boot wire in `index.ts`

When `TRADE_OTC_MID_FROM_VENUE` and `TRADE_VENUE_MARK_STREAM` are on, OTC mids use the same `MaintainedVenueBookPort` as futures marks / MM seed. Desynced or missing observedAt → null. Stream off keeps snapshot poll. Never invents §8 spreads/stake/maxMidAgeSeconds.

## Leverage

In-repo `MaintainedBook` + existing public venue adapter (`#1812` snapshot OTC mid, `#1815`/`#1817` stream port). No second book, no invented mid.

## Non-goals

- Owner §8 desk-law numbers
- `socket.otc-maker-routing` ledger recipe
- Icebergs / `svc-execution`
- Dual-edit `#1807` venue-adapter OKX barrel
