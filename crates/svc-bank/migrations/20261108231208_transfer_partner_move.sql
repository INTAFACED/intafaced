-- A standing order's occurrence the partner bank made (OWNER 226: INTAFACED holds no customer money; the partner holds
-- the person's spaces). The claim row records the partner's own reference for its one move under the business key
-- `bank.transfer.sched:<scheduleId>:<occurrence>`. Nothing is posted to the ledger for it, so `ledger_tx_id` stays NULL.
--
-- One occurrence is ONE movement: a row never names both a ledger transaction and a partner move, and a rejected row
-- names neither (the rejected rule for the ledger is 0018's). A settled row still points at what moved, as 0000's
-- `transfer_executions_settled_has_tx_ck` has always required (a settled run with nothing behind it is a phantom
-- transfer): now that is the ledger transaction OR the partner's move, exactly one of them, never neither.
--
-- No UPDATE and no DELETE of money rows. Every row the old rule allowed, this one allows.
--
-- Reversal: 20261108231208_transfer_partner_move.down.sql

ALTER TABLE "bank"."transfer_executions" ADD COLUMN IF NOT EXISTS "partner_move_id" text;

ALTER TABLE "bank"."transfer_executions" DROP CONSTRAINT IF EXISTS "transfer_executions_one_movement_ck";
ALTER TABLE "bank"."transfer_executions" ADD CONSTRAINT "transfer_executions_one_movement_ck"
  CHECK ("ledger_tx_id" IS NULL OR "partner_move_id" IS NULL);

ALTER TABLE "bank"."transfer_executions" DROP CONSTRAINT IF EXISTS "transfer_executions_rejected_omits_partner_move_ck";
ALTER TABLE "bank"."transfer_executions" ADD CONSTRAINT "transfer_executions_rejected_omits_partner_move_ck"
  CHECK ("status" <> 'rejected' OR "partner_move_id" IS NULL);

ALTER TABLE "bank"."transfer_executions" DROP CONSTRAINT IF EXISTS "transfer_executions_settled_has_tx_ck";
ALTER TABLE "bank"."transfer_executions" ADD CONSTRAINT "transfer_executions_settled_has_tx_ck"
  CHECK (
    "status" <> 'settled'
    OR ("settled_at" IS NOT NULL AND (("ledger_tx_id" IS NOT NULL) <> ("partner_move_id" IS NOT NULL)))
  );
