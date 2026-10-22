-- M-catalogue-01: merchant product records (create, edit, archive). No price lives here (prices are M-catalogue-02).
-- `product_ref` is the merchant's own optional product id: unique per merchant and immutable once set.
-- Writes are idempotent on (merchant_id, request_id) through the append-only actions table.
CREATE TABLE IF NOT EXISTS "pay"."catalog_products" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "product_ref" text CHECK ("product_ref" IS NULL OR "product_ref" ~ '^[A-Za-z0-9._-]{1,64}$'),
  "name" text NOT NULL CHECK (char_length("name") BETWEEN 1 AND 120),
  "description" text CHECK ("description" IS NULL OR char_length("description") <= 2000),
  "image_ref" text CHECK ("image_ref" IS NULL OR char_length("image_ref") <= 500),
  "tax_code" text CHECK ("tax_code" IS NULL OR char_length("tax_code") <= 64),
  "statement_descriptor" text CHECK ("statement_descriptor" IS NULL OR char_length("statement_descriptor") <= 22),
  "unit_label" text CHECK ("unit_label" IS NULL OR char_length("unit_label") <= 32),
  "type" text NOT NULL CHECK ("type" IN ('good', 'service', 'digital')),
  "type_fields" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "category" text CHECK ("category" IS NULL OR char_length("category") <= 80),
  "sku" text CHECK ("sku" IS NULL OR char_length("sku") <= 64),
  "archived_at" timestamptz,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "catalog_products_merchant_ref_uq" ON "pay"."catalog_products" ("merchant_id", "product_ref") WHERE "product_ref" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "catalog_products_merchant_created_idx" ON "pay"."catalog_products" ("merchant_id", "created_at" DESC, "id" DESC);

-- product_ref may be set once and never changed afterwards.
CREATE OR REPLACE FUNCTION "pay"."catalog_products_ref_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."product_ref" IS NOT NULL AND NEW."product_ref" IS DISTINCT FROM OLD."product_ref" THEN
    RAISE EXCEPTION 'catalog.product_ref_immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."merchant_id" IS DISTINCT FROM OLD."merchant_id" THEN
    RAISE EXCEPTION 'catalog.product_merchant_immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "catalog_products_ref_immutable_trg" ON "pay"."catalog_products";
CREATE TRIGGER "catalog_products_ref_immutable_trg" BEFORE UPDATE ON "pay"."catalog_products"
  FOR EACH ROW EXECUTE FUNCTION "pay"."catalog_products_ref_immutable"();

CREATE TABLE IF NOT EXISTS "pay"."catalog_product_actions" (
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "request_id" uuid NOT NULL,
  "product_id" uuid NOT NULL REFERENCES "pay"."catalog_products"("id"),
  "action" text NOT NULL,
  "fingerprint" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("merchant_id", "request_id")
);
