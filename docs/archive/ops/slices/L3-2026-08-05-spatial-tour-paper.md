# L3 pack — spatial host-write · tournament freeze-snapshot · paper fill-refs

**Date:** 2026-08-05  
**Class:** N (academy pure helpers; no ledger, no pay, no partner paths)  
**Does NOT invent L1/L2.** No prizes, no IFC rates, no paper prices/fills invented — only trade-supplied opaque fill refs.

## Outcome

Operators and shell get: host can place/remove avatars & props on the 2D canvas; freeze captures an immutable ranked standings snapshot (no prize); paper drills can attach fill history only when trade hands opaque fill ids.

## Non-goals

- Prize pool / fund / payout (tournament Class M Stage-2 money)
- Ambassador IFC pay / revenue share
- Paper prices, balances, or simulated match engine inside academy
- Dual-edit `svc-pay` / open partner PR paths (#800 / #346)
- Shell Vue canvas product UI this slice (helpers only)

## Done bar

- [ ] `placeAvatar` / `removeAvatar` / `placeProp` / `removeProp` + tests
- [ ] `snapshotStandingsAtFreeze` pure + tests (rank frozen; no money fields)
- [ ] `attachPaperFillRef` / `listPaperFillRefs` — refuse missing fillId; no amount/price invent
- [ ] Slice pack + L3 law enrich merged
- [ ] `pnpm verify` green on academy paths (or scoped vitest + gates)

## Paths allowlist

```
docs/NITRO-L3-SLICE-FACTORY-LAW.md
docs/ops/slices/L3-2026-08-05-spatial-tour-paper.md
services/svc-academy/src/spatial/canvas.ts
services/svc-academy/src/spatial/canvas.test.ts
services/svc-academy/src/tournaments/season-lifecycle.ts
services/svc-academy/src/tournaments/season-lifecycle.test.ts
services/svc-academy/src/paper/workbook-loop.ts
services/svc-academy/src/paper/workbook-loop.test.ts
```

## Path-intersect vs open partner PRs

| Partner          | Paths                        | Intersect |
| ---------------- | ---------------------------- | --------- |
| #800 Denon pay   | `svc-pay`, ledger chargeback | **none**  |
| #346 Shehzad pay | `svc-pay`, features.mjs      | **none**  |

## Depends on

- L1/trk: `docs/ops/trk/academy.spatial.md` Stage 2 canvas
- L1/trk: `docs/ops/trk/academy.tournaments.md` Stage 1 ladder + Stage-2 lifecycle non-money
- L1/trk: `docs/ops/trk/academy.paper-trading.md` Stage 2 workbook loop
- Prior: #806 residency+tournament lifecycle · #814 paper catalog · #817 reconcile+residency withdraw

## Board-Delta

L3 Class N: spatial host place/remove · tournament freeze snapshot · paper fill-ref attach — no money invent.
