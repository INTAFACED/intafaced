-- intafaced:destructive drops address_index and expires_at, only after the guard below proves no extra address and no held deposit exists
-- Reverses 20261024151100_pay_custody_deposit_address_index.sql. It refuses while any extra address or any deposit held for
-- release exists: removing them would leave a deposit to that address unmatched, so they are moved or released first.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "pay"."custody_deposit_addresses" WHERE "address_index" > 0)
     OR EXISTS (SELECT 1 FROM "pay"."custody_deposits" WHERE "status" = 'held_for_release' OR "reason" = 'address_expired') THEN
    RAISE EXCEPTION 'extra deposit addresses or deposits held for release exist; release or move them before reversing';
  END IF;
END $$;

ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_reason_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_reason_ck" CHECK ("reason" IS NULL OR "reason" IN
  ('below_minimum', 'amount_mismatch', 'unknown_asset', 'minimum_unset', 'confirmations_unset'));
ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_status_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_status_ck" CHECK ("status" IN
  ('detected', 'confirming', 'credited', 'below_minimum', 'held_for_screening', 'rejected', 'reversed', 'needs_review'));

ALTER TABLE "pay"."custody_deposit_addresses" DROP CONSTRAINT IF EXISTS "custody_deposit_addresses_index_ck";
ALTER TABLE "pay"."custody_deposit_addresses" DROP CONSTRAINT IF EXISTS "custody_deposit_addresses_pkey";
ALTER TABLE "pay"."custody_deposit_addresses"
  ADD CONSTRAINT "custody_deposit_addresses_pkey" PRIMARY KEY ("user_id", "asset_id", "network_id");
ALTER TABLE "pay"."custody_deposit_addresses" DROP COLUMN IF EXISTS "expires_at", DROP COLUMN IF EXISTS "address_index";
