# L3 pack — notify digest cadence residual

**Date:** 2026-08-05  
**Class:** N  
**Does NOT invent L1/L2.** Critical never digests; no Class X SMS/email vendor law.

## Outcome

Users can set digest cadence (`off` / `hourly` / `daily`) for non-critical traffic; margin/safety critical still sends immediately.

## Non-goals

- Gateway credential purchase / Class X content
- Claiming digest flush = user-read
- Muting critical (already refused in mute law)

## Done bar

- [x] Pure digest prefs + flush window helpers + tests
- [ ] Path-intersect none vs partner pay PRs
- [ ] Green CI merge

## Paths allowlist

```
docs/ops/slices/L3-2026-08-05-notify-digest.md
services/svc-notify/src/preferences/digest.ts
services/svc-notify/src/preferences/digest.test.ts
```

## Depends on

- L1/trk `ops.notifications` residual digest note
- Prior #813 required-channels · mute Stage-1 on tip

## Board-Delta

L3 Class N: notify digest cadence residual (critical never digests).
