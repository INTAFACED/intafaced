-- intafaced:destructive — reversal of 20261114093115_pay_merchant_own_wallet_acceptance.sql
--
-- Drops the businesses' receiving wallets, the addresses derived from them and each payment's custody. No money is in
-- our book for any of them: a payment to a business's own wallet booked only our fee, which stays on the ledger.

ALTER TABLE "pay"."payments" DROP CONSTRAINT IF EXISTS "payments_custody_ck";
ALTER TABLE "pay"."payments" DROP COLUMN IF EXISTS "custody";
DROP TABLE IF EXISTS "pay"."merchant_receive_addresses";
DROP TABLE IF EXISTS "pay"."merchant_receiving_wallets";
