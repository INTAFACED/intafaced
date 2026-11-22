-- A card round-up into a space the partner bank holds (OWNER 226; J-bank-07 #3): the run records the partner's own
-- reference for its one move under the business key `bank.transfer.own:roundup:<rule>:<authorization>:0`. Nothing is
-- posted to the ledger for it, so `ledger_tx_id` stays NULL. A run never names both a ledger transaction and a partner
-- move, and a rejected run names no partner move.
--
-- Every row the old rules allowed, these allow.
--
-- Reversal: 20261114215747_round_up_partner_move.down.sql

ALTER TABLE "bank"."auto_invest_runs" ADD COLUMN IF NOT EXISTS "partner_move_id" text;

ALTER TABLE "bank"."auto_invest_runs" DROP CONSTRAINT IF EXISTS "auto_invest_runs_one_movement_ck";
ALTER TABLE "bank"."auto_invest_runs" ADD CONSTRAINT "auto_invest_runs_one_movement_ck"
  CHECK ("ledger_tx_id" IS NULL OR "partner_move_id" IS NULL);

ALTER TABLE "bank"."auto_invest_runs" DROP CONSTRAINT IF EXISTS "auto_invest_runs_rejected_omits_partner_move_ck";
ALTER TABLE "bank"."auto_invest_runs" ADD CONSTRAINT "auto_invest_runs_rejected_omits_partner_move_ck"
  CHECK ("status" <> 'rejected' OR "partner_move_id" IS NULL);
