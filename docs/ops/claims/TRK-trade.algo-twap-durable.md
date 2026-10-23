# Claim — trade.algo TWAP durable schedule store

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Owner session:** grok trade-twap-durable  
**Paths:** `services/svc-trade/src/algo/**`, `services/svc-trade/src/spot/trade-service.ts`, `services/svc-trade/drizzle/0010_*`  
**status:** merged
**proof:** #1010 merged 2026-08-07 — durable TWAP parent schedule store (D-S-04 residual)
**updated:** 2026-08-07 (claim closed against merged main)
**Class:** M (algo child path already Class M; store is schedule-only)  
**Board-Delta:** Durable algo_parents table + hydrate on get/tickAll; parent still holds no fills.

VWAP/POV still OUT (ADR).

> Closed by the claim-board honesty pass. The code merged; the claim was never closed, so
> `swarm:freeze` kept reporting this mountain as owned by a session that no longer exists.
> Residual noted above (if any) is unchanged and still real — closing the claim closes the
> SLICE, not the mountain. Mountain state lives in `tooling/tracker/features.mjs`.
