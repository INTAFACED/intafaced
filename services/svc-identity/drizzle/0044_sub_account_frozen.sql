-- Sub-account freeze flag. Bybit frozen is 0 (active) or 1 (paused) on the
-- same sub-uid. Distinct from revoked, which retires the partition.
-- Reversal: 0044_sub_account_frozen.down.sql

ALTER TABLE "identity"."sub_accounts" ADD COLUMN IF NOT EXISTS "frozen" integer NOT NULL DEFAULT 0;

ALTER TABLE "identity"."sub_accounts" DROP CONSTRAINT IF EXISTS "sub_accounts_frozen_ck";
ALTER TABLE "identity"."sub_accounts"
  ADD CONSTRAINT "sub_accounts_frozen_ck" CHECK ("frozen" IN (0, 1));
