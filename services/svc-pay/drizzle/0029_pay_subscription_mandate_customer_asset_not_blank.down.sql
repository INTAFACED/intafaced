-- intafaced:destructive — reversal of 0029_pay_subscription_mandate_customer_asset_not_blank.sql
--
-- Drops the checks that refuse a blank or space-only customer_id or asset_id.
-- The columns stay text NOT NULL. The amount check and the ceiling check stay.
-- Stored rows stay. This reversal moves no value.

ALTER TABLE "pay"."subscription_mandates"
  DROP CONSTRAINT IF EXISTS "subscription_mandates_customer_id_not_blank";

ALTER TABLE "pay"."subscription_mandates"
  DROP CONSTRAINT IF EXISTS "subscription_mandates_asset_id_not_blank";
