-- W-deposit-02 (J-wallet-02 #4): a person may hold more than one deposit address for one asset on one network. NO BALANCE LIVES
-- HERE. `address_index` 0 is the first address every existing row already is, and it never expires; an extra address (1 to 9999, never reused)
-- carries the `expires_at` svc-bank computed from the owner's window when it asked for it. A deposit that first reaches an
-- extra address after its expiry is recorded `held_for_release` (reason `address_expired`): never credited on its own, never
-- dropped, kept for a support or compliance release.
-- Reversal: 20261024151100_pay_custody_deposit_address_index.down.sql

ALTER TABLE "pay"."custody_deposit_addresses"
  ADD COLUMN IF NOT EXISTS "address_index" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "expires_at" timestamptz;

ALTER TABLE "pay"."custody_deposit_addresses" DROP CONSTRAINT IF EXISTS "custody_deposit_addresses_pkey";
ALTER TABLE "pay"."custody_deposit_addresses"
  ADD CONSTRAINT "custody_deposit_addresses_pkey" PRIMARY KEY ("user_id", "asset_id", "network_id", "address_index");

ALTER TABLE "pay"."custody_deposit_addresses" DROP CONSTRAINT IF EXISTS "custody_deposit_addresses_index_ck";
ALTER TABLE "pay"."custody_deposit_addresses"
  ADD CONSTRAINT "custody_deposit_addresses_index_ck"
  CHECK ("address_index" BETWEEN 0 AND 9999 AND (("address_index" = 0) = ("expires_at" IS NULL)));

ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_status_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_status_ck" CHECK ("status" IN
  ('detected', 'confirming', 'credited', 'below_minimum', 'held_for_screening', 'held_for_release', 'rejected', 'reversed',
   'needs_review'));
ALTER TABLE "pay"."custody_deposits" DROP CONSTRAINT IF EXISTS "custody_deposits_reason_ck";
ALTER TABLE "pay"."custody_deposits" ADD CONSTRAINT "custody_deposits_reason_ck" CHECK ("reason" IS NULL OR "reason" IN
  ('below_minimum', 'amount_mismatch', 'unknown_asset', 'minimum_unset', 'confirmations_unset', 'address_expired'));
