-- trade.futures · freeze the funding RATE with the period membership
-- Reversal: 0049_funding_period_frozen_rate.down.sql
--
-- THE DEFECT
--
-- 0019/0020 freeze membership and sizes per periodId, but `runFundingTick`
-- still took the rate from the oracle on every run. Leg recipe keys are
-- (period, payer, payee) and their amounts depend on the rate. Legs 1..k post
-- at r1, a 5xx or crash stops the run before the settle marker, the oracle
-- republishes the same periodId at r2 (or a restart loses an in-memory rate
-- book): leg 1 replays under the same key with a different amount. Before the
-- ledger refuses a reused key with a different body, it silently kept leg 1 at
-- r1 while later legs booked at r2 — two rates inside one period. Once it
-- refuses (ledger.idempotency_conflict), the job fails every interval,
-- applyFundingNets never runs, and payers' margin_current is never reduced.
--
-- THE FIX
--
-- The first rate seen for a periodId is stored here (INSERT ... ON CONFLICT DO
-- NOTHING, then SELECT) and every later run plans from it, whatever the oracle
-- now says. First writer wins; no owner number, no invented rate.

CREATE TABLE IF NOT EXISTS "trade"."funding_period_rates" (
  "period_id"   text PRIMARY KEY,
  "rate"        text NOT NULL,
  "frozen_at"   timestamptz NOT NULL DEFAULT now()
);
