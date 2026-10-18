# Claim TRK-academy.ambassadors — D26-P1-C2 rate authority

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**status:** wip
**owner:** Phantom-X-007 (Denon)
**branch:** feat/academy-ambassadors-rate-authority
**updated:** 2026-08-12

## Scope

Residencies / IFC pay under rate authority (P0):

- Owner-published IFC + revenue-share law via env JSON (refuse invent)
- Dry-run quote product path when authority present
- Accepted residency gate for residency IFC quotes
- Live settlement remains Class M refuse until ledger recipe (no recipes in ambassadors)

## Paths

- `services/svc-academy/src/ambassadors/ifc-pay-rate-law.ts`
- `services/svc-academy/src/ambassadors/ifc-pay.ts`
- `services/svc-academy/src/router.ts` (pay wire)
- `services/svc-academy/src/env.ts` / `index.ts`

## Non-goals

- No FE
- No invented IFC rates / fee %
- No ledger recipe invent
- Tracker stays not-done until seasons + real settlement (or product-cut)
