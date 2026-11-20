-- Reversal of 0007_purposed_lock_kinds.sql — restores hold-only CHECK.

ALTER TABLE "ledger"."accounts" DROP CONSTRAINT IF EXISTS "accounts_lock_purposed_ck";
ALTER TABLE "ledger"."accounts" DROP CONSTRAINT IF EXISTS "accounts_hold_purposed_ck";
ALTER TABLE "ledger"."accounts" ADD CONSTRAINT "accounts_hold_purposed_ck"
  CHECK ("kind" <> 'hold' OR length("purpose") > 0);
