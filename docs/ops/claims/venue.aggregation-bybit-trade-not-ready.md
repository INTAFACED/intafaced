# Claim venue.aggregation (Bybit trade half honesty)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** wip  
**tracker:** `venue.aggregation` (stays **ready** — live-network CI + M3 still open)  
**owner session:** Nitro agent  
**class:** N  
**branch:** `feat/venue-bybit-trade-not-ready`  
**scope:** `packages/venue-adapter/src/fabric/venues/**` only

Bybit (and OKX, already on tip) trading/account halves throw typed `not_ready` / `VenueUnavailableError`. Public MD unchanged. No third commercial venue. No invented mid. No live credentials.

Hard path wall vs #2044: do not touch `router.ts`, `venue-adapter.test.ts`, `LIVE-LANES.md`, `TRACKER.md`, `features.mjs`.

## Leverage

Existing `@intafaced/venue-contracts` + binance-spot `NOT_BUILT` trade/account pattern. No ccxt.

## Non-goals

- Live-network CI (residual 4)
- M3 futures risk truth
- Venue Vault / signed REST
- Third commercial venue
