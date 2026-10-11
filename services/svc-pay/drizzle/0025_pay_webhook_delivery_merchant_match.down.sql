-- intafaced:destructive — reversal of 0025_pay_webhook_delivery_merchant_match.sql
--
-- Drops the foreign key that refuses a delivery whose merchant_id disagrees
-- with the endpoint's merchant_id, then the unique pair that key references.
-- The independent foreign keys stay. Stored rows stay.

ALTER TABLE "pay"."merchant_webhook_deliveries"
  DROP CONSTRAINT IF EXISTS "merchant_webhook_deliveries_endpoint_merchant_fk";

ALTER TABLE "pay"."merchant_webhook_endpoints"
  DROP CONSTRAINT IF EXISTS "merchant_webhook_endpoints_id_merchant_uq";
