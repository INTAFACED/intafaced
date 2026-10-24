-- intafaced:destructive — reversal of 20261024150000_pay_catalog_price_use.sql
--
-- Forgets which price each subscription was started on, which price replaced which, and which product creates were
-- deleted. The subscriptions, prices and products themselves stay.

DROP TABLE IF EXISTS "pay"."catalog_product_tombstones";
DROP INDEX IF EXISTS "pay"."catalog_prices_choices_idx";

DROP TRIGGER IF EXISTS "subscriptions_price_kept_trg" ON "pay"."subscriptions";
DROP FUNCTION IF EXISTS "pay"."subscriptions_price_kept"();
DROP INDEX IF EXISTS "pay"."subscriptions_price_idx";
ALTER TABLE "pay"."subscriptions" DROP COLUMN IF EXISTS "price_id";

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

DROP INDEX IF EXISTS "pay"."catalog_prices_replaced_once";
ALTER TABLE "pay"."catalog_prices" DROP COLUMN IF EXISTS "replaces_id";
