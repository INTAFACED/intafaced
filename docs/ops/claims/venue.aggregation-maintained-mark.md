# venue.aggregation — maintained venue mark

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

Lane: feat/trade-venue-maintained-mark
Tracker: venue.aggregation (stays ready — trading half / live-network CI / M3)
Goal: stop polling snapshotBook on every futures mark tick when ops opts in
Done-bar: TRADE_VENUE_MARK_STREAM ON uses existing MaintainedBook; desynced/missing observedAt → null; default OFF; no invented mid; no dual-edit of Nitro venue PRs
