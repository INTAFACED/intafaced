-- intafaced:destructive — reversal of 20261030184034_pay_payout_destination_activates_at.sql
-- A row still held when this runs becomes payable at once: drain held rows first
-- (SELECT count(*) FROM pay.merchant_payout_destinations WHERE activates_at > now()).

ALTER TABLE "pay"."merchant_payout_destinations"
  DROP COLUMN IF EXISTS "activates_at";
