-- One open subscription per mandate, and an Idempotency-Key for subscription.create.
-- Reversal: 0081_pay_subscription_create_idempotency.down.sql
--
-- 0010 indexes mandate_id but does not stop two active rows for one mandate.
-- A retried create, or two browsers, could start two schedules on the same
-- authorisation. This file does not edit 0010.
--
-- Open means status is active or paused. Cancelled and completed are finished:
-- a later create on that mandate is a new schedule. Paused is still open
-- because the schedule exists and must not gain a parallel one.
--
-- If two open rows for one mandate already exist, creating the unique index
-- fails and those rows stay. This file does not rewrite them.
--
-- subscription_create_idempotency is the Idempotency-Key journal. The owner
-- is the merchant, so a key does not cross tenants. Same key and same request
-- fingerprint stores one subscription id and a retry reads it back. Same key
-- and a different fingerprint is a conflict, decided in the service. The
-- 255-character cap matches the public REST Idempotency-Key. subscription_id
-- is nullable only so the claim and the subscription insert can share one
-- transaction; a committed row is written with the id filled in.

CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_one_open_per_mandate_uq"
  ON "pay"."subscriptions" ("mandate_id")
  WHERE "status" IN ('active', 'paused');

CREATE TABLE IF NOT EXISTS "pay"."subscription_create_idempotency" (
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants" ("id"),
  "idempotency_key" text NOT NULL,
  "request_fingerprint" text NOT NULL,
  "subscription_id" uuid REFERENCES "pay"."subscriptions" ("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("merchant_id", "idempotency_key"),
  CONSTRAINT "subscription_create_idempotency_key_len_ck"
    CHECK (char_length("idempotency_key") BETWEEN 1 AND 255 AND "idempotency_key" = btrim("idempotency_key")),
  CONSTRAINT "subscription_create_idempotency_fingerprint_ck"
    CHECK (char_length(btrim("request_fingerprint")) > 0)
);
