# Claim venue.aggregation (okx-spot on known-id list)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session
**tracker:** `venue.aggregation` (stays **ready** — trading half / live-network CI)
**branch:** `feat/venue-okx-spot-known-ids`
**class:** N

Factory landed in #1819. Boot warn, env comment, and README still listed only binance-spot / bybit-spot. Ops setting `TRADE_VENUE_MARK_VENUE=okx-spot` would work and then be told it was unknown.

## Leverage

Existing `OkxSpotMarketData` + `createVenueMarketDataAdapter('okx-spot')`. No trading half. No invented mid.
