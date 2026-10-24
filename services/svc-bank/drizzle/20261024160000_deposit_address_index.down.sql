-- intafaced:destructive drops address_index, label and expires_at, only after the guard below proves no extra address exists
-- Reverses 20261024160000_deposit_address_index.sql. It refuses while any extra address exists: dropping it would leave the
-- customer no record of an address custody still watches. Labels on first addresses are dropped with the column.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."deposit_addresses" WHERE "address_index" > 0) THEN
    RAISE EXCEPTION 'extra deposit addresses exist; they must be retired in custody before reversing';
  END IF;
END $$;

ALTER TABLE "bank"."deposit_addresses" DROP CONSTRAINT IF EXISTS "deposit_addresses_label_ck";
ALTER TABLE "bank"."deposit_addresses" DROP CONSTRAINT IF EXISTS "deposit_addresses_index_ck";
ALTER TABLE "bank"."deposit_addresses" DROP CONSTRAINT IF EXISTS "deposit_addresses_pkey";
ALTER TABLE "bank"."deposit_addresses"
  ADD CONSTRAINT "deposit_addresses_pkey" PRIMARY KEY ("user_id", "asset_id", "network_id");
ALTER TABLE "bank"."deposit_addresses"
  DROP COLUMN IF EXISTS "expires_at", DROP COLUMN IF EXISTS "label", DROP COLUMN IF EXISTS "address_index";
