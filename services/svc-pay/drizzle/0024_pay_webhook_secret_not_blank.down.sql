-- intafaced:destructive — reversal of 0024_pay_webhook_secret_not_blank.sql
--
-- Drops the checks that refuse a blank or space-only signing_secret or
-- secret_hash. The columns stay text NOT NULL. Stored rows stay.

ALTER TABLE "pay"."merchant_webhook_endpoints"
  DROP CONSTRAINT IF EXISTS "merchant_webhook_endpoints_signing_secret_not_blank";

ALTER TABLE "pay"."merchant_webhook_endpoints"
  DROP CONSTRAINT IF EXISTS "merchant_webhook_endpoints_secret_hash_not_blank";
