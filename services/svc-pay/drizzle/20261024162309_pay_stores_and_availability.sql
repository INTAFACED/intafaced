-- STORES AND WHERE EACH PRODUCT IS SOLD (M-adv-org-access-05, M-adv-payments-core-21; J-merchant-03 step 6).
--
-- A store is one of a business's places of sale: its name (unique in the business, whatever the case), an address and
-- its IANA time zone. It sells through three channels: online, in person and by invoice. A store is archived, never
-- deleted, so whatever named it later stays readable. `request_id` and `request_hash` make a retried create find the
-- store it made, and refuse the same key with other details.
--
-- A product is sold in every store and channel unless the business says otherwise: one row in
-- `catalog_product_unavailable` per (product, store, channel) it is not sold in. A price check for a store and channel
-- refuses there. Nothing here moves money.

CREATE TABLE IF NOT EXISTS "pay"."stores" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id"  uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "request_id"   uuid NOT NULL,
  "request_hash" text NOT NULL CONSTRAINT "stores_request_hash_format" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  "name"         text NOT NULL CONSTRAINT "stores_name_length" CHECK (length(btrim("name")) BETWEEN 1 AND 80),
  "address"      text CONSTRAINT "stores_address_length" CHECK ("address" IS NULL OR length(btrim("address")) BETWEEN 1 AND 300),
  "timezone"     text NOT NULL CONSTRAINT "stores_timezone_length" CHECK (length("timezone") BETWEEN 1 AND 64),
  "status"       text NOT NULL DEFAULT 'active' CONSTRAINT "stores_status_known" CHECK ("status" IN ('active', 'archived')),
  "version"      integer NOT NULL DEFAULT 1,
  "created_by"   text NOT NULL CONSTRAINT "stores_actor_not_blank" CHECK (length(btrim("created_by")) > 0),
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "stores_request_once" UNIQUE ("merchant_id", "request_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "stores_name_once" ON "pay"."stores" ("merchant_id", lower("name"));
CREATE INDEX IF NOT EXISTS "stores_merchant_idx" ON "pay"."stores" ("merchant_id", "status", "created_at", "id");

CREATE OR REPLACE FUNCTION "pay"."stores_fixed"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."merchant_id" IS DISTINCT FROM OLD."merchant_id" OR NEW."request_id" IS DISTINCT FROM OLD."request_id"
     OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash" OR NEW."created_by" IS DISTINCT FROM OLD."created_by"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'pay.stores: a store keeps its business, key and maker.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "stores_fixed_trg" ON "pay"."stores";
CREATE TRIGGER "stores_fixed_trg" BEFORE UPDATE ON "pay"."stores"
  FOR EACH ROW EXECUTE FUNCTION "pay"."stores_fixed"();

CREATE OR REPLACE FUNCTION "pay"."stores_kept"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.stores: a store is archived, never deleted.' USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "stores_kept_trg" ON "pay"."stores";
CREATE TRIGGER "stores_kept_trg" BEFORE DELETE ON "pay"."stores"
  FOR EACH ROW EXECUTE FUNCTION "pay"."stores_kept"();

-- No business column of its own: the business is the product's and the store's, which svc-pay checks are the same one.
CREATE TABLE IF NOT EXISTS "pay"."catalog_product_unavailable" (
  "product_id"  uuid NOT NULL REFERENCES "pay"."catalog_products"("id") ON DELETE CASCADE,
  "store_id"    uuid NOT NULL REFERENCES "pay"."stores"("id"),
  "channel"     text NOT NULL CONSTRAINT "catalog_product_unavailable_channel_known"
                  CHECK ("channel" IN ('online', 'in_person', 'invoice')),
  "set_by"      text NOT NULL CONSTRAINT "catalog_product_unavailable_actor_not_blank" CHECK (length(btrim("set_by")) > 0),
  "set_at"      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("product_id", "store_id", "channel")
);

CREATE INDEX IF NOT EXISTS "catalog_product_unavailable_store_idx" ON "pay"."catalog_product_unavailable" ("store_id");
