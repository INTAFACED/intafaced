-- PRICES ON CATALOGUE PRODUCTS (M-catalogue-02, J-merchant-03 step 3).
--
-- A price belongs to one product of one business. It is a fixed amount of one asset, charged once or every month, or a
-- customer-chosen amount between the business's own minimum and maximum (one-time only; both are required, so a blank
-- bound refuses). Amounts are decimal numbers of the asset, never floats. Nothing here moves money: a price is what a
-- link, an invoice or a subscription will quote.
--
-- A price is never edited: replacing one is a new price (M-adv-payments-core-20). Only two things change on a row: whether
-- it is the product's default (at most one default per product) and whether it is archived. `request_id` and
-- `request_hash` make a retried create find the price it made, and refuse the same key with other details.

CREATE TABLE IF NOT EXISTS "pay"."catalog_prices" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id"  uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "product_id"   uuid NOT NULL REFERENCES "pay"."catalog_products"("id"),
  "request_id"   uuid NOT NULL,
  "request_hash" text NOT NULL CONSTRAINT "catalog_prices_request_hash_format" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  "billing"      text NOT NULL CONSTRAINT "catalog_prices_billing_known" CHECK ("billing" IN ('one_time', 'monthly')),
  "kind"         text NOT NULL CONSTRAINT "catalog_prices_kind_known" CHECK ("kind" IN ('fixed', 'customer_chosen')),
  "asset_id"     text NOT NULL CONSTRAINT "catalog_prices_asset_format" CHECK ("asset_id" ~ '^[A-Z0-9]{1,16}$'),
  "amount"       numeric(38, 18),
  "min_amount"   numeric(38, 18),
  "max_amount"   numeric(38, 18),
  "is_default"   boolean NOT NULL DEFAULT false,
  "status"       text NOT NULL DEFAULT 'active' CONSTRAINT "catalog_prices_status_known" CHECK ("status" IN ('active', 'archived')),
  "created_by"   text NOT NULL CONSTRAINT "catalog_prices_actor_not_blank" CHECK (length(btrim("created_by")) > 0),
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "catalog_prices_amounts_whole" CHECK (
    ("kind" = 'fixed' AND "amount" > 0 AND "min_amount" IS NULL AND "max_amount" IS NULL)
    OR ("kind" = 'customer_chosen' AND "billing" = 'one_time' AND "amount" IS NULL
        AND "min_amount" > 0 AND "max_amount" >= "min_amount")
  ),
  CONSTRAINT "catalog_prices_default_active" CHECK (NOT "is_default" OR "status" = 'active'),
  CONSTRAINT "catalog_prices_request_once" UNIQUE ("merchant_id", "request_id")
);

-- One default per product.
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_prices_one_default" ON "pay"."catalog_prices" ("product_id") WHERE "is_default";
CREATE INDEX IF NOT EXISTS "catalog_prices_product_idx" ON "pay"."catalog_prices" ("product_id", "created_at", "id");

CREATE OR REPLACE FUNCTION "pay"."catalog_prices_fixed"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."merchant_id" IS DISTINCT FROM OLD."merchant_id" OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
     OR NEW."request_id" IS DISTINCT FROM OLD."request_id" OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
     OR NEW."billing" IS DISTINCT FROM OLD."billing" OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."asset_id" IS DISTINCT FROM OLD."asset_id" OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."min_amount" IS DISTINCT FROM OLD."min_amount" OR NEW."max_amount" IS DISTINCT FROM OLD."max_amount"
     OR NEW."created_by" IS DISTINCT FROM OLD."created_by" OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR (OLD."status" = 'archived' AND NEW."status" <> 'archived') THEN
    RAISE EXCEPTION 'pay.catalog_prices: a price is never edited; only its default mark and archiving change, and archiving is final.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "catalog_prices_fixed_trg" ON "pay"."catalog_prices";
CREATE TRIGGER "catalog_prices_fixed_trg"
  BEFORE UPDATE ON "pay"."catalog_prices"
  FOR EACH ROW EXECUTE FUNCTION "pay"."catalog_prices_fixed"();
