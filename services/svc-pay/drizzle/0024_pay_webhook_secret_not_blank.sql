-- svc-pay · a webhook signing secret and its hash cannot be blank.
-- Reversal: 0024_pay_webhook_secret_not_blank.down.sql
--
-- 0008 stores merchant_webhook_endpoints.signing_secret and secret_hash as
-- text NOT NULL. NOT NULL still admits '' and a string of spaces. Outbound
-- HMAC signs with the raw signing_secret column, so a blank value is a
-- signature anyone who knows that blank can recompute.
--
-- CHECK only. This file does not change stored rows and does not invent a
-- secret. If a stored row is already blank, ADD CONSTRAINT fails and that
-- row stays. 0008 is already applied.

ALTER TABLE "pay"."merchant_webhook_endpoints"
  ADD CONSTRAINT "merchant_webhook_endpoints_signing_secret_not_blank"
  CHECK (length(btrim("signing_secret")) > 0);

ALTER TABLE "pay"."merchant_webhook_endpoints"
  ADD CONSTRAINT "merchant_webhook_endpoints_secret_hash_not_blank"
  CHECK (length(btrim("secret_hash")) > 0);
