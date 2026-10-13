-- svc-market · purchase payee and asset snapshot (L1230)
-- Reversal: 0006_market_purchase_snapshot.down.sql
--
-- 0002 stores vendor_id, vendor_user_id, and asset_id on the purchase, but
-- vendor_user_id is not tied to vendors.user_id, vendor_id is not tied to
-- listings.vendor_id, and asset_id is only NOT NULL. A row can name one
-- listing, pay a different user, and carry a blank or different asset.
--
-- purchases.vendor_id is the vendor_id of purchases.listing_id.
-- purchases.vendor_user_id is the user_id of that same vendor.
-- purchases.asset_id equals the listing asset_id, is not blank, and is
-- at most 32 characters. This file does not post a ledger entry.

ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_listing_vendor_fk";
ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_vendor_user_fk";
ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_listing_asset_fk";
ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_asset_not_blank";

ALTER TABLE "market"."listings" DROP CONSTRAINT IF EXISTS "listings_id_vendor_key";
ALTER TABLE "market"."listings" DROP CONSTRAINT IF EXISTS "listings_id_asset_key";
ALTER TABLE "market"."vendors" DROP CONSTRAINT IF EXISTS "vendors_id_user_key";

ALTER TABLE "market"."listings"
  ADD CONSTRAINT "listings_id_vendor_key" UNIQUE ("id", "vendor_id");

ALTER TABLE "market"."listings"
  ADD CONSTRAINT "listings_id_asset_key" UNIQUE ("id", "asset_id");

-- vendors.user_id is already unique (vendors_user_idx). The pair is the
-- target that ties a purchase payee to that vendor's user.
ALTER TABLE "market"."vendors"
  ADD CONSTRAINT "vendors_id_user_key" UNIQUE ("id", "user_id");

ALTER TABLE "market"."purchases"
  ADD CONSTRAINT "purchases_asset_not_blank" CHECK (
    length(btrim("asset_id")) > 0 AND length("asset_id") <= 32
  );

ALTER TABLE "market"."purchases"
  ADD CONSTRAINT "purchases_listing_vendor_fk"
  FOREIGN KEY ("listing_id", "vendor_id")
  REFERENCES "market"."listings" ("id", "vendor_id");

ALTER TABLE "market"."purchases"
  ADD CONSTRAINT "purchases_vendor_user_fk"
  FOREIGN KEY ("vendor_id", "vendor_user_id")
  REFERENCES "market"."vendors" ("id", "user_id");

ALTER TABLE "market"."purchases"
  ADD CONSTRAINT "purchases_listing_asset_fk"
  FOREIGN KEY ("listing_id", "asset_id")
  REFERENCES "market"."listings" ("id", "asset_id");

-- The receipt belongs to the original claim. A valid new payee/asset/price is
-- still a different sale and must never replace the terms of this key.
CREATE OR REPLACE FUNCTION "market"."purchases_terms_snapshot"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."id", NEW."listing_id", NEW."buyer_id", NEW."vendor_id", NEW."vendor_user_id", NEW."asset_id", NEW."price", NEW."commission_bps")
     IS DISTINCT FROM
     ROW(OLD."id", OLD."listing_id", OLD."buyer_id", OLD."vendor_id", OLD."vendor_user_id", OLD."asset_id", OLD."price", OLD."commission_bps") THEN
    RAISE EXCEPTION 'market.purchases % terms are the immutable claim snapshot', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "purchases_terms_snapshot_trg" ON "market"."purchases";
CREATE TRIGGER "purchases_terms_snapshot_trg"
  BEFORE UPDATE ON "market"."purchases"
  FOR EACH ROW EXECUTE FUNCTION "market"."purchases_terms_snapshot"();
