-- IMPORTING A FILE OF PRODUCTS (M-catalogue-01, M-adv-payments-core-21, J-merchant-03 step 5).
--
-- One row a file a business imported in one mode: the file's SHA-256, how many product lines it had, and the products
-- it made, in file order. The file is its own key, so the same file again answers with this row and makes nothing. The
-- products are written in the same transaction as this row, so a file is imported whole or not at all. A product the
-- file made may be deleted later; its id stays here (no foreign key) and a replay leaves it out. The row is kept as
-- written.

CREATE TABLE IF NOT EXISTS "pay"."catalog_product_imports" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "mode"        text NOT NULL CONSTRAINT "catalog_product_imports_mode_known" CHECK ("mode" IN ('live', 'test')),
  "file_sha256" text NOT NULL CONSTRAINT "catalog_product_imports_sha256_format" CHECK ("file_sha256" ~ '^[0-9a-f]{64}$'),
  "row_count"   integer NOT NULL CONSTRAINT "catalog_product_imports_rows_positive" CHECK ("row_count" > 0),
  "product_ids" uuid[] NOT NULL CONSTRAINT "catalog_product_imports_ids_match" CHECK (cardinality("product_ids") = "row_count"),
  "imported_by" text NOT NULL CONSTRAINT "catalog_product_imports_actor_not_blank" CHECK (length(btrim("imported_by")) > 0),
  "imported_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "catalog_product_imports_file_once" UNIQUE ("merchant_id", "mode", "file_sha256")
);

CREATE OR REPLACE FUNCTION "pay"."catalog_product_imports_kept"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.catalog_product_imports is kept as written: % is not permitted.', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "catalog_product_imports_kept_trg" ON "pay"."catalog_product_imports";
CREATE TRIGGER "catalog_product_imports_kept_trg"
  BEFORE UPDATE OR DELETE ON "pay"."catalog_product_imports"
  FOR EACH ROW EXECUTE FUNCTION "pay"."catalog_product_imports_kept"();
