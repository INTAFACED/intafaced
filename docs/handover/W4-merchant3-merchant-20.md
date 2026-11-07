# WIP handover: J-merchant-20 (W4 merchant3, cloud)

Paused at the owner's checkpoint (6 Nov, about 10:00 UTC) before any code. This file holds only the design worked out from
the row and the specs. It is removed in the PR that builds the journey.

## What exists on main (03a4606d)

- `services/svc-pay/src/fraud/evaluate.ts`: the pure `evaluateFraud` (velocity count and volume, amount anomaly, IP and
  device blocklists). A blank threshold reviews with `pay.fraud_threshold_unpublished`. Router: `fraud.evaluate` and
  `fraud.enqueueReview`. Founder review queue: `fraud/review-queue*.ts` (admin only).
- `merchant-ops/merchant-disp-bill-rep-risk-policy.ts`: a read-only `merchantRiskPolicy()` (M-disp-05, partial).
- No payment stores a risk decision. No merchant risk settings, lists, rules, review queue or retry policy. No `/pay/risk*`
  rooms in `apps/customer`.

## Design (not built yet)

- Evaluate at `payment-service/lifecycle.ts createPayment`, in the admission transaction, and store one decision per payment
  (outcome, level, signals); an evaluation error is stored as "unknown". New optional `risk` signals on `payment.create`
  (email kept only as a hash, IP, country).
- The merchant opts into enforcement. Defaults keep today's behaviour for every other journey: a block is "recorded, not
  enforced", and a review is queued but not held. With holds on, capture refuses `pay.risk_review_pending` until approved,
  and a reject voids with no capture. With enforcement on, a block fails the payment at authorize, before any rail call.
- New tables (timestamped migration with a `.down.sql`): risk settings, decisions, lists with CSV import jobs, rules
  (shadow or live, with match counts), merchant review cases, fraud reports, retry attempts.
- Rooms: the Risk card on `/pay/payments/:id`; `/pay/risk` (settings, velocity, countries, authentication, retries),
  `/pay/risk/reviews`, `/pay/risk/lists` and `/pay/risk/rules` (with analytics). Each room is registered in
  `portal/routes.ts`, `portal/payments/rooms.tsx` and `app/room-templates.ts`.

## Next

Write `apps/customer/tests/real-app/J-merchant-20.pw.mjs` first (one test per step, eight steps), then build svc-pay, then the
rooms. Then the targeted journeys run on the exact head.
