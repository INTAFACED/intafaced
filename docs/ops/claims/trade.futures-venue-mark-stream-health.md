# Claim trade.futures (venue mark stream advertised default OFF)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** LIVE this session
**tracker:** `trade.futures` (stays **wip** — Connect stream still default OFF; no mountain-done)
**owner session:** Denon agent
**class:** N
**branch:** `feat/venue-mark-stream-health`
**scope:** `GET /health` `venueLatency.streamEnabled` + `streamDefault: false`

REST round-trip grade is not a WS-stream grade. `TRADE_VENUE_MARK_STREAM` stays default OFF and is visible on `/health`.

## Leverage

Phase A IN: existing `presentVenueLatencyHealth` + `TRADE_VENUE_MARK_STREAM` + Connect fabric grade. Horizon `trade.futures` / `venue.aggregation` = IN.

## Non-goals

- Flip stream ON
- Invent WS p95 / letter from REST samples
- Dual-edit `#1866` public-rest listing, Shehzad chain
