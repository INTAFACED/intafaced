# L3 pack — free TRK wave7

**Date:** 2026-08-05  
**Class:** N  
**Depends on:** tip #837 wave6 · L1 free-TRK mountains  
**Does NOT invent L1/L2:** no IFC pay / prizes / residual titles / rates / partner dual-edit.

## Outcome

- Ladder neighbors (above/self/below) without inventing missing place
- Season next-status + filter by status
- Ambassador frozen ids + freeze reason lookup
- Residency known cohorts + open queue depth
- Curriculum spine slug list + per-path count
- Mute channel list; fanout send-now channels
- Commission dry-run distinct beneficiaries (no payout)

## Non-goals

No pay, prizes, residual library invent, #800/#346 dual-edit.

## Done bar

Unit tests green for all helpers above. Class N pure paths only.

## Paths allowlist

- `services/svc-academy/src/tournaments/ladder.ts` + test
- `services/svc-academy/src/tournaments/season-lifecycle.ts` + test
- `services/svc-academy/src/ambassadors/programme.ts` + test
- `services/svc-academy/src/ambassadors/residency.ts` + test
- `services/svc-academy/src/curriculum/catalog.ts` + test
- `services/svc-notify/src/preferences/mute.ts` + test
- `services/svc-notify/src/preferences/combined.ts` + test
- `services/svc-identity/src/affiliates/commission.ts` + test
- `docs/ops/slices/L3-2026-08-05-free-trk-wave7.md`

## Board-Delta

L3 Class N free-TRK wave7: neighbors · season next/filter · frozen board · residency queue · curriculum spine · mute list · send-now · beneficiaries.
