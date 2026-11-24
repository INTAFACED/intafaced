-- Reverses 20261123222718_personal_transfer_fees.sql: the two recorded fee columns go, with what they recorded.

ALTER TABLE "bank"."personal_transfers" DROP COLUMN IF EXISTS "network_fee";
ALTER TABLE "bank"."personal_transfers" DROP COLUMN IF EXISTS "fee";
