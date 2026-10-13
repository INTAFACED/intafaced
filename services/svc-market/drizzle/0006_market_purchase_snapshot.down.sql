-- Reverse 0006_market_purchase_snapshot.sql
DROP TRIGGER IF EXISTS "purchases_terms_snapshot_trg" ON "market"."purchases";
DROP FUNCTION IF EXISTS "market"."purchases_terms_snapshot"();
ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_listing_vendor_fk";
ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_vendor_user_fk";
ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_listing_asset_fk";
ALTER TABLE "market"."purchases" DROP CONSTRAINT IF EXISTS "purchases_asset_not_blank";

ALTER TABLE "market"."listings" DROP CONSTRAINT IF EXISTS "listings_id_vendor_key";
ALTER TABLE "market"."listings" DROP CONSTRAINT IF EXISTS "listings_id_asset_key";
ALTER TABLE "market"."vendors" DROP CONSTRAINT IF EXISTS "vendors_id_user_key";
