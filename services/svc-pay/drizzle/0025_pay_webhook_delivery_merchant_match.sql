-- svc-pay · a webhook delivery merchant has to be the endpoint's merchant.
-- Reversal: 0025_pay_webhook_delivery_merchant_match.down.sql
--
-- 0008 stores merchant_webhook_deliveries.endpoint_id and merchant_id as
-- independent foreign keys. endpoint_id only references
-- merchant_webhook_endpoints(id) and merchant_id only references merchants(id),
-- so a delivery can name merchant B while its endpoint belongs to merchant A.
-- There is no composite foreign key on (endpoint_id, merchant_id).
-- UNIQUE (endpoint_id, event_id) does not stop that mix-up.
--
-- PostgreSQL requires the referenced pair to be unique, and id is already
-- the primary key, so this adds UNIQUE (id, merchant_id) on
-- merchant_webhook_endpoints, then a foreign key on
-- (endpoint_id, merchant_id). Not a trigger and not a check. This file does
-- not change stored rows and does not invent a merchant. If a stored delivery
-- already names a different merchant than its endpoint, ADD CONSTRAINT fails
-- and that row stays. 0008 is already applied.

ALTER TABLE "pay"."merchant_webhook_endpoints"
  ADD CONSTRAINT "merchant_webhook_endpoints_id_merchant_uq"
  UNIQUE ("id", "merchant_id");

ALTER TABLE "pay"."merchant_webhook_deliveries"
  ADD CONSTRAINT "merchant_webhook_deliveries_endpoint_merchant_fk"
  FOREIGN KEY ("endpoint_id", "merchant_id")
  REFERENCES "pay"."merchant_webhook_endpoints" ("id", "merchant_id");
