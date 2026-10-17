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
-- If two open rows for one mandate already exist, the preflight raises and
-- names those mandate ids. It does not cancel, pause, or rewrite them. The
-- merchant cancels one open subscription on each listed mandate, then this
-- migration can be applied again.
--
-- subscription_create_idempotency is the Idempotency-Key journal. The owner
-- is the merchant, so a key does not cross tenants. Same key and same request
-- fingerprint stores one subscription id and a retry reads it back. Same key
-- and a different fingerprint is a conflict, decided in the service. The
-- 255-character cap matches the public REST Idempotency-Key. subscription_id
-- is nullable only so the claim and the subscription insert can share one
-- transaction; a committed row is written with the id filled in.

-- Names every mandate that already has more than one open subscription and
-- stops. Open means active or paused. Cancelled and completed do not count.
DO $$
DECLARE
  open_mandate_ids text;
BEGIN
  SELECT string_agg(mandate_id::text, ', ' ORDER BY mandate_id::text)
    INTO open_mandate_ids
    FROM (
      SELECT mandate_id
        FROM pay.subscriptions
       WHERE status IN ('active', 'paused')
       GROUP BY mandate_id
      HAVING count(*) > 1
    ) AS open_duplicates;

  IF open_mandate_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'subscriptions_one_open_per_mandate: these mandates already have more than one open subscription (active or paused): %. The merchant must cancel one open subscription on each of those mandates, then apply this migration again. This migration does not cancel or rewrite those rows.',
      open_mandate_ids;
  END IF;
END $$;

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
