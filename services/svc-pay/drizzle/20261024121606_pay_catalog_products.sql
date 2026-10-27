-- THE PRODUCT CATALOGUE: A BUSINESS'S PRODUCTS AND THEIR IMAGES (M-catalogue-01, J-merchant-03 steps 1 and 2).
--
-- A product is a record only: no price (M-catalogue-02 adds prices) and no money. It belongs to one business and one
-- mode; `live` is the only mode written today, and test-mode rows come with the test and live copy
-- (M-adv-payments-core-21). Its key is the business's own choice or one svc-pay made, unique in that business and
-- mode. `request_id` is the client's key for one create and `request_hash` what that create asked for, so a retry
-- after a lost answer finds the product it made and a reused key with other details is refused.
-- An edit raises the version by one and never changes the key, the mode or the business. Only an event carries a
-- start time and a place, and it must carry both.
--
-- A product image is kept as uploaded and never changed: checked type, size and hash, the bytes, and who sent it.

CREATE TABLE IF NOT EXISTS "pay"."catalog_product_images" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id"  uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "request_id"   uuid NOT NULL,
  "content_type" text NOT NULL CONSTRAINT "catalog_product_images_type_known" CHECK ("content_type" IN ('image/png', 'image/jpeg', 'image/webp')),
  "byte_size"    integer NOT NULL CONSTRAINT "catalog_product_images_size_positive" CHECK ("byte_size" > 0),
  "sha256"       text NOT NULL CONSTRAINT "catalog_product_images_sha256_format" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  "bytes"        bytea NOT NULL,
  "uploaded_by"  text NOT NULL CONSTRAINT "catalog_product_images_actor_not_blank" CHECK (length(btrim("uploaded_by")) > 0),
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "catalog_product_images_size_matches" CHECK (octet_length("bytes") = "byte_size"),
  CONSTRAINT "catalog_product_images_request_once" UNIQUE ("merchant_id", "request_id")
);

CREATE TABLE IF NOT EXISTS "pay"."catalog_products" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id"          uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "mode"                 text NOT NULL CONSTRAINT "catalog_products_mode_known" CHECK ("mode" IN ('live', 'test')),
  "product_key"          text NOT NULL CONSTRAINT "catalog_products_key_format" CHECK ("product_key" ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
  "request_id"           uuid NOT NULL,
  "request_hash"         text NOT NULL CONSTRAINT "catalog_products_request_hash_format" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  "name"                 text NOT NULL CONSTRAINT "catalog_products_name_len" CHECK (length(btrim("name")) BETWEEN 1 AND 250),
  "type"                 text NOT NULL CONSTRAINT "catalog_products_type_known" CHECK ("type" IN ('physical', 'digital', 'service', 'event')),
  "unit_label"           text CONSTRAINT "catalog_products_unit_len" CHECK ("unit_label" IS NULL OR length(btrim("unit_label")) BETWEEN 1 AND 40),
  "statement_descriptor" text CONSTRAINT "catalog_products_descriptor_len" CHECK ("statement_descriptor" IS NULL OR length("statement_descriptor") BETWEEN 5 AND 22),
  "event_starts_at"      timestamptz,
  "event_location"       text CONSTRAINT "catalog_products_location_len" CHECK ("event_location" IS NULL OR length(btrim("event_location")) BETWEEN 1 AND 200),
  "image_id"             uuid REFERENCES "pay"."catalog_product_images"("id"),
  "status"               text NOT NULL DEFAULT 'active' CONSTRAINT "catalog_products_status_known" CHECK ("status" IN ('active', 'archived')),
  "version"              integer NOT NULL DEFAULT 1 CONSTRAINT "catalog_products_version_positive" CHECK ("version" >= 1),
  "created_by"           text NOT NULL CONSTRAINT "catalog_products_actor_not_blank" CHECK (length(btrim("created_by")) > 0),
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "catalog_products_event_whole" CHECK (
    ("type" = 'event') = ("event_starts_at" IS NOT NULL) AND ("type" = 'event') = ("event_location" IS NOT NULL)
  ),
  CONSTRAINT "catalog_products_key_once" UNIQUE ("merchant_id", "mode", "product_key"),
  CONSTRAINT "catalog_products_request_once" UNIQUE ("merchant_id", "request_id")
);

-- The list walks newest first for one business and mode; a status filter is applied on top of the same order.
CREATE INDEX IF NOT EXISTS "catalog_products_list_idx" ON "pay"."catalog_products" ("merchant_id", "mode", "created_at" DESC, "id" DESC);

CREATE OR REPLACE FUNCTION "pay"."catalog_product_images_kept"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.catalog_product_images is kept as uploaded: % is not permitted.', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "catalog_product_images_kept_trg" ON "pay"."catalog_product_images";
CREATE TRIGGER "catalog_product_images_kept_trg"
  BEFORE UPDATE ON "pay"."catalog_product_images"
  FOR EACH ROW EXECUTE FUNCTION "pay"."catalog_product_images_kept"();

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

DROP TRIGGER IF EXISTS "catalog_products_versioned_trg" ON "pay"."catalog_products";
CREATE TRIGGER "catalog_products_versioned_trg"
  BEFORE UPDATE ON "pay"."catalog_products"
  FOR EACH ROW EXECUTE FUNCTION "pay"."catalog_products_versioned"();
