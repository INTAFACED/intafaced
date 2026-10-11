-- intafaced:destructive — reversal of 0030_pay_subscription_party_matches_mandate.sql
--
-- Drops the foreign key that refuses a subscription whose merchant_id or
-- customer_id disagrees with the mandate, then the unique triple that key
-- references. The mandate_id foreign key stays. Stored rows stay. This
-- reversal moves no value.

ALTER TABLE "pay"."subscriptions"
  DROP CONSTRAINT IF EXISTS "subscriptions_mandate_merchant_customer_fk";

ALTER TABLE "pay"."subscription_mandates"
  DROP CONSTRAINT IF EXISTS "subscription_mandates_id_merchant_customer_uq";
