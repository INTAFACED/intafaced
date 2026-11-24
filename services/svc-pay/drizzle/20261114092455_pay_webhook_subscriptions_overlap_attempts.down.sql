-- intafaced:destructive — reversal of 20261114092455_pay_webhook_subscriptions_overlap_attempts.sql
--
-- Drops the attempt journal, recovery requests, subscriptions and secret overlap. No balance or payment changes:
-- deliveries keep their own rows; only the per-attempt history and a rolled secret's overlap are lost.

DROP TABLE IF EXISTS "pay"."merchant_webhook_recoveries";
DROP TABLE IF EXISTS "pay"."merchant_webhook_attempts";
ALTER TABLE "pay"."merchant_webhook_deliveries" DROP COLUMN IF EXISTS "resend_request_id";
ALTER TABLE "pay"."merchant_webhook_rotations" DROP CONSTRAINT IF EXISTS "merchant_webhook_rotations_overlap_ck";
ALTER TABLE "pay"."merchant_webhook_rotations" DROP COLUMN IF EXISTS "overlap_seconds";
ALTER TABLE "pay"."merchant_webhook_endpoints" DROP CONSTRAINT IF EXISTS "merchant_webhook_endpoints_overlap_pair_ck";
ALTER TABLE "pay"."merchant_webhook_endpoints" DROP COLUMN IF EXISTS "previous_secret_until";
ALTER TABLE "pay"."merchant_webhook_endpoints" DROP COLUMN IF EXISTS "previous_signing_secret";
ALTER TABLE "pay"."merchant_webhook_endpoints" DROP CONSTRAINT IF EXISTS "merchant_webhook_endpoints_event_types_ck";
ALTER TABLE "pay"."merchant_webhook_endpoints" DROP COLUMN IF EXISTS "event_types";
