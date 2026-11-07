# WIP handover: J-merchant-22 (W4 merchant4 cloud builder)

This file is a WIP handover for a paused session. Delete it before the PR is ready.

## State on 2026-11-06

- No product code or journey test was written before the pause. The branch has only this file.
- Read: project-state BUILDER.md; the J-merchant-22 row (operation-zero/modules/merchant/acceptance/journeys.md:401-418);
  the specs for M-bill-01, -02, -03, -05, -06 (operation-zero/specs/merchant-disp-bill-rep.md) and M-adv-billing-tax-01, -07
  (operation-zero/modules/merchant/specs/merchant-adv-billing-tax.md).

## What exists on main (mapped 2026-11-06)

- #2 (lost create reply) is built: `apps/customer/src/features/pay/portal/payments/subscription-recovery.ts` plus the
  `subscription_create_idempotency` table. It still needs proof in the running app.
- #1 and #3 are partly built. `subscription.create` takes mandate, path and catalogue price, but has no trial, start date,
  quantity, tiers or preview. Statuses are active, paused, cancelled and completed only. Pause has no date. Cancel is
  immediate only.
- #4 to #7 have no code: no phases, proration, payer portal, coupons or subscription import. Catalogue prices are
  fixed or customer_chosen only, with no tiers.

## Design constraints found

- `assertChargeTracesToMandate` (`services/svc-pay/src/subscriptions/mandate-product.ts:275`) requires the period amount
  to equal the mandate amount. Per-seat and tiered amounts must therefore equal the mandate amount. A plan change (#5)
  or a coupon (#7) changes the period amount, so it needs payer re-consent or a deliberate change to that money rule.
- A downgrade credit line (#5) is a negative invoice line, which needs the 0088 `merchant_invoice_lines` CHECK changed
  (spec D-143b).
- The stack has no due-pass trigger. Showing past due (#3) needs a TEST tool that signs
  `/internal/jobs/run-due-subscriptions` with the stack's internal secret, as `local-test-gates.mjs` `signedTrade` does.
- Trial plan: set `anchor_at` to the first invoice instant with `anchor_occurrence` 0, using the existing frame logic
  (`charge-cycle.ts:323`).

## Next

1. Write `apps/customer/tests/real-app/J-merchant-22.pw.mjs`, one test per step (#1 to #7).
2. Build #1 to #3 (M-bill-02, M-bill-01).
3. Then #6, #7, #5 and #4.
