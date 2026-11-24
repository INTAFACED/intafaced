-- W-deposit-02 (J-wallet-02 #4): a person may hold more than one deposit address for one asset on one network, each with
-- an optional label. NO BALANCE LIVES HERE: these are the addresses custody (svc-pay) issued. `address_index` 0 is the first
-- address every existing row already is, and it never expires; an extra address (1 to 9999, never reused) carries the
-- `expires_at` svc-pay stored for it. How many may be open at once is the owner's BANK_DEPOSIT_ADDRESS_CAP.
-- Reversal: 20261024160000_deposit_address_index.down.sql

ALTER TABLE "bank"."deposit_addresses"
  ADD COLUMN IF NOT EXISTS "address_index" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "label" text,
  ADD COLUMN IF NOT EXISTS "expires_at" timestamptz;

ALTER TABLE "bank"."deposit_addresses" DROP CONSTRAINT IF EXISTS "deposit_addresses_pkey";
ALTER TABLE "bank"."deposit_addresses"
  ADD CONSTRAINT "deposit_addresses_pkey" PRIMARY KEY ("user_id", "asset_id", "network_id", "address_index");

ALTER TABLE "bank"."deposit_addresses" DROP CONSTRAINT IF EXISTS "deposit_addresses_index_ck";
ALTER TABLE "bank"."deposit_addresses"
  ADD CONSTRAINT "deposit_addresses_index_ck"
  CHECK ("address_index" BETWEEN 0 AND 9999 AND (("address_index" = 0) = ("expires_at" IS NULL)));

ALTER TABLE "bank"."deposit_addresses" DROP CONSTRAINT IF EXISTS "deposit_addresses_label_ck";
ALTER TABLE "bank"."deposit_addresses"
  ADD CONSTRAINT "deposit_addresses_label_ck"
  CHECK ("label" IS NULL OR (length("label") BETWEEN 1 AND 40 AND "label" = btrim("label")));
