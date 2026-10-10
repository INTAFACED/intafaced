-- intafaced:destructive — reversal of 0036_pay_merchant_payout_destinations_rail_id_not_blank.sql
--
-- Drops the check that refuses a blank or space-only rail_id. The column
-- stays text NOT NULL. The kind and ref checks stay. The merchant index
-- stays. Stored rows stay.

ALTER TABLE "pay"."merchant_payout_destinations"
  DROP CONSTRAINT IF EXISTS "merchant_payout_destinations_rail_id_not_blank";
