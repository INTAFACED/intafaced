-- J-merchant-04 (launch money model, OWNER 226): a payer's crypto goes straight to the business's own wallet.
-- Reversal: 20261114093115_pay_merchant_own_wallet_acceptance.down.sql
--
-- 1. `merchant_receiving_wallets`: the business's own receiving wallet, given as its extended public key. We derive one
--    receiving address per payment from it and never hold a private key, so nothing paid there is ever ours to move.
-- 2. `merchant_receive_addresses`: each derived address, given out once, to one payment, at one child index.
-- 3. `payments.custody`: who holds a payment's money. `platform` is the custodial layer (an address we control, booked to
--    merchant clearing on our ledger); `merchant_wallet` is the business's own wallet and `partner` the acquiring
--    partner, for which our ledger records only our own fee.

CREATE TABLE IF NOT EXISTS "pay"."merchant_receiving_wallets" (
  "merchant_id" uuid PRIMARY KEY REFERENCES "pay"."merchants"("id"),
  -- The family of networks the key derives addresses for. Only EVM networks today.
  "network_family" text NOT NULL,
  "extended_public_key" text NOT NULL,
  -- The address at child index 0, shown back to the owner so they can check it is their wallet's.
  "first_address" text NOT NULL,
  "saved_by" uuid NOT NULL,
  "saved_at" timestamptz NOT NULL DEFAULT now(),
  "version" integer NOT NULL DEFAULT 1,
  -- The save that wrote this version, so a retried save is recognised and answered without a second write.
  "request_id" uuid NOT NULL,
  "request_hash" text NOT NULL,
  CONSTRAINT "merchant_receiving_wallets_family_ck" CHECK ("network_family" IN ('evm'))
);

CREATE TABLE IF NOT EXISTS "pay"."merchant_receive_addresses" (
  "merchant_id" uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  -- The key the address was derived from: a later key never reuses an index of an earlier one.
  "extended_public_key" text NOT NULL,
  "child_index" integer NOT NULL,
  "address" text NOT NULL,
  "payment_id" uuid NOT NULL REFERENCES "pay"."payments"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "merchant_receive_addresses_pkey" PRIMARY KEY ("extended_public_key", "child_index"),
  CONSTRAINT "merchant_receive_addresses_index_ck" CHECK ("child_index" >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "merchant_receive_addresses_address_idx" ON "pay"."merchant_receive_addresses" (lower("address"));
CREATE UNIQUE INDEX IF NOT EXISTS "merchant_receive_addresses_payment_idx" ON "pay"."merchant_receive_addresses" ("payment_id");
CREATE INDEX IF NOT EXISTS "merchant_receive_addresses_merchant_idx" ON "pay"."merchant_receive_addresses" ("merchant_id");

ALTER TABLE "pay"."payments" ADD COLUMN IF NOT EXISTS "custody" text NOT NULL DEFAULT 'platform';
ALTER TABLE "pay"."payments" DROP CONSTRAINT IF EXISTS "payments_custody_ck";
ALTER TABLE "pay"."payments" ADD CONSTRAINT "payments_custody_ck" CHECK ("custody" IN ('platform', 'merchant_wallet', 'partner'));
