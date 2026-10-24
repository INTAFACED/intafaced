-- intafaced:destructive — reversal of 20261024170000_pay_catalog_copy.sql
--
-- Forgets which product was copied from which, so a later copy would copy them again. The products, test and live, stay.

CREATE OR REPLACE FUNCTION "pay"."catalog_products_versioned"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."merchant_id" IS DISTINCT FROM OLD."merchant_id" OR NEW."mode" IS DISTINCT FROM OLD."mode"
     OR NEW."product_key" IS DISTINCT FROM OLD."product_key" OR NEW."request_id" IS DISTINCT FROM OLD."request_id"
     OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
     OR NEW."created_by" IS DISTINCT FROM OLD."created_by" OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'pay.catalog_products: a product keeps its business, mode, key and maker, and each edit raises its version by one.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP INDEX IF EXISTS "pay"."catalog_products_copied_once";
ALTER TABLE "pay"."catalog_products" DROP COLUMN IF EXISTS "copied_from";
