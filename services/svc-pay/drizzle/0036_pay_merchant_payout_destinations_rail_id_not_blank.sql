-- svc-pay · a payout destination rail id cannot be blank.
-- Reversal: 0036_pay_merchant_payout_destinations_rail_id_not_blank.down.sql
--
-- 0014 stores merchant_payout_destinations.rail_id as text NOT NULL. rail_id
-- is half of the primary key loaded before withdrawHold. kind and ref already
-- refuse a blank with CHECK (length(btrim(...)) > 0). NOT NULL still admits
-- '' and a string of spaces on rail_id, so an empty key is stored as a real
-- destination. This file only adds the same check on rail_id. It does not
-- change the kind or ref checks. It does not add a unique index on
-- btrim(rail_id). It does not invent a rail, a PSP, or an amount. This table
-- has no amount column. It does not call withdrawHold or post a ledger entry.
-- It does not UPDATE stored rows. If a stored rail_id is already blank,
-- ADD CONSTRAINT fails and that row stays. 0014 is already applied.

ALTER TABLE "pay"."merchant_payout_destinations"
  ADD CONSTRAINT "merchant_payout_destinations_rail_id_not_blank"
  CHECK (length(btrim("rail_id")) > 0);
