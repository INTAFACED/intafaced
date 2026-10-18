# Claim venue.aggregation (OKX on svc-trade factory)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session  
**tracker:** `venue.aggregation` (stays **ready** — trading half, live-network CI still open)  
**owner session:** Denon · Grok residual for Nitro  
**class:** N  
**branch:** `feat/trade-venue-okx-factory`  
**scope:** `services/svc-trade/src/futures/mark-from-venue.ts` + tests only

`TRADE_VENUE_MARK_VENUE=okx-spot` now constructs `#1807`'s public `OkxSpotMarketData`. Unknown / near-miss ids still null. Never invents a mid.

Does not dual-edit `#1818` (`index.ts` / `env.ts` / `otc/**`). Boot warn string still lists binance/bybit until that PR lands.

## Leverage

In-repo `#1807` adapter + existing svc-trade factory switch. No ccxt, no second book.

## Non-goals

- Trading / account halves
- Live-network CI
- Dual-edit `#1818` OTC MaintainedBook wire
