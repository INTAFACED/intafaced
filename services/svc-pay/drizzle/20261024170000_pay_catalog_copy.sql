-- THE TEST CATALOGUE, AND COPYING BETWEEN TEST AND LIVE (M-adv-payments-core-21, J-merchant-03 step 6).
--
-- A business keeps two catalogues, live and test (`catalog_products.mode`). A product copied from the other catalogue
-- names its source, and one source has at most one copy in each catalogue, so copying twice makes nothing new. The
-- source is named without a foreign key: deleting a product (one with no prices) must not depend on its copies. A copy
-- keeps its source for its whole life, like the rest of what a product was made with.

ALTER TABLE "pay"."catalog_products" ADD COLUMN IF NOT EXISTS "copied_from" uuid;

CREATE UNIQUE INDEX IF NOT EXISTS "catalog_products_copied_once"
  ON "pay"."catalog_products" ("merchant_id", "mode", "copied_from") WHERE "copied_from" IS NOT NULL;

CREATE OR REPLACE FUNCTION "pay"."catalog_products_versioned"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."merchant_id" IS DISTINCT FROM OLD."merchant_id" OR NEW."mode" IS DISTINCT FROM OLD."mode"
     OR NEW."product_key" IS DISTINCT FROM OLD."product_key" OR NEW."request_id" IS DISTINCT FROM OLD."request_id"
     OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash" OR NEW."copied_from" IS DISTINCT FROM OLD."copied_from"
     OR NEW."created_by" IS DISTINCT FROM OLD."created_by" OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'pay.catalog_products: a product keeps its business, mode, key and maker, and each edit raises its version by one.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
