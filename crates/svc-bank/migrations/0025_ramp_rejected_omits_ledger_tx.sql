-- A rejected onramp must not point at a ledger posting, and a rejected
-- offramp must not point at the hold or the settle posting.
--
-- `ramp_onramps_rejected_has_code_ck` requires a rejection code and says
-- nothing about `ledger_tx_id`. A rejected onramp can still name the
-- transaction that credited the user. `ramp_offramps_rejected_has_code_ck`
-- is the same shape for a withdrawal: rejected can still name
-- `hold_ledger_tx_id` or `settle_ledger_tx_id`. Settled rows still name
-- those postings. An offramp has no column for the posting that releases
-- a hold.
--
-- `release_ledger_tx_id` is that posting. It may be set only when status
-- is rejected. Pending and settled leave it null. A rejected row with no
-- hold may leave it null.
--
-- CHECK only. No UPDATE and no DELETE of ramp rows. If a book already
-- holds a violating row, ADD CONSTRAINT fails and the amounts stay. This
-- file does not insert a ramp.
--
-- Reversal: 0025_ramp_rejected_omits_ledger_tx.down.sql

ALTER TABLE "bank"."ramp_offramps" ADD COLUMN IF NOT EXISTS "release_ledger_tx_id" text;

ALTER TABLE "bank"."ramp_onramps" DROP CONSTRAINT IF EXISTS "ramp_onramps_rejected_omits_ledger_tx_ck";
ALTER TABLE "bank"."ramp_onramps" ADD CONSTRAINT "ramp_onramps_rejected_omits_ledger_tx_ck"
  CHECK ("status" <> 'rejected' OR "ledger_tx_id" IS NULL);

ALTER TABLE "bank"."ramp_offramps" DROP CONSTRAINT IF EXISTS "ramp_offramps_rejected_omits_ledger_tx_ck";
ALTER TABLE "bank"."ramp_offramps" ADD CONSTRAINT "ramp_offramps_rejected_omits_ledger_tx_ck"
  CHECK (
    "status" <> 'rejected'
    OR ("hold_ledger_tx_id" IS NULL AND "settle_ledger_tx_id" IS NULL)
  );

ALTER TABLE "bank"."ramp_offramps" DROP CONSTRAINT IF EXISTS "ramp_offramps_release_only_when_rejected_ck";
ALTER TABLE "bank"."ramp_offramps" ADD CONSTRAINT "ramp_offramps_release_only_when_rejected_ck"
  CHECK ("release_ledger_tx_id" IS NULL OR "status" = 'rejected');
