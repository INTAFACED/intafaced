-- M-catalogue-02: price records on a catalogue product. A price is IMMUTABLE in amount, asset, interval and model:
-- a change is a new price plus archiving the old one, so running subscriptions and issued invoices keep what they were sold.
-- Only description, archived_at and the product's default flag change after create (trigger below).
-- Amounts are numeric(38,18): anything larger is refused at save.
CREATE TABLE IF NOT EXISTS "pay"."catalog_prices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "product_id" uuid NOT NULL REFERENCES "pay"."catalog_products"("id"),
  "asset_id" text NOT NULL CHECK ("asset_id" ~ '^[A-Za-z0-9._-]{1,16}$'),
  "model" text NOT NULL CHECK ("model" IN ('flat', 'per_seat', 'graduated', 'volume')),
  "unit_amount" numeric(38,18) CHECK ("unit_amount" IS NULL OR "unit_amount" >= 0),
  "tiers" jsonb,
  "recurring_unit" text CHECK ("recurring_unit" IS NULL OR "recurring_unit" IN ('day', 'week', 'month', 'year')),
  "recurring_count" integer CHECK ("recurring_count" IS NULL OR "recurring_count" >= 1),
  "tax_behavior" text NOT NULL CHECK ("tax_behavior" IN ('inclusive', 'exclusive', 'unspecified')),
  "description" text CHECK ("description" IS NULL OR char_length("description") <= 500),
  "archived_at" timestamptz,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CHECK (("recurring_unit" IS NULL) = ("recurring_count" IS NULL)),
  CHECK (("model" IN ('flat', 'per_seat')) = ("unit_amount" IS NOT NULL)),
  CHECK (("model" IN ('graduated', 'volume')) = ("tiers" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "catalog_prices_product_idx" ON "pay"."catalog_prices" ("merchant_id", "product_id", "created_at" DESC, "id" DESC);

CREATE OR REPLACE FUNCTION "pay"."catalog_prices_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."merchant_id", NEW."product_id", NEW."asset_id", NEW."model", NEW."unit_amount", NEW."tiers",
      NEW."recurring_unit", NEW."recurring_count", NEW."tax_behavior", NEW."created_by", NEW."created_at")
     IS DISTINCT FROM
     (OLD."merchant_id", OLD."product_id", OLD."asset_id", OLD."model", OLD."unit_amount", OLD."tiers",
      OLD."recurring_unit", OLD."recurring_count", OLD."tax_behavior", OLD."created_by", OLD."created_at") THEN
    RAISE EXCEPTION 'catalog.price_immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "catalog_prices_immutable_trg" ON "pay"."catalog_prices";
CREATE TRIGGER "catalog_prices_immutable_trg" BEFORE UPDATE ON "pay"."catalog_prices"
  FOR EACH ROW EXECUTE FUNCTION "pay"."catalog_prices_immutable"();

-- The product's default price. Last write wins; setting the same default again changes nothing.
ALTER TABLE "pay"."catalog_products" ADD COLUMN IF NOT EXISTS "default_price_id" uuid REFERENCES "pay"."catalog_prices"("id");

CREATE TABLE IF NOT EXISTS "pay"."catalog_price_actions" (
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "request_id" uuid NOT NULL,
  "price_id" uuid NOT NULL REFERENCES "pay"."catalog_prices"("id"),
  "action" text NOT NULL,
  "fingerprint" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("merchant_id", "request_id")
);
