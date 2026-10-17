# L3 pack — support KB Stage-2 spine

**Class:** N  
**Does NOT invent L1/L2.** No refund recipes, no vendor product names, no rates.

## Outcome

`listKb` returns a platform i18n-keyed article spine (searchable by id/key) instead of empty Stage-1 list.

## Non-goals

- Refund / chargeback money path
- Full i18n string pack (keys only here)
- Third-party branded help content

## Paths

```
docs/ops/slices/L3-2026-08-05-support-kb.md
services/svc-support/src/kb-catalog.ts
services/svc-support/src/kb-catalog.test.ts
services/svc-support/src/support-service.ts
services/svc-support/src/support-service.test.ts
```

## Board-Delta

L3 Class N: support KB Stage-2 platform spine (i18n keys, vendor-clean).
