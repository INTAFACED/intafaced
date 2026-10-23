# Claim connect.latency-unscored-zero-weight

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**id:** connect.latency-unscored-zero-weight  
**tracker:** `connect.latency-grading`  
**branch:** `feat/connect-unscored-zero-weight`  
**owner:** Phantom-X-007 (Denon)  
**status:** pr-open  
**pr:** https://github.com/Phantom-X-007/intafaced/pull/1843  
**updated:** 2026-08-14

## Done bar

An adapter with no live latency score gets **zero** routing weight (D26-P1-X2). Unscored ≠ low score.

## What this claim ships

- Score feed: `routingWeightFromGrade` is 0 unless `isGraded` **and** `p95Ms` is a measured number.
- Public door: `measuredLatencyMs` returns `null` for missing measurement — never a sentinel, never 0ms, never an estimate.
- Cost model: `scoreSorCost` / `sorCostTermsFromAdapter` refuse never-run adapters (weight 0).
- Tests fail if a factory adapter that has never run still receives routing weight.

## Out of scope (honest)

- No new venue. Existing Binance / Bybit / OKX public adapters only.
- Tracker row stays `ready` (consumer / thresholds / WS grading residuals remain).
- `VenueHealth.latencyMs` stays a `number` (shared field); the score-feed door is what must not treat absence as a score.
