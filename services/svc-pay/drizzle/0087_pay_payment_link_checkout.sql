-- A payment link's checkout address can be read again, and createLink can be retried.
-- Reversal: 0087_pay_payment_link_checkout.down.sql
--
-- The token is the public checkout credential. Public resolve and the hosted
-- page hash it and treat possession as permission to pay. There is no second
-- secret. checkout_token stores that same credential so a caller who can list
-- the link can rebuild the checkout path. token_hash stays the lookup key.
-- A link minted before this column has a null checkout_token: the address was
-- not kept, and this migration does not invent one.
--
-- payment_link_create_idempotency is the Idempotency-Key journal. The owner
-- is the merchant, so a key does not cross tenants. Same key and same request
-- fingerprint stores one link id and a retry reads that link, including its
-- checkout token. Same key and a different fingerprint is a conflict, decided
-- in the service. The 255-character cap matches the public REST Idempotency-Key.
-- link_id is nullable only so the claim and the link insert can share one
-- transaction; a committed row is written with the id filled in.

ALTER TABLE "pay"."payment_links" ADD COLUMN IF NOT EXISTS "checkout_token" text;

ALTER TABLE "pay"."payment_links" DROP CONSTRAINT IF EXISTS "payment_links_checkout_token_ck";

ALTER TABLE "pay"."payment_links"
  ADD CONSTRAINT "payment_links_checkout_token_ck"
  CHECK (
    "checkout_token" IS NULL
    OR (
      char_length("checkout_token") BETWEEN 8 AND 200
      AND "checkout_token" = btrim("checkout_token")
      AND "checkout_token" LIKE 'pl|_%' ESCAPE '|'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS "payment_links_checkout_token_uq"
  ON "pay"."payment_links" ("checkout_token")
  WHERE "checkout_token" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "pay"."payment_link_create_idempotency" (
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants" ("id"),
  "idempotency_key" text NOT NULL,
  "request_fingerprint" text NOT NULL,
  "link_id" uuid REFERENCES "pay"."payment_links" ("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("merchant_id", "idempotency_key"),
  CONSTRAINT "payment_link_create_idempotency_key_len_ck"
    CHECK (char_length("idempotency_key") BETWEEN 1 AND 255 AND "idempotency_key" = btrim("idempotency_key")),
  CONSTRAINT "payment_link_create_idempotency_fingerprint_ck"
    CHECK (char_length(btrim("request_fingerprint")) > 0)
);
