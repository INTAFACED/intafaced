-- REPLACING PRICES, AND THE PRICE A SUBSCRIPTION RUNS ON (M-adv-payments-core-20, J-merchant-03 step 4).
--
-- A price is never edited, so changing what a product costs is a replacement: a new price that names the one it
-- replaces, made in the same transaction that archives the old one. A price is replaced at most once.
--
-- A subscription may be started from a catalogue price. It keeps that price for its whole life: replacing or archiving
-- the price, or archiving its product, never moves a running subscription. What a subscription charges is still its
-- mandate's amount, which equals the price's when the subscription is made (svc-pay checks it).
--
-- A product with prices, and a price a subscription uses, cannot be deleted (the foreign keys refuse it). A deleted
-- product leaves its create's request id and hash behind, so a retry of that create after a lost answer is told the
-- product was deleted instead of making it again.

ALTER TABLE "pay"."catalog_prices"
  ADD COLUMN IF NOT EXISTS "replaces_id" uuid REFERENCES "pay"."catalog_prices"("id");

CREATE UNIQUE INDEX IF NOT EXISTS "catalog_prices_replaced_once" ON "pay"."catalog_prices" ("replaces_id") WHERE "replaces_id" IS NOT NULL;

-- What a picker offers: one business's active prices, newest first.
CREATE INDEX IF NOT EXISTS "catalog_prices_choices_idx" ON "pay"."catalog_prices" ("merchant_id", "created_at" DESC, "id" DESC) WHERE "status" = 'active';

CREATE TABLE IF NOT EXISTS "pay"."catalog_product_tombstones" (
  "merchant_id"  uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "request_id"   uuid NOT NULL,
  "request_hash" text NOT NULL CONSTRAINT "catalog_product_tombstones_hash_format" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  "product_id"   uuid NOT NULL,
  "deleted_by"   text NOT NULL CONSTRAINT "catalog_product_tombstones_actor_not_blank" CHECK (length(btrim("deleted_by")) > 0),
  "deleted_at"   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("merchant_id", "request_id")
);

CREATE OR REPLACE FUNCTION "pay"."catalog_prices_fixed"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."merchant_id" IS DISTINCT FROM OLD."merchant_id" OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
     OR NEW."request_id" IS DISTINCT FROM OLD."request_id" OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
     OR NEW."billing" IS DISTINCT FROM OLD."billing" OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."asset_id" IS DISTINCT FROM OLD."asset_id" OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."min_amount" IS DISTINCT FROM OLD."min_amount" OR NEW."max_amount" IS DISTINCT FROM OLD."max_amount"
     OR NEW."replaces_id" IS DISTINCT FROM OLD."replaces_id"
     OR NEW."created_by" IS DISTINCT FROM OLD."created_by" OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR (OLD."status" = 'archived' AND NEW."status" <> 'archived') THEN
    RAISE EXCEPTION 'pay.catalog_prices: a price is never edited; only its default mark and archiving change, and archiving is final.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE "pay"."subscriptions"
  ADD COLUMN IF NOT EXISTS "price_id" uuid REFERENCES "pay"."catalog_prices"("id");

CREATE INDEX IF NOT EXISTS "subscriptions_price_idx" ON "pay"."subscriptions" ("price_id") WHERE "price_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION "pay"."subscriptions_price_kept"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."price_id" IS DISTINCT FROM OLD."price_id" THEN
    RAISE EXCEPTION 'pay.subscriptions: a subscription keeps the price it was started on.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "subscriptions_price_kept_trg" ON "pay"."subscriptions";
CREATE TRIGGER "subscriptions_price_kept_trg"
  BEFORE UPDATE OF "price_id" ON "pay"."subscriptions"
  FOR EACH ROW EXECUTE FUNCTION "pay"."subscriptions_price_kept"();
